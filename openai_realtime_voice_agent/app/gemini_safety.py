"""Gemini Live pusa Žána — druhá „pusa" vedle OpenAI Realtime.

Přepínač je env ``ZAN_PUSA`` (``openai`` = výchozí a beze změny chování,
``gemini`` = tahle větev). Modul se v ``main.py`` importuje AŽ uvnitř gemini
větve, protože táhne ``pipecat-ai[google]`` a ``google-genai`` — v openai
provozu se tedy nenačte vůbec a nemůže nic rozbít.

Co tenhle soubor přidává nad pipecatí ``GeminiLiveLLMService``:

1. **rychlou dráhu** (``FastLaneMixin``) — tatáž bezpečnostní brzda,
   přednahraná pusa a ověřování stavu v HA jako u OpenAI pusy. Sdílený kód,
   ne kopie: brzda na nevratné úkony se nesmí udržovat dvakrát,
2. **vypnutý ``languageCode``** — Live API ho v ``speechConfig`` posílá vždy
   (pipecat dosadí ``en-US``, když nic nenastavíš) a ``cs-CZ`` model 2.5
   odmítá. Bez pole se čeština chová správně (sonda 30. 8. 2026: přepisy
   i argumenty chodí v diakritice, ``{"mistnost": "obývák"}``),
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

import logging
from typing import Any, Dict, List, Optional

from google.genai.types import EndSensitivity
from pipecat.adapters.schemas.function_schema import FunctionSchema
from pipecat.adapters.schemas.tools_schema import ToolsSchema
from pipecat.services.google.gemini_live.llm import (
    GeminiLiveLLMService,
    GeminiModalities,
    GeminiVADParams,
    InputParams,
)

from app.fastlane_mixin import FastLaneMixin
from app.gemini_tools import (
    DEFAULT_GEMINI_MODEL,
    DEFAULT_GEMINI_VOICE,
    normalize_model_name,
    to_gemini_function_declarations,
    vad_plan,
)

logger = logging.getLogger(__name__)


class SafeGeminiLiveLLMService(FastLaneMixin, GeminiLiveLLMService):
    """Gemini Live se Žánovou rychlou dráhou a bez vnuceného ``languageCode``.

    ``FastLaneMixin`` musí být v MRO PRVNÍ — jeho ``register_function``
    přebíjí ten z pipecatu a ``super()`` uvnitř pak míří na
    ``GeminiLiveLLMService``.
    """

    def __init__(self, *, drop_language_code: bool = True, **kwargs):
        """Args:
            drop_language_code: Nevkládat do ``speechConfig`` pole
                ``languageCode``. Pipecat ho dosadí vždy (``en-US``, když
                ``params.language`` nenastavíš) a ``cs-CZ`` model 2.5 odmítá.
                Vynulováním ``_settings["language"]`` se z pydantic modelu
                ``SpeechConfig`` pole při serializaci vypustí úplně.
            **kwargs: Předává se beze změny do ``GeminiLiveLLMService``.
        """
        super().__init__(**kwargs)
        if drop_language_code:
            self._settings["language"] = None
            self._language_code = None
            logger.info("🌐 Gemini: languageCode se NEposílá (cs-CZ 2.5 odmítá)")

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
