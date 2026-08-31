# -*- coding: utf-8 -*-
"""Drát mezi mostem a plátnem: SESSION REŽIM (kdy Žanvis poslouchá).

Protistrana je `zan/zanvis/platno/session-stav.js` za HTTP rozhraním
`/api/session` (plátno, default `http://127.0.0.1:4600`):

  * ``GET  /api/session``  → stav ``{mode, base, muted, listening, …}``
  * ``POST /api/session``  → ``{action: 'heard'}`` posune okno ticha,
    ``{action: 'mute', muted: true|false}`` zrcadlí fyzický mute satelitu.

Tři dráty, každý zvlášť:

1. **heard** — při každém FINÁLNÍM přepisu. Fire-and-forget: hlas na tom
   nikdy nesmí stát, tak se výsledek jen loguje.
2. **mute** — když satelit ohlásí fyzicky vypnutý mikrofon. Software mute
   nevyrábí ani neruší, jen zrcadlí, co zařízení řeklo.
3. **gate** — každých ``PLATNO_POLL_S`` (30 s) se čte ``listening``. Když je
   ``false``, most nepouští mikrofonní audio dál do pusy.
4. **reflex** — při každém FINÁLNÍM přepisu jde text i na ``/api/reflex``
   (viz ``CESTA_REFLEX`` níž). Scénický povel se tak odbaví hned, ne až
   po kole přes Realtime model.

FAIL-SAFE (a proto ``_posloucha`` startuje na ``True``): **dům nesmí
ohluchnout kvůli UI.** Když plátno neběží, odpoví chybou nebo pošle
nesmysl, chováme se přesně jako dosud — posloucháme. Brzda, která při
„nevím" zavře ucho, by z výpadku pomocné vizualizace udělala výpadek
hlasu; tady je fail-open správně, protože gate nic nekoná, jen mlčí.

GATE JE VE VÝCHOZÍM STAVU VYPNUTÝ (``PLATNO_SESSION_GATE=false``).
Důvod je věcný, ne opatrnický: výchozí režim plátna je ``spi``, kde
``listening=false`` — a satelit streamuje i ve ``spi``, protože wake word
běží lokálně na něm a spojení otevře až po „Baklažáne". Zapnutý gate by
tedy zahodil i normální wake-word tah a dům by oněměl. Než se gate zapne,
musí být natažený druhý drát (wake → ``start('voice')`` na plátně), nebo
stačí ``PLATNO_GATE_WAKE_GRACE_S`` (default 30 s), které po každém wake
na chvíli otevře cestu i při ``listening=false``.

Bez pipecatu schválně — tenhle modul rozhoduje nad daty a jde testovat
bez zvukové roury (``tests/test_session_klient.py``).
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import threading
import time
import urllib.error
import urllib.request
from typing import Any, Callable, Dict, Optional

logger = logging.getLogger(__name__)

VYCHOZI_URL = "http://127.0.0.1:4600"
VYCHOZI_POLL_S = 30.0
VYCHOZI_WAKE_GRACE_S = 30.0
CESTA = "/api/session"
# REFLEXY (30. 8. 2026): druhá cesta na tomtéž plátně. Scénické povely
# („ukaž vesmír rodiny", „domů", „posuň níž") nemají co dělat u modelu —
# jsou to čistě lokální, vratné změny obrazu bez vnějšího účinku. Když
# se pošlou sem HNED po finálním přepisu, obraz se přepne za desítky
# milisekund; přes Realtime model to trvá sekundy a Ondra to popsal
# přesně takhle: „ne nejsou to reflexy a nezabiraji hned".
#
# Klasifikaci NEDĚLÁME tady — je jediná, v `platno/reflexes.js`. Most jen
# podá přepis a plátno řekne, jestli to reflex byl (`accepted`). Tím se
# seznam frází udržuje na JEDNOM místě, ne ve dvou, které se rozejdou.
CESTA_REFLEX = "/api/reflex"


def _env_float(name: str, default: float) -> float:
    try:
        return float(str(os.environ.get(name, "")).strip() or default)
    except (TypeError, ValueError):
        return default


def _env_bool(name: str, default: bool) -> bool:
    raw = str(os.environ.get(name, "")).strip().lower()
    if raw in ("1", "true", "yes", "on"):
        return True
    if raw in ("0", "false", "no", "off"):
        return False
    return default


def _http(url: str, token: str, payload: Optional[dict], timeout: float) -> dict:
    """Jedno HTTP volání na plátno. Blokující — volá se ve vlákně."""
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    headers = {"Accept": "application/json"}
    if payload is not None:
        headers["Content-Type"] = "application/json"
    if token:
        headers["Authorization"] = "Bearer " + token
    req = urllib.request.Request(url, data=data, headers=headers,
                                 method="POST" if payload is not None else "GET")
    with urllib.request.urlopen(req, timeout=timeout) as odpoved:
        telo = odpoved.read().decode("utf-8", "replace")
    try:
        vysledek = json.loads(telo)
    except ValueError:
        return {}
    return vysledek if isinstance(vysledek, dict) else {}


class SessionKlient:
    """Klient plátnového `/api/session` + rozhodnutí, jestli pustit audio."""

    def __init__(
        self,
        url: Optional[str] = None,
        token: Optional[str] = None,
        *,
        poll_s: Optional[float] = None,
        gate: Optional[bool] = None,
        wake_grace_s: Optional[float] = None,
        timeout_s: float = 3.0,
        ted: Optional[Callable[[], float]] = None,
        http: Optional[Callable[[str, str, Optional[dict], float], dict]] = None,
    ) -> None:
        base = (url if url is not None else os.environ.get("PLATNO_URL", "")).strip()
        self.url = (base or VYCHOZI_URL).rstrip("/") + CESTA
        self.url_reflex = (base or VYCHOZI_URL).rstrip("/") + CESTA_REFLEX
        # Plátno odmítá přehrát starší přepis téže interakce
        # (`transcript_version <= seen` → `stale`). Most má jeden hlas, tak
        # stačí monotónní čítač — každý finální přepis je nová interakce.
        self._reflex_n = 0
        self.token = (token if token is not None else os.environ.get("PLATNO_TOKEN", "")).strip()
        self.poll_s = poll_s if poll_s is not None else _env_float("PLATNO_POLL_S", VYCHOZI_POLL_S)
        self.gate = gate if gate is not None else _env_bool("PLATNO_SESSION_GATE", False)
        self.wake_grace_s = (
            wake_grace_s if wake_grace_s is not None
            else _env_float("PLATNO_GATE_WAKE_GRACE_S", VYCHOZI_WAKE_GRACE_S)
        )
        self.timeout_s = timeout_s
        self.ted = ted if ted is not None else time.monotonic
        self._http = http if http is not None else _http

        # FAIL-SAFE: dokud plátno neřeklo jinak, posloucháme.
        self._posloucha = True
        self._stav: Dict[str, Any] = {}
        self._dostupne: Optional[bool] = None   # None = ještě jsme se neptali
        self._wake_do = 0.0
        self._task: Optional[asyncio.Task] = None
        self._bezi = False
        logger.info(
            "🎚️ session klient: %s gate=%s poll=%.0fs wake_grace=%.0fs",
            self.url, "zapnutý" if self.gate else "vypnutý (jen hlásí)",
            self.poll_s, self.wake_grace_s,
        )

    # -- rozhodnutí -------------------------------------------------------

    @property
    def posloucha(self) -> bool:
        """Poslední známé `listening` z plátna (fail-safe True)."""
        return self._posloucha

    @property
    def stav(self) -> Dict[str, Any]:
        return dict(self._stav)

    def pusti_audio(self) -> bool:
        """Smí mikrofonní rámec dál do pusy?

        Pořadí je schválně takové, aby každá nejistota končila „pusť":
        vypnutý gate → pusť, plátno říká listening → pusť, čerstvý wake →
        pusť (člověk právě promluvil, to je výslovný akt), jinak zavři.
        """
        if not self.gate:
            return True
        if self._posloucha:
            return True
        if self.wake_grace_s > 0 and self.ted() < self._wake_do:
            return True
        return False

    def note_wake(self) -> None:
        """Satelit hlásí wake word — otevři cestu na `wake_grace_s`."""
        self._wake_do = self.ted() + max(0.0, self.wake_grace_s)

    # -- dráty ven --------------------------------------------------------

    def heard(self) -> None:
        """Finální přepis = slyšeli jsme řeč. Fire-and-forget."""
        self._posli({"action": "heard"})

    def mute(self, muted: bool, reason: str = "satelit") -> None:
        """Satelit ohlásil (od)mutování mikrofonu. Fire-and-forget."""
        self._posli({"action": "mute", "muted": bool(muted), "reason": reason})

    def reflex(self, transcript: str) -> None:
        """Finální přepis → plátnu na posouzení, jestli je to scénický reflex.

        Fire-and-forget, stejně jako `heard()`. Hlas na tom NESMÍ stát:
        když plátno neběží nebo reflex nesedne, nestane se nic a povel
        normálně dojede k modelu — což je přesně dnešní chování. Jediné,
        co se přidává, je RYCHLÁ ZKRATKA pro čistě obrazové povely.
        """
        text = str(transcript or "").strip()
        if not text:
            return
        self._reflex_n += 1
        self._posli(
            {
                "transcript": text,
                # Jedna interakce = jeden finální přepis. Plátno si podle
                # dvojice (id, verze) hlídá, že nepřehraje starší přepis.
                "interaction_id": "most-%d-%d" % (int(time.time()), self._reflex_n),
                "transcript_version": 1,
            },
            url=self.url_reflex,
        )

    def _posli(self, payload: dict, url: Optional[str] = None) -> None:
        cil = url or self.url
        try:
            smycka = asyncio.get_running_loop()
        except RuntimeError:
            smycka = None
        if smycka is not None:
            smycka.create_task(self._posli_async(payload, cil))
            return
        # Mimo event loop (test, sync callback) — vlastní vlákno, ať to
        # nikoho nezdrží.
        threading.Thread(target=self._posli_blokujici, args=(payload, cil), daemon=True).start()

    async def _posli_async(self, payload: dict, url: Optional[str] = None) -> None:
        await asyncio.to_thread(self._posli_blokujici, payload, url)

    def _posli_blokujici(self, payload: dict, url: Optional[str] = None) -> None:
        cil = url or self.url
        if cil == self.url_reflex:
            return self._reflex_blokujici(payload)
        try:
            odpoved = self._http(self.url, self.token, payload, self.timeout_s)
        except Exception as exc:  # noqa: BLE001 — hlas na plátně nestojí
            self._nedostupne(exc, payload.get("action"))
            return
        self._dostupne = True
        session = odpoved.get("session")
        if isinstance(session, dict):
            self._prevezmi(session)

    def _reflex_blokujici(self, payload: dict) -> None:
        """POST /api/reflex — a do logu jen to, co reflex OPRAVDU udělal."""
        try:
            odpoved = self._http(self.url_reflex, self.token, payload, self.timeout_s)
        except Exception as exc:  # noqa: BLE001 — hlas na reflexu nestojí
            self._nedostupne(exc, "reflex")
            return
        self._dostupne = True
        if odpoved.get("accepted") is True:
            zamer = (odpoved.get("reflex") or {}).get("intent")
            logger.info(
                "⚡ reflex '%s' → %s (revize %s)",
                str(payload.get("transcript", ""))[:60], zamer, odpoved.get("revision"),
            )
        else:
            # `no_reflex` je NORMÁLNÍ a nejčastější stav — běžná věta pro
            # model není reflex. Na debug, ať to nezavalí info log.
            logger.debug(
                "reflex nesedl ('%s'): %s",
                str(payload.get("transcript", ""))[:60], odpoved.get("reason"),
            )
        session = odpoved.get("session")
        if isinstance(session, dict):
            self._prevezmi(session)

    # -- poll dovnitř -----------------------------------------------------

    async def tik(self) -> bool:
        """Jedno přečtení stavu z plátna. Vrací, jestli se to povedlo."""
        try:
            stav = await asyncio.to_thread(self._http, self.url, self.token, None, self.timeout_s)
        except Exception as exc:  # noqa: BLE001
            self._nedostupne(exc, "poll")
            return False
        self._dostupne = True
        self._prevezmi(stav)
        return True

    def _prevezmi(self, stav: Dict[str, Any]) -> None:
        if not isinstance(stav, dict) or "listening" not in stav:
            # Odpověď bez `listening` není odpověď — nehádej, poslouchej.
            self._posloucha = True
            return
        nove = stav.get("listening") is True
        if nove != self._posloucha:
            logger.info(
                "🎚️ plátno: listening=%s (mode=%s, reason=%s) → mikrofon %s",
                nove, stav.get("mode"), stav.get("reason"),
                "pouštím" if (nove or not self.gate) else "zavírám",
            )
        self._posloucha = nove
        self._stav = stav

    def _nedostupne(self, exc: BaseException, co: Optional[str]) -> None:
        """Plátno neodpovědělo. Hlásí se jen při ZMĚNĚ, ať log nezavalí."""
        if self._dostupne is not False:
            logger.warning(
                "⚠️ plátno %s nedostupné (%s: %r) — poslouchám dál jako dosud",
                self.url, co, exc,
            )
        self._dostupne = False
        self._posloucha = True   # fail-safe

    # -- smyčka -----------------------------------------------------------

    async def _smycka(self) -> None:
        while self._bezi:
            await self.tik()
            try:
                await asyncio.sleep(self.poll_s)
            except asyncio.CancelledError:
                raise

    def start(self) -> None:
        """Nastartuje periodický poll. Idempotentní."""
        if self._task is not None and not self._task.done():
            return
        self._bezi = True
        self._task = asyncio.create_task(self._smycka(), name="session-klient-poll")

    async def zastav(self) -> None:
        self._bezi = False
        task, self._task = self._task, None
        if task is None or task.done():
            return
        task.cancel()
        try:
            await task
        except (asyncio.CancelledError, Exception):  # noqa: BLE001
            pass
