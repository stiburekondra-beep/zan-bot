"""Rychlá dráha neumlká: co nedokázala, předá mozku.

ŽIVÁ ZÁMINKA (2. 9. 2026, 17:48–17:49)
--------------------------------------
Dvakrát po sobě::

    17:48:40  HassTurnOn {'area': 'Ložnice', 'domain': ['plug']} = unconfirmed
    17:49:07  HassTurnOn {'name': 'TV ložnice'}                  = unconfirmed

Rychlá dráha povel odeslala, stav se nepotvrdil — a tím to skončilo. Model
řekl „nepotvrdilo se to" a nikdo se nedozvěděl PROČ. Vlastník na to: „a proč
to nešlo až do hlavního mozku!"

Mozek má oproti rychlé dráze rejstřík domu (``zan_data/zarizeni``), takže
umí buď najít správnou entitu, nebo se jednou větou doptat. Rychlá dráha
o něm neví nic — má jen intent a jméno, které řekl model.

CO SE TEDY DĚJE
---------------
Verdikt jiný než „ok" (nepotvrzeno, chyba, prázdná shoda, nenalezená
entita) se PŘEDÁ mozku toutéž cestou jako ``zeptej_se_mozku``: původní věta
člověka + krátká poznámka, co rychlá dráha zkusila a jak to dopadlo.

POJISTKA PROTI SMYČCE je součást zadání, ne ozdoba: mozek může skončit
u téhož nástroje, ten zas u nepotvrzeno — a dva takové kruhy za sebou udělají
z jednoho „rozsviť" nekonečnou konverzaci. Předává se proto NEJVÝŠ JEDNOU
NA TAH; tah se pozná podle razítka přepisu, ne podle stopek.

``ha_down`` se schválně NEPŘEDÁVÁ: když Home Assistant neodpovídá, nemá
mozek čím pomoct a jediná pravdivá věta je ta, kterou už model říká.
"""

from __future__ import annotations

#: Verdikty, se kterými má smysl jít za mozkem.
#:
#: `fail` je tady taky. Dosud dostal model jen POKYN, ať zavolá `ask_zan` —
#: pokyn v textu ale není totéž co provedené předání (živě se to párkrát
#: nestalo). Instrukce je prosba, tohle je mechanismus.
PREDAT_VERDIKTY = frozenset({"unconfirmed", "fail", "error"})

#: Značka do logu — ať jde jedním grepem spočítat, kolikrát dráha nedokázala
#: a kolikrát si o pomoc řekla.
ZNACKA = "voice-fastlane → predano mozku"


def predat(verdict: str, tah, uz_predano_tah) -> bool:
    """Má se tenhle výsledek předat mozku?

    `tah` je razítko přepisu tohohle tahu, `uz_predano_tah` razítko tahu,
    ve kterém se předávalo naposled. Shodná razítka = tentýž tah = podruhé
    už ne.
    """
    if verdict not in PREDAT_VERDIKTY:
        return False
    if tah and uz_predano_tah and float(tah) == float(uz_predano_tah):
        return False
    return True


def _args_strucne(arguments, limit: int = 120) -> str:
    """Argumenty do jedné krátké závorky. Mozek nepotřebuje celý JSON."""
    if not isinstance(arguments, dict) or not arguments:
        return ""
    kusy = []
    for klic in ("name", "area", "domain", "device_class", "search_query"):
        if arguments.get(klic) in (None, "", [], {}):
            continue
        kusy.append("%s=%s" % (klic, arguments[klic]))
    if not kusy:
        kusy = ["%s=%s" % (k, v) for k, v in list(arguments.items())[:3]]
    return ", ".join(kusy)[:limit]


def zadani(veta: str, function_name: str, arguments, verdict: str) -> str:
    """Text pro mozek: co člověk řekl + co s tím rychlá dráha udělala.

    Věta člověka jde PRVNÍ a celá. Mozek na ni odpovídá; poznámka je
    kontext, ne zadání. Kdyby se pořadí obrátilo, odpovídal by na diagnostiku
    místo na to, co kdo chtěl.
    """
    veta = (veta or "").strip()
    popis = "rychlá dráha: %s(%s) = %s" % (
        function_name, _args_strucne(arguments), verdict)
    if not veta:
        # Přepis nedorazil (stává se, viz `utrzek_argumenty`). Mozek pak
        # dostane aspoň to, co se dělo — s poctivým přiznáním, že větu nemáme.
        return ("Nemám přepis toho, co bylo řečeno, ale tohle se nepovedlo: "
                + popis + ". Najdi správné zařízení v rejstříku domu, "
                "nebo se jednou krátkou větou zeptej.")
    return (veta + "\n\n(" + popis + " — najdi správné zařízení v rejstříku "
            "domu, nebo se jednou krátkou větou zeptej.)")
