"""Očista uživatelského přepisu: wake word ven, útržek dál nepustit.

PROČ (živě 31. 8. 2026, 10:44–10:46, Gemini pusa, STT bez slovníku).
Do přepisu prosakuje wake word a Žán pak jedná na útržcích. Doslova z logu
kontejneru ``zan-realtime``::

    10:45:03  🗣️ user: baklažánrozsvítit jedno světlo v obýváku v jídelně nad
                        stolemRozsviť světlo v obýváku v jídelně nad stolem.
    10:45:14  🗣️ user: baklažáneRozsviť v obýváku to druhé světlo.
    10:46:12  🗣️ user: ne baklažánu.
    10:46:12  Calling function [HassTurnOff] {'name': 'V jídelně nad stolem'}
    10:46:13  🔊 přehráno z knihovny: vysledek_fail

Tři různé poruchy jednoho vstupu:

1. **Slepený prefix** — Gemini vrací segmenty bez oddělovače, takže wake word
   sroste s prvním slovem povelu (``baklažánrozsvítit``) a stejně tak dva
   segmenty mezi sebou (``stolemRozsviť``). Model to pak čte jako jedno slovo,
   které nezná.
2. **Wake word ve všech pádech** na začátku povelu (``baklažáne``,
   ``baklažánu``) — do textu povelu nepatří, je to adresa, ne obsah.
3. **Útržek** — ``ne baklažánu.`` není povel. Model na něm přesto vystřelil
   ``HassTurnOff`` na poslední zmíněné světlo a rychlá dráha odehrála
   ``vysledek_fail``. Zásah do domu na základě šumu je horší než nic.

Modul je ČISTÁ FUNKCE: žádná síť, žádný stav, žádný side effect. Kdo ho volá,
rozhodne sám, co se zahozeným útržkem udělá (``websocket_handler`` ho neposílá
na reflex, ``zan_bridge_tool`` ho nedeleguje mozku a ``fastlane_mixin`` po něm
neprovede zásah do domu). To platí i po přidání okna rozhovoru
(``ocisti(raw, ceka_na_odpoved=True)``, 1. 9. 2026): stav „Žán se právě na
něco zeptal" drží ``dispecer_reci.DispecerReci`` — sem se předává jako
argument, aby modul zůstal testovatelný bez času a bez pipecatu.

POZOR na hranici zodpovědnosti: u Gemini Live model slyší ZVUK, ne náš přepis —
očista textu tedy sama o sobě modelu nezabrání promluvit. Zabrání jen tomu, aby
se ŠUM stal POVELEM v místech, kudy jde text: reflex plátna, ``ask_zan`` a
(přes ``posledni_prepis``) provedení zásahu na rychlé dráze.
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass

# ---------------------------------------------------------------------------
# Wake word
# ---------------------------------------------------------------------------

#: Wake word ve všech tvarech, s diakritikou i bez ní (STT ji občas neudělá).
#: Pády, které reálně padají do přepisu: baklažán / baklažáne (vokativ) /
#: baklažánu (dativ, lokál) / baklažána (genitiv, akuzativ) / baklažánem.
#: ``ovi``/``ovy`` jsou tam kvůli komolení, ne kvůli gramatice.
_WAKE = r"bakla[žz][áa]n(?:e|u|a|em|i|ovi|ovy)?"

#: Wake word jako CELÉ slovo — na rozpoznání „z věty nezbylo nic než oslovení".
_WAKE_SLOVO = re.compile(r"^%s$" % _WAKE, re.IGNORECASE)

#: Interpunkce a uvozovky, které kolem wake wordu STT nasype.
_ODPAD = r"[\s,.;:!?…\-–—\"'„“”‚‘]*"

#: Prefix = jedno nebo víc oslovení na ZAČÁTKU, i slepených s dalším slovem.
#: Schválně BEZ ``\b`` na konci: právě slepený tvar (``baklažánrozsvítit``)
#: je ta porucha, kterou tu řešíme.
_PREFIX = re.compile(r"^(?:%s(?:%s))+" % (_ODPAD, _WAKE), re.IGNORECASE)

#: Oslovení nemusí stát úplně první — člověk mu předřadí souhlas nebo zápor
#: (živě 10:46:12: ``ne baklažánu.``). Tenhle náběh se PŘESKOČÍ a zachová
#: (``ne baklažáne, zhasni to`` → ``ne, zhasni to``), pořád je to ale jen
#: oslovovací blok na začátku — uvnitř věty se wake word nechává být.
_NABEH = (r"(?:ne|no|nono|jo|ano|a|ale|tak|takze|takže|hm+|ehm|aha|"
          r"jasne|jasně|ok|okej|prosim|prosím)")
_PREFIX_PO_NABEHU = re.compile(
    r"^((?:%s[\s,]+)+)((?:%s(?:%s))+)" % (_NABEH, _ODPAD, _WAKE), re.IGNORECASE)

#: Jediná výjimka ze slepeného stripu: ``baklažánov…`` je přídavné jméno
#: (baklažánová pomazánka), ne oslovení. Kdyby tohle chybělo, ze salátu by
#: zbylo „ová pomazánka".
_ODVOZENINA = re.compile(r"^ov[áéíýa]", re.IGNORECASE)

# ---------------------------------------------------------------------------
# Slepené segmenty
# ---------------------------------------------------------------------------

_MALA = "a-záäčďéěíľĺňóôöřšťúůüýž"
_VELKA = "A-ZÁÄČĎÉĚÍĽĹŇÓÔÖŘŠŤÚŮÜÝŽ"

#: Šev mezi dvěma segmenty přepisu: malé písmeno rovnou na velké
#: (``stolemRozsviť``, ``baklažáneRozsviť``). V českém mluveném povelu se
#: velké písmeno uvnitř slova nevyskytuje, takže je to bezpečný podpis
#: chybějícího oddělovače — ne pravopis.
_SEV = re.compile(r"(?<=[%s])(?=[%s])" % (_MALA, _VELKA))

# ---------------------------------------------------------------------------
# Slovník útržku
# ---------------------------------------------------------------------------


def _bez_diakritiky(text: str) -> str:
    rozklad = unicodedata.normalize("NFKD", str(text))
    return "".join(c for c in rozklad if not unicodedata.combining(c)).lower()


#: Slova, která sama o sobě nenesou povel. Souhlas, nesouhlas, citoslovce,
#: výplň. Ve větě s obsahem vadit nesmí („ne, zhasni to") — proto se testuje
#: až to, co po jejich odečtení ZBYDE.
_VYPLN = frozenset("""
ne nene ano jo jojo joo hm hmm mhm mm ehm eh ee eee aha ahoj no nono a ale
tak takze tedy teda jasne jasnee dobre dobra ok okej oukej prosim diky dik
dekuju dekuji cau nazdar hej haha ty to ja on ona my vy oni se si uz jeste
"""
                    .split())

#: Tvary, kterými člověk zastavuje, co právě běží. Samy o sobě povel NEJSOU
#: (nic nezapínají), ale nesmí se zahodit mlčky — v okně po akci je to STOP.
_STOPKA = frozenset("""
ne stop stoup zastav zastavit zrus zrusit prestan prestat zmlkni mlc dost
ticho nech necham nechej pockej
"""
                    .split())

#: Kořeny slov, po kterých je jasné, že věta NĚCO CHCE — i kdyby byla o dvou
#: slovech („Zhasni.", „Kolik?"). Porovnává se bez diakritiky na PREFIX, ať
#: to pokryje ohýbání (rozsvit / rozsvitit / rozsvet…).
_ZAMER = tuple("""
rozsvit rozsvet rozsvec zhasni zhasnout zhasn zapni zapnout zapin vypni
vypnout vypin pust poust spust zapoj odpoj zastav stop ztlum zesil hlasitost
otevri zavri zamkni odemkni nastav zmen prepni uklid ukaz ukazat zobraz
prehraj prehrat pauza pauzu pokracuj preskoc dalsi predchozi najdi hledej
rekni povez zeptej pripomen nastavit budik casovac topeni teplot vlhkost
kolik jaka jaky jake jakou kde kdy proc kdo co cim zda jestli je jsou mam
mame muzes muzeme chci chceme potrebuju potrebujeme udelej udelat zaliv
zalij spocitej napis posli zavolej vysvetli
"""
                 .split())


def _je_zamer(slovo: str) -> bool:
    holy = _bez_diakritiky(slovo)
    return any(holy.startswith(k) for k in _ZAMER)


# ---------------------------------------------------------------------------
# Výsledek
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Ocista:
    """Co z přepisu zbylo a co s tím dál."""

    puvodni: str
    #: Přepis po očistě — tohle se posílá dál (reflex, ask_zan, paměť).
    text: str
    #: True = po očistě nezbyl povel. Nikam se nepředává, jen se zaloguje.
    #: V okně rozhovoru (`ceka_na_odpoved=True`) je True jen u prázdna.
    utrzek: bool = False
    #: Verdikt PŘÍSNÉ brzdy — jako by okno rozhovoru vůbec nebylo.
    #:
    #: PROČ ZVLÁŠŤ (inventura brzd, 1. 9. 2026): `utrzek` čte i
    #: `fastlane_mixin._utrzek_blokuje`, který jím zastavuje ZÁSAH DO DOMU
    #: (18:48:37, 31. 8.: z útržku „zazemi bobrivaku" vznikl `HassTurnOff`
    #: a v obýváku se vypnula zásuvka). Otevřít okno rozhovoru pro mozek
    #: je jedna věc; nechat model v tom okně sáhnout na dům kvůli slovu
    #: „Eliška" je věc úplně jiná. Mozek tedy dostane odpověď, ale ruce
    #: zůstávají svázané přesně jako dosud — brzda se opravdu NERUŠÍ.
    #: Krátký povel se ZÁMĚREM („Zhasni.") tím dotčený není, ten přísnou
    #: pojistkou prochází taky.
    utrzek_prisne: bool = False
    #: Proč je to útržek. Prázdné, když utrzek=False.
    duvod: str = ""
    #: True = holé „ne / stop / zmlkni". V okně po akci to znamená ZRUŠ.
    stop: bool = False
    #: True = očista textu opravdu něco změnila (na logování).
    zmeneno: bool = False


def _slova(text: str) -> list[str]:
    return [s for s in re.findall(r"[^\W\d_]+", text, re.UNICODE) if s]


def rozlep(text: str) -> str:
    """Vrátí mezeru mezi slepené segmenty přepisu (``stolemRozsviť``)."""
    return _SEV.sub(" ", str(text or ""))


def sundej_wake(text: str) -> str:
    """Odřízne wake word ze ZAČÁTKU textu. Uvnitř věty ho nechá být."""
    hodnota = str(text or "").lstrip()
    while True:
        nabeh = ""
        shoda = _PREFIX.match(hodnota)
        if not shoda:
            # Oslovení až za souhlasem/záporem („ne baklažánu.").
            po = _PREFIX_PO_NABEHU.match(hodnota)
            if not po:
                break
            nabeh = po.group(1)
            zbytek = hodnota[po.end():]
        else:
            zbytek = hodnota[shoda.end():]
        # „baklažánová pomazánka" není oslovení — nechat celé.
        if _ODVOZENINA.match(zbytek):
            break
        zbytek = zbytek.lstrip(" ,.;:!?…-–—\"'„“”‚‘\t")
        if nabeh:
            # Náběh zůstává — nese význam („ne, zhasni to"). Oddělovač po něm
            # dáváme čárkou jen tehdy, když za oslovením ještě něco je.
            nabeh = nabeh.rstrip(" ,\t")
            hodnota = ("%s, %s" % (nabeh, zbytek)) if zbytek else (nabeh + ".")
        else:
            hodnota = zbytek
        if not hodnota:
            break
        if nabeh:
            # Náběh sám wake word neobsahuje, další kolo by jen točilo naprázdno.
            break
    return hodnota


def ocisti(raw: str, ceka_na_odpoved: bool = False) -> Ocista:
    """Jediný vstupní bod: syrový přepis → co poslat dál a jestli vůbec.

    Args:
        raw: syrový přepis ze STT.
        ceka_na_odpoved: **Žán se právě na něco zeptal a čeká odpověď.**
            Viz `OKNO_ROZHOVORU` níž — v tom okně se útržková pojistka
            zužuje na jediný důvod: po očistě nezbyl žádný text.

    OKNO ROZHOVORU (1. 9. 2026, onboardingový rozhovor)
    ---------------------------------------------------
    Brzda výš je psaná pro POVEL. U povelu je „Eliška" opravdu šum: nikdo
    neřídí dům jedním podstatným jménem. V ROZHOVORU je to ale celá
    odpověď — a onboarding se skládá skoro jen z takových: „Eliška",
    „tři roky", „ne, Maruška", „ano".

    Změřeno na `hovory/2026-09-01.jsonl`: z 99 lidských promluv se
    k mozku dostalo PĚT. Patnáct spadlo přesně sem, na útržkovou pojistku.

    Brzda se proto NERUŠÍ — jen dostává kontext. Mimo okno platí očista
    beze změny (staré testy to hlídají), uvnitř okna je útržkem jen text,
    ze kterého po očistě nezbylo vůbec nic (typicky holé oslovení).

    `stop` se počítá STEJNĚ v obou režimech: holé „stop / zmlkni / ne"
    zůstává stopkou i v rozhovoru a volající ji vyhodnocuje DŘÍV než
    útržkovou pojistku (`websocket_handler.na_prepis`), takže okno
    rozhovoru na zrušení běžící akce nesahá. Cena té volby: mimo okno po
    akci projde v rozhovoru „zmlkni" dál jako text (dosud se zahodilo).
    Model dostane zvuk tak jako tak, takže tím nic nového nezaznívá —
    jen to mozek uvidí i v textu.
    """
    puvodni = str(raw or "")
    text = re.sub(r"\s+", " ", rozlep(puvodni)).strip()
    text = sundej_wake(text)
    text = re.sub(r"\s+([,.!?;:])", r"\1", text).strip()

    slova = _slova(text)
    holy = [_bez_diakritiky(s) for s in slova]

    # Co ve větě opravdu něco NESE: ne oslovení, ne výplň, ne holá stopka.
    obsah = [
        s for s, h in zip(slova, holy)
        if not _WAKE_SLOVO.match(s) and h not in _VYPLN and h not in _STOPKA
    ]
    zamer = any(_je_zamer(s) for s in obsah)

    # STOPKA: z věty nezbylo nic než „ne / stop / zmlkni". Není to povel,
    # ale ani šum — volající to v okně po akci bere jako zrušení.
    stop = bool(holy) and not obsah and any(h in _STOPKA for h in holy)

    # PŘÍSNÝ verdikt — počítá se VŽDY, bez ohledu na okno rozhovoru.
    # Drží na něm brzda zásahu do domu (viz `Ocista.utrzek_prisne`).
    duvod_prisne = ""
    if not text:
        duvod_prisne = "po očistě nezbylo nic"
    elif not obsah:
        duvod_prisne = "jen wake word, souhlas/nesouhlas nebo citoslovce"
    elif len(obsah) <= 2 and not zamer:
        duvod_prisne = "zbytek bez slovesa a bez známého záměru (%s)" % " ".join(obsah)

    # MĚKKÝ verdikt — ten rozhoduje, jestli se text předá dál (mozek,
    # reflex, paměť). V okně rozhovoru je útržkem jen prázdno.
    duvod = "po očistě nezbylo nic" if not text else (
        "" if ceka_na_odpoved else duvod_prisne)

    return Ocista(
        puvodni=puvodni,
        text=text,
        utrzek=bool(duvod),
        utrzek_prisne=bool(duvod_prisne),
        duvod=duvod,
        stop=stop,
        zmeneno=(text != puvodni.strip()),
    )
