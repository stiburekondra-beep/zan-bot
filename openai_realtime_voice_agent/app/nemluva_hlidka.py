# -*- coding: utf-8 -*-
"""Po neúspěchu rychlé dráhy nesmí být ticho — hlídka němoty.

ŽIVÁ ZÁMINKA (revize hovorů 2026-08-30, 18:58–19:02)
----------------------------------------------------
Pět po sobě jdoucích akcí skončilo ``unconfirmed`` a **ani u jedné
nenásledovala odpověď**::

    18:58:41  akce pustit hudbu → (bez entity) = unconfirmed
    18:59:09  akce pustit hudbu → (bez entity) = unconfirmed
    19:00:35  akce vypnout      → (bez entity) = unconfirmed   („Vypni televizi.")
    19:02:15  akce vypnout      → Lounge/Bedroom = unconfirmed

Člověk stál v pokoji, nic se nestalo a nikdo nic neřekl — a tak to zkusil
znovu, hlasitěji. Kritérium SLUHY č. 4 (``MLUVENI-ZANA.md §9``) přitom říká:
„Když se ověřit nedá, zazní přesně to: ‚Povel odešel, ale zařízení stav
nepotvrdilo.'"

PROČ TO NESTAČÍ VYŘEŠIT INSTRUKCÍ MODELU
----------------------------------------
``fastlane_mixin._verdict_text`` už modelu říká, ať tu větu vysloví, a od
2. 9. jde neúspěch navíc za mozkem (``app/predani_mozku``). Obojí je
**prosba**: model ji občas nesplní (přesně to je nález z 30. 8.) a mozek
může odpovědět za deset vteřin nebo vůbec. Tohle je **mechanismus** — když
do lhůty nikdo nepromluví, výplň se zařadí do fronty mluvení.

CO TENHLE MODUL SCHVÁLNĚ NEDĚLÁ
-------------------------------
Nemluví. Vrací jen rozhodnutí „teď je splatná tahle věta"; kdo ji vysloví,
řeší volající — a smí to být **jenom fronta témat** (``app/fronta_temat.py``
přes ``app/dispecer_reci.py``), nikdy vlastní cesta do pipeline. Pátý
nezávislý mluvčí je právě to, co ruší karta ``2026-08-27-programator-zana-04``
(„mluví právě jeden").

Modul je proto čistá logika nad daty a časem: bez pipecatu, bez sítě,
bez asyncia — aby se dal otestovat celý, ne jen obejít.
"""

from __future__ import annotations

import logging
import os
import time
from dataclasses import dataclass
from typing import Callable, Optional

logger = logging.getLogger("zan.nemluva_hlidka")

#: Jak dlouho se čeká, jestli promluví model nebo mozek, než se sáhne po
#: výplni. Karta ``2026-08-30-programator-zana-13`` chce větu „do pár vteřin"
#: a hotovo měří „po ``unconfirmed`` do ~10 s věta" — šest vteřin je uvnitř
#: obojího a zároveň dost dlouho, aby normální odpověď modelu stihla přijít
#: dřív (živě 1–3 s od dokončení akce).
TTL_S = float(os.environ.get("ZAN_NEMLUVA_TTL_S", "6") or 6)

#: Verdikty, po kterých MUSÍ něco zaznít. ``ok`` mezi nimi schválně není:
#: po povedené akci mluví model o výsledku a výplň by byla druhý hlas.
NEME_VERDIKTY = frozenset({"unconfirmed", "fail", "error", "ha_down"})

#: CO se řekne. Věty jsou doslovné podle ``MLUVENI-ZANA.md §9`` — výplň má
#: přiznat pravdu, ne ji přebarvit. ``nepotvrdilo_stav`` je zároveň jméno
#: záměru v knihovně frází (``generovat-fraze.js``), takže se dá dohledat,
#: že jde o tutéž větu na obou stranách.
VETY = {
    "unconfirmed": "Povel odešel, ale zařízení stav nepotvrdilo.",
    "fail": "Nepovedlo se mi to, zjišťuju proč.",
    "error": "Nepovedlo se mi to, zjišťuju proč.",
    "ha_down": "Home Assistant neodpovídá, nemůžu to teď ověřit.",
}

#: Značka do logu i do fronty — ať jde jedním grepem spočítat, kolikrát
#: musela hlídka zaskočit za mlčícího mluvčího.
ZNACKA = "nemluva-hlidka"

#: Jméno záměru z knihovny frází, na které se karta odvolává.
ZAMER = "nepotvrdilo_stav"


@dataclass(frozen=True)
class Vypln:
    """Co se má říct, kdyby do lhůty nikdo nepromluvil."""

    text: str
    verdikt: str
    tah: float
    interaction_id: str
    vzniklo: float

    def zbyva_s(self, nyni: float, ttl_s: float) -> float:
        """Kolik sekund ještě zbývá do splatnosti (může být záporné)."""
        return ttl_s - (nyni - self.vzniklo)


class NemluvaHlidka:
    """Drží NEJVÝŠ JEDNU čekající výplň a ví, kdy je splatná.

    Životní cyklus jednoho tahu::

        po_akci('unconfirmed', tah=t)   # natažení
        promluveno()                     # ...pokud někdo promluvil → zrušeno
        splatna(nyni=t+TTL)              # ...jinak vrátí Vypln k vyslovení

    `hodiny` je injektovatelné schválně: test nesmí čekat reálné vteřiny.
    """

    def __init__(self, *, ttl_s: float = TTL_S,
                 hodiny: Callable[[], float] = time.monotonic) -> None:
        self._ttl_s = float(ttl_s)
        self._hodiny = hodiny
        self._ceka: Optional[Vypln] = None
        #: Razítko tahu, ve kterém se naposled natahovalo. Jeden tah = nejvýš
        #: jedna výplň; jinak by dvě volání nástroje v jedné větě (živě
        #: 19:02:15 dvakrát `vypnout`) vyrobila dvě věty za sebou.
        self._posledni_tah: float = 0.0
        #: Počitadla pro důkaz z provozu, ne jen z testu.
        self.zaskocila = 0
        self.zrusena = 0

    @property
    def ttl_s(self) -> float:
        return self._ttl_s

    def ceka(self) -> Optional[Vypln]:
        """Co je natažené (bez ohledu na splatnost). Pro logy a testy."""
        return self._ceka

    # -- vstupy -----------------------------------------------------------

    def po_akci(self, verdikt: str, *, tah: float = 0.0,
                interaction_id: str = "") -> Optional[Vypln]:
        """Konec akce rychlé dráhy → natáhnout hlídku, nebo ne.

        Vrací nataženou výplň (pro log volajícího), nebo ``None``, když se
        nenatahuje: po ``ok``, po neznámém verdiktu a podruhé v tomtéž tahu.
        """
        verdikt = str(verdikt or "")
        if verdikt not in NEME_VERDIKTY:
            return None
        text = VETY.get(verdikt)
        if not text:  # pragma: no cover - NEME_VERDIKTY a VETY drží spolu
            return None
        tah = float(tah or 0.0)
        if tah and self._posledni_tah and tah == self._posledni_tah:
            logger.debug("%s: tentýž tah (%.3f) — druhou výplň nenatahuju",
                         ZNACKA, tah)
            return None
        self._posledni_tah = tah
        self._ceka = Vypln(
            text=text,
            verdikt=verdikt,
            tah=tah,
            interaction_id=interaction_id or ("fastlane-%.3f" % tah),
            vzniklo=self._hodiny(),
        )
        logger.info("%s: nataženo po %s — když do %.0f s nikdo nepromluví, "
                    "řeknu %r", ZNACKA, verdikt, self._ttl_s, text)
        return self._ceka

    def promluveno(self, kdo: str = "") -> bool:
        """Někdo promluvil (model nebo mozek) → výplň už není potřeba.

        Vrací True, když se opravdu něco rušilo — ať jde spočítat, jak často
        mluvčí zaskočil sám a hlídka nemusela.
        """
        if self._ceka is None:
            return False
        logger.info("%s: %s promluvil včas — výplň %r ruším",
                    ZNACKA, kdo or "mluvčí", self._ceka.text)
        self._ceka = None
        self.zrusena += 1
        return True

    def zrus(self, duvod: str = "") -> None:
        """STOP / „zmlkni" / konec session — po tomhle už nesmí nic zaznít."""
        if self._ceka is not None:
            logger.info("%s: zahazuju čekající výplň (%s)", ZNACKA, duvod or "bez důvodu")
            self._ceka = None

    # -- výstup -----------------------------------------------------------

    def splatna(self, nyni: Optional[float] = None) -> Optional[Vypln]:
        """Je výplň splatná? Když ano, vrátí ji a SPOTŘEBUJE.

        Spotřebování je podstatné: kdyby výplň zůstala viset, vyslovila by se
        podruhé u dalšího tiku a v pokoji by tatáž věta zazněla dvakrát.
        """
        if self._ceka is None:
            return None
        nyni = self._hodiny() if nyni is None else nyni
        if self._ceka.zbyva_s(nyni, self._ttl_s) > 0:
            return None
        vypln = self._ceka
        self._ceka = None
        self.zaskocila += 1
        logger.warning(
            "🔇 %s: po %s nikdo %.0f s nepromluvil — zařazuju do fronty %r",
            ZNACKA, vypln.verdikt, self._ttl_s, vypln.text,
        )
        return vypln
