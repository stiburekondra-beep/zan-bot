"""Gemini Live pusa Žána — druhá „pusa" vedle OpenAI Realtime.

Přepínač je env ``ZAN_PUSA`` (``openai`` = výchozí a beze změny chování,
``gemini`` = tahle větev). Modul se v ``main.py`` importuje AŽ uvnitř gemini
větve, protože táhne ``pipecat-ai[google]`` a ``google-genai`` — v openai
provozu se tedy nenačte vůbec a nemůže nic rozbít.

Co tenhle soubor přidává nad pipecatí ``GeminiLiveLLMService``:

1. **rychlou dráhu** (``FastLaneMixin``) — tatáž bezpečnostní brzda,
   přednahraná pusa a ověřování stavu v HA jako u OpenAI pusy. Sdílený kód,
   ne kopie: brzda na nevratné úkony se nesmí udržovat dvakrát,
2. **``languageCode`` podle modelu** — Live API ho v ``speechConfig`` posílá
   vždy (pipecat dosadí ``en-US``, když nic nenastavíš). Modely se v tomhle
   chovají PROTICHŮDNĚ: ``2.5`` (native-audio) ho s ``cs-CZ`` odmítá chybou
   1007 „Unsupported language code", zatímco ``3.1`` ho naopak PŘIJÍMÁ (sonda
   30. 8. 2026: ``poc_1`` s ``gemini-3.1-flash-live-preview`` a
   ``languageCode=cs-CZ`` prošel, přepisy i argumenty chodí v diakritice,
   ``{"mistnost": "obývák"}``). Proto se u ``2.5``/``native-audio`` pole
   zahazuje úplně a u ostatních (3.1) se posílá natvrdo ``cs-CZ``,
3. **žádné ``audioStreamEnd``** — pipecat posílá mikrofon výhradně přes
   ``send_realtime_input(audio=…)`` a konec tahu nechává na server VAD. To je
   přesně varianta, která v sondě vyšla nejrychleji (běh D3: toolCall za
   525 ms) a zároveň se vyhýbá jediné variantě, která na 3.1 tah ZAHODÍ bez
   jediné zprávy (běh B1: nárazový upload klipu + okamžitý ``audioStreamEnd``
   → 25 s ticha, ani ``inputTranscription``). Dokumentace k tomu doslova:
   server „treats the audio_stream_end signal as an immediate finalization
   prompt, bypassing the default server-side silence detection delay".
   V provozu jede mikrofon v reálném tempu, takže ta past nehrozí — ale
   kdyby někdo v budoucnu ``audioStreamEnd`` doplňoval, tohle je důvod, proč
   tady není.

Neřeší se tu (vědomě, viz zápis k úkolu): dopřednou detekci „uživatel mluví"
pro fáze ``listening``/``thinking`` — Gemini pusa na rozdíl od OpenAI
nevydává ``UserStartedSpeakingFrame``. Fáze ``replying``/``idle`` fungují,
protože je do pipeline vrací výstupní transport (a ty jsou pro LED to hlavní).
"""

from __future__ import annotations

import asyncio
import logging
import os
from typing import Any, Dict, List, Optional

from google.genai.types import EndSensitivity
from pipecat.frames.frames import LLMTextFrame, TTSAudioRawFrame, TTSTextFrame
from pipecat.processors.frame_processor import FrameDirection
from pipecat.adapters.schemas.function_schema import FunctionSchema
from pipecat.adapters.schemas.tools_schema import ToolsSchema
from pipecat.services.google.gemini_live.llm import (
    GeminiLiveLLMService,
    GeminiModalities,
    GeminiVADParams,
    InputParams,
)

from app.fastlane_mixin import FastLaneMixin
from app.pusa_fallback import fallback_path, write_fallback
from app.gemini_tools import (
    DEFAULT_GEMINI_MODEL,
    DEFAULT_GEMINI_VOICE,
    normalize_model_name,
    to_gemini_function_declarations,
    vad_plan,
)

logger = logging.getLogger(__name__)

#: Podřetězce ve jméně modelu, které signalizují „``languageCode`` odmítá".
#: Sonda 30. 8. 2026: ``gemini-2.5-flash-native-audio-preview…`` vrátí na
#: ``cs-CZ`` chybu 1007 „Unsupported language code"; ``gemini-3.1-flash-
#: live-preview`` ho naopak přijme. Jméno modelu jde přes ``normalize_model_name``
#: (prefix ``models/``), substring test to nerozhodí.
_LANGUAGE_UNSUPPORTED_MARKERS = ("2.5", "native-audio")

#: Kolik sekund necháme doznít oznámení, než proces ukončíme. Krátké schválně:
#: cílem je RYCHLÉ čisté selhání, ne elegantní odchod.
_EXIT_DELAY_S = 2.0

#: Návratový kód "dočasné selhání" (EX_TEMPFAIL) — v ``docker inspect`` je pak
#: vidět, že most odešel vlastní brzdou, ne že ho někdo zabil.
_EXIT_CODE = 75


def _tvrdy_konec() -> None:
    """Doopravdy ukončí proces. ``sys.exit`` uvnitř tasku by zabil jen task."""
    logging.shutdown()
    os._exit(_EXIT_CODE)


class SafeGeminiLiveLLMService(FastLaneMixin, GeminiLiveLLMService):
    """Gemini Live se Žánovou rychlou dráhou a ``languageCode`` podle modelu.

    ``FastLaneMixin`` musí být v MRO PRVNÍ — jeho ``register_function``
    přebíjí ten z pipecatu a ``super()`` uvnitř pak míří na
    ``GeminiLiveLLMService``.
    """

    def __init__(self, *, drop_language_code: bool = True, **kwargs):
        """Args:
            drop_language_code: Zapíná chytrou volbu ``languageCode`` podle
                modelu (výchozí). Live API posílá pole v ``speechConfig``
                vždy (pipecat dosadí ``en-US``, když ``params.language``
                nenastavíš) — a modely se k němu chovají protichůdně:
                ``2.5``/``native-audio`` ho s ``cs-CZ`` ODMÍTAJÍ (chyba 1007),
                ``3.1`` ho naopak BEROU. Pro model s markerem z
                ``_LANGUAGE_UNSUPPORTED_MARKERS`` se pole vynuluje
                (``_settings["language"] = None`` → pydantic ``SpeechConfig``
                ho při serializaci vypustí úplně), pro ostatní se nastaví
                natvrdo na ``"cs-CZ"``. ``False`` tuhle logiku úplně vypne
                a nechá pipecatí výchozí chování (``en-US``).
            **kwargs: Předává se beze změny do ``GeminiLiveLLMService``.
        """
        super().__init__(**kwargs)
        # Brzda terminálního pádu smí proběhnout jen jednou za život služby.
        self._pusa_brzda_spustena = False
        if not drop_language_code:
            return
        model_name = str(getattr(self, "_model_name", "") or "")
        if any(marker in model_name for marker in _LANGUAGE_UNSUPPORTED_MARKERS):
            self._settings["language"] = None
            self._language_code = None
            logger.info(
                "🌐 Gemini: languageCode se NEposílá (%s odmítá cs-CZ)", model_name
            )
        else:
            self._settings["language"] = "cs-CZ"
            self._language_code = "cs-CZ"
            logger.info("🌐 Gemini: languageCode=cs-CZ (%s)", model_name)

    async def push_frame(self, frame, direction=FrameDirection.DOWNSTREAM):  # type: ignore[override]
        """Když frázi řekla rychlá dráha, řeč modelu se do zařízení nepustí.

        U OpenAI pusy se dvojhlas dá zastavit u zdroje (nepošle se
        ``response.create`` — viz ``SafeRealtimeLLMService._create_response``).
        Gemini Live tuhle páku NEMÁ: ``send_tool_response()`` rozmluví model
        přímo na serveru a klient odpověď dostane, ať chce nebo ne. Jediné
        místo, kde se dá pravidlo „mluvila rychlá dráha → model už výsledek
        nekomentuje" vynutit, je tedy cesta rámců ven.

        Zahazuje se jen OBSAH řeči (audio + text). Řídicí rámce (start/stop,
        fáze, metriky) jdou dál, aby transport ani LED prstenec neuvázly
        v „replying".
        """
        try:
            if (
                self.fastlane_muted()
                and not getattr(self, "_fastlane_playing", False)
                and isinstance(frame, (TTSAudioRawFrame, TTSTextFrame, LLMTextFrame))
            ):
                logger.debug("🔇 fast-lane (gemini): zahozen %s", type(frame).__name__)
                return
        except Exception as e:  # pragma: no cover - filtr nesmí shodit pipeline
            logger.warning("⚠️ fast-lane filtr (gemini) selhal, propouštím: %r", e)
        return await super().push_frame(frame, direction)

    async def _handle_connection_error(self, error: Exception) -> bool:  # type: ignore[override]
        """Terminální pád gemini pusy nesmí skončit smyčkou ``ErrorFrame``.

        CO SE DĚJE BEZ TÉHLE BRZDY (incident 30. 8. 2026, 18:34 — Ondra stál
        u němé krabičky): pipecat po třetím selhání v řadě
        (``MAX_CONSECUTIVE_FAILURES``) vrátí z ``_handle_connection_error``
        ``False``, čímž ``_connection_task_handler`` skončí ``break``. Tou
        cestou se ale NIKDY nezavolá ``_disconnect()``, takže ``self._session``
        zůstane viset jako ZAVŘENÝ, ale pravdivý objekt. Guardy
        ``not self._session`` v ``_send_user_audio`` i ``_handle_send_error``
        ho propustí, takže každý dvacetimilisekundový kus mikrofonu vyrobí
        další ``push_error`` — tisíce ``ErrorFrame`` za minutu a most, který
        už nikdy nepromluví.

        CO DĚLÁME MÍSTO TOHO: (1) vynulujeme session, čímž se ty dva pipecatí
        guardy začnou chytat a spam ustane u zdroje, (2) jednou poctivě
        zalogujeme příčinu, (3) řekneme to člověku u krabičky, (4) necháme po
        sobě značku a rychle a čistě spadneme — ``restart: unless-stopped``
        most do ~15 s zvedne a ``_resolve_pusa()`` ho podle značky pustí na
        openai pusu.

        PROČ NE VÝMĚNA SLUŽBY ZA BĚHU: pipeline se v pipecatu 0.0.97 staví
        jednou a instance služby je zadrátovaná v řetězu procesorů. Výměna za
        provozu je řádově složitější než restart a most tu nemá co držet —
        session je stejně po smrti. Jednoduchost je tady ta bezpečnější volba.
        """
        should_reconnect = await super()._handle_connection_error(error)
        if should_reconnect:
            return True
        if self._pusa_brzda_spustena:
            return False
        self._pusa_brzda_spustena = True
        try:
            await self._predej_pusu_openai(error)
        except Exception as e:  # pragma: no cover - brzda nesmí sama spadnout
            logger.exception("💥 brzda gemini pusy sama selhala: %r", e)
        return False

    async def _predej_pusu_openai(self, error: Exception) -> None:
        """Zastaví sesypání, oznámí to a předá pusu zpět OpenAI přes restart."""
        # 1) ZASTAVIT SPAM HNED — musí být první, ještě než cokoli awaitneme.
        self._session = None
        self._disconnecting = True
        logger.error(
            "💀 Gemini pusa terminálně selhala (%s selhání v řadě, poslední: %s: %s). "
            "Session vynulována, sesypání do ErrorFrame zastaveno.",
            getattr(self, "_consecutive_failures", "?"),
            type(error).__name__,
            error,
        )

        # 2) Člověk u krabičky musí vědět, co se stalo. Obojí jde MIMO Gemini:
        #    play_phrase tlačí PCM rovnou do výstupního transportu, takže
        #    funguje i s mrtvou session. Když fráze nahraná není, jen se to
        #    zaloguje — nic se nepředstírá.
        try:
            await self.play_phrase("zaloha_pusa")
        except Exception as e:
            logger.warning("⚠️ oznámení o přepnutí pusy se nepovedlo: %r", e)
        try:
            broadcast = getattr(self, "zan_broadcast_json", None)
            if broadcast is not None:
                # LED nesmí zůstat viset v "thinking" nad mrtvou session.
                await broadcast({"type": "phase", "value": "idle"})
        except Exception as e:
            logger.warning("⚠️ fáze 'idle' po pádu pusy neodešla: %r", e)

        # 3) Značka MUSÍ být ověřeně na disku, teprve pak smíme spadnout. Pád
        #    bez značky = restart zpátky do gemini = restart-smyčka, což je
        #    horší než němý most. Proto fail-closed směrem k "nepadat".
        if not write_fallback("%s: %s" % (type(error).__name__, error)):
            logger.error(
                "🛑 POPLACH: značku pádu (%s) NEJDE zapsat — proto NEPADÁM, "
                "restart by naběhl zpátky do gemini a zacyklil se. Most zůstává "
                "stát potichu (bez ErrorFrame) a čeká na ruku: ZAN_PUSA=openai "
                "v /etc/zan/realtime.env + recreate.",
                fallback_path(),
            )
            return

        logger.error(
            "🛟 Značka zapsána (%s) — za %.1f s ukončuji proces (exit %d). "
            "Docker mě zvedne a most naběhne na openai pusu.",
            fallback_path(), _EXIT_DELAY_S, _EXIT_CODE,
        )
        asyncio.get_running_loop().call_later(_EXIT_DELAY_S, _tvrdy_konec)

    async def _handle_msg_usage_metadata(self, message):  # type: ignore[override]
        """Nechá pipecat spočítat metriky a k tomu jeden řádek do logu.

        Nezrcadlí se do zařízení jako u OpenAI pusy: 40k/min okno je limit
        OpenAI účtu, u Gemini pro něj nemáme ověřený protějšek. Až bude
        z A/B jasné, co se má na displeji ukazovat, doplní se to sem.
        """
        await super()._handle_msg_usage_metadata(message)
        try:
            usage = getattr(message, "usage_metadata", None)
            if usage is None:
                return
            logger.info(
                "Žán usage (gemini): total=%s prompt=%s response=%s",
                getattr(usage, "total_token_count", None),
                getattr(usage, "prompt_token_count", None),
                getattr(usage, "response_token_count", None),
            )
        except Exception as e:  # pragma: no cover - log nesmí shodit relaci
            logger.debug("usage log (gemini) selhal: %r", e)


def build_gemini_tools_schema(openai_tools: Optional[List[Dict[str, Any]]]) -> Optional[ToolsSchema]:
    """Nástroje v OpenAI tvaru → pipecatí ``ToolsSchema`` pro Gemini adaptér.

    Vlastní převod (co se škrtá, jak se filtruje ``required``) dělá čistý
    ``app/gemini_tools.py``; tady se výsledek jen zabalí do ``FunctionSchema``,
    aby ho ``GeminiLLMAdapter.to_provider_tools_format`` uměl vysypat jako
    ``functionDeclarations``.
    """
    declarations = to_gemini_function_declarations(openai_tools)
    if not declarations:
        return None
    schemas = [
        FunctionSchema(
            name=declaration["name"],
            description=declaration["description"],
            properties=(declaration.get("parameters") or {}).get("properties", {}),
            required=(declaration.get("parameters") or {}).get("required", []),
        )
        for declaration in declarations
    ]
    return ToolsSchema(standard_tools=schemas)


def build_gemini_vad_params(eagerness: Optional[str],
                            silence_duration_ms: Optional[int] = None,
                            prefix_padding_ms: Optional[int] = None) -> GeminiVADParams:
    """``VAD_EAGERNESS`` → ``GeminiVADParams`` (tichem řízený VAD).

    Gemini Live nemá sémantický VAD; má jen citlivost začátku/konce řeči a
    délku ticha. ``low`` proto mapujeme na ``END_SENSITIVITY_LOW`` + delší
    ticho — tedy „raději počkej, než mě useknout uprostřed věty", což je to,
    co ``eagerness=low`` znamená na OpenAI straně.
    """
    plan = vad_plan(eagerness, silence_duration_ms, prefix_padding_ms)
    end_name = plan.get("end_sensitivity")
    # Jméno konstanty držíme jako text (čistý gemini_tools nemá závislosti),
    # takže sem doputuje řetězec. Kdyby ho google-genai v dané verzi neznal,
    # radši jedeme bez explicitní citlivosti než abychom shodili celou pusu —
    # délka ticha (to hlavní) platí i tak.
    end_sensitivity = None
    if end_name:
        end_sensitivity = getattr(EndSensitivity, str(end_name), None)
        if end_sensitivity is None:
            logger.warning(
                "⚠️ google.genai.types.EndSensitivity nezná %r — jedu bez ní", end_name
            )
            end_name = None
    params = GeminiVADParams(
        end_sensitivity=end_sensitivity,
        silence_duration_ms=plan.get("silence_duration_ms"),
        prefix_padding_ms=plan.get("prefix_padding_ms"),
    )
    logger.info(
        "🎚️ Gemini VAD: eagerness=%s → end_sensitivity=%s, silence=%sms, prefix=%sms",
        eagerness, end_name or "(server default)",
        plan.get("silence_duration_ms"), plan.get("prefix_padding_ms"),
    )
    return params


def build_gemini_service(*,
                         api_key: str,
                         model: str = DEFAULT_GEMINI_MODEL,
                         voice: str = DEFAULT_GEMINI_VOICE,
                         instructions: str = "",
                         openai_tools: Optional[List[Dict[str, Any]]] = None,
                         vad_eagerness: Optional[str] = "low",
                         vad_silence_duration_ms: Optional[int] = None,
                         vad_prefix_padding_ms: Optional[int] = None,
                         max_output_tokens: Optional[int] = None,
                         ) -> SafeGeminiLiveLLMService:
    """Postaví Gemini pusu se stejnými nástroji a promptem jako OpenAI pusa.

    ``inference_on_context_initialization=False`` je záměr, ne detail: bez
    něj pipecat při prvním kontextu nasype systémový prompt do
    ``send_client_content(turn_complete=True)`` a zařízení hned po startu
    samo od sebe promluví. Na OpenAI straně se týž problém řeší předsazením
    prázdného kontextu v ``main.run()``; tady stačí tenhle přepínač.
    """
    tools = build_gemini_tools_schema(openai_tools)
    params = InputParams(
        modalities=GeminiModalities.AUDIO,
        vad=build_gemini_vad_params(
            vad_eagerness, vad_silence_duration_ms, vad_prefix_padding_ms
        ),
    )
    if max_output_tokens:
        params.max_tokens = max_output_tokens

    service = SafeGeminiLiveLLMService(
        api_key=api_key,
        model=normalize_model_name(model),
        voice_id=voice or DEFAULT_GEMINI_VOICE,
        system_instruction=instructions or None,
        tools=tools,
        params=params,
        inference_on_context_initialization=False,
    )
    logger.info(
        "✅ Gemini pusa: model=%s hlas=%s nástrojů=%d",
        normalize_model_name(model), voice or DEFAULT_GEMINI_VOICE,
        len(tools.standard_tools) if tools else 0,
    )
    return service
