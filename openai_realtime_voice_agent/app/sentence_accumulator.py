"""Deduplication of cumulative realtime transcripts.

The Realtime service may emit ``ukaž`` -> ``ukaž Nov`` -> ``ukaž Novákovou.``.
This module has no network or side effects: it returns only newly closed
sentences and lets the caller decide whether to send them to a reflex or the
conversation brain.
"""

import re
from dataclasses import dataclass, field


def normalize(text: str) -> str:
    text = str(text or "").replace("\u00a0", " ")
    text = re.sub(r"\s+", " ", text)
    text = re.sub(r"\s+([,.!?;:])", r"\1", text)
    return text.strip()


def key(text: str) -> str:
    return re.sub(r"[.!?]+$", "", normalize(text).casefold()).strip()


def split_closed(text: str) -> tuple[list[str], str]:
    value = normalize(text)
    sentences: list[str] = []
    start = 0
    for match in re.finditer(r"[.!?]+", value):
        end = match.end()
        sentence = value[start:end].strip()
        if sentence:
            sentences.append(sentence)
        start = end
        while start < len(value) and value[start].isspace():
            start += 1
    return sentences, value[start:].strip()


def is_priority(text: str) -> bool:
    return bool(re.match(r"^(?:stop|zastav(?:it)?|zavři|zavri|ukonči|ukonci|konec)\b", normalize(text), re.I))


@dataclass(frozen=True)
class ClosedSentence:
    text: str
    key: str
    priority: bool


@dataclass
class SentenceAccumulator:
    """Stateful, per-interaction accumulator with stale-version rejection."""

    latest_version: int = -1
    emitted: set[str] = field(default_factory=set)

    def ingest(self, text: str, version: int, *, final: bool = False) -> tuple[list[ClosedSentence], str, bool]:
        if version < self.latest_version:
            return [], "", False
        self.latest_version = version
        sentences, tail = split_closed(text)
        out: list[ClosedSentence] = []
        for sentence in sentences + ([tail] if final and tail else []):
            sentence_key = key(sentence)
            if not sentence_key or sentence_key in self.emitted:
                continue
            self.emitted.add(sentence_key)
            out.append(ClosedSentence(sentence, sentence_key, is_priority(sentence)))
        return out, ("" if final else tail), True
