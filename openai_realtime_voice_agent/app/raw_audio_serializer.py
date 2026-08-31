"""Simple serializer for raw binary PCM audio frames."""
import json
import logging
import os
import time
from pipecat.frames.frames import InputAudioRawFrame, OutputAudioRawFrame, Frame

# Ramce, po kterych se vystupni proud na satelitu ZAHODI a zacina znovu.
# Importuji se defenzivne: nazvy se mezi verzemi pipecatu lisi a chybejici
# trida nesmi shodit most -- v nejhorsim pripade se nabeh chova jako driv.
_PRERUSENI_TYPY = []
for _jmeno in ("StartInterruptionFrame", "BotStoppedSpeakingFrame",
               "TTSStoppedFrame", "InterruptionFrame", "CancelFrame"):
    try:
        _PRERUSENI_TYPY.append(getattr(__import__(
            "pipecat.frames.frames", fromlist=[_jmeno]), _jmeno))
    except Exception:  # pragma: no cover - starsi/novejsi pipecat
        pass
_PRERUSENI_TYPY = tuple(_PRERUSENI_TYPY)
from pipecat.serializers.base_serializer import FrameSerializer, FrameSerializerType

logger = logging.getLogger(__name__)

# NABEH TICHA. Satelit (HA Voice PE) rozjizdi vystupni stream az s prvnim
# bajtem, takze prvni ~300 ms kazde nove promluvy spolkne.
#
# PROC SE PREZBROJUJE PO PRERUSENI (31. 8. 2026, Ondra: "Misto MOMENT rekl
# MENT"). Pipecat na zacatku odpovedi bezne vystreli KRATKY FALESNY ZACATEK
# a hned ho zahodi -- doslovne z logu 18:28:33:
#
#     .262  Bot started speaking
#     .263  nabeh: pred zacatek promluvy jde 280 ms ticha   <- nalepilo se SEM
#     .267  Bot stopped speaking      <- o 4 ms pozdeji FLUSH, ticho je pryc
#     .286  Bot started speaking      <- SKUTECNA rec, uz BEZ nabehu
#
# Nabeh se tim spotreboval na promluvu, ktera se nikdy neprehrala, a na tu
# opravdovou uz nezbyl: mezera .267->.286 je 19 ms, tedy hluboko pod
# NABEH_PAUZA_S, takze se nova promluva nerozpoznala. Satelit pak dostal
# rovnou prvni slabiku a snedl ji.
#
# Merit odstup uz proto nestaci -- po kazdem ramci, ktery vystupni proud
# ZAHAZUJE, se nabeh prezbroji, at je dalsi zvuk cimkoli. Ondra 31. 8. 2026
# v labu slysel misto 'Podivam se na to' jen '...am se na to'. Plati to pro
# vsechny tri zdroje zvuku (pusa Gemini, mluvci Piper, prednahrane fraze),
# proto se ticho pridava tady, v jedinem hrdle vystupniho zvuku.
NABEH_TICHA_MS = float(os.environ.get('ZAN_NABEH_TICHA_MS', '280'))
# Mezera, po ktere se dalsi ramec povazuje za ZACATEK nove promluvy.
NABEH_PAUZA_S = float(os.environ.get('ZAN_NABEH_PAUZA_S', '0.6'))

# ODPOSLECH VYSTUPU (mereni doslovnosti, karta 2026-08-31-programator-zana-19).
# Gemini 3.1 Live NEVRACI prepis toho, co samo reklo (pipecat si o
# `output_audio_transcription` rekne, ale nic nechodi -- overeno na logu
# 31. 8. 2026 17:23, kde bot mluvil 6,7 s a zadny transcript nedorazil).
# Jedine misto, kde jde zjistit, CO OPRAVDU ZAZNELO, je tenhle bajtovy tok.
# Kazda promluva se uklada jako samostatny WAV, ktery se pak da poslat
# whisperu a porovnat s textem mozku.
#
# VYCHOZI STAV JE VYPNUTO: prazdna promenna = zadny zapis, zadna rezie.
# Zapina se jen na dobu mereni (ZAN_TAP_DIR=/tmp/odposlech).
TAP_DIR = os.environ.get('ZAN_TAP_DIR', '').strip()


class RawAudioSerializer(FrameSerializer):
    """Serializer that treats all binary messages as raw PCM audio.

    Text frames (JSON control messages such as the va_client phase protocol)
    are NOT handled here — they are sent/received directly on the websocket by
    the WebSocketHandler so they go out as TEXT frames, not binary.
    """

    def __init__(self, input_sample_rate: int | None = None):
        # The Home Assistant Voice PE firmware (va_client) streams 16 kHz PCM16
        # mono from the XMOS mic. We tag incoming frames with the device's true
        # rate. NOTE: pipecat 0.0.97's input transport does NOT resample — the
        # InputResampler processor in websocket_handler.py upsamples 16k->24k
        # before the audio reaches OpenAI (which requires 24 kHz pcm16 input).
        if input_sample_rate is None:
            input_sample_rate = int(os.environ.get("DEVICE_INPUT_SAMPLE_RATE", "16000"))
        self._input_sample_rate = input_sample_rate
        # Kdy naposledy odesel vystupni zvuk do zarizeni (nabeh ticha).
        self._posledni_vystup = 0.0
        # Odposlech vystupu -- otevreny WAV probihajici promluvy (nebo None).
        self._tap_file = None
        self._tap_bytes = 0
        # Async callback invoked when the device sends {"type":"interrupt"} (the
        # "stop" wake word). Set by WebSocketHandler.build_pipeline once it has
        # the OpenAI service. We deliberately do NOT emit a pipecat
        # InterruptionFrame for this: pipecat's OWN VAD already emits
        # InterruptionFrame (StartInterruptionFrame) on every user-start-speaking,
        # so reacting to that class would cancel the response on ANY speech.
        self._on_interrupt = None
        # Async callback invoked when the device sends {"type":"start"}. NB the
        # va_client sends this once per WebSocket CONNECTION (on connect), NOT
        # per wake-word session. Used to start every (re)connection with a
        # clean OpenAI input buffer — a reconnect mid-utterance leaves half an
        # utterance behind, which session reuse would replay ahead of the next
        # turn. The per-WAKE stale-buffer case (follow-up window cutting a
        # sentence; observed live 2026-06-12) is covered separately by
        # ConnectionRecovery's mic-resume gap detector in websocket_handler.py.
        self._on_session_start = None
        # Async callback for {"type":"flush"} — the device sends this when a
        # follow-up window times out mid-stream, to drop any uncommitted partial
        # utterance from OpenAI's input buffer AT THE CUT-OFF (so no reactive
        # clear-on-wake is needed). Set by WebSocketHandler.build_pipeline.
        self._on_mic_flush = None
        # Async callback for {"type":"wake"} — sent by va_client on every wake.
        # Resets the dangling-VAD guard's "speech since wake" tracker. Set by
        # WebSocketHandler.build_pipeline.
        self._on_wake = None
        # Async callback pro {"type":"ping"} — keepalive od zařízení. Odpověď
        # `pong` musí jít NA TENTO satelit; dřív na ni čekala obsluha
        # `on_client_message`, kterou pipecat vůbec nezná (BaseObject na ni jen
        # zaloguje „Event handler ... not registered"), takže byla mrtvá.
        self._on_ping = None
        # Async callback pro {"type":"mute"} / {"type":"mic_mute"} — satelit
        # hlásí FYZICKY (od)mutovaný mikrofon; zrcadlí se na plátno
        # (`session_klient.mute`). Bere jeden argument (bool).
        #
        # POZOR, tohle je jediná cesta: do 30. 8. 2026 se `mute` četlo
        # v `setup_event_handlers` z pipecatí události `on_client_message`,
        # kterou pipecat NEZNÁ — byl to mrtvý kód, stejně jako `ping` vedle.
        # Multiklientní brána tu obsluhu zrušila, takže hlášení mute musí
        # téct sem, přes serializér toho satelitu.
        self._on_mute = None

    def set_interrupt_handler(self, handler):
        """Register the async no-arg callback fired on a device 'interrupt'."""
        self._on_interrupt = handler

    def set_session_start_handler(self, handler):
        """Register the async no-arg callback fired on a device 'start'."""
        self._on_session_start = handler

    def set_mic_flush_handler(self, handler):
        """Register the async no-arg callback fired on a device 'flush'."""
        self._on_mic_flush = handler

    def set_wake_handler(self, handler):
        """Register the async no-arg callback fired on a device 'wake'."""
        self._on_wake = handler

    def set_ping_handler(self, handler):
        """Register the async no-arg callback fired on a device 'ping'."""
        self._on_ping = handler

    def set_mute_handler(self, handler):
        """Register the async `(muted: bool)` callback fired on 'mute'/'mic_mute'."""
        self._on_mute = handler

    @property
    def type(self) -> FrameSerializerType:
        """Get the serialization type - binary for raw audio."""
        return FrameSerializerType.BINARY

    async def deserialize(self, message: bytes) -> InputAudioRawFrame:
        """Deserialize binary message as raw PCM audio frame.

        Args:
            message: Binary PCM audio data (16-bit, mono, device sample rate)

        Returns:
            InputAudioRawFrame with the audio data, or None if invalid
        """
        # Device CONTROL frames arrive as TEXT (str). pipecat 0.0.97's websocket
        # transport has NO on_message event and routes EVERY incoming frame
        # through this serializer, so the device's {"type":"interrupt"} (sent
        # when the user says the "stop" wake word) would be silently dropped and
        # the assistant's reply would never stop. Handle it via the registered
        # interrupt callback (which sends an explicit OpenAI response.cancel) and
        # inject NO frame into the pipeline — emitting a pipecat InterruptionFrame
        # here would be indistinguishable from the VAD's own per-utterance
        # interruptions and would cancel the reply on any speech.
        if isinstance(message, str):
            try:
                data = json.loads(message)
            except (ValueError, TypeError):
                return None
            if isinstance(data, dict) and data.get("type") == "interrupt":
                logger.info("🛑 device interrupt received")
                if self._on_interrupt is not None:
                    try:
                        await self._on_interrupt()
                    except Exception as e:
                        logger.warning(f"⚠️ device interrupt handler failed: {e!r}")
            elif isinstance(data, dict) and data.get("type") == "start":
                # Sent by va_client once per WS connection (on connect). Mic
                # audio only flows after a wake, so clearing the stale OpenAI
                # input buffer here cannot eat new speech.
                logger.info("🎬 device connection start received")
                if self._on_session_start is not None:
                    try:
                        await self._on_session_start()
                    except Exception as e:
                        logger.warning(f"⚠️ device session-start handler failed: {e!r}")
            elif isinstance(data, dict) and data.get("type") == "flush":
                # A follow-up window timed out mid-stream: drop any uncommitted
                # partial utterance at the cut-off so a later wake can't complete
                # it into a stale answer.
                logger.info("🧽 device mic flush received")
                if self._on_mic_flush is not None:
                    try:
                        await self._on_mic_flush()
                    except Exception as e:
                        logger.warning(f"⚠️ device mic-flush handler failed: {e!r}")
            elif isinstance(data, dict) and data.get("type") == "wake":
                # Sent by va_client on every wake (start_session). Marks a fresh
                # turn boundary for the dangling-VAD guard: until the user
                # actually speaks, any server-VAD end-of-turn is a stale segment
                # from the previous turn closing late (→ garbage response).
                logger.info("👋 device wake received")
                if self._on_wake is not None:
                    try:
                        await self._on_wake()
                    except Exception as e:
                        logger.warning(f"⚠️ device wake handler failed: {e!r}")
            elif isinstance(data, dict) and data.get("type") == "ping":
                # Keepalive: odpověď `pong` míří zpátky JEN na tenhle satelit.
                if self._on_ping is not None:
                    try:
                        await self._on_ping()
                    except Exception as e:
                        logger.warning(f"⚠️ device ping handler failed: {e!r}")
            elif isinstance(data, dict) and data.get("type") in ("mute", "mic_mute"):
                # Satelit hlásí fyzicky (od)mutovaný mikrofon. Snese obě
                # pojmenování pole (`muted` i `value`), ať se kvůli tomu
                # nemusí ladit firmware. Software mute se tím nevyrábí ani
                # neruší — jen se zrcadlí na plátno.
                raw = data.get("muted", data.get("value"))
                muted = raw is True or str(raw).strip().lower() in ("1", "true", "on", "yes")
                logger.info(f"🔇 device mute={muted} received")
                if self._on_mute is not None:
                    try:
                        await self._on_mute(muted)
                    except Exception as e:
                        logger.warning(f"⚠️ device mute handler failed: {e!r}")
            # interrupt / ping / mute / start / other control frames: nothing to inject.
            return None

        if not isinstance(message, bytes):
            # Skip anything that isn't bytes or a known text control frame.
            return None

        # Validate audio format: 16-bit = 2 bytes per sample
        if len(message) % 2 != 0:
            logger.warning(f"⚠️ Received audio with odd byte count: {len(message)} bytes, skipping")
            return None

        # Create InputAudioRawFrame at the device's mic rate; the InputResampler
        # processor (right after transport.input()) upsamples it to 24 kHz.
        frame = InputAudioRawFrame(
            audio=message,
            sample_rate=self._input_sample_rate,
            num_channels=1
        )

        return frame
    
    def _tap(self, audio_bytes: bytes, nova_promluva: bool, rate: int) -> None:
        """Ulozi probihajici promluvu do WAV souboru (mereni doslovnosti).

        Kazda promluva = jeden soubor. Hlavicka se pri kazdem zapisu
        prepisuje na aktualni delku, takze soubor je pouzitelny i drive,
        nez promluva skonci -- nemusi se cekat na konec session.
        """
        import struct

        if nova_promluva and self._tap_file is not None:
            self._tap_file.close()
            self._tap_file = None

        if self._tap_file is None:
            os.makedirs(TAP_DIR, exist_ok=True)
            jmeno = os.path.join(
                TAP_DIR, 'promluva-%s.wav' % time.strftime('%Y%m%d-%H%M%S'))
            self._tap_file = open(jmeno, 'wb')
            self._tap_bytes = 0
            f = self._tap_file
            f.write(b'RIFF' + struct.pack('<I', 36) + b'WAVEfmt ')
            f.write(struct.pack('<IHHIIHH', 16, 1, 1, rate, rate * 2, 2, 16))
            f.write(b'data' + struct.pack('<I', 0))
            logger.info('odposlech: nova promluva -> %s', jmeno)

        f = self._tap_file
        f.write(audio_bytes)
        self._tap_bytes += len(audio_bytes)
        # Prubezna oprava delek v hlavicce -- soubor je tim cely cas platny.
        f.seek(4);  f.write(struct.pack('<I', 36 + self._tap_bytes))
        f.seek(40); f.write(struct.pack('<I', self._tap_bytes))
        f.seek(0, 2)
        f.flush()

    async def serialize(self, frame: Frame) -> bytes:
        """Serialize frame to binary message.
        
        For output audio frames, we just return the raw audio bytes.
        Other frames are not serialized (return empty bytes).
        """
        # PREZBROJENI NABEHU. Tenhle ramec znamena "co je ve fronte na
        # satelitu, zahod" -- pristi zvuk je tedy ZACATEK, i kdyby prisel
        # za deset milisekund. Bez tohohle se nabeh spotreboval na falesny
        # zacatek a skutecna prvni slabika sla do studeneho streamu.
        if _PRERUSENI_TYPY and isinstance(frame, _PRERUSENI_TYPY):
            if self._posledni_vystup:
                logger.info('nabeh: %s -> prezbrojuju, dalsi zvuk je zacatek',
                            type(frame).__name__)
            self._posledni_vystup = 0.0
            if self._tap_file is not None:
                try:
                    self._tap_file.close()
                except Exception:  # pragma: no cover
                    logger.debug('odposlech: zavreni souboru selhalo', exc_info=True)
                self._tap_file = None

        if isinstance(frame, OutputAudioRawFrame):
            audio_bytes = frame.audio
            nyni = time.monotonic()
            nova_promluva = (nyni - self._posledni_vystup) > NABEH_PAUZA_S
            if NABEH_TICHA_MS > 0 and nova_promluva:
                rate = int(getattr(frame, 'sample_rate', 0) or 24000)
                vzorku = int(rate * NABEH_TICHA_MS / 1000.0)
                audio_bytes = bytes(2 * vzorku) + audio_bytes
                logger.info('nabeh: pred zacatek promluvy jde %.0f ms ticha (%d Hz)', NABEH_TICHA_MS, rate)
            self._posledni_vystup = nyni
            if TAP_DIR:
                # Chyba odposlechu NESMI umlcet Zana -- je to diagnostika,
                # ne provozni cesta. Proto siroky except a zadny re-raise.
                try:
                    self._tap(audio_bytes, nova_promluva,
                              int(getattr(frame, 'sample_rate', 0) or 24000))
                except Exception:
                    logger.debug('odposlech vystupu selhal', exc_info=True)
            logger.debug(f"📤 Serializing OutputAudioRawFrame: {len(audio_bytes)} bytes")
            return audio_bytes
        # For other frame types, return empty bytes (not serialized)
        logger.debug(f"📤 Serializing non-audio frame: {type(frame).__name__}, returning empty bytes")
        return b""

