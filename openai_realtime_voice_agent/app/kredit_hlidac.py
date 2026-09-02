"""Hlídač zůstatku u poskytovatele — ticho je horší než pád s hláškou.

Proč to existuje
----------------
1. 9. 2026 v 17:14:02 došel u OpenAI kredit. Most se pak **208×** marně
pokusil připojit, hlas hodinu mlčel a první, kdo si toho všiml, byl Ondra.
Žádná hlídka to neohlásila — a nemohla: ``app/budget.py`` hlídá TOKENY
(minutové okno, denní strop), tedy naši spotřebu. **Zůstatek na účtě
u poskytovatele je jiná veličina** a most o ní nevěděl vůbec.

Rozdíl, na kterém to stálo: vyčerpaný denní strop je stav, který jsme si
sami nastavili a umíme ho spočítat. Vyčerpaný kredit je stav u někoho
jiného — pozná se jedině podle toho, že poskytovatel začne odmítat. A
odmítá **stejným tvarem chyby**, jakým odmítá spadlá síť, takže se to bez
téhle klasifikace ztratí v šumu reconnectů.

Co modul dělá (a co ne)
-----------------------
* **Klasifikuje** chybu na „došel kredit / neplatný klíč / vyčerpaná
  kvóta / něco jiného" podle textu (``klasifikuj``).
* **Počítá je za sebou** v okně a teprve po ``prah`` po sobě jdoucích
  ohlásí poplach **jednou** (``KreditHlidac.zaznamenej``). Jeden 402
  uprostřed noci může být překlep na straně poskytovatele; tři v řadě
  nejsou.
* **Řekne, kam přepnout** (``zaloha_pro``) a **jakou větou to oznámit**
  (``veta_oznameni``) — česky, bez číslic a bez žargonu, protože to jde
  do uší (past č. 11 z ústavy: text pro oči ≠ text pro uši).

Co NEDĚLÁ: nečte zůstatek z API poskytovatele dopředu. Návod
``zan-internal/navody/hlidej-si-rozpocet.md``, oddíl „KDYŽ TO NEJDE",
tuhle náhradu pojmenovává přímo: *„Poskytovatel nemá žádný veřejný způsob,
jak zjistit zůstatek → nevymýšlím si číslo, navrhnu náhradu — sledování
posledního úspěšného volání a alarm při první chybě."* Tohle je ta
náhrada, ne kontrola zůstatku dopředu, a takhle se to má i hlásit.

Modul je **čistá stdlib** (hodiny jdou parametrem), aby šel testovat
offline — ``tests/test_kredit_hlidac.py``.
"""

from __future__ import annotations

import logging
import time
from typing import Callable, Optional, Tuple

logger = logging.getLogger(__name__)

#: Kolik po sobě jdoucích „došel kredit" chyb se snese, než se troubí.
#: Jedna může být výpadek na jejich straně; tři v řadě jsou stav účtu.
VYCHOZI_PRAH = 3
#: Jak dlouho se počítadlo drží. Delší mezera = jiná epizoda, počítá se
#: od nuly (jinak by se za týden sečetly tři nesouvisející výpadky).
VYCHOZI_OKNO_S = 600.0

#: Kdo je čí záloha. Jeden mozek, vyměnitelná pusa — rozhodnutí A-prim.
_ZALOHA = {"openai": "gemini", "gemini": "openai"}

#: Otisky v textu chyby, které znamenají „na účtě nejsou peníze".
#: Opsané z dokumentace obou poskytovatelů a z hlášek, které skutečně
#: chodí (OpenAI ``insufficient_quota`` / HTTP 402, Google
#: ``RESOURCE_EXHAUSTED`` s billingem).
_OTISKY_KREDIT = (
    "insufficient_quota",
    "insufficient quota",
    "exceeded your current quota",
    "billing_hard_limit_reached",
    "billing hard limit",
    "credit balance is too low",
    "check your plan and billing",
    "payment required",
    "http 402",
    "status 402",
    "quota_exceeded",
    "billing account",
)
#: Otisky „klíč je neplatný/odvolaný" — jiná porucha, stejný následek
#: (hlas mlčí), ale přepnutí na zálohu ji NEVYŘEŠÍ, když je klíč špatně
#: všude. Rozlišuje se schválně, ať se v logu nehádá o příčinu.
_OTISKY_KLIC = (
    "invalid_api_key",
    "incorrect api key",
    "invalid authentication",
    "api key not valid",
    "unauthorized",
    "http 401",
    "status 401",
    "permission_denied",
    "http 403",
    "status 403",
)
#: Otisky „moc rychle, zkus později" — NENÍ to došlý kredit, přepínat se
#: nemá. Kdyby se sem spletlo rate limitování, hlídač by pusu přehazoval
#: při každém rušném večeru.
_OTISKY_RYCHLOST = (
    "rate limit",
    "rate_limit_exceeded",
    "too many requests",
    "http 429",
    "status 429",
    "requests per minute",
    "tokens per min",
)


def zaloha_pro(pusa: str) -> str:
    """Na kterou pusu se má přepnout, když tahle nemůže mluvit."""
    return _ZALOHA.get((pusa or "").strip().lower(), "openai")


def klasifikuj(chyba) -> str:
    """``"kredit"`` | ``"klic"`` | ``"rychlost"`` | ``""`` (nic z toho).

    Bere výjimku i holý text. Pořadí testů má význam: „rate limit" se
    kontroluje PRVNÍ, protože hlášky o kvótě a o rychlosti sdílejí slovo
    „quota" a splést je znamená přepínat pusu při každém rušném večeru.
    """
    text = ("%s %s" % (type(chyba).__name__, chyba)
            if isinstance(chyba, BaseException) else str(chyba or ""))
    t = text.lower()
    if not t.strip():
        return ""
    if any(o in t for o in _OTISKY_RYCHLOST):
        return "rychlost"
    if any(o in t for o in _OTISKY_KREDIT):
        return "kredit"
    if any(o in t for o in _OTISKY_KLIC):
        return "klic"
    return ""


def veta_oznameni(pusa: str, druh: str = "kredit") -> str:
    """Co Žán řekne nahlas. Do uší, ne do logu.

    Pravidla, kterými se to řídí (a proto to nevypadá jako chybová
    hláška): žádné číslice, žádný název poskytovatele, žádný žargon
    o sobě („mozek", „session", „pusa") — prompt pusy má tohle všechno
    zakázané a Žán nemůže mluvit jednou tak a jednou jinak.
    """
    zal = zaloha_pro(pusa)
    if druh == "klic":
        return ("Nepustí mě to k mému hlasu, tak zkusím ten druhý. "
                "Kdyby to nešlo, budeš to muset odemknout ty.")
    if zal:
        return ("Došel mi limit u toho, čím mluvím, tak jedu na záložním. "
                "Může to znít trochu jinak.")
    return "Došel mi limit u toho, čím mluvím, a nemám kam přepnout."


class KreditHlidac:
    """Počítá po sobě jdoucí odmítnutí od poskytovatele a jednou zatroubí.

    Fail-safe směrem k tichu: neznámá chyba počítadlo **vynuluje**
    (jde nejspíš o běžný výpadek sítě), takže se nesbírají nesouvisející
    poruchy do falešného poplachu. Naopak jednou vyhlášený poplach se
    sám neruší — dokud někdo nesáhne na účet, stav trvá.
    """

    def __init__(
        self,
        pusa: str,
        prah: int = VYCHOZI_PRAH,
        okno_s: float = VYCHOZI_OKNO_S,
        monotonic: Callable[[], float] = time.monotonic,
    ) -> None:
        self.pusa = (pusa or "openai").strip().lower()
        self.prah = max(1, int(prah))
        self.okno_s = float(okno_s)
        self._monotonic = monotonic
        self._pocet = 0
        self._prvni_v_okne = 0.0
        self._posledni = 0.0
        self._druh = ""
        #: True, jakmile poplach jednou zazněl. Druhý už netroubí.
        self.ohlaseno = False

    # -- vstup ------------------------------------------------------------

    def zaznamenej(self, chyba) -> Optional[Tuple[str, str, str]]:
        """Přidej jednu chybu. Vrací ``(druh, zaloha, veta)`` při poplachu.

        ``None`` znamená „zatím nic k hlášení" — buď to nebyla chyba
        o penězích, nebo jich ještě není dost za sebou, nebo už se
        troubilo.
        """
        druh = klasifikuj(chyba)
        if druh in ("", "rychlost"):
            # Běžný výpadek nebo rate limit: epizoda o penězích končí.
            self._pocet = 0
            self._druh = ""
            return None

        ted = self._monotonic()
        if self._pocet == 0 or (ted - self._prvni_v_okne) > self.okno_s:
            self._pocet = 0
            self._prvni_v_okne = ted
        if druh != self._druh:
            # Změna povahy chyby = nová epizoda (kredit vs. klíč).
            self._pocet = 0
            self._prvni_v_okne = ted
            self._druh = druh
        self._pocet += 1
        self._posledni = ted

        if self.ohlaseno or self._pocet < self.prah:
            return None
        self.ohlaseno = True
        zal = zaloha_pro(self.pusa)
        veta = veta_oznameni(self.pusa, druh)
        logger.error(
            "💳 POPLACH: poskytovatel odmítá pořád dokola (%dx za sebou, druh=%s, "
            "pusa=%s). Tohle NENÍ spadlá síť ani vyčerpaný denní strop tokenů — "
            "vypadá to na došlý zůstatek u poskytovatele. Záloha: %s. "
            "1. 9. 2026 tenhle stav znamenal hodinu ticha, o kterém nikdo nevěděl.",
            self._pocet, druh, self.pusa, zal,
        )
        return druh, zal, veta

    def snapshot(self) -> dict:
        """Stav pro diagnostiku (``/prubeh``, testy, log při startu)."""
        return {
            "pusa": self.pusa,
            "zaloha": zaloha_pro(self.pusa),
            "druh": self._druh,
            "pocet_za_sebou": self._pocet,
            "prah": self.prah,
            "ohlaseno": self.ohlaseno,
        }
