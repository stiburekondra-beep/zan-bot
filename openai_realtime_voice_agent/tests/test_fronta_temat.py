# -*- coding: utf-8 -*-
"""Test fronty témat do úst LITE (dispečer řeči).

Specifikace: `MLUVENI-ZANA-TECHNICKY.md` §1 + §7, `MLUVENI-ZANA.md` §2,
sekce „Test": (a) `replying` nic nevstřikuje; (b) odpověď smaže čekající
průběžné hlášky stejného interaction_id; (c) položka po vypršení platnosti
se nevydá (a zaloguje); (d) STOP vyprázdní frontu; (e) dvě položky stejné
priority jdou v pořadí vzniku. Plus priority (0 před 2) a watchdog.

Bez sítě, s falešnou pusou (parametr `pusa_mluvi`) — žádný pipecat.

Pouští se bez pytestu i s ním:

    python tests/test_fronta_temat.py        # z adresáře add-onu
    pytest tests/test_fronta_temat.py
"""
import os
import sys

ADDON_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ADDON_DIR not in sys.path:
    sys.path.insert(0, ADDON_DIR)

from app.fronta_temat import (  # noqa: E402
    FrontaTemat,
    Tema,
    PRIORITA_ODPOVED,
    PRIORITA_OPRAVA,
    PRIORITA_PRUBEZNA,
    PRIORITA_SMALLTALK,
    TTL_ODPOVED,
    TTL_PRUBEZNA,
    WATCHDOG_S,
)


def _tema(obsah, priorita=PRIORITA_PRUBEZNA, platnost_s=TTL_PRUBEZNA,
          interaction_id="iid-1", vzniklo=0.0, znacka=""):
    return Tema(
        obsah=obsah,
        priorita=priorita,
        platnost_s=platnost_s,
        interaction_id=interaction_id,
        vzniklo=vzniklo,
        znacka=znacka,
    )


# -- (a) pusa mluví -> dalsi() nic nevydává ------------------------------

def test_a_pusa_mluvi_nic_nevydava():
    fronta = FrontaTemat()
    fronta.pridej(_tema("odpověď je hotová", priorita=PRIORITA_ODPOVED, vzniklo=0.0))
    assert fronta.dalsi(pusa_mluvi=True, nyni=1.0) is None
    # položka zůstává ve frontě, jen se nevydala
    assert fronta.je_prazdna() is False
    # jakmile pusa domluví, položka se vydá normálně
    vydana = fronta.dalsi(pusa_mluvi=False, nyni=1.0)
    assert vydana is not None
    assert vydana.obsah == "odpověď je hotová"


# -- (b) příchozí odpověď smaže čekající průběžné hlášky stejného iid ---

def test_b_odpoved_smaze_cekajici_prubezne():
    fronta = FrontaTemat()
    fronta.pridej(_tema("dívám se do Home Assistanta", priorita=PRIORITA_PRUBEZNA,
                         platnost_s=TTL_PRUBEZNA, interaction_id="iid-42", vzniklo=0.0))
    fronta.pridej(_tema("čerpadlo je zapnuté", priorita=PRIORITA_PRUBEZNA,
                         platnost_s=TTL_PRUBEZNA, interaction_id="iid-42", vzniklo=0.5))
    # průběžná hláška jiné otázky zůstává netknutá
    fronta.pridej(_tema("jiná otázka běží dál", priorita=PRIORITA_PRUBEZNA,
                         platnost_s=TTL_PRUBEZNA, interaction_id="iid-99", vzniklo=0.6))
    assert len(fronta._polozky) == 3

    smazano = fronta.zrus_prubezne("iid-42")
    assert smazano == 2
    zbyle = list(fronta._polozky)
    assert len(zbyle) == 1
    assert zbyle[0].interaction_id == "iid-99"

    # teď dorazí finální odpověď k iid-42 — jde do fronty normálně
    fronta.pridej(_tema("čerpadlo neběží, čeká na rytmus", priorita=PRIORITA_ODPOVED,
                         platnost_s=TTL_ODPOVED, interaction_id="iid-42", vzniklo=0.6))
    vydana = fronta.dalsi(pusa_mluvi=False, nyni=0.6)
    assert vydana.obsah == "čerpadlo neběží, čeká na rytmus"


# -- (c) položka po vypršení platnosti se nevydá (a zaloguje) -----------

def test_c_vyprsela_platnost_se_nevyda(caplog=None):
    fronta = FrontaTemat()
    fronta.pridej(_tema("ještě to zjišťuju", priorita=PRIORITA_PRUBEZNA,
                         platnost_s=TTL_PRUBEZNA, interaction_id="iid-1", vzniklo=0.0))
    # 9 s > TTL_PRUBEZNA (8 s) -> položka je stará, nesmí se vyslovit
    vydana = fronta.dalsi(pusa_mluvi=False, nyni=9.0)
    assert vydana is None
    assert fronta.je_prazdna() is True  # zahozena, ne ponechána ve frontě


def test_c_vyprsela_platnost_se_zaloguje(caplog):
    import logging
    fronta = FrontaTemat()
    fronta.pridej(_tema("stará hláška", priorita=PRIORITA_PRUBEZNA,
                         platnost_s=TTL_PRUBEZNA, interaction_id="iid-1", vzniklo=0.0))
    with caplog.at_level(logging.INFO, logger="zan.fronta_temat"):
        fronta.dalsi(pusa_mluvi=False, nyni=100.0)
    assert any("vypršení platnosti" in zaznam.message for zaznam in caplog.records)


# -- (d) vyprazdni() smaže vše -------------------------------------------

def test_d_vyprazdni_smaze_vse():
    fronta = FrontaTemat()
    fronta.pridej(_tema("A", priorita=PRIORITA_ODPOVED, vzniklo=0.0))
    fronta.pridej(_tema("B", priorita=PRIORITA_SMALLTALK, vzniklo=0.0))
    assert fronta.je_prazdna() is False
    fronta.vyprazdni("STOP")
    assert fronta.je_prazdna() is True
    assert fronta.dalsi(pusa_mluvi=False, nyni=0.0) is None


# -- (e) dvě položky stejné priority jdou v pořadí vzniku (FIFO) --------

def test_e_stejna_priorita_poradi_vzniku():
    fronta = FrontaTemat()
    fronta.pridej(_tema("druhá v pořadí", priorita=PRIORITA_PRUBEZNA,
                         platnost_s=TTL_PRUBEZNA, vzniklo=2.0))
    fronta.pridej(_tema("první v pořadí", priorita=PRIORITA_PRUBEZNA,
                         platnost_s=TTL_PRUBEZNA, vzniklo=1.0))
    prvni = fronta.dalsi(pusa_mluvi=False, nyni=2.0)
    assert prvni.obsah == "první v pořadí"
    druha = fronta.dalsi(pusa_mluvi=False, nyni=2.0)
    assert druha.obsah == "druhá v pořadí"


# -- priorita: 0 (odpověď) jde před 2 (průběžná), i když vznikla později -

def test_priorita_0_pred_2():
    fronta = FrontaTemat()
    fronta.pridej(_tema("průběžná hláška, vznikla dřív", priorita=PRIORITA_PRUBEZNA,
                         platnost_s=TTL_PRUBEZNA, vzniklo=0.0))
    fronta.pridej(_tema("finální odpověď, vznikla později", priorita=PRIORITA_ODPOVED,
                         platnost_s=TTL_ODPOVED, vzniklo=5.0))
    vydana = fronta.dalsi(pusa_mluvi=False, nyni=5.0)
    assert vydana.obsah == "finální odpověď, vznikla později"
    assert vydana.priorita == PRIORITA_ODPOVED


def test_priorita_oprava_pred_prubeznou():
    fronta = FrontaTemat()
    fronta.pridej(_tema("běžná hláška", priorita=PRIORITA_PRUBEZNA,
                         platnost_s=TTL_PRUBEZNA, vzniklo=0.0))
    fronta.pridej(_tema("oprava", priorita=PRIORITA_OPRAVA,
                         platnost_s=60.0, vzniklo=0.1))
    vydana = fronta.dalsi(pusa_mluvi=False, nyni=0.1)
    assert vydana.obsah == "oprava"


# -- watchdog: zaseknuti() -----------------------------------------------

def test_watchdog_neprazdna_pres_30s_bez_vyberu():
    fronta = FrontaTemat()
    # pusa mluví celou dobu -> nic se nikdy nevydá, fronta zůstává neprázdná
    fronta.pridej(_tema("čekám na slovo", priorita=PRIORITA_PRUBEZNA,
                         platnost_s=999.0, vzniklo=0.0))
    assert fronta.zaseknuti(nyni=10.0) is False
    for t in [0.0, 5.0, 10.0, 20.0, 29.9]:
        assert fronta.dalsi(pusa_mluvi=True, nyni=t) is None
    assert fronta.zaseknuti(nyni=29.9) is False
    assert fronta.zaseknuti(nyni=30.1) is True


def test_watchdog_prazdna_fronta_neni_zaseknuta():
    fronta = FrontaTemat()
    assert fronta.zaseknuti(nyni=1000.0) is False


def test_watchdog_po_uspesnem_vydani_se_resetuje():
    fronta = FrontaTemat()
    fronta.pridej(_tema("první", priorita=PRIORITA_PRUBEZNA,
                         platnost_s=999.0, vzniklo=0.0))
    assert fronta.dalsi(pusa_mluvi=False, nyni=1.0) is not None
    # nová položka přidaná těsně po vydání -> watchdog počítá od vydání, ne od 0
    fronta.pridej(_tema("druhá", priorita=PRIORITA_PRUBEZNA,
                         platnost_s=999.0, vzniklo=1.1))
    assert fronta.zaseknuti(nyni=25.0) is False
    assert fronta.zaseknuti(nyni=31.5) is True


def main():
    testy = [
        test_a_pusa_mluvi_nic_nevydava,
        test_b_odpoved_smaze_cekajici_prubezne,
        test_c_vyprsela_platnost_se_nevyda,
        test_d_vyprazdni_smaze_vse,
        test_e_stejna_priorita_poradi_vzniku,
        test_priorita_0_pred_2,
        test_priorita_oprava_pred_prubeznou,
        test_watchdog_neprazdna_pres_30s_bez_vyberu,
        test_watchdog_prazdna_fronta_neni_zaseknuta,
        test_watchdog_po_uspesnem_vydani_se_resetuje,
    ]
    for test in testy:
        test()
        print("OK   %s" % test.__name__)
    print("Hotovo: %d testů prošlo (bez logovacího testu, ten chce pytest caplog)." % len(testy))


if __name__ == "__main__":
    main()
