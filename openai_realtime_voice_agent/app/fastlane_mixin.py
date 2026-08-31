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
import json
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
    oprav_area,
    _norm,
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

#: Okno, ve kterém se STEJNÉ volání STEJNÉHO nástroje bere jako duplicita.
#:
#: PROČ (31. 8. 2026, 09:42, Ondrův první povel na gemini puse): „Vypni
#: televizi." se provedlo DVAKRÁT — `HassTurnOff:fc_6104322742753481559`
#: v 09:42:30.640 a `HassTurnOff:fc_2373295578869622761` v 09:42:32.045.
#: Ondra slyšel čtyři fráze místo dvou a po deseti vteřinách to umlčel
#: tlačítkem. Mezi voláními je v logu vidět příčina:
#: `gemini_live.llm:_create_initial_response:1369` — pipecat po výsledku
#: nástroje nasype modelu celý kontext zpátky a model volání zopakuje.
#: `run_llm=False` na to nedosáhne (u Gemini vyrábí odpověď server).
#:
#: Stráž je proto na VRSTVĚ VÝKONU nástroje, ne u konkrétní pusy: sedí ve
#: `register_function`, kterým procházejí všechny nástroje obou pus, takže
#: chrání i OpenAI (tam se dvojité volání zatím neukázalo, ale příčina —
#: model, co po výsledku vidí kontext znovu — je společná).
#:
#: 8 s = pokrývá pozorovaný odstup 1,4 s s velkou rezervou a přitom je pod
#: dobou, za kterou člověk vysloví druhý, MYŠLENÝ povel.
TOOL_DEDUP_S = 8.0

#: Jak dlouho se drží NEÚSPĚŠNÝ výsledek. Jen tak dlouho, aby spolkl okamžité
#: echo modelu (pozorováno 1,3-1,6 s) — ne aby zablokoval člověka, který povel
#: zopakuje právě proto, že poprvé nezabral.
DEDUP_MILOST_S = 2.5

#: Nástroje, u kterých je OPAKOVÁNÍ ZÁMĚR, ne porucha — ty se nikdy
#: nededuplikují:
#:
#: * čtení stavu a informací (`GetLiveContext`, `GetDateTime`,
#:   `todo_get_items`, `web_search`) — dvakrát přečíst nic nerozbije a
#:   zadržet druhé čtení by mohlo vrátit zastaralou pravdu o domě,
#: * RELATIVNÍ a krokové úkony (`HassSetVolumeRelative`, `HassMediaNext`,
#:   `HassMediaPrevious`) — „ztlum, ztlum" nebo „přeskoč, přeskoč" se má
#:   sečíst; deduplikovat je by znamenalo ignorovat druhé přání.
#:
#: Všechno ostatní je zásah do domu s absolutním cílem (rozsviť, zhasni,
#: zamkni seznam, pusť zálivku) — tam je druhé provedení do osmi vteřin
#: vždycky chyba, ne přání.
TOOL_DEDUP_VYJIMKY = frozenset({
    "GetLiveContext",
    "GetDateTime",
    "todo_get_items",
    "web_search",
    "HassSetVolumeRelative",
    "HassMediaNext",
    "HassMediaPrevious",
})


#: Co SMÍ rychlá dráha pustit z knihovny. Nic jiného — žádná přednahraná
#: řeč (viz `play_phrase`). Jsou to čtyři bezhlasé signály:
#:
#: * ``zvuk_zapnuti`` / ``zvuk_vypnuti`` — ~2 s, stoupavý „něco se zapíná"
#:   a klesavý „něco se vypíná" (Ondra 31. 8.: „na spouštění věcí tam dáme
#:   zvuk (nějaký uplifting 2s jak se něco zapíná) a vypínání zase jak se
#:   něco vypíná 2s"),
#: * ``vysledek_ok`` / ``vysledek_fail`` — krátké tóny po ověření stavu.
#:
#: Akce sama je potvrzení; slova k ní netřeba. Řeč zůstává modelu.
RYCHLA_DRAHA_ZVUKY = frozenset({
    "zvuk_zapnuti", "zvuk_vypnuti", "vysledek_ok", "vysledek_fail",
})

#: Okno, ve kterém se PROTICHŮDNÉ povely na tentýž cíl berou jako porucha.
#:
#: PROČ (31. 8. 2026, 10:15, dvakrát po sobě): Gemini rozseká jednu Ondrovu
#: promluvu na dva fragmenty, z nichž jeden je halucinace — do přepisu spadlo
#: i wake word:
#:
#:   🗣️ user: rozsvítit světla v obývákuA já, ne?
#:   🗣️ user: Vypni světlo v obýváku.
#:   ... a o milisekundu později:
#:   Calling function [HassTurnOn:fc_17354372043808562740]
#:   Calling function [HassTurnOff:fc_17354372043808559819]
#:
#: Model tedy vystřelí ZAPNI i VYPNI naráz. Dedup je nechytí — jsou to různé
#: nástroje s různými argumenty, takže do něj z definice nespadají. Výsledkem
#: byly dva dvousekundové zvuky PŘES SEBE a světlo, které blikne.
#:
#: Nikdo nikdy nemyslí „zapni a vypni to samé". Je to vždycky porucha vstupu,
#: takže druhý z protichůdné dvojice se NEPROVEDE a model se má doptat.
PROTISMER_S = 2.0

#: Průběhový záměr → zvuk, který ho zastoupí. Hlasitost a ztlumení tady
#: schválně NEJSOU: „ztlum" není zapnutí ani vypnutí, tam mluví model.
ZVUK_MISTO_RECI = {
    "rozsvecuju": "zvuk_zapnuti",
    "zapinam": "zvuk_zapnuti",
    "poustim_hudbu": "zvuk_zapnuti",
    "zhasinam": "zvuk_vypnuti",
    "vypinam": "zvuk_vypnuti",
    "zastavuju_hudbu": "zvuk_vypnuti",
}


def _dedup_klic(function_name: str, arguments) -> str:
    """Otisk volání: jméno nástroje + argumenty nezávisle na pořadí klíčů."""
    try:
        args = json.dumps(arguments or {}, sort_keys=True, ensure_ascii=False,
                          default=str)
    except Exception:  # pragma: no cover - otisk nesmí shodit tool
        args = repr(arguments)
    return f"{function_name}|{args}"


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

    # -----------------------------------------------------------------------
    # Dedup stráž: tentýž zásah do domu se do 8 s neprovede podruhé
    # -----------------------------------------------------------------------

    def _dedup_zaznamy(self) -> dict:
        """Evidence běžících/nedávných volání. Per relace (per satelit)."""
        zaznamy = getattr(self, "_tool_dedup", None)
        if zaznamy is None:
            zaznamy = {}
            self._tool_dedup = zaznamy
        return zaznamy

    def _dedup_uklid(self, ted: float) -> None:
        """Vyhodí, co je starší než okno — evidence nesmí růst donekonečna."""
        zaznamy = self._dedup_zaznamy()
        for klic in [k for k, z in zaznamy.items()
                     if ted - z["t"] > z.get("okno", TOOL_DEDUP_S)]:
            zaznamy.pop(klic, None)

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

            # OPRAVA OBLASTI (2026-08-31): model umí poslat `living_room`
            # místo „Obývák" a HA to odmítne jako INVALID_AREA — navenek to
            # vypadá, že Žán nechce poslechnout. Opraví se JEN když v domě
            # existuje právě jeden odpovídající pokoj (viz `oprav_area`).
            try:
                _args = getattr(params, "arguments", None)
                if isinstance(_args, dict) and _args.get("area"):
                    _opravena = oprav_area(_args["area"])
                    if _opravena:
                        logger.warning(
                            "🗺️ oblast %r neexistuje — opravuju na %r (%s)",
                            _args["area"], _opravena, function_name)
                        _args["area"] = _opravena
            except Exception as e:  # pragma: no cover - oprava nesmí shodit tool
                logger.warning("⚠️ oprava oblasti selhala, jedu dál: %r", e)

            # DEDUP STRÁŽ (2026-08-31): tentýž zásah do domu se do
            # `TOOL_DEDUP_S` neprovede podruhé. Model po výsledku nástroje
            # dostane kontext znovu a volání zopakuje (u Gemini prokazatelně,
            # viz `TOOL_DEDUP_S`) — dům by pak úkon udělal dvakrát a rychlá
            # dráha by přehrála dvě sady frází. Druhé volání dostane
            # VÝSLEDEK PRVNÍHO, ať model nezůstane bez ack a nezacyklí se.
            dedup_klic = None
            if function_name not in TOOL_DEDUP_VYJIMKY:
                ted = time.monotonic()
                self._dedup_uklid(ted)
                zaznamy = self._dedup_zaznamy()
                dedup_klic = _dedup_klic(function_name, getattr(params, "arguments", None))
                drivejsi = zaznamy.get(dedup_klic)
                if drivejsi is not None:
                    logger.warning(
                        "⚠️ dedup: %s se stejnými argumenty už běží/proběhl před "
                        "%.1f s — DRUHÉ VOLÁNÍ NEPROVÁDÍM (první: %s, druhé: %s)",
                        function_name, ted - drivejsi["t"],
                        drivejsi.get("tool_call_id", "?"),
                        getattr(params, "tool_call_id", "?"),
                    )
                    # Počkej na výsledek prvního, ať vracíme pravdu, ne dohad.
                    if not drivejsi["hotovo"].is_set():
                        try:
                            await asyncio.wait_for(
                                drivejsi["hotovo"].wait(), timeout=TOOL_DEDUP_S
                            )
                        except asyncio.TimeoutError:
                            logger.warning(
                                "⚠️ dedup: první volání %s se do %.0f s neozvalo — "
                                "vracím neutrální potvrzení", function_name, TOOL_DEDUP_S,
                            )
                    if drivejsi["hotovo"].is_set():
                        await params.result_callback(
                            drivejsi["vysledek"], properties=drivejsi["properties"]
                        )
                    else:
                        await params.result_callback(
                            {"status": "duplicate_ignored",
                             "note": "Tentýž povel už probíhá. Nic neopakuj a mlč."},
                            properties=FunctionCallResultProperties(run_llm=False),
                        )
                    return

                # Zapiš se JAKO BĚŽÍCÍ dřív, než cokoli awaitneme — jinak by
                # dvě souběžná volání proklouzla obě.
                zaznam = {
                    "t": ted,
                    "tool_call_id": getattr(params, "tool_call_id", "?"),
                    "hotovo": asyncio.Event(),
                    "vysledek": None,
                    "properties": None,
                    # Dokud běží, drží plné okno — souběžná duplicita se nesmí
                    # provést. Po dokončení se okno podle výsledku upraví níž.
                    "okno": TOOL_DEDUP_S,
                }
                zaznamy[dedup_klic] = zaznam

                # Výsledek si po cestě odchytneme, ať ho má čím dostat případná
                # duplicita. Musí obalit callback DŘÍV, než ho převezme
                # `_run_fast_lane` (ten si ho schovává jako `real_cb`).
                puvodni_cb = params.result_callback

                async def zapamatuj_a_posli(result, *, properties=None):
                    zaznam["vysledek"] = result
                    zaznam["properties"] = properties
                    # NEÚSPĚCH SE NECACHUJE NADLOUHO. Kdyby ano, člověk by
                    # řekl povel znovu (protože nezabral) a stráž by mu vrátila
                    # ten STARÝ neúspěch, aniž by to kdokoli zkusil — z pojistky
                    # proti dvojímu provedení by byla pojistka proti opravě.
                    # Plné okno drží jen OVĚŘENÝ ÚSPĚCH; po neúspěchu zůstává
                    # jen krátká milost, která spolkne echo modelu (~1,4 s),
                    # ale lidské zopakování povelu pustí dál.
                    uspech = (isinstance(result, dict)
                              and result.get("status") == "verified_success")
                    zaznam["okno"] = TOOL_DEDUP_S if uspech else DEDUP_MILOST_S
                    zaznam["hotovo"].set()
                    return await puvodni_cb(result, properties=properties)

                params.result_callback = zapamatuj_a_posli

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
            # PROTICHŮDNÉ POVELY V JEDNOM TAHU (viz `PROTISMER_S`): zapni
            # i vypni totéž naráz nikdy není přání, vždycky porucha vstupu.
            # Druhý z dvojice se NEPROVEDE a model se má doptat.
            if plan is not None:
                smer = ZVUK_MISTO_RECI.get(plan.progress)
                if smer:
                    cil = _norm(plan.target or plan.area or "?")
                    ted2 = time.monotonic()
                    protismery = getattr(self, "_protismer", None)
                    if protismery is None:
                        protismery = {}
                        self._protismer = protismery
                    posl = protismery.get(cil)
                    if (posl and posl["smer"] != smer
                            and ted2 - posl["t"] < PROTISMER_S):
                        logger.warning(
                            "🚫 protichůdný povel na %r: %s vs %s do %.1f s — "
                            "NEPROVÁDÍM, model se má doptat",
                            cil, posl["smer"], smer, ted2 - posl["t"])
                        self.fastlane_unmute("protichůdné povely — model se ptá")
                        await params.result_callback(
                            "V jednom tahu dorazily protichůdné povely (zapnout "
                            f"i vypnout {plan.target or plan.area or 'totéž'}). "
                            "Neprovedl jsem ten druhý. Zeptej se uživatele "
                            "jednou krátkou větou, co má platit.")
                        return
                    protismery[cil] = {"t": ted2, "smer": smer}

            liveness = getattr(self, "turn_liveness", None) or TURN_LIVENESS
            liveness.tool_started()
            try:
                if plan is not None:
                    return await self._run_fast_lane(plan, function_name, handler, params)
                return await handler(params)
            finally:
                liveness.tool_finished()
                # Kdyby nástroj spadl nebo callback nikdy nezavolal, ať
                # případná duplicita nečeká celé okno nadarmo.
                if dedup_klic is not None:
                    zaznam = self._dedup_zaznamy().get(dedup_klic)
                    if zaznam is not None and not zaznam["hotovo"].is_set():
                        zaznam["hotovo"].set()

        super().register_function(
            function_name, liveness_tracked, start_callback, cancel_on_interruption=False
        )

    # -----------------------------------------------------------------------
    # Rychlá dráha: přednahraná pusa místo modelu
    # -----------------------------------------------------------------------

    async def play_phrase(self, zamer: str, *, force: bool = False) -> bool:
        """Pustí přednahranou frázi/tón rovnou do pipeline — bez modelu.

        ``force=True`` obejde vypnutou knihovnu (``fastlane_phrases_enabled``).
        Používá to JEDINÁ věc: oznámení o pádu pusy v ``gemini_safety`` — to
        musí zaznít i tehdy, když model mluvit nemůže, protože je po session.

        Audio jde jako `TTSAudioRawFrame` po 20 ms kusech, tedy přesně tak,
        jak do pipeline padá řeč z modelu. Pro zařízení je to k nerozeznání
        od normální odpovědi, jen nestála nic a nečekalo se na model.

        Knihovna frází je v 24 kHz (`voice_fastlane.SAMPLE_RATE`), což je
        zároveň výstupní rychlost OBOU pus (OpenAI Realtime i Gemini Live
        vrací 24 kHz PCM), takže mixin nemusí nic převzorkovávat.
        """
        # JEN ZVUKY, ŽÁDNÁ PŘEDNAHRANÁ ŘEČ (Ondra, 31. 8. 2026). Knihovna je
        # namluvená jedním hlasem (`ash`), ale pusa mluví jiným — v jedné
        # výměně pak promluvili dva různí lidé: „pořád dva hlasy. Je to hnus."
        # Rozhodnutí: „nic negeneruj, říkal jsem že bude nějaký zvuk."
        # Rychlá dráha proto smí pustit POUZE bezhlasé signály
        # (`RYCHLA_DRAHA_ZVUKY`); mluvená fráze se nepřehraje nikdy. Když je
        # opravdu potřeba něco ŘÍCT, řekne to model — jedním hlasem.
        if not force and zamer not in RYCHLA_DRAHA_ZVUKY:
            logger.debug("🔇 rychlá dráha nemluví — %r nechávám modelu", zamer)
            return False
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
        # Zapnutí/vypnutí ohlásí ZVUK, ne věta — a je jedno, které místnosti
        # se to týká, takže se per-místnostní varianty vůbec neřeší.
        zamer = ZVUK_MISTO_RECI.get(plan.progress) or plan.progress
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

        # ÚSPĚCH = ZVUK A TÓN, ŽÁDNÁ SLOVA (Ondra, 31. 8.): „akce sama je
        # potvrzení". Zvuk zapnutí/vypnutí už zazněl, teď jen tón — a model
        # k tomu mlčí.
        if verdict == "ok" and spoke:
            await self.play_phrase("vysledek_ok")
            await real_cb(
                {"status": "verified_success",
                 "spoken_locally": "zvuk zapnutí/vypnutí + tón úspěchu"},
                properties=FunctionCallResultProperties(run_llm=False),
            )
            return

        # COKOLI JINÉHO NEŽ ÚSPĚCH SE MUSÍ ŘÍCT — a říká to MODEL, jedním
        # hlasem. Rychlá dráha na to nemá (a nesmí mít) přednahranou větu;
        # dřív ji měla a právě tím vznikal druhý hlas ve výměně.
        # `vysledek_fail` je bezhlasý tón, ať je hned slyšet, že něco není
        # v pořádku, ještě než model začne mluvit.
        if verdict != "ok":
            await self.play_phrase("vysledek_fail")
        self.fastlane_unmute("neúspěch nebo bez zvuku — pravdu musí říct model")
        params.result_callback = real_cb
        await real_cb(self._verdict_text(verdict, plan, captured))

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
