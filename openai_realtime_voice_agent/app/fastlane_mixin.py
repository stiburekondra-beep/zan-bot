"""Rychlá dráha (přednahraná pusa) sdílená OBĚMA pusami Žána.

Proč mixin: od 30. 8. 2026 má most dvě „pusy" — OpenAI Realtime
(``SafeRealtimeLLMService`` v ``app/main.py``) a Gemini Live
(``SafeGeminiLiveLLMService`` v ``app/gemini_safety.py``). Rychlá dráha
(bezpečnostní brzda → průběhová fráze HNED + akce souběžně → ověření stavu
v HA → tón / retry / poctivé selhání) je vlastnost **Žána**, ne konkrétního
poskytovatele, takže se nesmí udržovat dvakrát: jedna kopie by se v tichosti
rozešla a s ní i brzda na nevratné úkony.

Mixin stojí na tom, co mají obě služby společné (obě dědí z
``pipecat.services.llm_service.LLMService``):

* ``register_function(...)`` se stejnou signaturou včetně
  ``cancel_on_interruption`` (definované v ``LLMService``, ne v potomcích),
* ``push_frame(...)`` z ``FrameProcessor`` — tudy jde přednahrané audio,
* atributy, které mu zvenčí nastaví ``main.py``: ``fastlane_enabled``,
  ``phrase_library``, ``zan_event_url``, ``zan_event_token``.

Použití je vždy ``class Safe…(FastLaneMixin, <PipecatService>)`` — mixin musí
být PRVNÍ, aby jeho ``register_function`` přebil ten z pipecatu a ``super()``
uvnitř mířil na skutečnou službu.
"""

from __future__ import annotations

import asyncio
import logging
import time

from pipecat.frames.frames import (
    FunctionCallResultProperties,
    TTSAudioRawFrame,
    TTSStartedFrame,
    TTSStoppedFrame,
)

from app.phase_emitter import TURN_LIVENESS
from app.voice_safety import is_sensitive_actuation
from app.voice_fastlane import (
    CHUNK_BYTES as FASTLANE_CHUNK_BYTES,
    SAMPLE_RATE as FASTLANE_SAMPLE_RATE,
    VERIFY_DELAY_S,
    VERIFY_TRIES,
    build_event,
    classify as fastlane_classify,
    fetch_states,
    judge as fastlane_judge,
    room_variant,
    _post_event_blocking,
)

logger = logging.getLogger(__name__)

#: Jak dlouho po přehrané frázi platí „model už k tomu nic neříká".
#:
#: DVOJHLAS (Ondra, 31. 8. 2026 08:58): „řekl jsem mu ať zhasne v obýváku a on
#: pustí to přednahrané a pak ještě dořekne". Z logu: rychlá dráha přehrála
#: `zhasinam__obyvak` + tón `vysledek_ok` a vrátila výsledek s
#: `run_llm=False` — a model přesto v 08:58:25 řekl „Hotovo, světlo v obýváku
#: je zhasnuté."
#:
#: PROČ `run_llm=False` NESTAČÍ: ten příznak umí zastavit jen JEDNU cestu —
#: `LLMAssistantAggregator._handle_function_call_result` (push_context_frame).
#: Jenže konec uživatelova tahu pošle do služby vlastní kontextový rámec a
#: `pipecat/services/openai/realtime/llm.py:_process_completed_function_calls`
#: si po odeslání výsledku nástroje zavolá `_create_response()` sám —
#: bez ohledu na `run_llm`. U Gemini Live je to ještě tvrdší: `send_tool_response`
#: rozmluví model přímo na serveru a klient s tím nemá co dělat.
#:
#: Proto je pravidlo vynucené KÓDEM a na úrovni Žána, ne poskytovatele:
#: **když frázi řekla rychlá dráha, model výsledek už nekomentuje.**
#: Okno je krátké schválně — dorovnává jen doběh téhož tahu, nesmí spolknout
#: odpověď na další povel.
FASTLANE_MUTE_S = 6.0


class FastLaneMixin:
    """Bezpečnostní brzda + rychlá dráha nad libovolnou pipecat LLM službou."""

    # -----------------------------------------------------------------------
    # Umlčení modelu po přehrané frázi (obě pusy)
    # -----------------------------------------------------------------------

    def fastlane_mute_model(self, duvod: str) -> None:
        """Zapne okno, ve kterém model nesmí komentovat výsledek."""
        self._fastlane_mute_until = time.monotonic() + FASTLANE_MUTE_S
        logger.info("🔇 fast-lane: model umlčen na %.0f s (%s)", FASTLANE_MUTE_S, duvod)

    def fastlane_muted(self) -> bool:
        """Platí právě teď „mluvila rychlá dráha, model mlčí"?"""
        return time.monotonic() < getattr(self, "_fastlane_mute_until", 0.0)

    def fastlane_unmute(self, duvod: str = "") -> None:
        """Zruší umlčení — nový tah uživatele, nebo jsme ho právě spotřebovali."""
        if getattr(self, "_fastlane_mute_until", 0.0):
            self._fastlane_mute_until = 0.0
            if duvod:
                logger.debug("🔈 fast-lane: umlčení zrušeno (%s)", duvod)

    def register_function(self, function_name, handler, start_callback=None, *,
                          cancel_on_interruption: bool = True):  # type: ignore[override]
        """Force cancel_on_interruption=False for every tool registration.

        pipecat cancels in-flight function-call tasks on EVERY user-speech
        interruption — and semantic_vad fires one per utterance fragment, so
        merely continuing your own sentence kills the tool call your previous
        fragment started. By then the HTTP request to Home Assistant has
        usually already been SENT: the action executes, but its result never
        reaches the model, which then tells the user it failed (observed
        live: the lights turned ON while the assistant claimed they
        wouldn't). Our tools are all short-lived (HA service calls, one web
        search), so letting them finish and report the truth always beats
        killing them halfway. This single override covers every registration
        path (MCP tools via pipecat's MCPClient, web_search, disconnect).

        The handler is also wrapped to tick TURN_LIVENESS around its run, so
        the PhaseEmitter's thinking-watchdog knows a tool is in flight and a
        slow tool (web search: 10-20 s of pipeline silence) is never mistaken
        for a dead turn. All our handlers use the single-param
        FunctionCallParams signature, so the wrapper does too (pipecat
        inspects the signature to pick the calling convention).
        """
        async def liveness_tracked(params):
            # HARD BEZPEČNOSTNÍ BRZDA (2026-08-22): nevratné/rizikové cíle
            # (zámky, alarm, brány/garážová vrata, kotel) se na rychlé dráze
            # NEPROVÁDĚJÍ — vždy přes ask_zan (elevace + potvrzení v Žán-Code).
            # Vynuceno kódem, ne jen promptem; čtení (GetLiveContext) a vlastní
            # mosty (ask_zan/web_search) jsou vyňaté ve voice_safety.
            try:
                if is_sensitive_actuation(function_name, getattr(params, "arguments", None)):
                    logger.warning(
                        "🛑 fast-lane blokoval citlivý úkon %s(%r) → přesměruj na ask_zan",
                        function_name, getattr(params, "arguments", None),
                    )
                    await params.result_callback(
                        "Tohle je bezpečnostní úkon — zámek, alarm, vrata nebo kotel. "
                        "Neprovedu ho napřímo. Zavolej ask_zan s přesným zněním, ať to potvrdíme."
                    )
                    return
            except Exception as e:  # pragma: no cover - brzda nesmí shodit tool
                logger.warning(f"⚠️ safety-gate check selhal, propouštím tool: {e!r}")

            # RYCHLÁ DRÁHA (2026-08-22): u jednoduchých povelů, kde víme, co má
            # být po akci vidět ve stavu, jede tok „průběhová fráze HNED +
            # akce souběžně → ověření → tón". Cokoli jiného (a všechno, co
            # projde bezpečnostní brzdou výš) jde beze změny starou cestou.
            plan = None
            if getattr(self, "fastlane_enabled", False):
                try:
                    plan = fastlane_classify(function_name, getattr(params, "arguments", None))
                except Exception as e:  # pragma: no cover
                    logger.warning(f"⚠️ fast-lane klasifikace selhala: {e!r}")

            # Hlídač „myslím" musí koukat na nástroje TOHOTO satelitu. Kdyby se
            # sdílel (modulový TURN_LIVENESS), web search u televize by držel
            # hlídače i satelitu v domě a jeho mrtvá otočka by se neodblokovala.
            # `turn_liveness` na službu věší main.py při stavbě relace satelitu;
            # bez něj (starý/testovací kód) se spadne na modulový.
            liveness = getattr(self, "turn_liveness", None) or TURN_LIVENESS
            liveness.tool_started()
            try:
                if plan is not None:
                    return await self._run_fast_lane(plan, function_name, handler, params)
                return await handler(params)
            finally:
                liveness.tool_finished()

        super().register_function(
            function_name, liveness_tracked, start_callback, cancel_on_interruption=False
        )

    # -----------------------------------------------------------------------
    # Rychlá dráha: přednahraná pusa místo modelu
    # -----------------------------------------------------------------------

    async def play_phrase(self, zamer: str) -> bool:
        """Pustí přednahranou frázi/tón rovnou do pipeline — bez modelu.

        Audio jde jako `TTSAudioRawFrame` po 20 ms kusech, tedy přesně tak,
        jak do pipeline padá řeč z modelu. Pro zařízení je to k nerozeznání
        od normální odpovědi, jen nestála nic a nečekalo se na model.

        Knihovna frází je v 24 kHz (`voice_fastlane.SAMPLE_RATE`), což je
        zároveň výstupní rychlost OBOU pus (OpenAI Realtime i Gemini Live
        vrací 24 kHz PCM), takže mixin nemusí nic převzorkovávat.
        """
        lib = getattr(self, "phrase_library", None)
        if lib is None:
            return False
        pcm = lib.get(zamer)
        if not pcm:
            logger.info("🔇 fráze %r není v knihovně — nechávám mluvit model", zamer)
            return False
        # Vlastní hlas rychlé dráhy nesmí spadnout do filtru, který u Gemini
        # pusy zahazuje řeč modelu během umlčení (`fastlane_muted`).
        self._fastlane_playing = True
        try:
            await self.push_frame(TTSStartedFrame())
            for i in range(0, len(pcm), FASTLANE_CHUNK_BYTES):
                await self.push_frame(
                    TTSAudioRawFrame(
                        audio=pcm[i:i + FASTLANE_CHUNK_BYTES],
                        sample_rate=FASTLANE_SAMPLE_RATE,
                        num_channels=1,
                    )
                )
            await self.push_frame(TTSStoppedFrame())
            logger.info("🔊 přehráno z knihovny: %s (%d B)", zamer, len(pcm))
            return True
        except Exception as e:  # pragma: no cover - přehrání nesmí shodit tool
            logger.warning("⚠️ přehrání fráze %s selhalo: %r", zamer, e)
            return False
        finally:
            self._fastlane_playing = False

    async def _verify_after_action(self, pre, plan) -> str:
        """Přečte stav PO akci a vrátí verdikt: ok / fail / unconfirmed / ha_down.

        Čte se opakovaně (HA stav se propíše se zpožděním), ale krátce —
        maximálně ~1,4 s. `unavailable`/`unknown` se nikdy nepovažuje za úspěch.
        """
        verdict = "unconfirmed"
        for attempt in range(VERIFY_TRIES):
            try:
                post = await asyncio.to_thread(fetch_states, plan.domains)
            except Exception as e:
                logger.warning("⚠️ fast-lane: HA stav nejde přečíst: %r", e)
                return "ha_down"
            verdict = fastlane_judge(pre, post, plan)
            if verdict == "ok":
                return "ok"
            if attempt < VERIFY_TRIES - 1:
                await asyncio.sleep(VERIFY_DELAY_S)
        return verdict

    def _mirror_to_zan(self, plan, function_name, args, verdict, note="") -> None:
        """Pošle událost do Žán-Code (`POST /event`) — asynchronně, hlas nečeká.

        Mozek má vědět, co se v domě dělo, i když to sám neprováděl: rychlá
        dráha jinak zůstane pro Žán-Code neviditelná.
        """
        url = getattr(self, "zan_event_url", "")
        if not url:
            return
        payload = build_event(plan, function_name, args, verdict, note)
        token = getattr(self, "zan_event_token", "")

        async def _send():
            try:
                await asyncio.to_thread(_post_event_blocking, url, token, payload)
                logger.debug("↪️ zrcadleno do Žán-Code: %s/%s", payload["action"], verdict)
            except Exception as e:
                logger.info("ℹ️ zrcadlení do Žán-Code neprošlo (hlas to neřeší): %r", e)

        try:
            asyncio.create_task(_send())
        except Exception as e:  # pragma: no cover
            logger.debug("zrcadlení se nepodařilo naplánovat: %r", e)

    async def _run_fast_lane(self, plan, function_name, handler, params):
        """Průběh HNED + akce souběžně → ověření → tón / retry / poctivé selhání."""
        lib = getattr(self, "phrase_library", None)
        args = dict(getattr(params, "arguments", None) or {})
        real_cb = params.result_callback
        captured = []

        async def capture(result, *, properties=None):
            captured.append(result)

        # Stav PŘED akcí — jen jako referenční snímek na porovnání.
        try:
            pre = await asyncio.to_thread(fetch_states, plan.domains)
        except Exception as e:
            logger.warning("⚠️ fast-lane: stav PŘED se nepodařilo přečíst: %r", e)
            pre = {}

        # SOUČASNĚ: pusť průběhovou frázi a odpal HA akci. Žádné čekání jednoho
        # na druhé — uživatel má slyšet „Rozsvěcuju." v tomtéž okamžiku, kdy
        # povel odchází do Home Assistanta.
        params.result_callback = capture
        zamer = room_variant(lib, plan) if lib else plan.progress
        started = time.time()
        speak_task = asyncio.create_task(self.play_phrase(zamer))
        action_task = asyncio.create_task(handler(params))
        spoke, action_res = await asyncio.gather(
            speak_task, action_task, return_exceptions=True
        )
        spoke = spoke is True
        if spoke:
            # Od téhle chvíle platí: mluvila rychlá dráha → model mlčí.
            # Zapíná se HNED po frázi (ne až u výsledku), protože odpověď
            # modelu umí spustit i konec uživatelova tahu, který přijde dřív,
            # než doběhne ověřování stavu v HA.
            self.fastlane_mute_model(f"{function_name}/{zamer}")
        if isinstance(action_res, Exception):
            logger.warning("⚠️ fast-lane: HA akce selhala: %r", action_res)
        logger.info(
            "⚡ fast-lane %s: fráze %s (%s), akce hotová za %.0f ms",
            function_name, zamer, "přehrána" if spoke else "chybí v knihovně",
            (time.time() - started) * 1000,
        )

        verdict = await self._verify_after_action(pre, plan)

        # Neúspěch → JEDEN pokus znovu (ústava, Princip 2 bod 4).
        if verdict == "fail":
            logger.info("🔁 fast-lane: %s neprošlo, zkouším jednou znovu", function_name)
            await self.play_phrase("vysledek_fail")
            try:
                await handler(params)
            except Exception as e:
                logger.warning("⚠️ fast-lane: druhý pokus selhal: %r", e)
            verdict = await self._verify_after_action(pre, plan)

        self._mirror_to_zan(plan, function_name, args, verdict)

        # Knihovna nemá čím mluvit → ať mluví model, ale jen ověřenou pravdu.
        if not spoke:
            params.result_callback = real_cb
            await real_cb(self._verdict_text(verdict, plan, captured))
            return

        if verdict == "ok":
            await self.play_phrase("vysledek_ok")   # krátký tón „tadá"
            await real_cb(
                {"status": "verified_success", "spoken_locally": "tón + průběhová fráze"},
                properties=FunctionCallResultProperties(run_llm=False),
            )
            return

        if verdict == "unconfirmed":
            # Poctivě: povel odešel, ale nemáme důkaz. Nikdy ne tón úspěchu.
            await self.play_phrase("nepotvrdilo_stav")
            await real_cb(
                {"status": "unconfirmed", "spoken_locally": "povel odešel, stav nepotvrzen"},
                properties=FunctionCallResultProperties(run_llm=False),
            )
            return

        if verdict == "ha_down":
            await self.play_phrase("ha_neodpovida")
            await real_cb(
                {"status": "ha_unreachable", "spoken_locally": "Home Assistant neodpovídá"},
                properties=FunctionCallResultProperties(run_llm=False),
            )
            return

        # Selhalo i podruhé → poctivá věta + diagnostiku převezme Žán-Code.
        # Tady model mluvit MUSÍ (má zavolat ask_zan), takže umlčení zrušíme.
        await self.play_phrase("nepovedlo_se")
        self.fastlane_unmute("selhání — model má převzít a zavolat ask_zan")
        cil = plan.target or plan.area or "to"
        await real_cb(
            "Akce se nepovedla ani na druhý pokus a ověřený stav to potvrzuje. "
            f"Uživatel UŽ SLYŠEL „Nepovedlo se mi to, zjišťuju proč.\" — nic o "
            "výsledku už neopakuj a hlavně netvrď, že se to povedlo. Rovnou "
            f"zavolej ask_zan s textem „proč nejde {cil}\" a nech Žán-Code najít příčinu."
        )

    @staticmethod
    def _verdict_text(verdict: str, plan, captured) -> str:
        """Text pro model, když knihovna frází chybí — pořád jen ověřená pravda."""
        cil = plan.target or plan.area or "to"
        if verdict == "ok":
            return f"Ověřeno: {plan.label} — {cil} je v požadovaném stavu. Řekni jednu krátkou větu."
        if verdict == "unconfirmed":
            return ("Povel odešel, ale zařízení stav nepotvrdilo. Řekni přesně tohle, "
                    "netvrď úspěch.")
        if verdict == "ha_down":
            return "Home Assistant neodpovídá. Řekni to na rovinu, nic neslibuj."
        return (f"Nepovedlo se to ani napodruhé ({cil}). Řekni „Nepovedlo se mi to, "
                f"zjišťuju proč.\" a zavolej ask_zan s textem „proč nejde {cil}\".")
