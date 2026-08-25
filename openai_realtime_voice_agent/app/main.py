"""Main application entry point using Pipecat."""
import os
import sys
import asyncio
import logging
import time
from typing import Optional
import dotenv
from pipecat.frames.frames import (
    FunctionCallResultProperties,
    TTSAudioRawFrame,
    TTSStartedFrame,
    TTSStoppedFrame,
)
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.runner import PipelineRunner
from pipecat.pipeline.task import PipelineTask
from pipecat.services.openai.realtime.llm import OpenAIRealtimeLLMService
from pipecat.transports.websocket.server import WebsocketServerTransport
from app import config_source
from app.mcp_service import HomeAssistantMCPService
from app.phase_emitter import TURN_LIVENESS
from app.disconnect_tool import get_disconnect_tool_definition, create_disconnect_tool_handler
from app.web_search_tool import get_web_search_tool_definition, create_web_search_tool_handler
from app.zan_bridge_tool import get_ask_zan_tool_definition, ZanBridge
from app.voice_safety import is_sensitive_actuation
from app.voice_fastlane import (
    CHUNK_BYTES as FASTLANE_CHUNK_BYTES,
    SAMPLE_RATE as FASTLANE_SAMPLE_RATE,
    VERIFY_DELAY_S,
    VERIFY_TRIES,
    PhraseLibrary,
    build_event,
    classify as fastlane_classify,
    event_url as fastlane_event_url,
    fetch_states,
    judge as fastlane_judge,
    room_variant,
    _post_event_blocking,
)
from app.audio_recording_service import AudioRecordingService
from app.session_manager import SessionManager
from app.websocket_handler import WebSocketHandler

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

# Reduce verbosity of noisy loggers
logging.getLogger("aiortc").setLevel(logging.WARNING)
logging.getLogger("websockets").setLevel(logging.WARNING)
logging.getLogger("__main__").setLevel(logging.INFO)


def _resolve_choice(env_var: str, custom_env_var: str, default: str) -> str:
    """Resolve a dropdown option that supports a 'custom' escape hatch.

    The add-on UI renders these as a `list(...|custom)` dropdown plus a sibling
    free-text *_custom field. When the dropdown is set to "custom", use the
    custom field's value; otherwise use the dropdown value. Falls back to
    `default` if the resolved value is empty (e.g. "custom" picked but the custom
    field left blank).
    """
    choice = os.environ.get(env_var, default).strip()
    if choice.lower() == "custom":
        custom = os.environ.get(custom_env_var, "").strip()
        if custom:
            return custom
        logger.warning(
            f"⚠️ {env_var}=custom but {custom_env_var} is empty; falling back to {default!r}"
        )
        return default
    return choice or default

dotenv.load_dotenv()

# Konfigurace pro OBA světy jedním kódem (viz app/config_source.py):
#   * add-on   — hodnoty z /data/options.json (tytéž, které dosud exportoval
#                root/run.sh přes bashio; v add-onu se tedy nic nemění),
#   * kontejner — env proměnné z docker `env_file` + výchozí hodnoty z config.yaml.
# Zbytek aplikace čte dál os.environ, takže se nikde jinde nemuselo sahat.
_CONFIG_APPLIED = config_source.apply_to_environ()
logger.info(
    "⚙️ Konfigurace: %s — nastaveno %d proměnných",
    config_source.describe(),
    len(_CONFIG_APPLIED),
)


class SafeRealtimeLLMService(OpenAIRealtimeLLMService):
    """OpenAIRealtimeLLMService with audio-truncation-on-interruption disabled.

    pipecat's `_truncate_current_audio_response()` (called by `_handle_interruption`
    on EVERY interruption — both our device "stop" AND pipecat's own server-VAD
    barge-in when the user wakes/speaks mid-reply) sends a
    `conversation.item.truncate` with `audio_end_ms = wall-clock ms since audio
    start`. But OpenAI BURSTS the reply faster than real-time, so that elapsed
    value massively overshoots the audio that actually exists, and OpenAI rejects
    it with `invalid_request_error("Audio content of N ms is already shorter than
    M ms")`. That errored truncate wedges the realtime session, so the user's very
    next turn gets NO response — the recurring "interrupt, then immediately ask
    again → silence" bug (confirmed in logs: session goes quiet right after
    `_truncate_current_audio_response`).

    The device stops playback authoritatively on its own, so server-side
    truncation buys us nothing. No-op it. (Cost: OpenAI's conversation history
    keeps the full assistant text the user may not have fully heard — purely
    cosmetic for context.)
    """

    async def _truncate_current_audio_response(self):  # type: ignore[override]
        return

    async def _handle_evt_response_done(self, evt):  # type: ignore[override]
        """Keep Pipecat metrics and expose cache + the local 40k/min budget."""
        await super()._handle_evt_response_done(evt)
        usage = getattr(evt.response, "usage", None)
        if not usage:
            return
        now = time.monotonic()
        if not hasattr(self, "_zan_usage_window_start") or now - self._zan_usage_window_start >= 60:
            self._zan_usage_window_start = now
            self._zan_usage_window_tokens = 0
        total = int(getattr(usage, "total_tokens", 0) or 0)
        self._zan_usage_window_tokens += total
        details = getattr(usage, "input_token_details", None)
        cached = int(getattr(details, "cached_tokens", 0) or 0) if details else 0
        input_tokens = int(getattr(usage, "input_tokens", 0) or 0)
        logger.info(
            "Žán usage: total=%d input=%d cached=%d cache_ratio=%.1f%% window=%d/40000",
            total, input_tokens, cached, (100.0 * cached / input_tokens) if input_tokens else 0.0,
            self._zan_usage_window_tokens,
        )
        broadcaster = getattr(self, "zan_broadcast_json", None)
        if broadcaster:
            await broadcaster({
                "type": "usage",
                "remaining": max(0, 40000 - self._zan_usage_window_tokens),
                "limit": 40000,
                "reset_seconds": max(0, int(60 - (now - self._zan_usage_window_start))),
                "cached_input_tokens": cached,
            })

    async def reset_conversation(self):  # type: ignore[override]
        """Reconnect WITHOUT forcing a response on the reconnected session.

        pipecat's reset_conversation() (used by ConnectionRecovery on a 60-min cap
        / keepalive drop) reconnects and leaves `_llm_needs_conversation_setup =
        True`. The collision: if a turn was mid-flight when the WS dropped,
        `_create_response()` had already set `_run_llm_when_api_session_ready =
        True` (because `_api_session_ready` went False on disconnect). After the
        reconnect, the `session.updated` handler sees that flag and fires
        `_create_response()` — but under semantic_vad (`create_response=true`) the
        SERVER also auto-creates a response for the user's next turn. Two
        response.create events collide → `conversation_already_has_active_response`,
        and that turn gets no answer (observed: first turn right after a reconnect
        fails, ~1 in 20 reconnects — whenever the user happens to speak in the few
        seconds just after a reconnect).

        Fix: after the normal reconnect, clear `_run_llm_when_api_session_ready` so
        the reconnected session does NOT self-create a response, and set
        `_llm_needs_conversation_setup = False` (same as the startup pre-seed) — the
        server-VAD drives every user-turn response, so we never need to create one
        ourselves on reconnect. The live context is untouched (it's restored by the
        SessionManager on the next real turn).
        """
        await super().reset_conversation()
        try:
            self._run_llm_when_api_session_ready = False
            self._llm_needs_conversation_setup = False
        except Exception as e:  # pragma: no cover - defensive
            logger.warning(f"⚠️ could not clear post-reconnect response flags: {e!r}")

    # Error codes that must NOT kill the realtime session. pipecat 0.0.97's
    # _receive_task_handler does `_handle_evt_error(evt); return` on EVERY
    # error event — the reader task dies, the in-flight reply cuts off
    # mid-sentence and the session is deaf until the next connection death.
    # Observed live (2026-06-10): semantic_vad split one utterance into two
    # turns, the server's auto-created second response collided with the
    # first → conversation_already_has_active_response → the playing reply
    # stopped at 4.4 s and the session wedged. These codes are harmless
    # protocol races; the right move is to keep reading.
    BENIGN_ERROR_CODES = {
        # The server auto-created a response while one was still active
        # (VAD split a sentence into two turns). The active response keeps
        # streaming — nothing is broken.
        "conversation_already_has_active_response",
        # response.cancel landed after the response already finished (device
        # "stop" / the post-interrupt racing-response kill) — nothing to
        # cancel, nothing broken.
        "response_cancel_not_active",
        # input_audio_buffer.commit raced our input_audio_buffer.clear (device
        # "stop"): an empty commit is exactly the outcome we wanted.
        "input_audio_buffer_commit_empty",
    }

    async def _maybe_handle_evt_retrieve_conversation_item_error(self, evt):  # type: ignore[override]
        """Generic benign-error filter, hooked into pipecat's receive loop.

        pipecat's `_receive_task_handler` treats a True return from this
        method as "error handled — keep the receive loop alive"; every other
        error event kills the reader task (`_handle_evt_error` + `return`).
        It is the ONLY surviving path, so besides the original retrieve-item
        case (super()), we declare our benign protocol races handled here
        instead of letting them cut off live audio and wedge the session.
        """
        if await super()._maybe_handle_evt_retrieve_conversation_item_error(evt):
            return True
        code = getattr(getattr(evt, "error", None), "code", None)
        if code in self.BENIGN_ERROR_CODES:
            logger.warning(
                f"⚠️ benign realtime error ignored (session stays alive): {code}"
            )
            return True
        return False

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

            TURN_LIVENESS.tool_started()
            try:
                if plan is not None:
                    return await self._run_fast_lane(plan, function_name, handler, params)
                return await handler(params)
            finally:
                TURN_LIVENESS.tool_finished()

        super().register_function(
            function_name, liveness_tracked, start_callback, cancel_on_interruption=False
        )

    # -----------------------------------------------------------------------
    # Rychlá dráha: přednahraná pusa místo modelu
    # -----------------------------------------------------------------------

    async def play_phrase(self, zamer: str) -> bool:
        """Pustí přednahranou frázi/tón rovnou do pipeline — bez modelu.

        Audio jde jako `TTSAudioRawFrame` po 20 ms kusech, tedy přesně tak,
        jak do pipeline padá řeč z OpenAI. Pro zařízení je to k nerozeznání
        od normální odpovědi, jen nestála nic a nečekalo se na model.
        """
        lib = getattr(self, "phrase_library", None)
        if lib is None:
            return False
        pcm = lib.get(zamer)
        if not pcm:
            logger.info("🔇 fráze %r není v knihovně — nechávám mluvit model", zamer)
            return False
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
        await self.play_phrase("nepovedlo_se")
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

    async def _receive_task_handler(self):  # type: ignore[override]
        """Surface OpenAI reader death as an ErrorFrame so recovery can act.

        pipecat's receive loop can end without producing ANY ErrorFrame: a
        silent server-side close ends the `async for` normally, and a network
        drop raises ConnectionClosed, which the task manager merely LOGS
        ("unexpected exception"). Nothing reaches ConnectionRecovery either
        way, so the session sat deaf for HOURS until the next user utterance
        hit the dead socket — losing that utterance (observed live twice).
        Wrap the loop and report its end; ConnectionRecovery treats the
        message as a reconnect trigger.
        """
        try:
            await super()._receive_task_handler()
        except asyncio.CancelledError:
            raise  # our own disconnect/reset tearing the task down — not a death
        except Exception as e:
            await self.push_error(error_msg=f"realtime receive loop died: {e!r}")
            return
        # Loop ended without an exception: a clean server-side close, or the
        # fatal-error path (which already pushed its own ErrorFrame —
        # duplicates collapse in ConnectionRecovery's cooldown/guard).
        await self.push_error(error_msg="realtime receive loop ended — connection closed")


class Application:
    """Main application class using Pipecat."""
    
    def __init__(self):
        """Initialize application."""
        self.pipeline: Optional[Pipeline] = None
        self.runner: Optional[PipelineRunner] = None
        self.websocket_handler: Optional[WebSocketHandler] = None
        self.websocket_transport: Optional[WebsocketServerTransport] = None
        self.openai_service: Optional[OpenAIRealtimeLLMService] = None
        self.mcp_service: Optional[HomeAssistantMCPService] = None
        self.audio_recording_service: Optional[AudioRecordingService] = None
        self.session_manager: Optional[SessionManager] = None
        self.current_task: Optional[PipelineTask] = None
        self._pipeline_lock: Optional[asyncio.Lock] = None
        
    async def initialize(self) -> None:
        """Initialize all components."""
        # Get configuration from environment
        openai_api_key = os.environ.get("OPENAI_API_KEY")
        websocket_port = int(os.environ.get("WEBSOCKET_PORT", "8080"))
        websocket_host = os.environ.get("WEBSOCKET_HOST", "0.0.0.0")
        
        # Get turn detection settings with defaults
        vad_threshold = float(os.environ.get("VAD_THRESHOLD", "0.5"))
        vad_prefix_padding_ms = int(os.environ.get("VAD_PREFIX_PADDING_MS", "300"))
        vad_silence_duration_ms = int(os.environ.get("VAD_SILENCE_DURATION_MS", "800"))

        # Turn detection mode. "semantic_vad" is OpenAI's recommended mode for
        # natural conversation: it detects a *semantic* end-of-utterance instead
        # of a fixed silence window, so it doesn't cut the user off on a pause
        # and is more resistant to speaker->mic echo. "server_vad" is the classic
        # silence-based detector tuned by the vad_* values above.
        turn_detection_type = os.environ.get("TURN_DETECTION_TYPE", "semantic_vad").strip().lower()
        if turn_detection_type not in ("semantic_vad", "server_vad"):
            logger.warning(f"⚠️ Unknown TURN_DETECTION_TYPE '{turn_detection_type}', falling back to semantic_vad")
            turn_detection_type = "semantic_vad"
        # semantic_vad eagerness: "low" waits longest before deciding the user is
        # done (fewest mid-sentence cut-offs). low | medium | high | auto.
        vad_eagerness = os.environ.get("VAD_EAGERNESS", "low").strip().lower()
        if vad_eagerness not in ("low", "medium", "high", "auto"):
            logger.warning(f"⚠️ Unknown VAD_EAGERNESS '{vad_eagerness}', falling back to low")
            vad_eagerness = "low"
        # Whether detected user speech may interrupt the assistant's reply
        # (handsfree barge-in). With imperfect device-side AEC, set this false so
        # speaker echo can't cut replies short; interrupt then only via the
        # device "stop" wake word / center button.
        interrupt_response = os.environ.get("INTERRUPT_RESPONSE", "false").strip().lower() == "true"
        # Who creates the OpenAI response each user turn (semantic_vad only).
        # TRUE (default) = the server creates a response on every detected
        # end-of-turn. This is REQUIRED for multi-turn: Pipecat 0.0.97's realtime
        # service only auto-creates a response for the FIRST context (turn 1) and
        # after tool results; plain 2nd/3rd user turns get NO response unless the
        # server makes it. FALSE reproduces the old single-turn-only behaviour
        # (turn 1 answers, turn 2 hangs in "thinking"). See _ensure_openai_service.
        semantic_vad_create_response = os.environ.get("SEMANTIC_VAD_CREATE_RESPONSE", "true").strip().lower() == "true"
        # Expose the `disconnect_client` tool to the model. DEFAULT FALSE: on the
        # Voice PE the device owns its own session lifecycle (wake word starts a
        # turn, the no-speech watchdog / idle phase ends it), so a model-driven
        # disconnect just tears down the persistent WebSocket mid-conversation —
        # it was seen closing the socket DURING the first reply ("conversation_ended").
        # Only enable if your device relies on the backend to hang up.
        enable_disconnect_tool = os.environ.get("ENABLE_DISCONNECT_TOOL", "false").strip().lower() == "true"
        # Pin the input-transcription language (ISO code, e.g. "nl"). Empty = let
        # the model auto-detect. Helps stop the model drifting to another
        # language; pair it with an explicit language lock in `instructions`.
        transcription_language = os.environ.get("TRANSCRIPTION_LANGUAGE", "").strip()
        # Model that transcribes the user's speech to TEXT (the transcript shown
        # in logs + put in the context). NOTE: this is NOT what gpt-realtime-2
        # uses to understand you — the main model hears the audio natively; this
        # only affects the side-channel transcript. Default "gpt-4o-transcribe".
        # Alternatives: "gpt-4o-mini-transcribe", "whisper-1", and the newer
        # streaming "gpt-realtime-whisper" (purpose-built for the Realtime API,
        # faster/cheaper). If the API rejects a value, transcription silently
        # falls back; check the logs.
        transcription_model = _resolve_choice(
            "TRANSCRIPTION_MODEL", "TRANSCRIPTION_MODEL_CUSTOM", "gpt-4o-transcribe"
        )

        # Get instructions with default
        instructions = os.environ.get("INSTRUCTIONS", "You are the Home Assistant Voice Agent and can control the Smart Home.")

        # OpenAI Realtime model + voice. These are dropdowns in the add-on UI with
        # a "custom" sentinel + a sibling *_CUSTOM free-text field; _resolve_choice
        # returns the custom value when the dropdown is "custom", else the dropdown.
        openai_model = _resolve_choice("OPENAI_MODEL", "OPENAI_MODEL_CUSTOM", "gpt-realtime-2")
        openai_voice = _resolve_choice("OPENAI_VOICE", "OPENAI_VOICE_CUSTOM", "marin")

        # Playback speed (post-generation rate): 0.25-1.5, 1.0 = normal. Clamped.
        try:
            openai_speed = float(os.environ.get("OPENAI_SPEED", "1.0"))
        except (TypeError, ValueError):
            openai_speed = 1.0
        openai_speed = max(0.25, min(1.5, openai_speed))
        # Max reply length in output tokens. 0 = unlimited (API default). Caps a
        # runaway monologue + bounds per-response output-token cost.
        try:
            max_output_tokens = int(os.environ.get("MAX_OUTPUT_TOKENS", "0"))
        except (TypeError, ValueError):
            max_output_tokens = 0
        # Pass None when 0/unset so SessionProperties omits it (API default "inf").
        max_output_tokens = max_output_tokens if max_output_tokens > 0 else None
        # Input noise reduction: "near_field" | "far_field" | "" (off). Anything
        # else is treated as off so a typo can't reach the API.
        noise_reduction = os.environ.get("NOISE_REDUCTION", "").strip().lower()
        if noise_reduction not in ("near_field", "far_field"):
            noise_reduction = ""

        zan_bridge_enabled = os.environ.get("ZAN_BRIDGE_ENABLED", "false").lower() == "true"
        zan_voice_url = os.environ.get("ZAN_VOICE_URL", "http://127.0.0.1:8099/voice").strip()
        zan_voice_token = os.environ.get("ZAN_VOICE_TOKEN", "").strip()
        zan_voice_chat_id_raw = os.environ.get("ZAN_VOICE_CHAT_ID", "").strip()
        zan_voice_chat_id = int(zan_voice_chat_id_raw) if zan_voice_chat_id_raw else None
        if zan_bridge_enabled and not zan_voice_token:
            raise ValueError("ZAN_VOICE_TOKEN is required when ZAN_BRIDGE_ENABLED=true")

        # Optional allow-list to trim the (large) ha-mcp tool set exposed to the
        # model. Comma-separated tool names; empty means expose all.
        mcp_tool_allowlist = [t.strip() for t in os.environ.get("MCP_TOOL_ALLOWLIST", "").split(",") if t.strip()]
        
        # Web search: let the assistant look things up online (weather, news,
        # facts). ON by default; existing installs keep their saved option, so an
        # Update won't silently flip it. When on, a `web_search` function tool
        # calls OpenAI's Responses web_search built-in tool server-side (using
        # OPENAI_API_KEY) and returns a short spoken answer. The model is
        # configurable so a different price/quality — or a renamed model — needs
        # no code change.
        enable_web_search = os.environ.get("ENABLE_WEB_SEARCH", "true").lower() == "true"
        web_search_model = _resolve_choice(
            "WEB_SEARCH_MODEL", "WEB_SEARCH_MODEL_CUSTOM", "gpt-5.5"
        )

        # Get recording setting (optional, defaults to false)
        enable_recording = os.environ.get("ENABLE_RECORDING", "false").lower() == "true"
        
        # Post-reply follow-up window: how many seconds the device keeps the mic
        # open after the assistant finishes so the user can answer back without
        # re-saying the wake word. Sent to the device in the `hello` handshake as
        # follow_up_ms; the device opens the mic (after its TTS tail drains) and
        # shows the listening LED for that long. 0 disables (turn-based).
        try:
            follow_up_listen_seconds = int(os.environ.get("FOLLOW_UP_LISTEN_SECONDS", "8"))
        except (TypeError, ValueError):
            follow_up_listen_seconds = 8
        follow_up_listen_seconds = max(0, min(60, follow_up_listen_seconds))
        follow_up_ms = follow_up_listen_seconds * 1000
        # Delay (ms) before the follow-up mic opens, bridging the device speaker's
        # hardware tail so the mic doesn't catch the reply's own end. Sent to the
        # device in `hello`; lower = snappier, higher = safer against echo.
        try:
            follow_up_open_delay_ms = int(os.environ.get("FOLLOW_UP_OPEN_DELAY_MS", "700"))
        except (TypeError, ValueError):
            follow_up_open_delay_ms = 700
        follow_up_open_delay_ms = max(0, min(5000, follow_up_open_delay_ms))
        # Same idea at the WAKE boundary: delay (ms) after the wake chime before
        # the mic opens, so the chime's own hardware tail doesn't leak into the
        # fresh mic and become a ghost turn (the wake-path twin of
        # follow_up_open_delay_ms — the yaml wake handler reads it via a lambda).
        try:
            wake_open_delay_ms = int(os.environ.get("WAKE_OPEN_DELAY_MS", "700"))
        except (TypeError, ValueError):
            wake_open_delay_ms = 700
        wake_open_delay_ms = max(0, min(5000, wake_open_delay_ms))
        # Playback jitter buffer (ms): the device holds incoming TTS until this
        # much has accumulated before playing, so a brief network hiccup doesn't
        # dry out the speaker chain mid-word (audible crackle). Sent in `hello`.
        try:
            playback_prebuffer_ms = int(os.environ.get("PLAYBACK_PREBUFFER_MS", "150"))
        except (TypeError, ValueError):
            playback_prebuffer_ms = 150
        playback_prebuffer_ms = max(0, min(2000, playback_prebuffer_ms))

        # Get session reuse timeout and initialize session manager
        session_reuse_timeout = float(os.environ.get("SESSION_REUSE_TIMEOUT_SECONDS", "300"))
        # Cap on restored conversation history (0 = unlimited). Bounds per-turn
        # tokens so a long chat doesn't trip OpenAI's TPM rate limit (gpt-realtime
        # re-bills the whole conversation on every response; pipecat has no
        # truncation). Default 12 keeps recent continuity cheaply.
        try:
            max_context_messages = int(os.environ.get("MAX_CONTEXT_MESSAGES", "12"))
        except (TypeError, ValueError):
            max_context_messages = 12
        max_context_messages = max(0, max_context_messages)
        self.session_manager = SessionManager(
            reuse_timeout=session_reuse_timeout,
            max_restored_messages=max_context_messages,
        )
        logger.info(
            f"Session reuse timeout: {session_reuse_timeout} seconds, "
            f"max restored messages: {max_context_messages or 'unlimited'}"
        )
        
        if not openai_api_key:
            raise ValueError("OPENAI_API_KEY environment variable is required")
        
        # Initialize Home Assistant MCP Service
        mcp_client = None
        try:
            supervisor_token = os.environ.get("LONGLIVED_TOKEN") or os.environ.get("SUPERVISOR_TOKEN")
            ha_mcp_url = os.environ.get("HA_MCP_URL", "http://supervisor/core/api/mcp")
            # RYCHLÁ DRÁHA (2026-08-22): HA MCP nástroje se načítají VŽDY, i když
            # je Žán bridge zapnutý. Dřív se v bridge režimu schovávaly a všechno
            # (i „rozsviť") muselo přes ask_zan → mozek (~20 s). Teď jednoduché
            # ovládání (světla, zásuvky, hudba, čtení stavů) vyřídí model sám
            # nativními HA nástroji hned, a ask_zan zůstává jen pro „přemýšlení"
            # (automatizace, diagnostika, dashboardy). Routing určuje prompt níže.
            if supervisor_token:
                logger.info("Loading Home Assistant MCP tools (fast lane, coexists with ask_zan)...")
                self.mcp_service = HomeAssistantMCPService(url=ha_mcp_url, access_token=supervisor_token)
                mcp_client = await self.mcp_service.initialize()
                logger.info("✅ Home Assistant MCP Client initialized")
            else:
                logger.warning("⚠️ SUPERVISOR_TOKEN not set, skipping Home Assistant MCP integration")
        except Exception as e:
            logger.warning(f"⚠️ Failed to initialize Home Assistant MCP Client: {e}")
        
        # Initialize WebSocket handler
        self.websocket_handler = WebSocketHandler(
            host=websocket_host,
            port=websocket_port,
            session_manager=self.session_manager,
            audio_recording_service=self.audio_recording_service,
            follow_up_ms=follow_up_ms,
            follow_up_open_delay_ms=follow_up_open_delay_ms,
            wake_open_delay_ms=wake_open_delay_ms,
            playback_prebuffer_ms=playback_prebuffer_ms,
        )
        logger.info(
            f"🔁 Follow-up window: {follow_up_listen_seconds}s "
            f"({'enabled' if follow_up_ms > 0 else 'disabled — turn-based'}), "
            f"mic-open delay {follow_up_open_delay_ms}ms, "
            f"wake-open delay {wake_open_delay_ms}ms, "
            f"playback prebuffer {playback_prebuffer_ms}ms"
        )
        self.websocket_transport = self.websocket_handler.create_transport()
        
        # Store configuration for session creation
        self.openai_api_key = openai_api_key
        self.vad_threshold = vad_threshold
        self.vad_prefix_padding_ms = vad_prefix_padding_ms
        self.vad_silence_duration_ms = vad_silence_duration_ms
        self.turn_detection_type = turn_detection_type
        self.vad_eagerness = vad_eagerness
        self.interrupt_response = interrupt_response
        self.semantic_vad_create_response = semantic_vad_create_response
        self.enable_disconnect_tool = enable_disconnect_tool
        self.transcription_language = transcription_language
        self.transcription_model = transcription_model
        if zan_bridge_enabled:
            # RYCHLÁ DRÁHA vs. DELEGACE (2026-08-22). Model má k dispozici jak
            # nativní HA nástroje (rychlá dráha), tak ask_zan (most na mozek).
            # Tento prefix je vynucen KÓDEM (přežije editaci volby instructions),
            # osobnost/kontext přidává volba instructions za ním.
            instructions = (
                "ROUTING (řiď se tímto přednostně):\n"
                "• TELEVIZE — VOLBA Z NABÍDKY: když uživatel řekne JEN číslo "
                "nebo číslovku (jedna, dvojku, tři, čtyřku, ... deset), je to "
                "volba z nabídky videí na televizi. Nekomentuj ji, nevolej HA "
                "nástroje — zavolej ask_zan s přesným zněním toho, co uživatel "
                "řekl. Totéž povely o televizi: pust na televizi X, najdi na "
                "televizi X, zastav televizi — vždy ask_zan.\n"
                "• JEDNODUCHÉ OVLÁDÁNÍ DOMU udělej SÁM svými HA nástroji, HNED, "
                "bez ask_zan: rozsvítit/zhasnout světla, zapnout/vypnout zásuvku "
                "nebo spotřebič, hudba a hlasitost (play/pause/další/ztlumit), "
                "čtení stavů a teploty. U AKCÍ zavolej nástroj a SÁM K TOMU NIC "
                "NEŘÍKEJ — průběžnou hlášku i potvrzení přehraje systém z knihovny; "
                "kdybys mluvil taky, zazní to dvakrát. Jen u čtení stavů a teplot "
                "odpověz sám jednou krátkou větou.\n"
                "• ask_zan zavolej JEN když jde o: psaní nebo změnu automatizací "
                "a konfigurace, diagnostiku typu „proč něco nejede\", tvorbu "
                "dashboardu, cokoli na víc než dvě věty přemýšlení, nebo když si "
                "nejsi jistý. Když deleguješ, řekni NEJDŘÍV jednu krátkou LIDSKOU "
                "větu, že se nad tím zamýšlíš, a teprve pak zavolej ask_zan přesně "
                "jednou s textem uživatele. Ty věty STŘÍDEJ, ať nezníš jako robot — "
                "nikdy dvakrát za sebou stejnou. V tomhle tónu: „Moment, zamyslím "
                "se…\", „Aha… vteřinku.\", „No, tohle budu muset líp rozmyslet, dej "
                "mi chvilku.\", „Hmm, na tohle se musím podívat.\", „Počkej chvilku, "
                "rozmyslím to.\", „Tak na tohle si vezmu chvilku.\" Vlastní obměny "
                "v tomhle tónu jsou vítané. Žádná čísla, žádné technické názvy, "
                "žádný slib konkrétního výsledku — jen že přemýšlíš.\n"
                "• DELEGACE JE ASYNCHRONNÍ: ask_zan se vrátí HNED se stavem "
                "„delegated\" — to NENÍ odpověď. Neodpovídej za mozek, nic si "
                "nevymýšlej a nic neuzavírej; po tom výsledku už nemluv. Odpověď "
                "ti dorazí sama jako systémová zpráva začínající „ŽÁN-CODE\" — "
                "teprve tu řekni uživateli, česky, krátce a beze změny významu. "
                "Když přijde „DÍLČÍ NÁLEZ\", řekni ho a čekej, že přijde další. "
                "Když přijde „POŘÁD PRACUJE\", řekni JEDNOU, krátce a lidsky, že "
                "to ještě rozmýšlíš — a taky ty věty střídej (např. „Ještě na tom "
                "dělám, vydrž.\", „Pořád nad tím přemýšlím.\", „Chvilku to potrvá, "
                "ještě to rozmýšlím.\"). NIKDY neříkej, kolik to trvá vteřin ani "
                "žádná jiná čísla. Mezitím se dá normálně mluvit dál — nové povely "
                "obsluhuj, jako by nic neběželo.\n"
                "• BEZPEČNOST: nevratné a rizikové akce NIKDY sám přes HA nástroje "
                "— vždy přes ask_zan: zámky, alarm, brány a garážová vrata, "
                "kotel/topný okruh, mazání, restart. Když by povel spadl sem, "
                "místo provedení zavolej ask_zan.\n"
                "• KRÁTKÉ HLÁŠENÍ: u jednoduchého povelu řekni jen krátce, co "
                "právě děláš („Rozsvěcuju.\"). Výsledek potvrdí krátký tón, "
                "který systém přehraje sám z přednahrané knihovny — výsledek už "
                "slovy nekomentuj. Když nástroj vrátí status verified_success, "
                "unconfirmed nebo ha_unreachable, uživatel už odpověď slyšel: "
                "nic nedodávej a čekej na další povel.\n"
                "• POCTIVOST: nikdy netvrď VÝSLEDEK („rozsvíceno\", „hotovo\") bez "
                "ověřeného stavu a nevymýšlej si, co je v domě. Průběh („dělám to\") "
                "smí zaznít hned. Když ověřit nejde, řekni přesně to.\n"
                "• Nikdy nevyslovuj entity_id ani technické názvy; mluv o „světle "
                "v obýváku\". Odpovědi krátké, mluvené, bez markdownu a výčtů, "
                "stručně a k věci, žádná vata.\n\n"
                + instructions
            )
        self.instructions = instructions
        self.model = openai_model
        self.voice = openai_voice
        self.openai_speed = openai_speed
        self.max_output_tokens = max_output_tokens
        self.noise_reduction = noise_reduction
        self.mcp_tool_allowlist = mcp_tool_allowlist
        self.mcp_client = mcp_client
        self.enable_web_search = enable_web_search
        self.web_search_model = web_search_model
        self.zan_bridge_enabled = zan_bridge_enabled
        self.zan_voice_url = zan_voice_url
        self.zan_voice_token = zan_voice_token
        self.zan_voice_chat_id = zan_voice_chat_id

        # RYCHLÁ DRÁHA — knihovna přednahraných frází a tónů (generuje ji
        # `projects/baklazan/zan/zan-code/generovat-fraze.js` do
        # `zan_data/fraze/`). Načte se jednou, drží se v paměti: přehrání pak
        # stojí nula latence a nula peněz. Když knihovna chybí, rychlá dráha se
        # vypne sama a mluví model jako dřív — nic se nerozbije.
        self.fastlane_enabled = os.environ.get("FASTLANE_PHRASES", "true").lower() not in (
            "false", "0", "no", "off"
        )
        self.phrase_library = PhraseLibrary() if self.fastlane_enabled else None
        if self.fastlane_enabled and (self.phrase_library is None or not self.phrase_library.audio):
            logger.warning("⚠️ rychlá dráha: knihovna frází je prázdná — mluví model")
            self.fastlane_enabled = False
        # Zrcadlení akcí rychlé dráhy do Žán-Code (`POST /event`) — ať mozek ví,
        # co se v domě dělo, i když to sám neprováděl.
        self.zan_event_url = fastlane_event_url(zan_voice_url)
        self.zan_event_token = zan_voice_token
        logger.info(
            "⚡ rychlá dráha: %s · zrcadlení do Žán-Code: %s",
            "zapnutá" if self.fastlane_enabled else "vypnutá",
            self.zan_event_url or "vypnuté",
        )

        # Initialize audio recording service (optional)
        self.audio_recording_service = AudioRecordingService(
            enable_recording=enable_recording,
            sample_rate=24000,
            chunk_duration_seconds=30,
            output_dir="recordings"
        )
        
        logger.info("✅ Application initialized - ready to accept WebSocket connections")
    
    def _build_pipeline_for_transport(self, transport: WebsocketServerTransport, client_id: str):
        """
        Build pipeline for a WebSocket transport connection.
        
        Args:
            transport: The WebSocket transport instance
            client_id: Unique identifier for the client device
        """
        # Ensure OpenAI service exists
        if self.openai_service is None:
            raise RuntimeError("OpenAI service must be created before building pipeline")
        
        # Use WebSocket handler to build pipeline
        self.pipeline, self.runner, self.current_task = self.websocket_handler.build_pipeline(
            transport=transport,
            openai_service=self.openai_service,
            client_id=client_id,
            activity_callback=self._update_session_activity
        )
    
    def _update_session_activity(self):
        """Update session activity timestamp (called by SessionActivityTracker)."""
        pass
    
    async def _ensure_openai_service(self, client_id: Optional[str] = None):
        """Create a new OpenAI service instance for a client.
        
        Args:
            client_id: Optional client ID for session management
        """
        if self._pipeline_lock is None:
            self._pipeline_lock = asyncio.Lock()
        
        async with self._pipeline_lock:
            if client_id is None:
                logger.warning("⚠️ No client_id provided to _ensure_openai_service")
            
            # Create new session
            if client_id:
                logger.info(f"🆕 Creating new OpenAI Session for Client {client_id}...")
            else:
                logger.info("🆕 Creating new OpenAI Session...")
            
            # Cache context from old service before creating new one
            if client_id and self.openai_service is not None:
                try:
                    self.session_manager.cleanup_before_new_session(client_id)
                    logger.debug(f"Cached context from previous session for client {client_id}")
                except Exception as e:
                    logger.warning(f"⚠️ Error caching context from old service for client {client_id}: {e}")
            
            # Create session properties with audio configuration
            from pipecat.services.openai.realtime.events import (
                SessionProperties,
                AudioConfiguration,
                AudioInput,
                AudioOutput,
                TurnDetection,
                SemanticTurnDetection,
                InputAudioTranscription,
                InputAudioNoiseReduction,
            )
            
            # Collect all tool definitions for session properties. The
            # disconnect_client tool is opt-in (see enable_disconnect_tool): by
            # default we do NOT expose it, so the model can't hang up the device
            # mid-conversation.
            all_tools = []
            if self.zan_bridge_enabled:
                all_tools.append(get_ask_zan_tool_definition())
            elif self.enable_disconnect_tool:
                all_tools.append(get_disconnect_tool_definition())

            # Web search tool (optional). Lets the model look things up online via
            # a secondary OpenAI Responses web_search call in the handler.
            # Rychlá dráha: koexistuje i s ask_zan (dřív jen mimo bridge).
            if self.enable_web_search:
                all_tools.append(get_web_search_tool_definition())

            # Get MCP tool definitions if available (rychlá dráha — i v bridge režimu)
            mcp_tools_schema = None
            if self.mcp_client:
                try:
                    logger.info("🔧 Fetching MCP tool definitions...")
                    mcp_tools_schema = await self.mcp_client.get_tools_schema()
                    
                    # Convert MCP tool schemas to OpenAI format, applying the
                    # optional allow-list so the realtime session isn't flooded
                    # with ha-mcp's 80+ tools.
                    exposed = 0
                    for function_schema in mcp_tools_schema.standard_tools:
                        if self.mcp_tool_allowlist and function_schema.name not in self.mcp_tool_allowlist:
                            continue
                        openai_tool = {
                            "type": "function",
                            "name": function_schema.name,
                            "description": function_schema.description,
                            "parameters": {
                                "type": "object",
                                "properties": function_schema.properties,
                                "required": function_schema.required
                            }
                        }
                        all_tools.append(openai_tool)
                        exposed += 1

                    if self.mcp_tool_allowlist:
                        logger.info(f"✅ Fetched {len(mcp_tools_schema.standard_tools)} MCP tools, exposing {exposed} per allow-list")
                    else:
                        logger.info(f"✅ Fetched {len(mcp_tools_schema.standard_tools)} MCP tools")
                except Exception as e:
                    logger.warning(f"⚠️ Failed to fetch MCP tool definitions: {e}")
            
            # Turn detection: semantic_vad (recommended — semantic end-of-turn,
            # echo-resistant, doesn't cut the user off) or classic server_vad.
            if self.turn_detection_type == "semantic_vad":
                turn_detection = SemanticTurnDetection(
                    eagerness=self.vad_eagerness,
                    # create_response=True (default): the SERVER creates a
                    # response on every detected end-of-turn. This is required for
                    # multi-turn conversation. Pipecat 0.0.97's
                    # OpenAIRealtimeLLMService._handle_context only auto-creates a
                    # response for the FIRST context (turn 1) and after tool
                    # results (its else-branch just updates the context); a plain
                    # 2nd/3rd user turn therefore gets NO response unless the
                    # server makes it. We previously set this False to stop a
                    # turn-1 double-response (server + Pipecat first-context both
                    # creating → `conversation_already_has_active_response`), but
                    # that silently broke every turn after the first (device hung
                    # in "thinking"). True is the correct trade: the server drives
                    # all user-turn responses; Pipecat still creates the post-tool
                    # response via _process_completed_function_calls. To stop the
                    # turn-1 double (server + Pipecat-first-context both creating →
                    # conversation_already_has_active_response), run() seeds
                    # self._context once at startup with a kickoff LLMRunFrame, so
                    # the user's first real turn hits the else-branch too.
                    create_response=self.semantic_vad_create_response,
                    interrupt_response=self.interrupt_response,
                )
            else:
                turn_detection = TurnDetection(
                    type="server_vad",
                    threshold=self.vad_threshold,
                    prefix_padding_ms=self.vad_prefix_padding_ms,
                    silence_duration_ms=self.vad_silence_duration_ms,
                )

            # Optionally pin the input-transcription language to stop the model
            # drifting between languages (e.g. "nl"). Empty -> auto-detect.
            # transcription_model picks the STT used for the transcript text.
            transcription = (
                InputAudioTranscription(
                    model=self.transcription_model,
                    language=self.transcription_language,
                )
                if self.transcription_language
                else None
            )

            # Optional near/far-field input noise reduction (helps the VAD reject
            # background noise / residual speaker leak). None = off (default).
            noise_reduction = (
                InputAudioNoiseReduction(type=self.noise_reduction)
                if self.noise_reduction
                else None
            )

            session_properties = SessionProperties(
                instructions=self.instructions,
                # Cap the reply length: bounds runaway monologues + per-response
                # output-token cost. None = unlimited (the API default "inf").
                max_output_tokens=self.max_output_tokens,
                audio=AudioConfiguration(
                    input=AudioInput(
                        turn_detection=turn_detection,
                        transcription=transcription,
                        noise_reduction=noise_reduction,
                    ),
                    # speed is a post-generation playback rate (0.25-1.5, 1.0 = normal).
                    output=AudioOutput(voice=self.voice, speed=self.openai_speed)
                ),
                tools=all_tools
            )

            if self.turn_detection_type == "semantic_vad":
                logger.info(
                    f"🎚️ Turn detection: semantic_vad (eagerness={self.vad_eagerness}, "
                    f"create_response={self.semantic_vad_create_response}, "
                    f"interrupt_response={self.interrupt_response})"
                    + (f", transcription={self.transcription_model} (lang={self.transcription_language})" if self.transcription_language else " (transcription off)")
                )
            else:
                logger.info(
                    f"🎚️ Turn detection: server_vad (threshold={self.vad_threshold}, "
                    f"silence_duration_ms={self.vad_silence_duration_ms})"
                    + (f", transcription={self.transcription_model} (lang={self.transcription_language})" if self.transcription_language else " (transcription off)")
                )

            logger.info(f"🔧 Creating session with {len(all_tools)} tools: {[tool.get('name', 'unknown') for tool in all_tools]}")
            
            # Create new service instance
            self.openai_service = SafeRealtimeLLMService(
                api_key=self.openai_api_key,
                model=self.model,
                session_properties=session_properties,
                start_audio_paused=False
            )
            self.openai_service.zan_broadcast_json = self.websocket_handler.broadcast_json
            # Rychlá dráha potřebuje knihovnu frází a adresu pro zrcadlení —
            # služba se vytváří znovu při každém spojení, tak jí to předáme.
            self.openai_service.fastlane_enabled = self.fastlane_enabled
            self.openai_service.phrase_library = self.phrase_library
            self.openai_service.zan_event_url = self.zan_event_url
            self.openai_service.zan_event_token = self.zan_event_token
            if self.zan_bridge_enabled:
                # DVA MOZKY (25. 8. 2026): most se vrací HNED a odpověď mozku
                # si pak sám vstřikuje do TÉHLE session. Instanci si drží
                # služba, aby na ni dosáhl websocket_handler (STOP musí umět
                # zrušit běžící dotazy) — služba se tvoří znovu při každém
                # spojení, takže most nikdy nevstřikuje do staré session.
                zan_bridge = ZanBridge(
                    self.zan_voice_url, self.zan_voice_token,
                    self.zan_voice_chat_id, self.websocket_handler.broadcast_json,
                )
                self.openai_service.zan_bridge = zan_bridge
                self.openai_service.register_function("ask_zan", zan_bridge.handler)
            logger.info(f"✅ OpenAI Service created: {type(self.openai_service).__name__}")
            
            # Register disconnect tool handler (only when the tool is exposed)
            if self.enable_disconnect_tool and not self.zan_bridge_enabled:
                disconnect_tool_handler = create_disconnect_tool_handler(self.websocket_transport)
                self.openai_service.register_function("disconnect_client", disconnect_tool_handler)
                logger.info("✅ Registered disconnect tool handler")

            # Register web search tool handler (only when the tool is exposed)
            if self.enable_web_search:
                self.openai_service.register_function(
                    "web_search",
                    create_web_search_tool_handler(self.openai_api_key, self.web_search_model),
                )
                logger.info(f"✅ Registered web_search tool handler (model={self.web_search_model})")

            # Register MCP tool handlers if available (rychlá dráha — i v bridge režimu)
            if self.mcp_client and mcp_tools_schema:
                try:
                    await self.mcp_client.register_tools_schema(mcp_tools_schema, self.openai_service)
                    logger.info(f"✅ Registered {len(mcp_tools_schema.standard_tools)} MCP tool handlers")
                except Exception as e:
                    logger.warning(f"⚠️ Failed to register MCP tool handlers: {e}")
            
            # Register service with session manager
            if client_id:
                self.session_manager.set_current_service(client_id, self.openai_service)
            
            logger.info("✅ New OpenAI Session created")
            return self.openai_service
    
    async def run(self) -> None:
        """Run the application."""
        await self.initialize()
        
        # Create initial OpenAI service (will be replaced per connection)
        await self._ensure_openai_service()
        
        # Build pipeline - based on pipecat-examples, one pipeline handles all connections
        # The transport manages multiple connections internally
        self._build_pipeline_for_transport(self.websocket_transport, "server")

        # Zanova obrazovka (LAB 23. 8.): HTTP 127.0.0.1:8791/follow_up ->
        # broadcast {"type":"request_follow_up"} -> Voice PE otevre mikrofon
        # bez wake wordu (nabidka videi na TV ceka na cislo od ditete).
        try:
            from app.tv_control import start_tv_control
            await start_tv_control(self.websocket_handler.broadcast_json)
        except OSError as e:
            logger.warning(f"tv_control se nespustil (port obsazeny?): {e!r}")

        # Consume pipecat's FIRST-context auto-response ONCE at startup — SILENTLY.
        # WHY: pipecat 0.0.97's OpenAIRealtimeLLMService._handle_context does
        # `if not self._context: ... await self._create_response()` — i.e. the
        # very first context it ever sees triggers a real response. With
        # semantic_vad create_response=True the SERVER also creates a response on
        # every user turn, so the user's first turn would double-create →
        # `conversation_already_has_active_response` (cut turn 1 short, hung
        # turn 2). We previously consumed that path with a throwaway LLMRunFrame
        # kickoff — but an LLMRunFrame runs `_create_response()`, producing a REAL
        # (audible, tool-calling) reply. The old comment assumed it "goes to no
        # device" because nothing is connected at startup; WRONG: when the user
        # updates the add-on the device auto-reconnects within seconds and lands
        # mid-kickoff (and its post-tool follow-up), so the device plays a
        # spontaneous "answer" nobody asked for (observed: "Ik vond geen
        # betrouwbare lamp in de gang" right after a restart).
        #
        # Fix: pre-set `self._context` to an empty LLMContext instead. Now the
        # first REAL user turn hits the ELSE branch of _handle_context (no
        # _create_response), the server creates that turn's response (semantic_vad
        # create_response=True), and there's no double — AND no startup speech.
        # The empty sentinel is harmlessly overwritten by the real context on the
        # first turn (both branches do `self._context = context`).
        if self.turn_detection_type == "semantic_vad" and self.semantic_vad_create_response:
            try:
                from pipecat.processors.aggregators.llm_context import LLMContext
                if self.openai_service is not None and getattr(self.openai_service, "_context", None) is None:
                    self.openai_service._context = LLMContext()
                    # Also mark pipecat's one-time "conversation setup" as already
                    # done. pipecat runs it on the FIRST _create_response: it
                    # re-sends the context's messages as ConversationItemCreate
                    # events, then flips _llm_needs_conversation_setup False. On a
                    # fresh realtime session OpenAI already builds the conversation
                    # from the live audio + tool-call flow, so that one-time setup
                    # re-injects items OpenAI already has — which made the first
                    # post-tool reply come out as a meaningless filler ("Ik ben
                    # klaar om verder te gaan met het gesprek."). Instructions are
                    # sent independently via _update_settings() on session.created,
                    # so clearing this flag is safe and makes the first real turn a
                    # normal reply.
                    if hasattr(self.openai_service, "_llm_needs_conversation_setup"):
                        self.openai_service._llm_needs_conversation_setup = False
                    logger.info("🌱 Pre-seeded empty context + marked conversation setup done (no startup speech, no first-turn filler)")
                else:
                    logger.info("🌱 Startup context already set; skipping pre-seed")
            except Exception as e:
                logger.warning(f"⚠️ Could not pre-seed startup context (turn-1 double may occur): {e}")

        # Setup WebSocket event handlers
        async def on_client_connected(client_id: str):
            """Handle new client connection."""
            await self._ensure_openai_service(client_id=client_id)
            if self.audio_recording_service:
                self.audio_recording_service.start_new_session(client_id)
        
        def on_client_disconnected(client_id: str):
            """Handle client disconnection."""
            # DVA MOZKY: běžící dotaz na Žán-Code už nemá kam odpovědět —
            # zrušíme ho hned, ať se zbytečně nedrží vlákno na HTTP. (I bez
            # toho by se výsledek jen zalogoval a zahodil: most před každým
            # vstříknutím kontroluje, že session žije.)
            bridge = getattr(self.openai_service, "zan_bridge", None)
            if bridge is not None:
                try:
                    bridge.cancel_all("odpojení zařízení")
                except Exception as e:  # pragma: no cover
                    logger.warning(f"⚠️ zrušení ask_zan při odpojení selhalo: {e!r}")
            if self.session_manager:
                self.session_manager.handle_client_disconnect(client_id, self.openai_service)
            if self.audio_recording_service:
                self.audio_recording_service.stop_recording()
        
        # Function to get OpenAI service for a client
        def get_openai_service_for_client(client_id: str) -> Optional[OpenAIRealtimeLLMService]:
            """Get OpenAI service for a specific client."""
            if self.session_manager:
                return self.session_manager.get_current_service(client_id)
            return self.openai_service
        
        self.websocket_handler.setup_event_handlers(
            transport=self.websocket_transport,
            on_client_connected_callback=on_client_connected,
            on_client_disconnected_callback=on_client_disconnected,
            openai_service_getter=get_openai_service_for_client
        )
        
        try:
            # Start the pipeline runner - this will start the WebSocket server
            # Based on pipecat-examples: PipelineRunner.run() starts the transport server
            logger.info("✅ Starting WebSocket server and pipeline...")
            await self.runner.run(self.current_task)
        except KeyboardInterrupt:
            logger.info("Received keyboard interrupt")
        except Exception as e:
            logger.error(f"Fatal error: {e}", exc_info=True)
            raise
        finally:
            await self.cleanup()
    
    async def cleanup(self) -> None:
        """Cleanup resources."""
        logger.info("Cleaning up application...")
        
        if self.runner:
            try:
                await self.runner.cancel()
            except Exception as e:
                logger.warning(f"⚠️ Error cancelling runner: {e}")
        
        if self.websocket_handler:
            try:
                await self.websocket_handler.cleanup()
            except Exception as e:
                logger.warning(f"⚠️ Error cleaning up WebSocket handler: {e}")
        
        if self.audio_recording_service:
            self.audio_recording_service.cleanup()
        
        logger.info("✅ Application cleanup complete")


async def main() -> None:
    """Main entry point."""
    app = Application()
    
    try:
        await app.run()
    except KeyboardInterrupt:
        logger.info("Received keyboard interrupt")
    except Exception as e:
        logger.error(f"Fatal error: {e}", exc_info=True)
        sys.exit(1)


if __name__ == "__main__":
    asyncio.run(main())
