# -*- coding: utf-8 -*-
"""Fronta témat do úst LITE — dispečer řeči.

Specifikace: `projects/baklazan/zan/MLUVENI-ZANA-TECHNICKY.md` §1
a `MLUVENI-ZANA.md` §2 (karta `2026-08-27-programator-zana-04`).

Čistý Python bez závislosti na pipecat/síti — jen datová struktura
(`Tema`) a rozhodovací logika (`FrontaTemat`). Samotnou dispečerskou
smyčku (čtení `phase_emitter`, volání `deliver_text` každých ~200 ms)
tenhle modul NEobsahuje — to je práce volajícího v `zan_bridge_tool.py`.

Proč fronta existuje: **mluví právě jeden**. Dokud pusa mluví (fáze
`replying`), nic se nevstřikuje — žádné „po 15 s to risknu". Nová
odpověď smaže zastaralé průběžné hlášky ke stejné otázce. Vypršelá
platnost = zahodit, nikdy nevyslovit starou informaci jako čerstvou.
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass, field
from typing import List, Optional

logger = logging.getLogger("zan.fronta_temat")

# Doporučené platnosti (TTL) v sekundách — MLUVENI-ZANA-TECHNICKY.md §1.
TTL_ODPOVED = 120.0
TTL_OPRAVA = 60.0
TTL_PRUBEZNA = 8.0
TTL_SMALLTALK = 5.0

# Priority — nižší číslo = důležitější, při shodě vítězí starší (FIFO).
PRIORITA_ODPOVED = 0
PRIORITA_OPRAVA = 1
PRIORITA_PRUBEZNA = 2
PRIORITA_SMALLTALK = 3

# Watchdog: fronta neprázdná a nic se nevyslovilo přes tuhle dobu = zaseknutí.
WATCHDOG_S = 30.0


@dataclass
class Tema:
    """Jedna položka fronty — CO se má říct, ne hotová věta."""

    obsah: str
    priorita: int
    platnost_s: float
    interaction_id: str
    vzniklo: float = field(default_factory=time.monotonic)
    znacka: str = ""


class FrontaTemat:
    """Dispečer řeči: drží čekající témata a rozhoduje, co (ne)vyslovit.

    Nevolá nic síťového ani na pipecat — jen datová struktura + logika.
    Volající (most) zavolá `dalsi()` v pravidelné smyčce a výsledek buď
    pošle do TTS, nebo (při `None`) nic neudělá.
    """

    def __init__(self) -> None:
        self._polozky: List[Tema] = []
        self._posledni_vydani: Optional[float] = None

    # -- veřejné rozhraní -------------------------------------------------

    def pridej(self, tema: Tema) -> None:
        """Zařadí položku do fronty. Neprotlačuje, nic dalšího neřeší."""
        self._polozky.append(tema)

    def zrus_prubezne(self, interaction_id: str) -> int:
        """Smaže čekající průběžné hlášky (priorita 2) daného interaction_id.

        Volá se, jakmile dorazí finální odpověď na tu samou otázku — dál
        vyprávět „ještě to zjišťuju" poté, co je odpověď hotová, by lhalo.
        Vrací počet smazaných položek.
        """
        pred = len(self._polozky)
        self._polozky = [
            t
            for t in self._polozky
            if not (t.priorita == PRIORITA_PRUBEZNA and t.interaction_id == interaction_id)
        ]
        return pred - len(self._polozky)

    def vyprazdni(self, duvod: str = "") -> None:
        """STOP / změna tématu — smaže úplně vše, co čeká na vyslovení."""
        pocet = len(self._polozky)
        if pocet:
            logger.info("fronta_temat: vyprázdněno (%s), zahozeno %d položek", duvod, pocet)
        self._polozky.clear()

    def je_prazdna(self) -> bool:
        return not self._polozky

    def dalsi(self, pusa_mluvi: bool, nyni: Optional[float] = None) -> Optional[Tema]:
        """Vrátí co vyslovit teď, nebo `None`.

        Pravidla (MLUVENI-ZANA.md §2):
        1. Mluví právě jeden — dokud `pusa_mluvi`, nic se nevrací.
        2. Prázdná fronta -> nic.
        3. Vybírá se nejvyšší priorita (nejnižší číslo), při shodě nejstarší
           (nejmenší `vzniklo`).
        4. Vypršelá platnost se ZAHODÍ (zaloguje) a nevyslovuje — hledá se
           dál, dokud se nenajde platná položka nebo fronta nedojde.
        """
        if pusa_mluvi:
            return None
        if not self._polozky:
            return None

        nyni = time.monotonic() if nyni is None else nyni

        while self._polozky:
            # Nejvyšší priorita (min. číslo), při shodě nejstarší (min. vzniklo).
            vybrana = min(self._polozky, key=lambda t: (t.priorita, t.vzniklo))

            stari = nyni - vybrana.vzniklo
            if stari > vybrana.platnost_s:
                self._polozky.remove(vybrana)
                logger.info(
                    "fronta_temat: zahozeno po vypršení platnosti "
                    "(stáří %.1fs > TTL %.1fs, priorita=%d, interaction_id=%s): %r",
                    stari,
                    vybrana.platnost_s,
                    vybrana.priorita,
                    vybrana.interaction_id,
                    vybrana.obsah,
                )
                continue

            self._polozky.remove(vybrana)
            self._posledni_vydani = nyni
            return vybrana

        return None

    def zaseknuti(self, nyni: Optional[float] = None) -> bool:
        """Watchdog: True, když je fronta neprázdná a nic se nevydalo přes
        `WATCHDOG_S` (30 s). Volající na to reaguje logem + `vyprazdni()`.

        `_posledni_vydani` se nastavuje jen v `dalsi()`, takže dlouhé
        období, kdy fronta byla prázdná (a tedy vydávat nebylo co), sama
        o sobě zaseknutí nehlásí — až první `pridej()` po dlouhé pauze,
        které následuje přes 30 s bez dalšího `dalsi()`.
        """
        if not self._polozky:
            return False
        nyni = time.monotonic() if nyni is None else nyni
        if self._posledni_vydani is None:
            # Nikdy nic nevydáno — měřítkem je vznik nejstarší položky.
            nejstarsi = min(t.vzniklo for t in self._polozky)
            return (nyni - nejstarsi) > WATCHDOG_S
        return (nyni - self._posledni_vydani) > WATCHDOG_S
