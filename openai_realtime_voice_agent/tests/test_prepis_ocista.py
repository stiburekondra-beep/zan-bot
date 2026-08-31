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
