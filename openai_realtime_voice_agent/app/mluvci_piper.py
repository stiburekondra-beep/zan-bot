# -*- coding: utf-8 -*-
"""Mluvčí mozku — lokální Piper (wyoming) místo přebásnění pusou.

PROČ TENHLE MODUL VŮBEC JE (Ondra, 31. 8. 2026):

    „ten STT podle me rozumi dobre. Bohuzel jen casto mluvi blbosti
    a opakuje fraze. To se mi tady s tebou v session nedeje. Takze bych
    nejak aby co nejvic mluvil ten Opus."

Cesta „vlož odpověď mozku do Live session a nech ji vyslovit" je cesta přes
JAZYKOVÝ MODEL — pusa dostane text jako *podnět k odpovědi*, ne jako text
k vyslovení, a přebásní ho. Živě z `hovory/2026-08-31.jsonl`:

    08:18:19 člověk  „Ukaž mi mozek."
    08:18:28 Žán     „„Moje věci" může být víc věcí — třeba pošta, kalendář…"

To není tlumočení, to je vlastní nápad pusy. Gemini Live API nemá
`session.say()` ani jiný průchod „vyslov přesně tohle"; jediná vrstva, kde
lze text a zvuk držet v poměru 1:1, je **vlastní TTS**.

Rozhodnutí (a proč ne to druhé):

* **Piper `cs_CZ-jirka-medium` přes wyoming**, warm kontejner vedle
  `wyoming-whisper`. Měřeno na téhle krabici 31. 8. 2026 (N150, 4 jádra,
  souběžně 12 kontejnerů): **0,29 s** krátká věta, **0,66 s** dlouhá věta
  (7,5 s zvuku, RTF 0,09). Doslovnost je dána konstrukcí — text jde do
  syntézy, ne do modelu, takže se změnit NEMŮŽE.
* edge-tts (Antonín) zní bohatěji, ale je to cloud a navíc neoficiální
  reverse-engineered rozhraní Microsoftu (0,49 s do prvního bajtu, kolísá
  0,5–2,1 s podle sítě). Pro vrstvu, na které stojí veškerá řeč Žána, je
  offline důležitější než prozódie — Antonín zůstává jako volba
  (`ZAN_MLUVCI=edge`), ne jako výchozí.

Poučení, která tenhle modul respektuje:

* `2026-08-23_health-na-portu-neni-funkcni-sluzba.md` — `je_zivy()` se ptá
  na STAV (proběhne `describe` a vrátí hlasy?), ne na to, že port odpoví.
* `2026-08-05_ceske-tts-necist-cislice.md` — Piper číslice čte stejně blbě
  jako kdokoli jiný; převod na slova je věc MOZKU (ten text píše), tenhle
  modul do textu nesahá. Doslovnost je tu svatá.
* `2026-08-24_dukaz-na-spatne-vrstve.md` — důkazem není návratový kód, ale
  soubor: `synth()` vrací počet bajtů PCM a volající ho loguje.
"""

from __future__ import annotations

import audioop
import json
import logging
import os
import socket
import time
from typing import Optional, Tuple

logger = logging.getLogger("zan.mluvci")

#: Cílová rychlost pipeline. Obě pusy (OpenAI Realtime i Gemini Live) vracejí
#: 24 kHz PCM16 mono a knihovna frází je taky 24 kHz — mluvčí se do toho musí
#: trefit, jinak by zvuk hrál rychleji/pomaleji.
CILOVY_RATE = 24000

#: Piper `medium` modely generují 22050 Hz. Převzorkuje se `audioop.ratecv`
#: (stdlib; Python 3.12 v kontejneru ho má, od 3.13 je pryč — až se bude
#: povyšovat základ, chce to `soxr`/`av`, viz poznámka v kartě).
_PIPER_RATE_FALLBACK = 22050

_ADRESA = os.environ.get("ZAN_PIPER_URL", "127.0.0.1:10200").strip()
_HLAS = os.environ.get("ZAN_PIPER_HLAS", "cs_CZ-jirka-medium").strip()
_TIMEOUT = float(os.environ.get("ZAN_PIPER_TIMEOUT", "12"))


def _rozdel_adresu(adresa: str) -> Tuple[str, int]:
    host, _, port = adresa.partition(":")
    return (host or "127.0.0.1", int(port or 10200))


class _WyomingSpojeni:
    """Jedno krátké spojení na wyoming server. Rámce: hlavička JSON + \\n."""

    def __init__(self, host: str, port: int, timeout: float) -> None:
        self._sock = socket.create_connection((host, port), timeout=timeout)
        self._sock.settimeout(timeout)
        self._buf = b""

    def __enter__(self) -> "_WyomingSpojeni":
        return self

    def __exit__(self, *_exc) -> None:
        try:
            self._sock.close()
        except OSError:
            pass

    def posli(self, typ: str, data: Optional[dict] = None) -> None:
        telo = json.dumps(data or {}).encode("utf-8")
        hlavicka = json.dumps(
            {"type": typ, "data_length": len(telo), "payload_length": None}
        ).encode("utf-8")
        self._sock.sendall(hlavicka + b"\n" + telo)

    def _radek(self) -> Optional[bytes]:
        while b"\n" not in self._buf:
            kus = self._sock.recv(65536)
            if not kus:
                return None
            self._buf += kus
        radek, self._buf = self._buf.split(b"\n", 1)
        return radek

    def _bajty(self, kolik: int) -> bytes:
        while len(self._buf) < kolik:
            kus = self._sock.recv(65536)
            if not kus:
                break
            self._buf += kus
        out, self._buf = self._buf[:kolik], self._buf[kolik:]
        return bytes(out)

    def prijmi(self) -> Optional[Tuple[str, dict, bytes]]:
        radek = self._radek()
        if radek is None:
            return None
        hlavicka = json.loads(radek)
        data_len = hlavicka.get("data_length") or 0
        payload_len = hlavicka.get("payload_length") or 0
        data = json.loads(self._bajty(data_len)) if data_len else {}
        payload = self._bajty(payload_len) if payload_len else b""
        return str(hlavicka.get("type", "")), data, payload


def synth(text: str, *, hlas: Optional[str] = None) -> Optional[bytes]:
    """Vyrobí PCM16 mono 24 kHz z textu. `None` = nepovedlo se.

    BLOKUJE (socket + syntéza) — volá se z `asyncio.to_thread`, nikdy
    přímo ze smyčky (poučení „blokující await zamrzne celé WS spojení",
    research 2026-08-31 §4).
    """
    text = str(text or "").strip()
    if not text:
        return None
    host, port = _rozdel_adresu(_ADRESA)
    zacatek = time.monotonic()
    rate = _PIPER_RATE_FALLBACK
    pcm = bytearray()
    try:
        with _WyomingSpojeni(host, port, _TIMEOUT) as spojeni:
            spojeni.posli(
                "synthesize",
                {"text": text, "voice": {"name": hlas or _HLAS}},
            )
            while True:
                ramec = spojeni.prijmi()
                if ramec is None:
                    break
                typ, data, payload = ramec
                if typ == "audio-start":
                    rate = int(data.get("rate") or _PIPER_RATE_FALLBACK)
                    if int(data.get("width") or 2) != 2 or int(data.get("channels") or 1) != 1:
                        logger.warning(
                            "⚠️ mluvčí: čekal jsem PCM16 mono, přišlo width=%s channels=%s",
                            data.get("width"), data.get("channels"),
                        )
                elif typ == "audio-chunk":
                    pcm += payload
                elif typ in ("audio-stop", "error"):
                    if typ == "error":
                        logger.error("❌ mluvčí: wyoming vrátil chybu: %.200s", data)
                        return None
                    break
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        logger.error("❌ mluvčí: syntéza selhala (%s): %r", _ADRESA, exc)
        return None

    if not pcm:
        logger.error("❌ mluvčí: syntéza vrátila nula bajtů — %.80s", text)
        return None

    if rate != CILOVY_RATE:
        pcm, _ = audioop.ratecv(bytes(pcm), 2, 1, rate, CILOVY_RATE, None)
        pcm = bytearray(pcm)

    trvani = time.monotonic() - zacatek
    zvuk_s = len(pcm) / (CILOVY_RATE * 2)
    logger.info(
        "🗣️ mluvčí: %d B (%.1f s zvuku) za %.2f s — „%.60s\"",
        len(pcm), zvuk_s, trvani, text,
    )
    return bytes(pcm)


def je_zivy() -> bool:
    """Odpoví wyoming server a nabízí hlasy? (STAV, ne „port je otevřený".)"""
    host, port = _rozdel_adresu(_ADRESA)
    try:
        with _WyomingSpojeni(host, port, min(_TIMEOUT, 5.0)) as spojeni:
            spojeni.posli("describe")
            while True:
                ramec = spojeni.prijmi()
                if ramec is None:
                    return False
                typ, data, _ = ramec
                if typ == "info":
                    hlasy = [
                        h.get("name")
                        for program in (data.get("tts") or [])
                        for h in (program.get("voices") or [])
                    ]
                    logger.info(
                        "✅ mluvčí Piper na %s: %d hlasů, používám %s",
                        _ADRESA, len(hlasy), _HLAS,
                    )
                    return bool(hlasy)
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        logger.warning("⚠️ mluvčí Piper na %s neodpovídá: %r", _ADRESA, exc)
        return False
