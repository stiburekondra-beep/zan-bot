"""Druhý svědek útržkové pojistky: ARGUMENTY volání, když přepis nedorazil.

ŽIVÁ ZÁMINKA (2. 9. 2026, 18:02, děti u televize)
-------------------------------------------------
Dítě si řeklo o pohádku ze seznamu, který mu Žán před chvílí přečetl.
Model rozuměl správně a zavolal::

    18:02:55.597  HassMediaSearchAndPlay
                  {'media_class': 'episode',
                   'search_query': 'Rachotík nechce nastartovat'}

Přepis TOHOTO tahu ale nepřišel vůbec — poslední, co most slyšel, byl
o dvě vteřiny starší útržek ``hotýlek``. Útržková pojistka počkala 400 ms,
nedočkala se a rozhodla podle toho staršího útržku::

    18:02:56,015  ⏱️ prepis tohoto tahu nedorazil do 400 ms -- posuzuju bez nej
    18:02:56,015  🗑 útržek: HassMediaSearchAndPlay(...) NEPROVÁDÍM

Pohádka se nepustila. Vlastník to vidí jako „Žán se sekl".

PROČ NESTAČÍ DÉLE ČEKAT
----------------------
Prodloužení čekání je správné, ale tenhle večer by nezachránilo: přepis
té promluvy nepřišel ANI POZDĚJI (mezi 18:02:53 a 18:03:08 není v logu
jediná řádka ``user:``). Když svědek nedorazí, musí se soudit z toho, co
na místě zůstalo — a to jsou argumenty volání.

CO TEDY ROZHODUJE
-----------------
``search_query`` je věta, kterou model složil z toho, co slyšel. Z útržku
``hotýlek`` nikdo neposkládá „Rachotík nechce nastartovat"; ten titul stojí
v knihovně pohádek na disku. Shoda s knihovnou je proto **důkaz**, že to
povel byl, nezávislý na přepisu.

HRANICE, KTERÁ SE NESMÍ POSUNOUT
--------------------------------
Tohle NENÍ obecné změkčení pojistky. Argument smí přebít útržek jen tam,
kde je cena omylu malá a vratná — pohádka a hudba se zastaví slovem „dost".
Zásah do domu (světlo, zásuvka, ventil) zůstává **fail-closed**: ``HassTurnOn``
bez přepisu se neprovede, i kdyby v argumentech stálo cokoli. Proto je
seznam :data:`MEKKE_NASTROJE` výčtem, ne pravidlem — přidat do něj nástroj
je rozhodnutí o tom, co se smí stát omylem.

Modul je schválně BEZ pipecatu a bez stavu mostu: jde o čistý úsudek nad
třemi vstupy (jméno nástroje, argumenty, útržek), takže se dá otestovat
samostatně — ``tests/test_utrzek_argumenty.py``.
"""

from __future__ import annotations

import json
import logging
import os
import threading
import time
import unicodedata
import urllib.error
import urllib.request

logger = logging.getLogger(__name__)

#: Nástroje, u kterých smí o povelu rozhodnout ARGUMENT místo přepisu.
#:
#: Výčet, ne pravidlo. Co je tady, to se smí stát omylem — a musí jít vzít
#: zpátky jedním slovem. Pohádka a hudba ano; dům ne.
MEKKE_NASTROJE = frozenset({
    "HassMediaSearchAndPlay",
})

#: Runner pohádek — u něj se ptáme, co je v knihovně. Loopback, žádný token.
POHADKY_URL = (os.environ.get("ZAN_POHADKA_URL", "") or
               "http://127.0.0.1:8794").rstrip("/")

#: Jak dlouho se knihovna drží v paměti. Deset pohádek se nemění po minutách.
KNIHOVNA_TTL_S = float(os.environ.get("ZAN_KNIHOVNA_TTL_S", "300"))

#: Runner může spát. Čeká se na něj krátce — a když neodpoví, prostě o něm
#: nevíme; pojistka pak spadne na druhé kritérium, ne do chyby.
KNIHOVNA_TIMEOUT_S = float(os.environ.get("ZAN_KNIHOVNA_TIMEOUT_S", "1.0"))

#: Kratší slovo nese málo informace — „a", „je", „ryba" se trefí do čehokoli.
_MIN_SLOVO = 4

#: Kolik významných slov musí sedět, aby to byla shoda s titulem.
_MIN_SPOLECNYCH = 2

#: Kolik slov musí mít dotaz, aby platil za souvislou větu, ne za ozvěnu.
_MIN_SLOV_VE_VETE = 2


def norm(text) -> str:
    """Malá písmena, bez diakritiky, jen slova oddělená mezerou.

    „03 — Rachotík nechce nastartovat" → „03 rachotik nechce nastartovat".
    Bez tohohle by se dětské „rachotík" nikdy netrefilo do titulu, který má
    v knihovně před sebou pořadové číslo a pomlčku.
    """
    if not text:
        return ""
    rozlozene = unicodedata.normalize("NFKD", str(text))
    bez = "".join(z for z in rozlozene if not unicodedata.combining(z))
    pismena = [z.lower() if z.isalnum() else " " for z in bez]
    return " ".join("".join(pismena).split())


class _Knihovna:
    """Názvy pohádek a hrdinů z runneru, držené v paměti s krátkou platností.

    Zvlášť od zbytku, aby šla v testu podstrčit vlastní čtečka a aby se
    dalo ověřit, že se runneru neposílá dotaz při každém volání nástroje.
    """

    def __init__(self, nacti=None, ttl_s: float = KNIHOVNA_TTL_S):
        self._nacti = nacti or self._nacti_z_runneru
        self._ttl_s = ttl_s
        self._zamek = threading.Lock()
        self._nazvy: tuple = ()
        self._kdy = 0.0
        #: kolikrát se doopravdy sáhlo na runner (pro test cache)
        self.dotazu = 0

    @staticmethod
    def _nacti_z_runneru() -> dict:
        with urllib.request.urlopen(POHADKY_URL + "/knihovna",
                                    timeout=KNIHOVNA_TIMEOUT_S) as o:
            return json.loads(o.read().decode("utf-8"))

    @staticmethod
    def _z_odpovedi(data) -> tuple:
        """Odpověď runneru → dvojice (jak se to jmenuje, jak se to porovnává)."""
        if not isinstance(data, dict):
            return ()
        ven = []
        for polozka in (data.get("pohadky") or []):
            if not isinstance(polozka, dict):
                continue
            for klic in ("nazev", "slug"):
                syrovy = (polozka.get(klic) or "").strip()
                if syrovy:
                    ven.append((syrovy, norm(syrovy)))
        for hrdina in (data.get("hrdinove") or []):
            if not isinstance(hrdina, dict):
                continue
            for klic in ("jmeno", "slug"):
                syrovy = (hrdina.get(klic) or "").strip()
                if syrovy:
                    ven.append((syrovy, norm(syrovy)))
        return tuple((s, n) for s, n in ven if n)

    def nazvy(self) -> tuple:
        """Vrátí dvojice (název, normalizovaný název). Prázdné = nevíme."""
        with self._zamek:
            if self._nazvy and (time.monotonic() - self._kdy) <= self._ttl_s:
                return self._nazvy
        try:
            self.dotazu += 1
            data = self._nacti()
        except (urllib.error.URLError, OSError, ValueError, TypeError) as e:
            # Runner nemusí běžet. Nevědomost o knihovně není důvod k pádu —
            # jen se o jeden důkaz přijde.
            logger.debug("knihovna pohádek se nedá přečíst: %r", e)
            return ()
        nazvy = self._z_odpovedi(data)
        with self._zamek:
            self._nazvy = nazvy
            self._kdy = time.monotonic()
        return nazvy


#: Sdílená instance pro most. Testy si dělají vlastní.
KNIHOVNA = _Knihovna()


def _obsahuje_slova(velky, maly) -> bool:
    """Je `maly` souvislý úsek slov uvnitř `velky`?

    Schválně po SLOVECH, ne po písmenech: prosté ``dn in tn`` udělá z „a"
    shodu s „01 — Jak Luboš spravil hráz". Takhle laciná shoda by pojistce
    stačila na cokoli, co model vysloví.
    """
    if not maly or len(maly) > len(velky):
        return False
    return any(velky[i:i + len(maly)] == maly
               for i in range(len(velky) - len(maly) + 1))


def shoda_s_knihovnou(dotaz: str, nazvy) -> str:
    """Sedí `dotaz` na některý titul nebo hrdinu? Vrací ten název, jinak ''.

    Nejdřív souvislý úsek slov oběma směry (dotaz bez pořadového čísla se
    schová v titulu, který ho má), pak částečná shoda přes významná slova —
    dítě řekne „ta o ztracené hrázi", ne katalogové jméno.
    """
    dn = norm(dotaz)
    if not dn or not nazvy:
        return ""
    slova_dotazu = dn.split()
    # Jedno krátké slovo se trefí do všeho a nedokazuje nic.
    if len(slova_dotazu) == 1 and len(slova_dotazu[0]) < _MIN_SLOVO:
        return ""
    for syrovy, tn in nazvy:
        slova_nazvu = tn.split()
        if (_obsahuje_slova(slova_nazvu, slova_dotazu)
                or _obsahuje_slova(slova_dotazu, slova_nazvu)):
            return syrovy
    slova = {s for s in slova_dotazu if len(s) >= _MIN_SLOVO}
    if len(slova) < _MIN_SPOLECNYCH:
        return ""
    for syrovy, tn in nazvy:
        spolecna = slova & {s for s in tn.split() if len(s) >= _MIN_SLOVO}
        if len(spolecna) >= _MIN_SPOLECNYCH:
            return syrovy
    return ""


def povel_z_argumentu(function_name: str, arguments, utrzek: str = "",
                      nazvy=None) -> str:
    """Nesou argumenty samy o sobě povel? Vrací DŮVOD, prázdné = nenesou.

    Dvě kritéria, obě jen pro :data:`MEKKE_NASTROJE`:

    1. ``search_query`` sedí na titul nebo hrdinu z knihovny pohádek —
       to je důkaz nezávislý na přepisu.
    2. ``search_query`` je souvislá věta (dvě a víc slov), která NENÍ
       ozvěnou útržku. Z „hotýlek" nikdo neposkládá dvouslovný dotaz;
       když ho model vyslovil, něco slyšel. Kdyby jen zopakoval útržek,
       důkaz to není a pojistka platí dál.
    """
    if function_name not in MEKKE_NASTROJE:
        return ""
    if not isinstance(arguments, dict):
        return ""
    dotaz = str(arguments.get("search_query") or "").strip()
    dn = norm(dotaz)
    if not dn:
        return ""

    nazev = shoda_s_knihovnou(dn, nazvy if nazvy is not None else ())
    if nazev:
        return "%r je titul z knihovny pohádek (%s)" % (dotaz, nazev)

    un = norm(utrzek)
    if un and (dn == un or dn in un or un == dn):
        return ""
    if len(dn.split()) >= _MIN_SLOV_VE_VETE:
        return ("%r je souvislý dotaz, ne ozvěna útržku %r" % (dotaz, utrzek))
    return ""


def omluva(function_name: str, arguments, prepis_dorazil: bool,
           utrzek: str = "", nazvy=None) -> str:
    """Smí se volání provést, i když útržková pojistka říká ne?

    Vrací DŮVOD, proč ano (do logu), nebo prázdný řetězec = zákaz platí.

    Podmínka, která to celé drží pohromadě: ``prepis_dorazil is False``.
    Když přepis TOHOTO tahu dorazil a nebyl to povel, model jedná na šumu
    a argumenty na tom nic nemění — blokuje se dál. Argument je náhradní
    svědek, ne odvolací instance.
    """
    if prepis_dorazil:
        return ""
    if nazvy is None:
        nazvy = KNIHOVNA.nazvy()
    return povel_z_argumentu(function_name, arguments, utrzek=utrzek,
                             nazvy=nazvy)


def omluva_z_mostu(sluzba, function_name: str, arguments, cerstvy_s: float,
                   ted=time.monotonic, nazvy=None) -> str:
    """Totéž, ale vstupy si přečte z mostu (``fastlane_mixin`` volá tohle).

    ASYMETRIE, NA KTERÉ TO 2. 9. 2026 SPADLO. Most má dvě různě široká
    okna pro tutéž otázku „je tenhle přepis z tohohle tahu?":

    * ``_pockej_na_prepis`` bere za tenhle tah jen razítko mladší než
      ``UTRZEK_CERSTVY_S`` (1,5 s) — v 18:02:56 tedy správně ohlásilo
      „přepis tohoto tahu nedorazil";
    * ``_utrzek_blokuje`` ale vetuje podle ``UTRZEK_OKNO_S`` (3 s), takže
      o vteřinu později vetovalo TÍMŽ přepisem, který čekání odmítlo jako
      cizí tah. Dvě pravidla na jednu otázku = jedno z nich rozhodne špatně.

    Tady platí to UŽŠÍ, poctivější: když přepis tohohle tahu nedorazil,
    rozhoduje argument. Když dorazil, veto platí a argument nemá co dodat.

    `ted` je vstřikovatelné kvůli testům — čas se neodhaduje ani nefixuje
    v kódu.
    """
    o = getattr(sluzba, "posledni_prepis", None)
    razitko = getattr(sluzba, "posledni_prepis_t", 0.0) or 0.0
    dorazil = bool(razitko) and (ted() - float(razitko)) <= cerstvy_s
    utrzek = (getattr(o, "puvodni", "") or getattr(o, "text", "") or "")
    return omluva(function_name, arguments, prepis_dorazil=dorazil,
                  utrzek=utrzek, nazvy=nazvy)
