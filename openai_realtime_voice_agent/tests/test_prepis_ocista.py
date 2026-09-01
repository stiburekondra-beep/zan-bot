"""Očista přepisu — na DOSLOVNÝCH větách z živého provozu.

Vstupy níže nejsou vymyšlené: jsou zkopírované z logu kontejneru
``zan-realtime`` z 31. 8. 2026, 10:44–10:46 (Gemini pusa, STT bez slovníku),
řádky ``app.transcript_logger - INFO - 🗣️ user: …``.
"""

import pytest

from app.prepis_ocista import ocisti, rozlep, sundej_wake


# --- tři reálné útržky z 10:45–10:46 --------------------------------------

#: 10:45:03.859 — wake word slepený s povelem A dva segmenty slepené mezi
#: sebou (`stolemRozsviť`). Model z toho udělal `ask_zan(text='…')`.
REALNY_1 = ("baklažánrozsvítit jedno světlo v obýváku v jídelně nad stolem"
            "Rozsviť světlo v obýváku v jídelně nad stolem.")

#: 10:45:14.789 — vokativ slepený s velkým písmenem povelu.
REALNY_2 = "baklažáneRozsviť v obýváku to druhé světlo."

#: 10:46:12.366 — NEJHORŠÍ: není to povel, a přesto z toho model vystřelil
#: `HassTurnOff` na poslední zmíněné světlo → `vysledek_fail`.
REALNY_3 = "ne baklažánu."


def test_realny_1_rozlepi_a_sundá_wake():
    o = ocisti(REALNY_1)
    assert o.text == ("rozsvítit jedno světlo v obýváku v jídelně nad stolem "
                      "Rozsviť světlo v obýváku v jídelně nad stolem.")
    assert o.utrzek is False
    assert o.stop is False
    assert o.zmeneno is True


def test_realny_2_vokativ_slepeny_s_velkym_pismenem():
    o = ocisti(REALNY_2)
    assert o.text == "Rozsviť v obýváku to druhé světlo."
    assert o.utrzek is False
    assert o.stop is False
    assert o.zmeneno is True


def test_realny_3_neni_povel_a_dal_nesmi():
    o = ocisti(REALNY_3)
    assert o.text == "ne."
    assert o.utrzek is True
    assert o.duvod == "jen wake word, souhlas/nesouhlas nebo citoslovce"
    # Zároveň je to stopka: v okně po akci znamená „zruš", ne „vypni něco".
    assert o.stop is True


# --- wake word ve všech pádech, i bez diakritiky --------------------------

@pytest.mark.parametrize("veta", [
    "baklažán rozsviť v obýváku",
    "Baklažáne rozsviť v obýváku",
    "baklažánu rozsviť v obýváku",
    "baklažána rozsviť v obýváku",
    "baklazan rozsviť v obýváku",
    "BAKLAZANE rozsviť v obýváku",
    "baklažán, rozsviť v obýváku",
    "baklažán baklažáne rozsviť v obýváku",
    "baklažánrozsviť v obýváku",
])
def test_wake_prefix_pryc(veta):
    o = ocisti(veta)
    assert o.text.lower().startswith("rozsviť")
    assert "baklaž" not in o.text.lower()
    assert o.utrzek is False


def test_osloveni_az_za_zaporem():
    # Oslovovací blok smí začínat souhlasem/záporem — ten se ZACHOVÁ,
    # protože nese význam. Pryč jde jen oslovení.
    assert ocisti("ne baklažáne, zhasni to").text == "ne, zhasni to"
    assert ocisti("jo baklažáne rozsviť v obýváku").text == "jo, rozsviť v obýváku"


def test_wake_uvnitr_vety_zustava():
    # Uvnitř věty je to obsah, ne oslovení — sáhnout na to by změnilo význam.
    o = ocisti("napiš na nákup baklažán a rajčata")
    assert o.text == "napiš na nákup baklažán a rajčata"
    assert o.utrzek is False


def test_odvozenina_neni_osloveni():
    o = ocisti("baklažánová pomazánka na nákup")
    assert o.text == "baklažánová pomazánka na nákup"


# --- útržková pojistka -----------------------------------------------------

@pytest.mark.parametrize("veta", [
    "baklažán",
    "baklažáne.",
    "Baklažánu?",
    "ne baklažánu.",
    "jo",
    "hmm",
    "aha",
    "no ne",
    "",
])
def test_utrzek_se_nepredava(veta):
    assert ocisti(veta).utrzek is True


@pytest.mark.parametrize("veta", [
    "Zhasni světla v obýváku.",
    "Rozsviť v obýváku to druhé světlo.",
    "Ale to prdní zhasni.",          # 10:45:35 — komolené, ale povel to je
    "Zhasni.",
    "Kolik je hodin?",
    "ne, zhasni to",
    "baklažáne, jaká je teplota v ložnici?",
])
def test_povel_projde(veta):
    o = ocisti(veta)
    assert o.utrzek is False, o.duvod


# --- stopka ----------------------------------------------------------------

@pytest.mark.parametrize("veta", ["ne", "stop", "zmlkni", "dost", "ne ne"])
def test_stopka(veta):
    o = ocisti(veta)
    assert o.stop is True
    assert o.utrzek is True   # povel to není — volající rozhodne podle okna


def test_stop_ve_vete_neni_holá_stopka():
    o = ocisti("zastav hudbu v obýváku")
    assert o.stop is False
    assert o.utrzek is False


# --- dílčí funkce ----------------------------------------------------------

def test_rozlep():
    assert rozlep("stolemRozsviť") == "stolem Rozsviť"
    assert rozlep("nad stolem") == "nad stolem"


def test_sundej_wake_nechá_prázdno():
    assert sundej_wake("baklažáne") == ""


# --- OKNO ROZHOVORU: „Žán se právě na něco zeptal" ------------------------
#
# PROČ (1. 9. 2026, onboardingový rozhovor). Útržková pojistka výš je psaná
# pro POVEL a zahazuje všechno do dvou slov bez známého záměru. Onboarding
# se ale skládá skoro jen z takových odpovědí. Změřeno na
# `hovory/2026-09-01.jsonl`: z 99 lidských promluv došlo k mozku PĚT,
# patnáct spadlo přesně sem.
#
# Brzda se NERUŠÍ — dostává kontext. Jména „Eliška" a „Maruška" jsou
# smyšlené příklady z předávky, ne skutečná data rodiny.

#: Doslova to, co onboardingový rozhovor od člověka čeká.
ODPOVEDI_V_ROZHOVORU = [
    "Eliška",           # jedno jméno na „jak se jmenuje?"
    "tři roky",         # věk — dvě slova, žádné sloveso
    "ne, Maruška",      # oprava předchozí odpovědi
    "ano",
    "ne",
    "jo",
    "jo jo",
    "Štěpán a Eliška",
    "sedm",
]


@pytest.mark.parametrize("veta", ODPOVEDI_V_ROZHOVORU)
def test_v_okne_rozhovoru_neni_odpoved_utrzek(veta):
    o = ocisti(veta, ceka_na_odpoved=True)
    assert o.utrzek is False, o.duvod
    assert o.text  # a něco na předání opravdu zbylo


@pytest.mark.parametrize("veta", ODPOVEDI_V_ROZHOVORU)
def test_mimo_okno_se_chovani_nemeni(veta):
    # Kontrolní strana: bez okna musí platit stará pravidla beze změny —
    # jinak by test výš nedokazoval nic (nula je konzistentní s obojím).
    bez_okna = ocisti(veta)
    assert bez_okna.utrzek is True, veta


def test_okno_nechava_procist_wake_word_a_slepence():
    # Okno mění JEN útržkovou pojistku. Očista textu zůstává táž.
    o = ocisti("baklažáneEliška", ceka_na_odpoved=True)
    assert o.text == "Eliška"
    assert o.utrzek is False


def test_v_okne_je_utrzkem_jen_prazdno():
    # Jediný důvod, který v okně přežívá: po očistě nezbylo nic.
    for veta in ["", "   ", "baklažáne", "baklažán."]:
        o = ocisti(veta, ceka_na_odpoved=True)
        assert o.utrzek is True, veta
        assert o.duvod == "po očistě nezbylo nic"


def test_v_okne_zustava_stopka_stopkou():
    # `stop` se počítá STEJNĚ v obou režimech — volající ho vyhodnocuje
    # dřív než útržkovou pojistku, takže okno na rušení akce nesahá.
    for veta in ["stop", "zmlkni", "dost", "ne"]:
        assert ocisti(veta, ceka_na_odpoved=True).stop is True, veta
        assert ocisti(veta).stop is True, veta


def test_okno_je_vychozi_zavrene():
    # Fail-closed: kdo `ceka_na_odpoved` nepředá, dostane starou brzdu.
    assert ocisti("Eliška").utrzek is True
    assert ocisti("Eliška", ceka_na_odpoved=False).utrzek is True


def test_povel_projde_i_v_okne():
    o = ocisti("Zhasni světla v obýváku.", ceka_na_odpoved=True)
    assert o.utrzek is False
    assert o.text == "Zhasni světla v obýváku."


# --- kdo okno otevírá: dispečer řeči ---------------------------------------

from app.dispecer_reci import DispecerReci, OKNO_ODPOVEDI_S, konci_otazkou


@pytest.mark.parametrize("veta,ceka", [
    ("Jak se jmenuje tvoje dcera?", True),
    ("A kolik jí je?", True),
    ("Je to Maruška, nebo Eliška?“", True),      # rámovací uvozovka za otazníkem
    ("Kolik je hodin?.", True),                  # tečka za otazníkem od modelu
    ("V ložnici je dvacet stupňů.", False),
    ("Řeknu ti, kolik je hodin.", False),        # tázací slovo, ale oznámení
    ("", False),
    (None, False),
])
def test_konci_otazkou(veta, ceka):
    assert konci_otazkou(veta) is ceka


def _dispecer():
    # Bez sítě a bez pipecatu — dispečer je schválně čistá logika.
    return DispecerReci(vyslov=None, pusa_mluvi=lambda: False)


def test_okno_se_otevre_jen_na_otazku():
    d = _dispecer()
    assert d.ceka_na_odpoved(nyni=100.0) is False       # nic se nestalo
    d.zaznamenej_svou_otazku("V ložnici je dvacet stupňů.", nyni=100.0)
    assert d.ceka_na_odpoved(nyni=100.1) is False       # oznámení okno neotvírá
    d.zaznamenej_svou_otazku("Jak se jmenuje tvoje dcera?", nyni=100.0)
    assert d.ceka_na_odpoved(nyni=100.1) is True


def test_okno_vyprsi():
    d = _dispecer()
    d.zaznamenej_svou_otazku("A kolik jí je?", nyni=100.0)
    assert d.ceka_na_odpoved(nyni=100.0 + OKNO_ODPOVEDI_S - 0.1) is True
    assert d.ceka_na_odpoved(nyni=100.0 + OKNO_ODPOVEDI_S + 0.1) is False


def test_stopka_okno_zavre():
    # „zmlkni" vyprázdní frontu — a s ní musí spadnout i okno rozhovoru.
    d = _dispecer()
    d.zaznamenej_svou_otazku("Jak se jmenuje tvoje dcera?", nyni=100.0)
    d.vyprazdni("zmlkni")
    assert d.ceka_na_odpoved(nyni=100.1) is False


# --- brzda zásahu do domu zůstává PŘÍSNÁ i v okně rozhovoru ---------------
#
# Inventura brzd (pravidlo 5 ústavy): `utrzek` čte i
# `fastlane_mixin._utrzek_blokuje`, kterým se zastavuje ZÁSAH DO DOMU.
# Okno rozhovoru otevírá cestu k MOZKU, ne k rukám — jinak by slovo
# „Eliška" mohlo dvacet sekund zhasínat světla.

@pytest.mark.parametrize("veta", ODPOVEDI_V_ROZHOVORU)
def test_prisny_verdikt_okno_ignoruje(veta):
    o = ocisti(veta, ceka_na_odpoved=True)
    assert o.utrzek is False           # mozek to dostane
    assert o.utrzek_prisne is True     # ruce zůstávají svázané


def test_prisny_verdikt_povel_nebrzdi():
    # Krátký povel se ZÁMĚREM projde obojím — brzda se nezpřísnila.
    for veta in ["Zhasni.", "Kolik je hodin?", "Rozsviť v obýváku to druhé světlo."]:
        o = ocisti(veta, ceka_na_odpoved=True)
        assert o.utrzek is False, veta
        assert o.utrzek_prisne is False, veta


def test_prisny_verdikt_mimo_okno_sedi_s_mekkym():
    # Mimo okno musí být oba verdikty totožné — jinak by se brzda
    # zásahu do domu tiše rozešla s tou útržkovou.
    for veta in ODPOVEDI_V_ROZHOVORU + ["Zhasni.", "baklažáne", "", "stop"]:
        o = ocisti(veta)
        assert o.utrzek is o.utrzek_prisne, veta
