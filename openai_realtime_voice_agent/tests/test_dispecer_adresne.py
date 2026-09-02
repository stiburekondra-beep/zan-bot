"""Odpověď zazní tam, odkud se ptali — karta 2026-08-30-programator-zana-17.

Nález pochází z integrace čtyř větví mostu 30. 8.: `ZanBridge` je JEDEN na
celý běh (jeden mozek, jedna paměť), ale `pripoj()` ho vždycky přepnul na
NAPOSLEDY vytvořenou relaci a starou frontu vysypal. Se dvěma satelity to
znamená, že se dítě zeptá v jednom pokoji a Žán odpoví ve druhém — nebo
odpověď zmizí úplně, protože ji vysypalo připojení toho druhého.

Karta si výslovně žádá **test, který nepotřebuje železo** („fake sloty +
`zdroj_zarizeni`, aby regrese nečekala na ruce"). Proto je rozhodovací
pravidlo čistá funkce v `app/zdroj_zarizeni.py` — `zan_bridge_tool` tahá
pipecat a šel by otestovat jedině na krabici se dvěma satelity naráz.

Akustický důkaz (povel na A → odpoví A, B mlčí) tenhle soubor nenahrazuje
a nepředstírá; hlídá jen to, aby se pravidlo nedalo tiše rozbít.
"""
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.zdroj_zarizeni import (  # noqa: E402
    VYCHOZI_MAPA,
    je_jiny_satelit,
    payload_voice,
    zdroj_zarizeni,
)

VOICE_PE = "192.168.0.115"
RESPEAKER = "192.168.0.12"


# ---------------------------------------------------------------------------
# jádro: kdy se smí sáhnout na běžící rozhovor
# ---------------------------------------------------------------------------

def test_druhy_satelit_nesmi_prevzit_frontu():
    """Voice PE se probudí, zatímco běží odpověď pro reSpeaker."""
    assert je_jiny_satelit("respeaker", "voice_pe") is True


def test_tentyz_satelit_znovu_frontu_vysype():
    """Wifi blikla, firmware se restartoval — stará fronta patřila jeho
    minulému rozhovoru a nemá se do nového vléct."""
    assert je_jiny_satelit("voice_pe", "voice_pe") is False


@pytest.mark.parametrize("stary,novy", [
    (None, "voice_pe"),      # první spojení vůbec
    ("voice_pe", None),      # neznámý nováček
    ("", "voice_pe"),
    ("voice_pe", ""),
    (None, None),
])
def test_pri_nejistote_plati_dosavadni_chovani(stary, novy):
    """Neznámý stav nesmí tiše zavést nové chování — když se o kterékoli
    straně neví, kdo to je, most dělá přesně to co dřív."""
    assert je_jiny_satelit(stary, novy) is False


# ---------------------------------------------------------------------------
# mozek musí vědět, ODKUD se ptali (jinak nemá kam odpovědět)
# ---------------------------------------------------------------------------

def test_zdroj_se_lisi_podle_satelitu():
    assert zdroj_zarizeni(VOICE_PE, VYCHOZI_MAPA) == "voice_pe"
    assert zdroj_zarizeni(RESPEAKER, VYCHOZI_MAPA) == "respeaker"


def test_payload_nese_zdroj_toho_kdo_se_ptal():
    """Kdyby zdroj následoval naposledy PŘIPOJENÝ satelit místo toho, kdo
    se ptá, dostal by mozek špatnou místnost — a „pusť pohádku tam, kde se
    ptalo" by mířilo do vedlejšího pokoje."""
    p1 = payload_voice("Kolik je stupňů?", None, zdroj_zarizeni(RESPEAKER, VYCHOZI_MAPA))
    p2 = payload_voice("Kolik je stupňů?", None, zdroj_zarizeni(VOICE_PE, VYCHOZI_MAPA))
    assert p1["zdroj_zarizeni"] == "respeaker"
    assert p2["zdroj_zarizeni"] == "voice_pe"
    assert p1["zdroj_zarizeni"] != p2["zdroj_zarizeni"]


def test_dva_satelity_se_neslijou_v_jednu_identitu():
    """Kontrola mapy: kdyby obě adresy padly na totéž jméno, adresování by
    se tvářilo, že funguje, a přitom by nerozlišovalo nic."""
    jmena = {zdroj_zarizeni(ip, VYCHOZI_MAPA) for ip in (VOICE_PE, RESPEAKER)}
    assert len(jmena) == 2
