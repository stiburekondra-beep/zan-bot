"""Log the conversation transcript (assistant + user) into the add-on log.

WHY: with gpt-realtime the model hears the user's audio natively and bursts the
whole spoken reply as audio — the only window into *what it actually said* used to
be the OpenAI tool-call arguments. This processor surfaces the assistant's spoken
text (and, when input transcription is enabled, the user's transcript) as plain
INFO lines so the add-on log alone explains a turn.

How the text reaches us (verified against pipecat 0.0.97's *real*
`pipecat.services.openai.realtime.llm.OpenAIRealtimeLLMService` — NOT the older
`openai_realtime_beta` module, which pushes different frames):

  - Assistant reply, AUDIO modality (what we use): the service handles
    `response.output_audio_transcript.delta` and pushes a **`TTSTextFrame`** per
    chunk (NOT `LLMTextFrame` — that's only for the text modality). The whole
    response is bracketed by `LLMFullResponseStartFrame` /
    `LLMFullResponseEndFrame`. We accumulate the chunks and log one line on the
    End frame. (We also match `LLMTextFrame` so a text-modality run still logs.)
    These flow DOWNSTREAM out of the service, so the "assistant" tap sits AFTER
    it in the pipeline.

  - User transcript: `conversation.item.input_audio_transcription.completed`
    pushes a `TranscriptionFrame` — but UPSTREAM (toward the input, so the user
    context aggregator can consume it) and ONLY when input transcription is
    configured (main.py: transcription is None unless TRANSCRIPTION_LANGUAGE is
    set). A tap placed AFTER the service never sees it; the "user" tap therefore
    sits BEFORE the service (between the user aggregator and the LLM).

Because the two transcripts travel in opposite directions past the service, no
single position sees both — so the pipeline wires TWO instances of this class,
one per role (see websocket_handler.build_pipeline). It is pure instrumentation:
it never transforms or drops a frame. (Listed for removal under CLAUDE.md
roadmap #5 once the system is stable.)
"""
import logging

from pipecat.frames.frames import (
    Frame,
    TTSTextFrame,
    LLMTextFrame,
    LLMFullResponseEndFrame,
    TTSStoppedFrame,
    TranscriptionFrame,
)
from pipecat.processors.frame_processor import FrameProcessor, FrameDirection

logger = logging.getLogger(__name__)


class TranscriptLogger(FrameProcessor):
    """Forward-only processor that logs assistant and/or user transcript lines.

    Args:
        capture: which side to log — "assistant" (TTS/LLM reply text, place AFTER
            the LLM), "user" (TranscriptionFrame, place BEFORE the LLM), or "both".
    """

    def __init__(self, capture: str = "both", on_user_final=None, **kwargs):
        super().__init__(**kwargs)
        self._capture = capture
        self._assistant_buf: list[str] = []
        # Volitelný odposlech FINÁLNÍHO uživatelského přepisu. Používá ho
        # `session_klient` („slyšeli jsme řeč" → posun okna ticha na plátně).
        # Schválně tady: `TranscriptionFrame` je jediný bod v rouře, kde
        # finální přepis prokazatelně existuje. Zůstává to instrumentace —
        # callback nesmí rámec změnit ani zdržet (výjimky se polykají).
        self._on_user_final = on_user_final

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)

        if self._capture in ("assistant", "both"):
            # Accumulate the reply text chunks (audio modality -> TTSTextFrame;
            # text modality -> LLMTextFrame), then log once per response on the
            # End bracket so it's one readable line instead of one per chunk.
            if isinstance(frame, (TTSTextFrame, LLMTextFrame)):
                if frame.text:
                    self._assistant_buf.append(frame.text)
            # GEMINI PUSA (doplněno 31. 8. 2026): její cesta `LLMFullResponseEndFrame`
            # dolů nepouští, takže se text, který model VYSLOVIL, nikdy nezapsal —
            # tři a půl tisíce řádků logu a ani jedno „🤖 assistant:". Přitom je to
            # jediné okno do toho, jestli si pusa vymýšlí. `TTSStoppedFrame` uzavírá
            # promluvu u OBOU pus, takže se bere jako druhá závorka.
            # (Vlastní doslovná řeč Žána sem nespadne — ta žádné TTSTextFrame
            # negeneruje, takže je nárazník prázdný a nic se nezaloguje.)
            elif isinstance(frame, (LLMFullResponseEndFrame, TTSStoppedFrame)):
                text = "".join(self._assistant_buf).strip()
                self._assistant_buf = []
                if text:
                    logger.info(f"🤖 assistant: {text}")

        if self._capture in ("user", "both"):
            if isinstance(frame, TranscriptionFrame):
                text = (frame.text or "").strip()
                if text:
                    logger.info(f"🗣️ user: {text}")
                    if self._on_user_final is not None:
                        try:
                            self._on_user_final(text)
                        except Exception as e:  # noqa: BLE001 - odposlech nesmí shodit rouru
                            logger.warning(f"⚠️ odposlech finálního přepisu selhal: {e!r}")

        await self.push_frame(frame, direction)
