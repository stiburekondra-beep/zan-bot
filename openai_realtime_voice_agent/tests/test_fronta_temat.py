# -*- coding: utf-8 -*-
"""Test fronty témat do úst LITE (dispečer řeči).

Specifikace: `MLUVENI-ZANA-TECHNICKY.md` §1 + §7, `MLUVENI-ZANA.md` §2,
sekce „Test": (a) `replying` nic nevstřikuje; (b) odpověď smaže čekající
průběžné hlášky stejného interaction_id; (c) položka po vypršení platnosti
se nevydá (a zaloguje); (d) STOP vyprázdní frontu; (e) dvě položky stejné
priority jdou v pořadí vzniku. Plus priority (0 před 2) a watchdog.

Dvě patra testů:

  * **jednotkové** (`test_a_` … `test_watchdog_`) — samotná `FrontaTemat`,
    rozhodování nad daty.
  * **integrační** (`test_i_`) — celá dispečerská smyčka
    (`app/dispecer_reci.DispecerReci`) s **falešnou pusou** a injektovaným
    časem. `tik()` se volá ručně, takže scénář, který v provozu trvá půl
    minuty, doběhne v mikrosekundách a nezávisí na časování stroje.

Bez sítě, bez pipecatu — dispečer je schválně od pipecatu odstřižený
(`app/zan_bridge_tool.py` mu jen dodá funkci „vstříkni do session").

Pouští se bez pytestu i s ním:

    python tests/test_fronta_temat.py        # z adresáře add-onu
    pytest tests/test_fronta_temat.py
"""
import asyncio
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
from app.dispecer_reci import DispecerReci, obal  # noqa: E402


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


# ========================================================================
# INTEGRAČNÍ TESTY — celá dispečerská smyčka s falešnou pusou
# ========================================================================

class FalesnaPusa:
    """Náhrada za realtime session: zapisuje, co jí dispečer podstrčil.

    `mluvi` je ruční páka — v provozu ho drží fáze `replying`
    z `phase_emitter`, v testu si ho přepínáme sami. `ziva` simuluje
    ukončenou session (odpojené zařízení).
    """

    def __init__(self):
        self.mluvi = False
        self.ziva = True
        self.receno = []          # [(text, run_llm)]
        self.selze = False        # vstříknutí vyhodí výjimku

    async def vyslov(self, text, run_llm=True):
        if self.selze:
            raise RuntimeError("websocket spadl")
        if not self.ziva:
            return False
        self.receno.append((text, run_llm))
        return True

    @property
    def obsahy(self):
        """Jen vyslovené texty, bez hlaviček — na to se testuje."""
        return list(self.receno)


def _dispecer(pusa, rozbeh_s=0.0):
    return DispecerReci(
        vyslov=pusa.vyslov,
        pusa_mluvi=lambda: pusa.mluvi,
        session_ziva=lambda: pusa.ziva,
        rozbeh_s=rozbeh_s,
    )


def _tik(dispecer, nyni):
    """Jeden krok dispečera synchronně, s injektovaným časem."""
    return asyncio.run(dispecer.tik(nyni=nyni))


def _rekl(pusa, kus):
    return any(kus in text for text, _ in pusa.receno)


# -- (a) při `replying` se nic nevstřikuje -------------------------------

def test_i_a_pri_replying_se_nic_nevstrikuje():
    pusa = FalesnaPusa()
    d = _dispecer(pusa)
    d.pridej_odpoved("čerpadlo běží", "iid-1", nyni=0.0)

    pusa.mluvi = True
    for t in (0.2, 0.4, 0.6, 5.0):
        assert _tik(d, t) is None
    assert pusa.receno == []              # ani jedno vstříknutí
    assert d.fronta.pocet() == 1          # odpověď se nezahodila, čeká

    pusa.mluvi = False
    tema = _tik(d, 5.2)
    assert tema is not None
    assert len(pusa.receno) == 1
    assert _rekl(pusa, "čerpadlo běží")


# -- (b) nová odpověď maže čekající průběžné — end-to-end ---------------

def test_i_b_nova_odpoved_maze_prubezne_end_to_end():
    pusa = FalesnaPusa()
    d = _dispecer(pusa)

    # Mozek přemýšlí, pusa zatím mluví („jdu na to") → hlášky se hromadí.
    pusa.mluvi = True
    d.pridej_prubeh("Ještě na tom dělám, vydrž.", "iid-42", nyni=0.0)
    d.pridej_prubeh("Pořád nad tím přemýšlím.", "iid-42", nyni=0.5)
    # Souběžná druhá otázka — její hláška se smazat NESMÍ.
    d.pridej_prubeh("Koukám se na to.", "iid-99", nyni=0.6)
    assert _tik(d, 0.7) is None
    assert d.fronta.pocet() == 3

    # Dorazí odpověď → obě hlášky k iid-42 zmizí, iid-99 zůstává.
    d.pridej_odpoved("Čerpadlo neběží, čeká na rytmus.", "iid-42", nyni=1.0)
    assert d.fronta.pocet() == 2
    zbyle = {t.interaction_id for t in d.fronta._polozky}
    assert zbyle == {"iid-42", "iid-99"}

    # Pusa domluví: první jde odpověď (priorita 0), pak hláška druhé otázky.
    pusa.mluvi = False
    prvni = _tik(d, 1.2)
    assert prvni.priorita == PRIORITA_ODPOVED
    druha = _tik(d, 1.4)
    assert druha.interaction_id == "iid-99"

    assert _rekl(pusa, "Čerpadlo neběží, čeká na rytmus.")
    assert _rekl(pusa, "Koukám se na to.")
    # Zastaralé hlášky k hotové otázce nikdy nezazněly.
    assert not _rekl(pusa, "Ještě na tom dělám")
    assert not _rekl(pusa, "Pořád nad tím přemýšlím")
    assert d.fronta.je_prazdna() is True


# -- (c) položka po platnosti se nevysloví -------------------------------

def test_i_c_po_platnosti_se_nevyslovi():
    pusa = FalesnaPusa()
    d = _dispecer(pusa)
    pusa.mluvi = True
    d.pridej_prubeh("Ještě to zjišťuju.", "iid-1", nyni=0.0)

    # Pusa mluvila devět sekund — hláška s platností osmi je už lež.
    for t in (2.0, 5.0, 8.5):
        assert _tik(d, t) is None
    pusa.mluvi = False
    assert _tik(d, 9.0) is None
    assert pusa.receno == []
    assert d.fronta.je_prazdna() is True   # zahozeno, ne ponecháno


# -- (d) STOP („zmlkni") vyprázdní frontu --------------------------------

def test_i_d_stop_vyprazdni_frontu():
    pusa = FalesnaPusa()
    d = _dispecer(pusa)
    pusa.mluvi = True
    d.pridej_odpoved("Zavřel jsem klapku.", "iid-1", nyni=0.0)
    d.pridej_prubeh("Dívám se na to.", "iid-1", nyni=0.1)
    assert _tik(d, 0.2) is None

    d.vyprazdni("zmlkni")

    pusa.mluvi = False
    assert _tik(d, 0.4) is None
    assert _tik(d, 0.6) is None
    assert pusa.receno == []               # po stopce nesmí promluvit nic
    assert d.fronta.je_prazdna() is True


# -- (e) dvě položky stejné priority jdou v pořadí vzniku ----------------

def test_i_e_stejna_priorita_v_poradi_vzniku():
    pusa = FalesnaPusa()
    d = _dispecer(pusa)
    d.pridej_prubeh("druhá", "iid-1", nyni=1.0)
    d.pridej_prubeh("první", "iid-1", nyni=0.5)

    _tik(d, 1.1)
    _tik(d, 1.2)
    poradi = [text for text, _ in pusa.receno]
    assert len(poradi) == 2
    assert "první" in poradi[0]
    assert "druhá" in poradi[1]


# -- priorita napříč druhy přes dispečer ---------------------------------

def test_i_odpoved_predbehne_prubeh_i_smalltalk():
    pusa = FalesnaPusa()
    d = _dispecer(pusa)
    d.pridej_smalltalk("venku prší", "iid-1", nyni=0.0)
    d.pridej_prubeh("dívám se do Home Assistanta", "iid-1", nyni=0.1)
    d.pridej_opravu("ještě k tomu, co jsem řekl", "iid-1", nyni=0.2)
    d.pridej_odpoved("v obýváku je dvacet stupňů", "iid-1", nyni=0.3)

    # Odpověď a oprava projdou; průběžné hlášky odpověď smazala,
    # smalltalk zbude jako poslední.
    prvni = _tik(d, 0.4)
    druha = _tik(d, 0.5)
    assert prvni.priorita == PRIORITA_ODPOVED
    assert druha.priorita == PRIORITA_OPRAVA
    treti = _tik(d, 0.6)
    assert treti.priorita == PRIORITA_SMALLTALK
    assert not _rekl(pusa, "dívám se do Home Assistanta")


# -- watchdog: zaseknuté hrdlo se pozná a uvolní -------------------------

def test_i_watchdog_zaseknute_hrdlo_vyprazdni():
    pusa = FalesnaPusa()
    d = _dispecer(pusa)
    pusa.mluvi = True
    # Dlouhá platnost, aby položka nezmizela sama vypršením — jinak by se
    # zaseknutí nikdy neprojevilo.
    d.fronta.pridej(Tema(obsah="visím tu", priorita=PRIORITA_ODPOVED,
                         platnost_s=999.0, interaction_id="iid-1",
                         vzniklo=0.0, druh="odpoved"))
    assert _tik(d, 10.0) is None
    assert d.fronta.pocet() == 1
    assert d.zahozeno_watchdogem == 0

    assert _tik(d, WATCHDOG_S + 0.5) is None
    assert d.fronta.je_prazdna() is True
    assert d.zahozeno_watchdogem == 1
    assert pusa.receno == []


# -- mrtvá session: nevstřikovat, nedržet ---------------------------------

def test_i_mrtva_session_vyprazdni_a_nevstrikuje():
    pusa = FalesnaPusa()
    d = _dispecer(pusa)
    d.pridej_odpoved("odpověď pro nikoho", "iid-1", nyni=0.0)
    pusa.ziva = False
    assert _tik(d, 0.2) is None
    assert pusa.receno == []
    assert d.fronta.je_prazdna() is True


# -- rozběh pusy: nevystřelit druhou položku do rozjeté odpovědi ---------

def test_i_rozbeh_nedovoli_dve_vstriknuti_za_sebou():
    pusa = FalesnaPusa()
    d = _dispecer(pusa, rozbeh_s=2.0)
    d.pridej_odpoved("první odpověď", "iid-1", nyni=0.0)
    d.pridej_odpoved("druhá odpověď", "iid-2", nyni=0.0)

    assert _tik(d, 0.0) is not None          # první projde
    # Pusa se ještě nerozjela (fáze `replying` dorazí až za chvíli) —
    # dispečer čeká, místo aby překřičel rozjíždějící se odpověď.
    assert _tik(d, 0.2) is None
    assert _tik(d, 1.0) is None
    assert len(pusa.receno) == 1

    # Rozjela se → platí normální pravidlo „mluví jeden".
    pusa.mluvi = True
    assert _tik(d, 1.2) is None
    # Domluvila → jde druhá.
    pusa.mluvi = False
    assert _tik(d, 3.0) is not None
    assert len(pusa.receno) == 2


def test_i_rozbeh_se_nezasekne_kdyz_pusa_mlci():
    """Pojistka: když se pusa nikdy nerozjede, dispečer nesmí oněmět."""
    pusa = FalesnaPusa()
    d = _dispecer(pusa, rozbeh_s=2.0)
    d.pridej_odpoved("první", "iid-1", nyni=0.0)
    d.pridej_odpoved("druhá", "iid-2", nyni=0.0)
    assert _tik(d, 0.0) is not None
    assert _tik(d, 1.0) is None              # čeká na rozběh
    assert _tik(d, 2.5) is not None          # rozběh vypršel, jede se dál
    assert len(pusa.receno) == 2


# -- potvrzení z knihovny frází: vloží se, ale pusa ho neopakuje ----------

def test_i_potvrzeni_se_nevyslovuje_znovu():
    pusa = FalesnaPusa()
    d = _dispecer(pusa)
    d.pridej_odpoved("Rozsvíceno.", "iid-1", druh="potvrzeni", run_llm=False, nyni=0.0)
    tema = _tik(d, 0.1)
    assert tema is not None
    text, run_llm = pusa.receno[0]
    assert run_llm is False                  # model to NESMÍ vyslovit znovu
    assert "NEOPAKUJ" in text


# -- selhání vstříknutí nesmí shodit dispečera ---------------------------

def test_i_selhani_vstriknuti_nezabije_dispecera():
    pusa = FalesnaPusa()
    d = _dispecer(pusa)
    d.pridej_odpoved("tahle spadne", "iid-1", nyni=0.0)
    pusa.selze = True
    assert _tik(d, 0.1) is None              # spolkne se, nespadne

    pusa.selze = False
    d.pridej_odpoved("tahle projde", "iid-2", nyni=0.2)
    assert _tik(d, 0.3) is not None
    assert _rekl(pusa, "tahle projde")


# -- prázdný text se nezařazuje ------------------------------------------

def test_i_prazdny_text_se_nezarazuje():
    pusa = FalesnaPusa()
    d = _dispecer(pusa)
    assert d.pridej_odpoved("   ", "iid-1", nyni=0.0) is False
    assert d.fronta.je_prazdna() is True


# -- obal: nikdy technický název do reproduktoru -------------------------

def test_i_obal_neznamy_druh_nepusti_technicky_nazev():
    tema = Tema(obsah="něco", priorita=PRIORITA_ODPOVED, platnost_s=120.0,
                interaction_id="iid-1", vzniklo=0.0, druh="uplne_novy_druh")
    text = obal(tema)
    assert "uplne_novy_druh" not in text
    assert "něco" in text


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
        # integrační — celá smyčka s falešnou pusou
        test_i_a_pri_replying_se_nic_nevstrikuje,
        test_i_b_nova_odpoved_maze_prubezne_end_to_end,
        test_i_c_po_platnosti_se_nevyslovi,
        test_i_d_stop_vyprazdni_frontu,
        test_i_e_stejna_priorita_v_poradi_vzniku,
        test_i_odpoved_predbehne_prubeh_i_smalltalk,
        test_i_watchdog_zaseknute_hrdlo_vyprazdni,
        test_i_mrtva_session_vyprazdni_a_nevstrikuje,
        test_i_rozbeh_nedovoli_dve_vstriknuti_za_sebou,
        test_i_rozbeh_se_nezasekne_kdyz_pusa_mlci,
        test_i_potvrzeni_se_nevyslovuje_znovu,
        test_i_selhani_vstriknuti_nezabije_dispecera,
        test_i_prazdny_text_se_nezarazuje,
        test_i_obal_neznamy_druh_nepusti_technicky_nazev,
    ]
    for test in testy:
        test()
        print("OK   %s" % test.__name__)
    print("Hotovo: %d testů prošlo (bez logovacího testu, ten chce pytest caplog)." % len(testy))


if __name__ == "__main__":
    main()
