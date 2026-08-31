"""WebSocket handler for managing WebSocket connections and pipelines.

MOST PRO VÍC SATELITŮ (2026-08-30)
----------------------------------
Do 26. 8. držel port sám pipecat: ``WebsocketServerTransport`` si uvnitř
otevřel ``websockets.serve`` a povolil PRÁVĚ JEDNO spojení — druhý satelit
to první zavřel (``server.py:191`` a ``:284``, hláška
``Only one client allowed, using new connection``). Voice PE a reSpeaker se
pak střídavě odkopávaly (74 přepnutí za 90 s) a hlas přestal fungovat i tomu,
kdo předtím jel.

Teď je to obráceně: **port drží vstupní brána tohohle modulu**
(``WebSocketHandler.serve_forever``) a každé přijaté spojení dostane svůj
vlastní pipecatí transport (``SingleClientTransport``), který port neotvírá —
jen obslouží ten JEDEN předaný websocket. Nad ním stojí vlastní pipeline,
vlastní OpenAI Realtime relace a vlastní fázový kanál. Důsledky:

* povel řečený do jednoho satelitu se odbaví na něm (fáze míří adresně,
  ne broadcastem),
* odpojení jednoho satelitu se druhého vůbec nedotkne (padá jen jeho task),
* strop je věcí registru (``ZAN_MAX_KLIENTU``, výchozí 2) — třetí satelit se
  ODMÍTNE a nikdo se neodkopává,
* žádný druhý most na jiném portu (to by byli dva Žáni s oddělenou pamětí).
"""
import asyncio
import json
import logging
import time
import uuid
from typing import Optional, Callable, Awaitable

from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.runner import PipelineRunner
from pipecat.pipeline.task import PipelineTask
from pipecat.transports.websocket.server import (
    WebsocketServerTransport,
    WebsocketServerParams,
    WebsocketServerInputTransport,
    WebsocketServerOutputTransport,
)
# LLMService (nadtyp), NE OpenAIRealtimeLLMService: od gemini pusy může do
# pipeline přijít i GeminiLiveLLMService. Multiklientní větev tu měla užší
# anotaci, protože o druhé puse ještě nevěděla.
from pipecat.services.llm_service import LLMService

from pipecat.processors.frame_processor import FrameProcessor, FrameDirection
from pipecat.frames.frames import Frame, InputAudioRawFrame, OutputAudioRawFrame, StartFrame, EndFrame, ErrorFrame
from pipecat.audio.utils import create_stream_resampler
from pipecat.services.openai.realtime import events as openai_rt_events

from websockets.asyncio.server import serve as websocket_serve

from app.raw_audio_serializer import RawAudioSerializer
from app.session_manager import SessionManager
from app.audio_recording_service import AudioRecordingService
from app.phase_emitter import PhaseEmitter
from app.transcript_logger import TranscriptLogger
from app.client_registry import (
    ClientRegistry,
    ClientSlot,
    DEFAULT_MAX_CLIENTS,
    REJECTED_FULL,
)

logger = logging.getLogger(__name__)

# The OpenAI Realtime API works in 24 kHz PCM16. The Voice PE firmware plays
# 24 kHz back and streams 16 kHz up. IMPORTANT: pipecat 0.0.97's websocket INPUT
# transport does NOT resample (only the OUTPUT transport does), and OpenAI
# Realtime's pcm16 input rate is hard-locked to 24000 (PCMAudioFormat.rate =
# Literal[24000]) — you cannot tell it the audio is 16 kHz. So the device's
# 16 kHz frames would be read 1.5x too fast / pitched up, garbling the whole
# transcript. The InputResampler below upsamples 16k->24k in the pipeline.
PIPELINE_SAMPLE_RATE = 24000

# GEMINI PUSA (ZAN_PUSA=gemini) chce vstup v 16 kHz. Na rozdíl od OpenAI, kde
# je vstupní rychlost napevno 24 kHz (`PCMAudioFormat.rate = Literal[24000]`),
# posílá pipecatí GeminiLiveLLMService rychlost s KAŽDÝM kusem zvuku
# (`audio/pcm;rate={frame.sample_rate}`) a Live API očekává 16 kHz PCM16 — což
# je přesně to, co Voice PE streamuje. V gemini větvi se tedy nepřevzorkovává
# vůbec (InputResampler projde naprázdno) a ušetří se převod tam a zpět.
# VÝSTUP zůstává v obou větvích 24 kHz: tolik vrací OpenAI Realtime i Gemini
# Live a v 24 kHz je i knihovna přednahraných frází (voice_fastlane.SAMPLE_RATE).
GEMINI_INPUT_SAMPLE_RATE = 16000


def input_sample_rate_for(provider: str) -> int:
    """Vstupní rychlost pipeline podle pusy (`openai` = 24k, `gemini` = 16k)."""
    return GEMINI_INPUT_SAMPLE_RATE if provider == "gemini" else PIPELINE_SAMPLE_RATE


class SessionActivityTracker(FrameProcessor):
    """Processor that tracks session activity by monitoring audio frames."""
    
    def __init__(self, activity_callback, **kwargs):
        super().__init__(**kwargs)
        self.activity_callback = activity_callback
    
    async def process_frame(self, frame: Frame, direction: FrameDirection):
        if isinstance(frame, StartFrame):
            logger.debug("🎬 SessionActivityTracker: Received StartFrame")
            await super().process_frame(frame, direction)
            await self.push_frame(frame, direction)
            return
        elif isinstance(frame, EndFrame):
            logger.debug("🏁 SessionActivityTracker: Received EndFrame")
            await self.push_frame(frame, direction)
            return
        
        # Track activity on any audio frame
        if isinstance(frame, (InputAudioRawFrame, OutputAudioRawFrame)):
            if self.activity_callback:
                self.activity_callback()
            logger.debug(f"🎵 SessionActivityTracker: Processing {type(frame).__name__} ({len(frame.audio)} bytes)")
        
        # Pass frame through to next processor
        await self.push_frame(frame, direction)


class SessionGate(FrameProcessor):
    """Zavře cestu mikrofonu do pusy, když plátno hlásí `listening=false`.

    Rozhodnutí NENÍ tady — je v `app/session_klient.SessionKlient.pusti_audio()`
    (a je tam i otestované). Tenhle procesor jen zahazuje `InputAudioRawFrame`;
    všechno ostatní (StartFrame, EndFrame, ErrorFrame, textové rámce) prochází
    vždycky, jinak by se zavřeným uchem umřela i obnova spojení.

    FAIL-SAFE: bez klienta se nezavírá nikdy. Výpadek plátna nesmí ohluchnout dům.
    """

    def __init__(self, klient, **kwargs):
        super().__init__(**kwargs)
        self._klient = klient
        self._zavreno = False

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)
        if isinstance(frame, InputAudioRawFrame) and self._klient is not None:
            try:
                pustit = self._klient.pusti_audio()
            except Exception as e:  # noqa: BLE001 - brzda při nejistotě pouští
                logger.warning(f"⚠️ session gate selhal ({e!r}) — pouštím audio dál")
                pustit = True
            if not pustit:
                if not self._zavreno:
                    logger.info("🔇 session gate: plátno hlásí listening=false → mikrofon do pusy nejde")
                    self._zavreno = True
                return
            if self._zavreno:
                logger.info("🔊 session gate: ucho zase otevřené")
                self._zavreno = False
        await self.push_frame(frame, direction)


class InputResampler(FrameProcessor):
    """Upsample incoming device mic audio to the OpenAI Realtime input rate.

    The Voice PE streams 16 kHz PCM16. pipecat 0.0.97's websocket input transport
    forwards those frames unchanged, and OpenAI Realtime reads pcm16 input at a
    fixed 24 kHz — so without this the audio is interpreted ~1.5x too fast,
    badly degrading transcription (e.g. first word dropped, words mangled). This
    sits right after transport.input() and resamples each InputAudioRawFrame to
    out_rate. Uses a streaming resampler so there are no per-chunk edge artifacts.
    """

    def __init__(self, out_rate: int = PIPELINE_SAMPLE_RATE, **kwargs):
        super().__init__(**kwargs)
        self._out_rate = out_rate
        self._resampler = create_stream_resampler()
        self._logged = False

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)
        if isinstance(frame, InputAudioRawFrame) and frame.sample_rate != self._out_rate:
            if not frame.audio:
                return  # nothing to resample / forward; don't emit empty audio
            try:
                resampled = await self._resampler.resample(
                    frame.audio, frame.sample_rate, self._out_rate
                )
            except Exception as e:
                logger.warning(f"⚠️ input resample {frame.sample_rate}->{self._out_rate} failed: {e!r}")
                return  # drop rather than forward wrong-rate audio
            # The streaming resampler buffers internally and can return empty
            # bytes while priming or on a tiny chunk. OpenAI rejects an
            # input_audio_buffer.append with empty audio ("got empty bytes"), so
            # drop those frames — the samples stay buffered and come out next call.
            if not resampled:
                return
            if not self._logged:
                logger.info(
                    f"🎙️ Resampling device input {frame.sample_rate}Hz -> {self._out_rate}Hz for OpenAI"
                )
                self._logged = True
            frame = InputAudioRawFrame(
                audio=resampled,
                sample_rate=self._out_rate,
                num_channels=frame.num_channels,
            )
        await self.push_frame(frame, direction)


class ConnectionRecovery(FrameProcessor):
    """Auto-reconnect the OpenAI Realtime session when its WebSocket dies.

    pipecat 0.0.97's OpenAIRealtimeLLMService has NO reconnect logic: when the
    OpenAI WS drops (1011 keepalive ping timeout, 1001 going away on the 60-min
    cap, 1006, or any send/receive failure) it treats the send error as fatal and
    floods ErrorFrame — ~15/s, one per forwarded mic frame — forever. The single
    persistent session is then dead until the add-on restarts, so the device gets
    no answer to any further turn (observed live: a 1011 flood after which the
    next question got silence).

    This processor watches the ErrorFrames as they travel upstream to the task
    source, and on the first connection-death signature it:
      1. emits `idle` to the device so it unsticks (LED + mic reset), and
      2. calls service.reset_conversation() — the one PUBLIC method that does
         _disconnect() + _connect() + re-sends the session config (instructions,
         tools, turn detection) — to bring the session back IN PLACE. No pipeline
         rebuild: the running pipeline keeps the same service object, which is
         exactly the one reset_conversation reconnects.
    A guard + cooldown collapse the error flood into a single reconnect attempt,
    retrying at most every RECONNECT_COOLDOWN_S while the link stays down.
    """

    # Substrings that mark a dead/closed OpenAI websocket (vs an app-level error
    # like a tool failure, which we must NOT reconnect on). These appear on the
    # SEND-side flood ("Error sending client event: …"), so they're paired with
    # the "client event" check below to avoid reacting to a device disconnect.
    _DEATH_MARKERS = (
        "keepalive ping timeout",
        "going away",
        "no close frame",
        "ConnectionClosed",
        "connection is closed",
        "sent 1011",
        "sent 1001",
        "1006",
    )
    # Substrings that UNAMBIGUOUSLY mean OUR OpenAI session is gone and must be
    # reconnected, regardless of how the error surfaced. The 60-minute cap can
    # arrive as a proactive OpenAI *error event* (code='session_expired', "Your
    # session hit the maximum duration of 60 minutes.") with NO "client event"
    # send-flood and NO close-code marker — so the paired check above misses it
    # and the session stays dead until the add-on restarts. These markers force a
    # reconnect on their own. They can only come from OpenAI (not a device close),
    # so no "client event" guard is needed.
    _SESSION_DEAD_MARKERS = (
        "session_expired",
        "maximum duration",
    )
    RECONNECT_COOLDOWN_S = 5.0
    IDLE_UNSTICK_COOLDOWN_S = 2.0
    # Proactive refresh: reconnect BEFORE OpenAI's 60-min session cap, but only
    # while the house is genuinely quiet, so the cap practically never lands
    # mid-conversation (where it costs the user a turn).
    REFRESH_AGE_S = 55 * 60   # refresh once the session is this old
    REFRESH_QUIET_S = 60.0    # ... and no mic audio flowed for this long
    REFRESH_CHECK_S = 60.0    # poll cadence of the background check

    def __init__(self, openai_service, emit_idle=None, phase_emitter=None, **kwargs):
        super().__init__(**kwargs)
        self._service = openai_service
        self._emit_idle = emit_idle  # async callable(value:str), e.g. broadcast_phase
        # Preferred idle route: PhaseEmitter.force_idle() keeps the emitter's
        # phase state consistent AND suppresses the racing `thinking` from VAD
        # stop events still in flight (observed: a raw broadcast idle was
        # overridden 400 ms later and the device sat in `thinking` with an
        # open mic for 44 s). emit_idle stays as fallback wiring.
        self._phase_emitter = phase_emitter
        self._reconnecting = False
        self._last_attempt = 0.0
        self._last_idle_unstick = 0.0
        # Diagnostics: when the current OpenAI session connected, so we can log its
        # age at a drop (the 60-min cap shows up as ~3600 s) and the reconnect
        # duration (the brief gap the user hears).
        self._connected_at = time.monotonic()
        # Proactive-refresh state. This processor sits right behind
        # transport.input(), so every mic frame passes through it — the cheapest
        # possible "is anyone interacting?" signal (the device only streams the
        # mic during an active turn or the follow-up window).
        self._last_input_audio = time.monotonic()
        self._refresh_task = None

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)
        if self._refresh_task is None:
            self._refresh_task = asyncio.create_task(self._proactive_refresh_loop())
        if isinstance(frame, InputAudioRawFrame):
            # Only kept for the proactive-refresh "is anyone interacting?" check.
            # (Stale-audio clearing is now done at the cut-off source — the device
            # sends {"type":"flush"} when a follow-up window times out — not
            # reactively on mic-resume, which disturbed the VAD and caused garbage.)
            self._last_input_audio = time.monotonic()
        if isinstance(frame, ErrorFrame) and not self._reconnecting:
            msg = str(getattr(frame, "error", "") or "")
            # Two reconnect triggers:
            #  (a) the OpenAI send-side flood ("Error sending client event: …" +
            #      a close-code marker) — OUR WS died mid-send. We require the
            #      "client event" signature so a normal DEVICE-side disconnect
            #      (also 1011/ConnectionClosed, but the device went away) does NOT
            #      trigger an OpenAI reconnect.
            #  (b) an unambiguous OpenAI session-dead error event (session_expired
            #      / "maximum duration") — this is the 60-min cap surfacing as a
            #      proactive error event with NO send-flood, so (a) misses it.
            #      It can only come from OpenAI, so it needs no "client event" guard.
            send_flood = "client event" in msg and any(m in msg for m in self._DEATH_MARKERS)
            session_dead = any(m in msg for m in self._SESSION_DEAD_MARKERS)
            # (c) the OpenAI READ side died or ended (network drop / silent
            #     server close). pipecat produces no ErrorFrame for these at
            #     all — SafeRealtimeLLMService wraps the receive loop and
            #     reports them with this message. Without it the session sat
            #     deaf for hours until the next utterance hit the dead socket.
            reader_dead = "realtime receive loop" in msg
            if send_flood or session_dead or reader_dead:
                now = time.monotonic()
                if now - self._last_attempt >= self.RECONNECT_COOLDOWN_S:
                    self._reconnecting = True
                    self._last_attempt = now
                    asyncio.create_task(self._recover(msg))
            else:
                # Non-connection-death error that ENDS a turn without a reply:
                # most importantly an OpenAI rate-limit ("Rate limit reached …"),
                # but also any other transient response.create failure. No bot
                # speech was produced, so PhaseEmitter never fires
                # BotStopped→idle; the device is left stuck in `thinking`
                # (LED keeps blinking) with no device-side watchdog to recover.
                # Emit one `idle` to unstick it so the user can just try again.
                # Guarded by a short cooldown so a rare flood collapses to one.
                now = time.monotonic()
                if now - self._last_idle_unstick >= self.IDLE_UNSTICK_COOLDOWN_S:
                    self._last_idle_unstick = now
                    asyncio.create_task(self._unstick_idle(msg))
        await self.push_frame(frame, direction)

    async def _recover(self, reason: str):
        t0 = time.monotonic()
        age_s = t0 - self._connected_at
        try:
            logger.warning(
                f"🔌 OpenAI Realtime connection lost after {age_s:.0f}s "
                f"({reason[:90]}) — reconnecting…"
            )
            # Unstick the device first, regardless of how the reconnect goes.
            try:
                await self._go_idle(f"reconnect: {reason[:60]}")
            except Exception as e:
                logger.warning(f"⚠️ could not emit idle during recovery: {e!r}")
            reset = getattr(self._service, "reset_conversation", None)
            if reset is None:
                logger.error("❌ service has no reset_conversation(); cannot reconnect in place")
                return
            await reset()
            self._connected_at = time.monotonic()
            logger.info(
                f"✅ OpenAI Realtime session reconnected in {self._connected_at - t0:.1f}s "
                f"(gap the user may have heard)"
            )
        except Exception as e:
            logger.error(f"❌ OpenAI reconnect attempt failed: {e!r}")
        finally:
            self._reconnecting = False

    async def _proactive_refresh_loop(self):
        """Refresh the OpenAI session BEFORE the 60-min cap, during real idle.

        The cap reconnect is recoverable (~3 s), but when it lands
        mid-conversation that turn hiccups. Refreshing proactively while
        nothing is happening means users practically never meet the cap.
        "Quiet" is double-checked: no assistant response in flight AND no mic
        audio for REFRESH_QUIET_S — so it can never fire during a turn, a
        reply, or an open follow-up window.
        """
        while True:
            try:
                await asyncio.sleep(self.REFRESH_CHECK_S)
                if self._reconnecting:
                    continue
                now = time.monotonic()
                age = now - self._connected_at
                quiet = now - self._last_input_audio
                busy = getattr(self._service, "_current_assistant_response", None) is not None
                if (age >= self.REFRESH_AGE_S and quiet >= self.REFRESH_QUIET_S
                        and not busy and now - self._last_attempt >= self.RECONNECT_COOLDOWN_S):
                    self._reconnecting = True
                    self._last_attempt = now
                    logger.info(
                        f"🔄 proactive session refresh (session {age/60:.0f} min old, "
                        f"quiet for {quiet:.0f}s) — staying ahead of the 60-min cap"
                    )
                    await self._recover("proactive refresh before the 60-min session cap")
            except asyncio.CancelledError:
                raise
            except Exception as e:
                logger.warning(f"⚠️ proactive refresh loop error: {e!r}")

    async def _go_idle(self, reason: str) -> None:
        """Put the device in idle for a dead turn — via PhaseEmitter when wired."""
        if self._phase_emitter is not None:
            await self._phase_emitter.force_idle(reason)
        elif self._emit_idle is not None:
            await self._emit_idle("idle")

    async def _unstick_idle(self, reason: str):
        """Emit `idle` to the device after a turn-ending error (e.g. rate limit).

        The session is still alive (no reconnect needed) — we just nudge the
        device out of its stuck `thinking` blink so the user can retry.
        """
        try:
            logger.warning(f"⚠️ turn ended on error, emitting idle to unstick device ({reason[:90]})")
            await self._go_idle(f"turn ended on error: {reason[:60]}")
        except Exception as e:
            logger.warning(f"⚠️ could not emit idle after turn-ending error: {e!r}")


class SingleClientInputTransport(WebsocketServerInputTransport):
    """Pipecatí vstup pro JEDEN předaný websocket — port sám neotvírá.

    Rodičovská třída si v ``_server_task_handler`` otevře ``websockets.serve``
    a v ``_client_handler`` povolí jen jedno spojení (druhé to první zavře).
    Tady je port cizí věc: drží ho vstupní brána ``WebSocketHandler`` a nám
    předá hotový websocket přes ``attach()``. Čtecí smyčku, deserializaci
    i oznámení o (od)pojení pak dělá beze změny rodičovský ``_client_handler``
    — jen nad jedním jediným spojením, takže nemá koho odkopávat.
    """

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._attached_ws = None
        self._attached_event = asyncio.Event()
        self._finished_event = asyncio.Event()

    def attach(self, websocket) -> None:
        """Předat spojení, které má tenhle transport obsloužit."""
        self._attached_ws = websocket
        self._attached_event.set()

    async def wait_finished(self) -> None:
        """Počkat, až čtecí smyčka tohohle spojení doběhne."""
        await self._finished_event.wait()

    @property
    def finished(self) -> bool:
        """Doběhla už čtecí smyčka?"""
        return self._finished_event.is_set()

    async def _server_task_handler(self):
        """Místo poslouchání na portu obsloužit ten jeden přidělený websocket."""
        try:
            await self._attached_event.wait()
            await self._client_handler(self._attached_ws)
        except asyncio.CancelledError:
            raise
        except Exception as e:  # pragma: no cover - obrana, ať nepadne celý most
            logger.error(f"❌ chyba obsluhy spojení satelitu: {e!r}", exc_info=True)
        finally:
            self._finished_event.set()


class SingleClientOutputTransport(WebsocketServerOutputTransport):
    """Pipecatí výstup pro JEDEN websocket — nikoho neodkopává.

    Rodičovský ``set_client_connection`` zavře dosavadní spojení a zaloguje
    ``Only one client allowed, using new connection`` (``server.py:284``).
    V režimu 1:1 je to jednak zbytečné, jednak zavádějící: ta hláška padá
    i při ÚPLNĚ běžném odpojení (transport si volá ``set_client_connection(None)``),
    takže by ji log obsahoval, i kdyby žádná kolize nebyla — a akceptační
    kritérium karty zní „nula ``Only one client allowed`` v logu".
    Zavření socketu si obstará čtecí smyčka v ``_client_handler``.
    """

    async def set_client_connection(self, websocket):
        """Nastavit/zrušit spojení bez zavírání cizího socketu a bez varování."""
        self._websocket = websocket


class SingleClientTransport(WebsocketServerTransport):
    """Transport jednoho satelitu: vlastní vstup, výstup i serializér."""

    def input(self) -> SingleClientInputTransport:
        """Vstupní transport (bez vlastního serveru)."""
        if not self._input:
            self._input = SingleClientInputTransport(
                self, self._host, self._port, self._params, self._callbacks,
                name=self._input_name,
            )
        return self._input

    def output(self) -> SingleClientOutputTransport:
        """Výstupní transport (bez odkopávání)."""
        if not self._output:
            self._output = SingleClientOutputTransport(
                self, self._params, name=self._output_name
            )
        return self._output

    def attach(self, websocket) -> None:
        """Předat přijaté spojení pipeline tohohle satelitu."""
        self.input().attach(websocket)

    async def wait_finished(self) -> None:
        """Počkat, až spojení tohohle satelitu skončí."""
        await self.input().wait_finished()


class WebSocketHandler:
    """Handles WebSocket transport initialization, pipeline building, and event management."""

    def __init__(
        self,
        host: str = "0.0.0.0",
        port: int = 8080,
        session_manager: Optional[SessionManager] = None,
        audio_recording_service: Optional[AudioRecordingService] = None,
        follow_up_ms: int = 0,
        follow_up_open_delay_ms: int = 700,
        wake_open_delay_ms: int = 700,
        playback_prebuffer_ms: int = 0,
        provider: str = "openai",
        max_clients: int = DEFAULT_MAX_CLIENTS,
        budget=None,
    ):
        """
        Initialize WebSocket handler.

        Args:
            host: Host address to bind to
            port: Port to listen on
            session_manager: Session manager instance
            audio_recording_service: Audio recording service instance
            follow_up_ms: How long (ms) the device should keep the mic open
                after a reply so the user can answer without a wake word. Sent to
                the device in the `hello` handshake. 0 = turn-based (no window).
            follow_up_open_delay_ms: How long (ms) the device waits after a reply
                finishes before opening that follow-up mic (bridges the speaker
                hardware tail). Sent in the `hello` handshake.
            wake_open_delay_ms: How long (ms) the device waits after the wake
                chime before opening the mic, so the chime's hardware tail can't
                leak into the fresh mic as a ghost turn. Sent in `hello`.
            provider: Která pusa jede — `openai` (výchozí) nebo `gemini`.
                Řídí vstupní rychlost zvuku a to, jestli se do pipeline zapojí
                ConnectionRecovery a OpenAI-specifické záchranné brzdy.
            max_clients: Kolik satelitů most unese současně (ZAN_MAX_KLIENTU).
                Další se ODMÍTNE — nikdo se neodkopává.
            budget: Volitelný `SharedBudget` — sdílená peněženka všech satelitů.
        """
        self.provider = (provider or "openai").strip().lower()
        self.host = host
        self.port = port
        self.session_manager = session_manager
        self.audio_recording_service = audio_recording_service
        self.follow_up_ms = max(0, int(follow_up_ms))
        self.follow_up_open_delay_ms = max(0, int(follow_up_open_delay_ms))
        self.wake_open_delay_ms = max(0, int(wake_open_delay_ms))
        self.playback_prebuffer_ms = max(0, int(playback_prebuffer_ms))

        # Registr satelitů: mapa client_id -> ClientSlot se stropem. Tohle je
        # celé jádro multiklientního mostu — každý satelit má svůj transport,
        # svou pipeline a svou OpenAI relaci, nic z toho se nesdílí.
        self.clients = ClientRegistry(max_clients=max_clients)
        self.budget = budget
        # Vstupní brána (websockets server) a signál k jejímu zastavení.
        self._server = None
        self._stop_event: Optional[asyncio.Event] = None
        # Callback z main.py: dostane ClientSlot a doplní do něj transport,
        # OpenAI relaci a rozběhnutou pipeline.
        self._build_client_session: Optional[Callable[[ClientSlot], Awaitable[None]]] = None
        # Volitelný callback po úklidu satelitu (nahrávání apod.).
        self._on_client_gone: Optional[Callable[[str], None]] = None
        # Most na Žánův mozek. Nastavuje ho main.py; potřebujeme ho jen
        # kvůli STOP — po „zmlkni" se musí vyprázdnit fronta témat, jinak
        # promluví to, co do ní stihlo spadnout před stopkou.
        self.zan_bridge = None
        # Drát na plátnový SESSION REŽIM (`app/session_klient.py`). Nastavuje
        # ho main.py; bez něj se nic nemění — gate nepouští ani nezavírá,
        # heard/mute se prostě neposílají.
        self.session_klient = None

    def aktualni_faze(self) -> Optional[str]:
        """Fáze pro dispečera řeči (`replying` = pusa mluví), nebo None.

        POZOR NA JMENOVATEL: dispečer řeči je JEDEN na celý most (jedna
        fronta témat, jeden mozek), ale od multiklientu má fázový emitter
        KAŽDÝ satelit svůj (`ClientSlot.phase_emitter`). Pravidlo „mluví
        právě jeden" proto čte přes všechny sloty: když mluví kterýkoli
        satelit, do session se nic nevstřikuje.

        FAIL-CLOSED: `replying` má přednost před vším ostatním — radši
        počkat, než skočit někomu do řeči. Když žádný satelit fázi nehlásí,
        vrací se None (dispečer si to přebere jako „nevím" a taky mlčí,
        viz `ZanBridge.pusa_mluvi`).
        """
        posledni: Optional[str] = None
        for slot in self.clients.all():
            emitter = getattr(slot, "phase_emitter", None)
            if emitter is None:
                continue
            faze = emitter.faze
            if faze == "replying":
                return "replying"
            if faze is not None:
                posledni = faze
        return posledni

    def create_client_transport(self, client_id: str):
        """Postavit transport + serializér pro JEDEN satelit.

        Vlastní serializér je nutnost, ne kosmetika: drží callbacky
        (``interrupt``/``wake``/``flush``/``start``) navázané na konkrétní
        OpenAI relaci. Sdílený serializér by „stop" řečený u televize poslal
        do relace toho druhého satelitu.

        Returns:
            Dvojice ``(SingleClientTransport, RawAudioSerializer)``.
        """
        serializer = RawAudioSerializer()
        # Vstupní rychlost podle pusy: openai 24 kHz, gemini 16 kHz
        # (`input_sample_rate_for`). Multiklientní větev tu měla natvrdo
        # PIPELINE_SAMPLE_RATE, protože o gemini puse nevěděla — s ní by
        # gemini dostával zvuk ve špatné rychlosti a komolil přepis.
        audio_in_rate = input_sample_rate_for(self.provider)
        transport = SingleClientTransport(
            host=self.host,
            port=self.port,
            params=WebsocketServerParams(
                serializer=serializer,
                audio_in_enabled=True,
                audio_out_enabled=True,
                audio_in_sample_rate=audio_in_rate,
                audio_out_sample_rate=PIPELINE_SAMPLE_RATE,
            ),
        )
        logger.info(
            f"🔧 transport pro satelit {client_id} připraven (bez vlastního portu; "
            f"pusa={self.provider}, vstup {audio_in_rate} Hz, výstup {PIPELINE_SAMPLE_RATE} Hz)"
        )
        return transport, serializer


    def build_pipeline(
        self,
        transport: WebsocketServerTransport,
        openai_service: LLMService,
        client_id: str,
        activity_callback: Optional[Callable[[], None]] = None,
        serializer: Optional[RawAudioSerializer] = None,
        turn_liveness=None,
        enable_recorders: bool = True,
    ) -> tuple:
        """
        Build pipeline for a WebSocket transport connection.

        Args:
            transport: The WebSocket transport instance
            openai_service: The OpenAI service instance
            client_id: Unique identifier for the client device
            activity_callback: Optional callback for session activity tracking
            serializer: Serializér TOHOTO satelitu (drží jeho device callbacky).
            turn_liveness: `TurnLiveness` tohoto satelitu — hlídač „myslím"
                se nesmí dívat na nástroje běžící u druhého satelitu.
            enable_recorders: zapojit do pipeline nahrávací procesory.
                `AudioRecordingService` vrací POŘÁD TYTÉŽ instance
                `AudioFrameRecorder`, a jeden FrameProcessor nesmí být ve dvou
                pipeline (pipecat si na něm přepisuje sousedy). Nahrávat proto
                smí jen jeden satelit — rozhoduje main.py.

        Returns:
            Tuple of (Pipeline, PipelineRunner, PipelineTask, PhaseEmitter, runner_task)
        """
        logger.info(f"🔗 Building pipeline for client: {client_id}")
        if serializer is None:
            raise RuntimeError("build_pipeline vyžaduje serializér daného satelitu")
        # Fázový kanál MÍŘÍ NA JEDNO ZAŘÍZENÍ. Dřív se fáze rozesílaly
        # broadcastem všem — druhý satelit by tedy rozsvítil prstenec a otevřel
        # mikrofon kvůli povelu, který zazněl v jiné místnosti.
        phase_send = self.phase_sender(client_id)
        json_send = self.json_sender(client_id)
        
        if openai_service is None:
            raise RuntimeError("OpenAI service must be created before building pipeline")
        
        logger.info(f"🔗 Building pipeline with WebSocket transport and OpenAI service: {type(openai_service).__name__}")
        
        # Create activity trackers
        input_activity_tracker = SessionActivityTracker(
            activity_callback=activity_callback or (lambda: None)
        )
        output_activity_tracker = SessionActivityTracker(
            activity_callback=activity_callback or (lambda: None)
        )
        
        # Create context aggregator with cached context if available
        context_aggregator = None
        context_initializer = None
        if self.session_manager:
            context_aggregator = self.session_manager.create_context_aggregator(client_id)
            context_initializer = self.session_manager.create_context_initializer(client_id, context_aggregator)
        
        # Build pipeline components. InputResampler runs FIRST (right after the
        # transport) so every later stage — VAD, context aggregator, OpenAI
        # service — sees correctly-rated 24 kHz audio instead of the device's
        # raw 16 kHz (which OpenAI would otherwise read 1.5x too fast).
        # Built early so ConnectionRecovery can route its unstick/reconnect
        # idle through PhaseEmitter.force_idle() (consistent phase state +
        # racing-`thinking` suppression); it is APPENDED near the end of the
        # pipeline below, before transport.output().
        # ADRESNÝ fázový kanál (`phase_send`), ne broadcast: fáze patří tomu
        # satelitu, kterého se týká. Dispečer řeči si emitter nebere odsud —
        # čte ho ze slotů přes `aktualni_faze()`, protože každý satelit má
        # svůj (viz komentář u té metody).
        phase_emitter = PhaseEmitter(send_phase=phase_send, turn_liveness=turn_liveness)

        pipeline_components = [transport.input()]

        # ConnectionRecovery JEN pro openai pusu. Je celá postavená na OpenAI
        # Realtime příznacích (`session_expired`, „maximum duration", 60minutový
        # strop, `reset_conversation()`) — u Gemini by nic z toho nikdy
        # nenamatchovalo, zato by jeho proaktivní „refresh" sahal na metodu,
        # kterou Gemini služba nemá. Gemini Live má obnovu VESTAVĚNOU:
        # `SessionResumptionConfig` v setupu + `_handle_connection_error()` /
        # `_reconnect()` v pipecatu, které navazují na uložený resumption handle.
        if self.provider == "openai":
            # Watch for OpenAI connection-death ErrorFrames (they travel upstream
            # to the task source, so place this upstream of the service) and
            # reconnect in place. Without it a 1011/1001 drop bricks the session.
            # `emit_idle` je ADRESNÝ (`phase_send`), ne broadcast — obnova
            # spojení u jednoho satelitu nesmí zhasnout prstenec druhému.
            pipeline_components.append(
                ConnectionRecovery(openai_service=openai_service, emit_idle=phase_send,
                                   phase_emitter=phase_emitter)
            )
        else:
            logger.info(
                "🔁 ConnectionRecovery vynechána (pusa=%s) — Gemini Live má session "
                "resumption vestavěnou v pipecatu", self.provider
            )

        pipeline_components.extend([
            # Gate SESSION REŽIMU. Sedí PŘED resamplerem schválně: zavřené
            # ucho nemá co převzorkovávat, a ConnectionRecovery nad ním pořád
            # vidí ErrorFrames (ty jdou upstream, gate je nepustí do cesty).
            # ZÁMĚRNĚ MIMO větev `provider == "openai"`: session režim platí
            # pro OBĚ pusy — u gemini ConnectionRecovery odpadá, gate ne.
            SessionGate(self.session_klient),
            InputResampler(out_rate=input_sample_rate_for(self.provider)),
            input_activity_tracker,
        ])
        
        # Add input audio recorder to capture ONLY InputAudioRawFrame
        input_recorder = (self.audio_recording_service.get_input_recorder()
                          if (self.audio_recording_service and enable_recorders) else None)
        if input_recorder:
            pipeline_components.append(input_recorder)
        
        # Continue with rest of pipeline, with transcript-logging taps. The
        # assistant reply text (TTSTextFrame) flows DOWNSTREAM out of the LLM
        # while the user's TranscriptionFrame is pushed UPSTREAM (so the user
        # aggregator can consume it) — opposite directions, so they need taps on
        # opposite sides of the service (see transcript_logger.py): "user" before
        # the LLM, "assistant" after it.
        #
        # Na uživatelský tap se navíc věší drát na plátno: každý FINÁLNÍ
        # přepis = „slyšeli jsme řeč" → POST {action:'heard'} (posune okno
        # ticha session). POZOR: `TranscriptionFrame` vzniká jen když je
        # zapnutá vstupní transkripce (TRANSCRIPTION_LANGUAGE) — bez ní se
        # `heard` neposílá a session dojede na svůj timeout ticha.
        # Dva dráty na jednom finálním přepisu:
        #   1. `heard()`  — posune okno ticha session (jako dosud),
        #   2. `reflex()` — podá text plátnu k posouzení, jestli to není
        #      SCÉNICKÝ POVEL („ukaž vesmír rodiny", „domů", „posuň níž").
        #
        # Bod 2 je oprava z 30. 8. 2026. Do teď reflexní dráha z HLASU
        # NEBYLA ZAPOJENÁ VŮBEC — `/api/reflex` uměl jen plátno sám pro
        # sebe, takže každý obrazový povel musel projít Realtime modelem
        # a přišel se sekundovým zpožděním. Ondra: „ne nejsou to reflexy
        # a nezabiraji hned."
        #
        # Reflex se posílá SOUBĚŽNĚ, ne místo modelu: nesedne-li, plátno
        # vrátí `no_reflex` a nestane se nic. Model dostane povel tak jako
        # tak — obraz se jen přepne dřív, než domluví.
        session_klient = self.session_klient

        def na_prepis(text):
            session_klient.heard()
            try:
                session_klient.reflex(text)
            except Exception:  # noqa: BLE001 — hlas na reflexu nikdy nestojí
                logger.debug("reflex se nepodařilo odeslat", exc_info=True)

        if session_klient is None:
            na_prepis = None
        if context_aggregator:
            pipeline_components.extend([
                context_aggregator.user(),
                TranscriptLogger(capture="user", on_user_final=na_prepis),
                openai_service,
                TranscriptLogger(capture="assistant"),
                context_aggregator.assistant(),
            ])
        else:
            pipeline_components.extend([
                TranscriptLogger(capture="user", on_user_final=na_prepis),
                openai_service,
                TranscriptLogger(capture="assistant"),
            ])

        pipeline_components.append(output_activity_tracker)

        # Emit va_client phase messages (listening/thinking/replying/idle) to
        # the device, derived from Pipecat speaking frames as they pass
        # downstream. Placed before transport.output() so it sees both the
        # user (UserStarted/Stopped) and bot (BotStarted/Stopped) frames.
        # (Constructed above, before ConnectionRecovery.)
        pipeline_components.append(phase_emitter)

        # Add output audio recorder to capture ONLY OutputAudioRawFrame
        output_recorder = (self.audio_recording_service.get_output_recorder()
                           if (self.audio_recording_service and enable_recorders) else None)
        if output_recorder:
            pipeline_components.append(output_recorder)

        pipeline_components.append(transport.output())
        
        # Add context initializer if we have cached messages
        if context_initializer:
            pipeline_components.append(context_initializer)
        
        pipeline = Pipeline(pipeline_components)
        logger.info("✅ Pipeline created for WebSocket connection")
        
        # Audio recording is handled by AudioFrameRecorder processors in the pipeline
        if self.audio_recording_service and enable_recorders:
            logger.info("🎙️ Audio recording enabled - will record input and output audio")
        
        # Create pipeline runner and task
        # Disable idle timeout - server should always stay ready for connections
        # handle_sigint=False: běhounů je teď víc (jeden na satelit) a signály
        # patří hlavní aplikaci, ne každé pipeline zvlášť.
        runner = PipelineRunner(handle_sigint=False)
        task = PipelineTask(pipeline, idle_timeout_secs=None, cancel_on_idle_timeout=False)

        # Start pipeline in background
        runner_task = asyncio.create_task(runner.run(task), name=f"pipeline-{client_id}")
        logger.info(f"✅ Pipeline started for client {client_id}")

        # Wire the device "stop" interrupt. The serializer calls this when it
        # sees {"type":"interrupt"} from the device.
        #
        # The DEVICE stops playback AUTHORITATIVELY: on "stop" its firmware
        # flushes the PSRAM queue and drops all further incoming TTS
        # (suppress_incoming_audio_) until the next turn boundary. So the backend
        # does NOT need to clear its own output here — the user already hears
        # silence. The backend's only job is to stop OpenAI generating MORE
        # tokens: a plain response.cancel, and ONLY while a response is actually
        # active (avoids the noisy response_cancel_not_active in the common
        # already-burst-finished case).
        #
        # We deliberately do NOT queue an InterruptionTaskFrame anymore. It made
        # pipecat run _handle_interruption → _truncate_current_audio_response(),
        # which tells OpenAI to truncate the assistant audio at the *playback*
        # position. But OpenAI bursts the reply faster than real-time, so that
        # position overshoots the audio that actually exists and OpenAI rejects
        # the truncate with invalid_request_error ("Audio content of N ms is
        # already shorter than M ms"). That error left the realtime session in a
        # broken state where the user's VERY NEXT turn got NO response — the
        # recurring "say stop, then immediately ask again → silence" bug. Since
        # the device already silenced playback, dropping the truncate costs us
        # nothing and keeps the next turn alive. (The backend still drains its
        # already-buffered output to the device, which the device discards —
        # minor wasted bandwidth, tracked as roadmap #3; no extra tokens because
        # response.cancel stops further generation.)
        # FOLLOW-UP-WINDOW STOP (the "stop heard as a question" bug). During the
        # post-reply follow-up window the device mic is OPEN and streaming, so by
        # the time the device's local wake-word detects "stop" and sends us the
        # interrupt, the stop word's audio is ALREADY in OpenAI's input buffer.
        # Left alone, the server VAD commits it as a user turn and — with
        # create_response=true — the model literally ANSWERS the word "stop"
        # ("Ik hou me stil…"). The device's local detection must therefore be
        # authoritative on the cloud side too, in two layers:
        #   1) input_audio_buffer.clear discards the not-yet-committed stop-word
        #      audio (the device closed its own mic gate in the same instant),
        #      so in the common case no turn is created at all;
        #   2) if the server VAD committed BEFORE our clear landed (tight race),
        #      OpenAI creates a response moments later anyway — so any assistant
        #      conversation item that appears within INTERRUPT_KILL_WINDOW_S of
        #      a device interrupt is cancelled on arrival (handler below). A
        #      legitimate next turn cannot fall inside that window: after a stop
        #      the mic is closed, and a fresh wake-word turn needs the chime +
        #      speech + VAD end-of-turn (> 2 s) before a response is created.
        _interrupt_kill_until = {"t": 0.0}
        INTERRUPT_KILL_WINDOW_S = 1.5
        # A device "stop" must cancel the NEXT assistant response too, not only
        # the one currently playing. After a stop, the only responses OpenAI can
        # still produce before the user speaks again are unwanted:
        #   - the cancelled reply's already-generated tail;
        #   - a slow tool's answer (web search ~2-4 s) the user stopped mid-run,
        #     created on the tool result OUTSIDE the 1.5 s time-window;
        #   - most common: OpenAI's STT hearing the user's spoken "stop" as a
        #     turn and the model REPLYING to it ("Okay, I'll stop"), which lands
        #     ~1.8 s later — just outside 1.5 s (observed 2026-06-14 22:51: the
        #     device flashed red but a fresh "I'll be quiet" reply played, so the
        #     user had to say stop twice).
        # The time-window alone misses the >1.5 s cases. This flag, armed on
        # EVERY device interrupt, makes _kill_racing_response cancel that one
        # next response regardless of timing. It is consumed when used and
        # cleared at the next genuine turn boundary (real speech via
        # on_real_speech, and {"type":"wake"}) — and a legitimate next turn needs
        # the user to actually speak — so it can never cancel a real turn.
        _kill_next_response = {"v": False}

        async def _on_device_interrupt():
            _interrupt_kill_until["t"] = time.monotonic() + INTERRUPT_KILL_WINDOW_S
            # „Zmlkni" / tlačítko: zrušit běžící dotazy na mozek A VYPRÁZDNIT
            # FRONTU TÉMAT. Samotné zrušení dotazů nestačí — co už do fronty
            # spadlo (dílčí nálezy, průběžné hlášky), by po stopce promluvilo.
            bridge = self.zan_bridge
            if bridge is not None:
                try:
                    bridge.stop("device interrupt (zmlkni)")
                except Exception as e:  # brzda nesmí shodit stopku
                    logger.warning(f"⚠️ STOP: vyprázdnění fronty témat selhalo ({e!r})")
            # Arm the next-response kill on EVERY stop (see the flag comment):
            # the 1.5 s time-window alone misses responses that land later —
            # OpenAI replying to the spoken "stop", or a slow tool's answer.
            _kill_next_response["v"] = True
            # GEMINI PUSA: Live API nemá protějšek `input_audio_buffer.clear`
            # ani `response.cancel` — přerušení se na jeho straně řeší tím, že
            # dorazí nový vstup, a zařízení si přehrávání umlčí samo. Uděláme
            # tedy jen to, co jde: srovnáme pipeline (TTSStoppedFrame), ať
            # navazující fáze/LED sedí. NEOVĚŘENO ŽIVĚ — jeden z bodů LAB A/B.
            if self.provider != "openai":
                try:
                    handler = getattr(openai_service, "_handle_interruption", None)
                    if handler is not None:
                        await handler()
                    logger.info("🛑 device interrupt (gemini) → pipeline srovnána, zařízení už mlčí")
                except Exception as e:
                    logger.info(f"🛑 device interrupt (gemini) no-op ({e!r})")
                return
            try:
                await openai_service.send_client_event(openai_rt_events.InputAudioBufferClearEvent())
                logger.info("🛑 device interrupt → input_audio_buffer.clear sent (drop in-flight user audio)")
            except Exception as e:
                logger.info(f"🛑 device interrupt → input_audio_buffer.clear no-op ({e!r})")
            try:
                if getattr(openai_service, "_current_assistant_response", None) is not None:
                    await openai_service.send_client_event(openai_rt_events.ResponseCancelEvent())
                    logger.info("🛑 device interrupt → response.cancel sent (response was still active)")
                else:
                    logger.info("🛑 device interrupt → no active response to cancel (device already silenced)")
            except Exception as e:
                logger.info(f"🛑 device interrupt → response.cancel no-op ({e!r})")

        # Post-stop „racing response“ killer je čistě OpenAI záležitost —
        # visí na události `on_conversation_item_created`, kterou Gemini pusa
        # vůbec nevydává (a `response.cancel` v Live API nemá protějšek).
        if self.provider == "openai":
            @openai_service.event_handler("on_conversation_item_created")
            async def _kill_racing_response(service, item_id, item):
                # Pipecat fires this for every conversation.item.added; only an
                # ASSISTANT item right after a device interrupt is the racing
                # response to the stop word the user just cancelled.
                if getattr(item, "role", None) != "assistant":
                    return
                within_window = time.monotonic() < _interrupt_kill_until["t"]
                kill_armed = _kill_next_response["v"]
                if not within_window and not kill_armed:
                    return
                # Consume the flag: this assistant item is the unwanted response the
                # user's stop pre-empted — a stop-acknowledgement ("Okay, I'll stop"),
                # a stopped tool's answer, or the cancelled reply's tail.
                _kill_next_response["v"] = False
                try:
                    await openai_service.send_client_event(openai_rt_events.ResponseCancelEvent())
                    logger.info(
                        "🛑 response raced in right after a device interrupt → "
                        "response.cancel (post-stop)"
                    )
                except Exception as e:
                    logger.info(f"🛑 post-interrupt racing-response cancel no-op ({e!r})")

        async def _on_device_session_start():
            # va_client sends {"type":"start"} once per WebSocket CONNECTION
            # (on connect) — NOT per wake. A reconnect mid-utterance (wifi
            # blip, backend restart with session reuse) can leave half an
            # utterance in OpenAI's input buffer; start every (re)connection
            # with a clean one. The per-WAKE/follow-up stale-buffer case is
            # covered by the device's {"type":"flush"} on follow-up timeout.
            # GEMINI: `input_audio_buffer.clear` v Live API neexistuje — vstup
            # tam nemá klientem řízený buffer, server VAD si drží vlastní okno.
            if self.provider != "openai":
                return
            try:
                await openai_service.send_client_event(openai_rt_events.InputAudioBufferClearEvent())
                logger.info("🎬 device (re)connected → input_audio_buffer.clear (clean start)")
            except Exception as e:
                logger.debug(f"🎬 connect-time input clear no-op ({e!r})")

        async def _on_device_mic_flush():
            # The device sends {"type":"flush"} when a follow-up window times out
            # mid-stream. Drop any uncommitted partial utterance NOW, at the
            # cut-off, so a later wake can't "complete" it into a stale answer.
            # This replaced the reactive clear-on-mic-resume, which fired on
            # every wake and disturbed the server VAD → spurious garbage commits.
            # Also a turn boundary for the dangling-VAD guard: the follow-up
            # closed without speech, so any later server-VAD stop is dangling.
            phase_emitter.note_wake()
            # GEMINI: viz _on_device_session_start — klientský buffer tam není.
            if self.provider != "openai":
                return
            try:
                await openai_service.send_client_event(openai_rt_events.InputAudioBufferClearEvent())
                logger.info("🧽 follow-up cut-off → input_audio_buffer.clear (drop partial utterance)")
            except Exception as e:
                logger.debug(f"🧽 mic-flush input clear no-op ({e!r})")

        async def _on_device_wake():
            # va_client sends {"type":"wake"} on every wake (start_session). Mark
            # the turn boundary for the dangling-VAD guard (A): until the user
            # actually speaks, a server-VAD end-of-turn is a stale pre-wake
            # segment closing late → suppress its thinking + cancel its garbage
            # response (handled in PhaseEmitter via the kill-window callbacks).
            phase_emitter.note_wake()
            # New turn boundary: drop any pending post-tool kill so it can't
            # leak onto this fresh turn's response.
            _kill_next_response["v"] = False
            # Wake word je výslovný lidský akt — otevři gate na `wake_grace`,
            # i kdyby plátno hlásilo `listening=false` (režim SPÍ). Bez tohohle
            # by zapnutý gate zabil normální wake-word tah.
            if self.session_klient is not None:
                self.session_klient.note_wake()

        # Wire the dangling-VAD guard's kill-window into the PhaseEmitter. It
        # reuses the SAME _interrupt_kill_until + _kill_racing_response machinery
        # as the device stop: on a dangling stop, arm it so the auto-created
        # garbage response is cancelled; on a real UserStartedSpeaking, clear it
        # so a genuine new turn's response is never cancelled.
        def _clear_kill_window():
            # Real user speech = a genuine new turn — disarm BOTH the time
            # window and the post-tool flag so neither can cancel it.
            _interrupt_kill_until["t"] = 0.0
            _kill_next_response["v"] = False

        phase_emitter.set_kill_window_handlers(
            on_dangling=lambda: _interrupt_kill_until.__setitem__(
                "t", time.monotonic() + INTERRUPT_KILL_WINDOW_S),
            on_real_speech=_clear_kill_window,
        )

        async def _on_device_ping():
            # Keepalive od zařízení. Dřív na něj neodpovídal NIKDO: obsluha
            # seděla v `setup_event_handlers` na události `on_client_message`,
            # kterou pipecat nezná (BaseObject ji jen zaloguje jako
            # „Event handler on_client_message not registered") — takže to byl
            # mrtvý kód. Teď odpověď míří adresně na ten satelit, co se ptal.
            await json_send({"type": "pong"})

        async def _on_device_mute(muted: bool):
            # Satelit hlásí fyzicky (od)mutovaný mikrofon → zrcadlí se na
            # plátno. Stejná cesta jako `ping`: stará obsluha na
            # `on_client_message` byla mrtvý kód, který multiklientní brána
            # zrušila, takže hlášení teče serializérem TOHOTO satelitu.
            logger.info(f"🔇 mute={muted} hlášeno klientem {client_id}")
            if self.session_klient is not None:
                self.session_klient.mute(muted, reason="satelit")

        serializer.set_interrupt_handler(_on_device_interrupt)
        serializer.set_session_start_handler(_on_device_session_start)
        serializer.set_mic_flush_handler(_on_device_mic_flush)
        serializer.set_wake_handler(_on_device_wake)
        serializer.set_ping_handler(_on_device_ping)
        serializer.set_mute_handler(_on_device_mute)

        return pipeline, runner, task, phase_emitter, runner_task

    def extract_client_id(self, websocket) -> str:
        """
        Extract client ID from websocket connection.
        
        Args:
            websocket: WebSocket connection object
            
        Returns:
            Client ID string
        """
        client_ip = None
        if hasattr(websocket, 'client') and websocket.client:
            client_ip = websocket.client.host
        elif hasattr(websocket, 'remote_address'):
            client_ip = str(websocket.remote_address[0]) if websocket.remote_address else None
        
        if not client_ip:
            client_ip = f"unknown_{uuid.uuid4().hex[:8]}"
            logger.warning("⚠️ Could not extract client IP, using generated ID")

        return client_ip

    async def _send_json(self, websocket, obj: dict) -> None:
        """Send a JSON object to one device as a TEXT websocket frame.

        IMPORTANT: use COMPACT separators (no space after ':' or ','). The Voice
        PE va_client does a literal substring match on `"value":"<phase>"`
        (va_client.cpp handle_text_), so the default json.dumps output
        `"value": "listening"` (with a space) would NOT match and the device
        would silently ignore every phase. Compact output `"value":"listening"`
        matches. This is what made listening/thinking/replying never reach the
        device (LED stuck idle, no-speech watchdog never cancelled).
        """
        try:
            await websocket.send(json.dumps(obj, separators=(",", ":")))
        except Exception as e:
            logger.warning(f"⚠️ Could not send {obj.get('type')} to device: {e!r}")

    async def send_json_to(self, client_id: str, obj: dict) -> None:
        """Poslat JSON JEDNOMU satelitu (adresný kanál).

        Tohle je jádro pravidla „povel na jednom nechá druhý v klidu":
        fáze, potvrzení i účtenka o spotřebě míří na to zařízení, kterého se
        týkají. Když satelit mezitím zmizel, jen se to zaloguje — mlčky
        zahodit zprávu je správně, křičet do prázdna ne.
        """
        slot = self.clients.get(client_id)
        if slot is None or slot.websocket is None:
            logger.debug(f"↩️ {obj.get('type')} pro {client_id} zahozeno — satelit není připojený")
            return
        await self._send_json(slot.websocket, obj)

    async def send_phase_to(self, client_id: str, value: str) -> None:
        """Poslat fázi (listening/thinking/replying/idle) jednomu satelitu."""
        logger.info(f"➡️ fáze '{value}' → {client_id}")
        await self.send_json_to(client_id, {"type": "phase", "value": value})

    def phase_sender(self, client_id: str) -> Callable[[str], Awaitable[None]]:
        """Vrátit `async (value) -> None` navázané na jeden satelit."""
        async def send(value: str) -> None:
            await self.send_phase_to(client_id, value)
        return send

    def json_sender(self, client_id: str) -> Callable[[dict], Awaitable[None]]:
        """Vrátit `async (obj) -> None` navázané na jeden satelit."""
        async def send(obj: dict) -> None:
            await self.send_json_to(client_id, obj)
        return send

    async def broadcast_json(self, obj: dict) -> None:
        """Poslat JSON VŠEM satelitům.

        Zůstává jen pro zprávy, které se opravdu týkají celého domu. Fáze
        a potvrzení tudy NECHODÍ — od 2026-08-30 mají adresný kanál
        (`send_json_to`), protože broadcast rozsvěcoval prstenec i satelitu,
        na který nikdo nemluvil.
        """
        for slot in self.clients.all():
            if slot.websocket is not None:
                await self._send_json(slot.websocket, obj)

    async def broadcast_phase(self, value: str) -> None:
        """Fáze všem — jen pro zpětnou kompatibilitu, provoz ji nepoužívá."""
        logger.info(f"➡️ broadcast phase '{value}' to {self.clients.count} device(s)")
        await self.broadcast_json({"type": "phase", "value": value})

    # ------------------------------------------------------------------
    # Vstupní brána: jeden port, víc satelitů
    # ------------------------------------------------------------------

    async def serve_forever(
        self,
        build_client_session: Callable[[ClientSlot], Awaitable[None]],
        on_client_gone: Optional[Callable[[str], None]] = None,
    ) -> None:
        """Otevřít port a obsluhovat satelity, dokud nás někdo nezastaví.

        Port drží tahle brána (ne pipecat), takže se dá o přijatém spojení
        rozhodnout DŘÍV, než se ho zmocní transport, který umí jen jednoho.


        Args:
            build_client_session: `async (slot) -> None`, které do slotu
                doplní transport, OpenAI relaci a rozběhnutou pipeline.
            on_client_gone: volitelný `(client_id) -> None` po úklidu satelitu.
        """
        self._build_client_session = build_client_session
        self._on_client_gone = on_client_gone
        self._stop_event = asyncio.Event()
        async with websocket_serve(self._front_door, self.host, self.port) as server:
            self._server = server
            logger.info(
                f"✅ most poslouchá na ws://{self.host}:{self.port}/ "
                f"— strop {self.clients.max_clients} satelit(y) současně"
            )
            await self._stop_event.wait()
        logger.info("🛑 vstupní brána mostu zavřena")

    def stop(self) -> None:
        """Požádat vstupní bránu o ukončení."""
        if self._stop_event is not None:
            self._stop_event.set()

    async def _front_door(self, websocket) -> None:
        """Obsluha JEDNOHO přijatého spojení od začátku do konce.

        Dokud tahle korutina běží, spojení žije — proto se v ní čeká na
        konec čtecí smyčky satelitu. Nikdy tu nesaháme na spojení někoho
        jiného: strop se řeší ODMÍTNUTÍM nového, ne odkopnutím starého.
        """
        client_id = self.extract_client_id(websocket)
        logger.info(f"🔗 nové spojení od {client_id}")

        # Rozpočet: v tvrdém režimu se po vyčerpání denního stropu nepouští
        # DALŠÍ satelit. Ten, kdo už mluví, se nikdy neumlčuje.
        if self.budget is not None:
            allowed, reason = self.budget.allow_new_client()
            if not allowed:
                logger.warning(f"💸 odmítám {client_id}: {reason}")
                await self._reject(websocket, "budget", reason)
                return

        verdict, slot, old = self.clients.reserve(client_id)
        if verdict == REJECTED_FULL:
            await self._reject(
                websocket, "max_clients",
                f"most unese {self.clients.max_clients} satelit(y): {', '.join(self.clients.ids())}",
            )
            return

        if old is not None:
            # Totéž zařízení se připojilo znovu — uklidíme JEHO starou relaci.
            await self._teardown(old, reason="reconnect téhož zařízení")

        try:
            slot.websocket = websocket
            await self._build_client_session(slot)
        except Exception as e:
            logger.error(f"❌ nepodařilo se postavit relaci pro {client_id}: {e!r}", exc_info=True)
            self.clients.release(slot)
            try:
                await websocket.close(code=1011, reason="relace se nepodarila")
            except Exception:
                pass
            return

        try:
            # Handshake ack expected by the va_client protocol (server -> device
            # "hello"). follow_up_ms tells the device how long to keep the mic
            # open after a reply; 0/absent = turn-based. Sent on every connect so
            # an add-on config change takes effect on reconnect.
            await self._send_json(
                websocket,
                {
                    "type": "hello",
                    "audio_out": "pcm",
                    "follow_up_ms": self.follow_up_ms,
                    "follow_up_open_delay_ms": self.follow_up_open_delay_ms,
                    "wake_open_delay_ms": self.wake_open_delay_ms,
                    "playback_prebuffer_ms": self.playback_prebuffer_ms,
                },
            )
            # Teprve teď dostane pipeline satelitu jeho spojení do ruky.
            slot.transport.attach(websocket)
            await self._wait_until_gone(slot, websocket)
        finally:
            await self._teardown(slot, reason="satelit se odpojil")

    async def _reject(self, websocket, reason_code: str, detail: str) -> None:
        """Slušně odmítnout spojení, aniž bychom sáhli na ostatní satelity."""
        try:
            await self._send_json(
                websocket,
                {"type": "busy", "reason": reason_code, "detail": detail,
                 "max_clients": self.clients.max_clients},
            )
        except Exception:
            pass
        try:
            # 1013 = "try again later". Odmítnutí je VĚDOMÉ a viditelné —
            # tiché odkopnutí někoho jiného byl přesně ten starý problém.
            await websocket.close(code=1013, reason="most je plny")
        except Exception:
            pass

    async def _wait_until_gone(self, slot: ClientSlot, websocket) -> None:
        """Čekat, dokud satelit mluví — buď doběhne čtecí smyčka, nebo socket."""
        waiters = [asyncio.create_task(slot.transport.wait_finished())]
        wait_closed = getattr(websocket, "wait_closed", None)
        if wait_closed is not None:
            waiters.append(asyncio.create_task(wait_closed()))
        try:
            await asyncio.wait(waiters, return_when=asyncio.FIRST_COMPLETED)
        finally:
            for waiter in waiters:
                if not waiter.done():
                    waiter.cancel()

    async def _teardown(self, slot: ClientSlot, reason: str) -> None:
        """Uklidit JEDEN satelit — ostatních se to nesmí dotknout.

        Pořadí je důležité: nejdřív se uschová kontext (aby relace přežila
        odpojení a satelit navázal tam, kde skončil), pak se zruší JEHO
        pipeline a nakonec se uvolní slot.
        """
        if slot.torn_down:
            return
        slot.torn_down = True
        logger.info(f"🧹 uklízím satelit {slot.client_id} ({reason})")

        if self.session_manager is not None and slot.service is not None:
            try:
                self.session_manager.handle_client_disconnect(slot.client_id, slot.service)
            except Exception as e:
                logger.warning(f"⚠️ kontext satelitu {slot.client_id} se nepodařilo uschovat: {e!r}")

        if slot.task is not None:
            try:
                await slot.task.cancel()
            except Exception as e:
                logger.warning(f"⚠️ pipeline satelitu {slot.client_id} nešla zrušit: {e!r}")

        if slot.runner_task is not None and not slot.runner_task.done():
            try:
                await asyncio.wait_for(asyncio.shield(slot.runner_task), timeout=5.0)
            except asyncio.TimeoutError:
                logger.warning(f"⚠️ pipeline satelitu {slot.client_id} se do 5 s neukončila")
            except Exception:
                pass

        if slot.websocket is not None:
            try:
                await slot.websocket.close()
            except Exception:
                pass

        self.clients.release(slot)

        if self._on_client_gone is not None:
            try:
                self._on_client_gone(slot.client_id)
            except Exception as e:
                logger.warning(f"⚠️ úklidový callback selhal pro {slot.client_id}: {e!r}")

    async def cleanup(self):
        """Cleanup WebSocket handler resources."""
        self.stop()
        for slot in self.clients.all():
            await self._teardown(slot, reason="most se vypíná")
