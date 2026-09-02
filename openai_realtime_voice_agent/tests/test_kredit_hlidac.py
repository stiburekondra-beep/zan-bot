"""Hlídač zůstatku u poskytovatele — karta -44 bod 3.

Co se tu hlídá především: aby se **rate limit nespletl s došlým kreditem**.
Obojí přijde jako odmítnutí od téhož poskytovatele a obojí obsahuje slovo
„quota"; kdyby to hlídač nerozlišil, přehazoval by pusu při každém rušném
večeru — a přepínání pusy je slyšet (jiný hlas), takže falešný poplach má
cenu.
"""
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.kredit_hlidac import (  # noqa: E402
    KreditHlidac,
    klasifikuj,
    veta_oznameni,
    zaloha_pro,
)


class Hodiny:
    """Ruční čas — hlídač nesmí potřebovat skutečné čekání."""

    def __init__(self, t=1000.0):
        self.t = t

    def __call__(self):
        return self.t

    def posun(self, o):
        self.t += o


# ---------------------------------------------------------------------------
# klasifikace
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("text", [
    "Error code: 429 - insufficient_quota: You exceeded your current quota",
    "billing_hard_limit_reached",
    "Your credit balance is too low to access the API",
    "HTTP 402 Payment Required",
    "RESOURCE_EXHAUSTED: quota_exceeded for billing account",
])
def test_kredit(text):
    assert klasifikuj(text) == "kredit"


@pytest.mark.parametrize("text", [
    "Rate limit reached for gpt-realtime-2 in organization org-x",
    "429 Too Many Requests",
    "rate_limit_exceeded: Limit 40000 tokens per min",
])
def test_rychlost_neni_kredit(text):
    """Nejdůležitější test souboru: rychlost NENÍ došlý kredit."""
    assert klasifikuj(text) == "rychlost"


@pytest.mark.parametrize("text", [
    "Incorrect API key provided: sk-***",
    "401 Unauthorized",
    "PERMISSION_DENIED: API key not valid",
])
def test_klic(text):
    assert klasifikuj(text) == "klic"


@pytest.mark.parametrize("text", [
    "keepalive ping timeout; no close frame received",
    "ConnectionClosed: sent 1011 (internal error)",
    "",
    "   ",
])
def test_bezna_porucha_neni_o_penezich(text):
    assert klasifikuj(text) == ""


def test_klasifikuje_i_vyjimku():
    class ApiError(Exception):
        pass
    assert klasifikuj(ApiError("insufficient_quota")) == "kredit"


def test_zaloha_je_ta_druha_pusa():
    assert zaloha_pro("openai") == "gemini"
    assert zaloha_pro("gemini") == "openai"
    assert zaloha_pro("") == "openai"       # nesmysl → něco, co umí mluvit
    assert zaloha_pro("nesmysl") == "openai"


# ---------------------------------------------------------------------------
# počítadlo a poplach
# ---------------------------------------------------------------------------

def test_jedna_chyba_netroubi():
    h = KreditHlidac("openai", prah=3, monotonic=Hodiny())
    assert h.zaznamenej("insufficient_quota") is None


def test_tri_za_sebou_troubi_jednou():
    h = KreditHlidac("openai", prah=3, monotonic=Hodiny())
    assert h.zaznamenej("insufficient_quota") is None
    assert h.zaznamenej("insufficient_quota") is None
    nalez = h.zaznamenej("insufficient_quota")
    assert nalez is not None
    druh, zaloha, veta = nalez
    assert druh == "kredit"
    assert zaloha == "gemini"
    # Podruhé už mlčí — ohlášené zůstává ohlášené.
    assert h.zaznamenej("insufficient_quota") is None


def test_bezna_porucha_mezi_tim_vynuluje():
    """Tři nesouvisející výpadky za týden nesmí dát dohromady poplach."""
    h = KreditHlidac("openai", prah=3, monotonic=Hodiny())
    h.zaznamenej("insufficient_quota")
    h.zaznamenej("insufficient_quota")
    h.zaznamenej("keepalive ping timeout")     # jiná porucha → nulování
    assert h.zaznamenej("insufficient_quota") is None
    assert h.snapshot()["pocet_za_sebou"] == 1


def test_rate_limit_nikdy_nespusti_prepnuti():
    h = KreditHlidac("openai", prah=2, monotonic=Hodiny())
    for _ in range(10):
        assert h.zaznamenej("Rate limit reached for gpt-realtime-2") is None
    assert h.ohlaseno is False


def test_stare_chyby_vypadnou_z_okna():
    hod = Hodiny()
    h = KreditHlidac("openai", prah=3, okno_s=600.0, monotonic=hod)
    h.zaznamenej("insufficient_quota")
    h.zaznamenej("insufficient_quota")
    hod.posun(601)                              # jiná epizoda
    assert h.zaznamenej("insufficient_quota") is None
    assert h.snapshot()["pocet_za_sebou"] == 1


def test_zmena_povahy_chyby_zacina_znovu():
    h = KreditHlidac("openai", prah=3, monotonic=Hodiny())
    h.zaznamenej("insufficient_quota")
    h.zaznamenej("insufficient_quota")
    assert h.zaznamenej("401 Unauthorized") is None   # kredit → klíč
    assert h.snapshot()["druh"] == "klic"
    assert h.snapshot()["pocet_za_sebou"] == 1


# ---------------------------------------------------------------------------
# věta jde do UŠÍ, ne do logu
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("pusa", ["openai", "gemini"])
def test_veta_je_pro_usi(pusa):
    veta = veta_oznameni(pusa, "kredit")
    assert not any(z.isdigit() for z in veta), "číslice se česky nedají skloňovat"
    zakazane = ("mozek", "session", "token", "API", "OpenAI", "Gemini",
                "kredit", "quota")
    for slovo in zakazane:
        assert slovo.lower() not in veta.lower(), slovo
    assert "záložním" in veta or "druhý" in veta


def test_veta_pri_neplatnem_klici_je_jina():
    """Přepnutí klíč nespraví — věta to nesmí slibovat stejně."""
    assert veta_oznameni("openai", "klic") != veta_oznameni("openai", "kredit")
