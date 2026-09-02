"""Jednoslovná odpověď dítěte nesmí propadnout jako útržek.

Nález z rešerše režimu Učitel (2. 9. 2026): okno rozhovoru se dosud
otevíralo **jen** když Žánova věta končila otazníkem
(`dispecer_reci.konci_otazkou`). Jenže sokratovská otázka, výzva ve hře
ani doplňovačka průvodce otazníkem často nekončí:

    „Řekni mi, kolik je pět a sedm."
    „Teď ty."
    „Zkus to znovu."

Dítě na to odpoví jedním slovem — „dvanáct", „modrá", „ano" — a to bez
otevřeného okna spadne v `prepis_ocista` jako útržek. Sokratovská otázka,
hra i rozhovor tím mlčí.

Oprava nerozšiřuje heuristiku (to by otevíralo okno na oznámení — viz
docstring `konci_otazkou`), ale přidává **druhý, spolehlivější zdroj**:
kdo otázku položil, ten o ní ví. Mozek to řekne výslovně
(`ceka_na_odpoved: true` v odpovědi na `/voice`), most tomu věří.
"""
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.dispecer_reci import (  # noqa: E402
    OKNO_ODPOVEDI_S,
    ZNACKA_PTAM_SE,
    DispecerReci,
    konci_otazkou,
)
from app.prepis_ocista import ocisti  # noqa: E402
from app.odpoved_mozku import polozky, ptam_se_z_odpovedi  # noqa: E402


def _dispecer():
    async def _vyslov(text, run_llm=True):
        return True
    return DispecerReci(
        vyslov=_vyslov,
        pusa_mluvi=lambda: False,
        session_ziva=lambda: True,
    )


# ---------------------------------------------------------------------------
# jádro nálezu
# ---------------------------------------------------------------------------

VYZVY_BEZ_OTAZNIKU = [
    "Řekni mi, kolik je pět a sedm.",
    "Teď ty.",
    "Zkus to znovu.",
    "Doplň, co chybí.",
    "Vyber jednu barvu.",
]


@pytest.mark.parametrize("vyzva", VYZVY_BEZ_OTAZNIKU)
def test_vyzva_bez_otazniku_heuristiku_neprojde(vyzva):
    """Kotva nálezu: samotný otazníkový detektor tyhle věty nechytí."""
    assert konci_otazkou(vyzva) is False


@pytest.mark.parametrize("vyzva", VYZVY_BEZ_OTAZNIKU)
def test_mozek_rekne_ze_se_pta_a_okno_se_otevre(vyzva):
    d = _dispecer()
    assert d.zaznamenej_svou_otazku(vyzva, nyni=100.0, ptam_se=True) is True
    assert d.ceka_na_odpoved(nyni=100.0) is True


@pytest.mark.parametrize("odpoved", ["dvanáct", "modrá", "ano", "Eliška", "tři roky"])
def test_jednoslovna_odpoved_v_okne_projde(odpoved):
    """Celý řetěz: výzva bez otazníku → okno → krátká odpověď projde."""
    d = _dispecer()
    d.zaznamenej_svou_otazku("Řekni mi, kolik je pět a sedm.",
                             nyni=100.0, ptam_se=True)
    ceka = d.ceka_na_odpoved(nyni=101.0)
    assert ceka is True
    o = ocisti(odpoved, ceka_na_odpoved=ceka)
    assert o.utrzek is False, o.duvod
    assert o.text


def test_bez_okna_zustava_stara_brzda():
    """Regrese: mimo rozhovor je „dvanáct" pořád útržek. Kdyby ne, byla by
    útržková pojistka fakticky zrušená."""
    assert ocisti("dvanáct", ceka_na_odpoved=False).utrzek is True


def test_otaznik_dal_funguje_sam():
    d = _dispecer()
    assert d.zaznamenej_svou_otazku("Jak se jmenuješ?", nyni=50.0) is True
    assert d.ceka_na_odpoved(nyni=50.0) is True


def test_oznameni_okno_neotevre():
    """Rozšiřovat heuristiku na tázací slova by otevíralo okno na oznámení —
    a otevřené okno = vypnutá útržková brzda na dvacet sekund."""
    d = _dispecer()
    assert d.zaznamenej_svou_otazku("Řeknu ti, kolik je hodin.", nyni=10.0) is False
    assert d.ceka_na_odpoved(nyni=10.0) is False


def test_ptam_se_false_okno_neotevre():
    d = _dispecer()
    assert d.zaznamenej_svou_otazku("Jak se jmenuješ?", nyni=10.0,
                                    ptam_se=False) is False


def test_okno_vyprsi():
    d = _dispecer()
    d.zaznamenej_svou_otazku("Teď ty.", nyni=100.0, ptam_se=True)
    assert d.ceka_na_odpoved(nyni=100.0 + OKNO_ODPOVEDI_S + 0.1) is False


# ---------------------------------------------------------------------------
# kontrakt s mozkem
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("payload", [
    {"reply": "Teď ty.", "ceka_na_odpoved": True},
    {"reply": "Teď ty.", "cekam_na_odpoved": True},
    {"reply": "Teď ty.", "otazka": True},
    {"reply": "Teď ty.", "awaiting_reply": True},
    {"reply": "Teď ty.", "expects_reply": "true"},
    {"reply": "Teď ty.", "ceka_na_odpoved": "ano"},
])
def test_mozek_smi_rict_ze_se_pta(payload):
    assert ptam_se_z_odpovedi(payload) is True


@pytest.mark.parametrize("payload", [
    {"reply": "Zhasnuto."},
    {"reply": "Zhasnuto.", "ceka_na_odpoved": False},
    {"reply": "Zhasnuto.", "otazka": ""},
    {},
    None,
    "nesmysl",
])
def test_fail_closed_kdyz_mozek_mlci(payload):
    """Bez výslovného „ptám se" platí útržková pojistka dál."""
    assert ptam_se_z_odpovedi(payload) is False


def test_znacku_dostane_jen_posledni_veta_davky():
    """Okno se má otevřít až po dořečené otázce, ne po první větě před ní."""
    items = polozky({
        "chunks": ["Zkusíme počty.", "Řekni mi, kolik je pět a sedm."],
        "ceka_na_odpoved": True,
    })
    assert [i[2] for i in items] == [False, True]


def test_lokalni_potvrzeni_se_nevyslovuje_znovu():
    """Regrese na `local_confirmation` — přestěhováním parsování se nesmělo
    ztratit, že potvrzení už zaznělo z knihovny."""
    assert polozky({"reply": "Zhasnuto.", "local_confirmation": "success"})         == [("Zhasnuto.", False, False)]
    assert polozky({"reply": "Zhasnuto."}) == [("Zhasnuto.", True, False)]


def test_znacka_ma_jmeno_ktere_se_hleda_v_tema():
    """Značka jede přes `Tema.znacka` (řetězec s čárkami), takže nesmí být
    podřetězcem jiné značky — jinak by se otevíralo okno na pozdní odpověď."""
    from app.dispecer_reci import ZNACKA_POZDNI
    assert ZNACKA_PTAM_SE not in ZNACKA_POZDNI
    assert ZNACKA_POZDNI not in ZNACKA_PTAM_SE
