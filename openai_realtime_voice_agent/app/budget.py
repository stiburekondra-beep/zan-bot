"""Sdílený rozpočet mostu — jedna peněženka pro VŠECHNY satelity.

Proč sdílený
------------
Účtování dosud viselo na instanci ``SafeRealtimeLLMService``
(``_zan_usage_window_tokens``), tedy na JEDNÉ relaci. Jakmile má každý
satelit vlastní relaci (což je celý smysl multiklientního mostu), počítal by
si každý svoje okno — a přitom limit u OpenAI je **na účet**, ne na relaci.
Dva satelity by tedy strop projely dvojnásobnou rychlostí a každý by přitom
hlásil, že je zhruba v polovině. Přesně tomu má tenhle modul zabránit
(zadání karty, bod 3).

Co umí
------
* **minutové okno (TPM)** — kolik tokenů spolkl CELÝ dům za poslední minutu;
  z něj se počítá ``remaining``, které se posílá satelitům do zprávy
  ``{"type":"usage"}``,
* **denní strop** — volitelný (0 = vypnuto). Loguje se překročení prahů
  (80 % a 100 %), takže se rozpočet nevyčerpá potichu,
* **tvrdý režim** (volitelný, výchozí vypnutý) — po vyčerpání denního stropu
  se NOVÝ satelit na most nepustí. Vědomě to NEumlčí satelit, který už mluví:
  brzda, která uprostřed věty vypne dům, je horší než překročený rozpočet.

Modul je čistý Python (žádné IO, hodiny jdou parametrem), aby šel testovat
offline — viz ``tests/test_multiklient.py``.
"""
from __future__ import annotations

import logging
import time
from typing import Callable, Dict, List

logger = logging.getLogger(__name__)

#: Výchozí minutový strop (odpovídá hodnotě, kterou most hlásil dosud).
DEFAULT_TPM_LIMIT = 40000
#: Prahy denního stropu, na kterých se hlásí varování (podíl z celku).
DEFAULT_THRESHOLDS = (0.8, 1.0)


def _local_day(now_wall: float) -> str:
    """Datum v místním čase jako ``YYYY-MM-DD`` (klíč denního okna)."""
    return time.strftime("%Y-%m-%d", time.localtime(now_wall))


class SharedBudget:
    """Účetnictví tokenů společné pro všechny satelity mostu."""

    def __init__(
        self,
        tpm_limit: int = DEFAULT_TPM_LIMIT,
        daily_limit: int = 0,
        hard_stop: bool = False,
        thresholds=DEFAULT_THRESHOLDS,
        monotonic: Callable[[], float] = time.monotonic,
        wallclock: Callable[[], float] = time.time,
    ):
        """
        Args:
            tpm_limit: strop tokenů za minutu (sdílený). 0 = nehlídat.
            daily_limit: denní strop tokenů. 0 = vypnuto.
            hard_stop: po vyčerpání denního stropu odmítat NOVÁ připojení.
            thresholds: podíly denního stropu, na kterých se loguje varování.
            monotonic: zdroj času pro minutové okno (testy si ho podstrčí).
            wallclock: zdroj času pro denní okno.
        """
        self.tpm_limit = max(0, int(tpm_limit))
        self.daily_limit = max(0, int(daily_limit))
        self.hard_stop = bool(hard_stop)
        self._thresholds = tuple(sorted(float(t) for t in thresholds))
        self._monotonic = monotonic
        self._wallclock = wallclock

        self._window_start = monotonic()
        self._window_tokens = 0
        self._day = _local_day(wallclock())
        self._day_tokens = 0
        self._day_by_client: Dict[str, int] = {}
        self._reported_thresholds: List[float] = []

    # ---- zápis -----------------------------------------------------------

    def note_usage(self, client_id: str, total_tokens: int) -> dict:
        """Zapsat spotřebu jedné odpovědi a vrátit aktuální stav rozpočtu."""
        tokens = max(0, int(total_tokens or 0))
        self._roll_windows()
        self._window_tokens += tokens
        self._day_tokens += tokens
        self._day_by_client[client_id] = self._day_by_client.get(client_id, 0) + tokens
        self._warn_if_crossed(client_id)
        return self.snapshot()

    def _roll_windows(self) -> None:
        """Překlopit minutové okno po 60 s a denní o půlnoci."""
        now = self._monotonic()
        if now - self._window_start >= 60:
            self._window_start = now
            self._window_tokens = 0
        today = _local_day(self._wallclock())
        if today != self._day:
            logger.info(
                "🗓️ nový den (%s → %s) — denní rozpočet se nuluje (včera %d tokenů: %s)",
                self._day, today, self._day_tokens,
                ", ".join(f"{k}={v}" for k, v in sorted(self._day_by_client.items())) or "nikdo",
            )
            self._day = today
            self._day_tokens = 0
            self._day_by_client = {}
            self._reported_thresholds = []

    def _warn_if_crossed(self, client_id: str) -> None:
        """Zalogovat překročení prahu denního stropu — přesně jednou za den."""
        if self.daily_limit <= 0:
            return
        ratio = self._day_tokens / float(self.daily_limit)
        for threshold in self._thresholds:
            if ratio >= threshold and threshold not in self._reported_thresholds:
                self._reported_thresholds.append(threshold)
                rozpis = ", ".join(
                    f"{k}={v}" for k, v in sorted(self._day_by_client.items())
                )
                logger.warning(
                    "💸 denní rozpočet mostu na %.0f %% (%d/%d tokenů; %s)%s",
                    threshold * 100, self._day_tokens, self.daily_limit, rozpis,
                    " — tvrdý režim: další satelit se už nepřipojí"
                    if (threshold >= 1.0 and self.hard_stop) else "",
                )

    # ---- čtení -----------------------------------------------------------

    def snapshot(self) -> dict:
        """Stav rozpočtu pro log i pro zprávu ``usage`` satelitu."""
        self._roll_windows()
        now = self._monotonic()
        limit = self.tpm_limit or 0
        remaining = max(0, limit - self._window_tokens) if limit else 0
        snap = {
            "limit": limit,
            "remaining": remaining,
            "window_tokens": self._window_tokens,
            "reset_seconds": max(0, int(60 - (now - self._window_start))),
            "day_tokens": self._day_tokens,
            "day_limit": self.daily_limit,
            "day_exhausted": self.is_day_exhausted(),
        }
        if self.daily_limit:
            snap["day_remaining"] = max(0, self.daily_limit - self._day_tokens)
        return snap

    def is_day_exhausted(self) -> bool:
        """Je denní strop vyčerpaný? (Bez stropu nikdy.)"""
        return bool(self.daily_limit) and self._day_tokens >= self.daily_limit

    def allow_new_client(self) -> tuple[bool, str]:
        """Smí se teď připojit DALŠÍ satelit?

        Vrací ``(smí, důvod)``. Odmítá jen v tvrdém režimu a jen po vyčerpání
        denního stropu — satelit, který už na mostě je, se nikdy neumlčuje.
        """
        if self.hard_stop and self.is_day_exhausted():
            return False, (
                f"denní rozpočet vyčerpán ({self._day_tokens}/{self.daily_limit} tokenů)"
            )
        return True, ""

    def describe(self) -> str:
        """Jednořádkový popis do startovního logu."""
        casti = [f"minutový strop {self.tpm_limit or 'nehlídá se'}"]
        if self.daily_limit:
            casti.append(
                f"denní strop {self.daily_limit} tokenů"
                + (" (tvrdý)" if self.hard_stop else " (jen varování)")
            )
        else:
            casti.append("denní strop vypnutý")
        return ", ".join(casti)
