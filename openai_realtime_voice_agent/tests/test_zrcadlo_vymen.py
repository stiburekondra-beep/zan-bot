# -*- coding: utf-8 -*-
"""Zrcadlení konverzačních výměn do Žán-Code (`POST /event {typ:"vymena"}`).

PROČ TENHLE TEST EXISTUJE. `build_exchange_event` byla od 25. 8. 2026 hot-patch
v běžícím kontejneru. 30. 8. se do gitu zachránila jen DEFINICE, volající ne
(commit b0bae1e: „Zatím se nikde nevolá — přidána pouze definice"). Rebuild ji
tedy neztratil, ale nikdo ji nezavolal: poslední `typ:"vymena"` v kronice je
z 27. 8. Změřeno 1. 9.: z 69 lidských promluv u televize skončilo ve společném
vlákně SEDM. Definice bez volajícího vypadá v diffu jako hotová věc — tenhle
test je to, co rozdíl pozná.

Testuje se `ZrcadloVymen` z `app.voice_fastlane`, ne mixin: `fastlane_mixin`
se bez nainstalovaného `pipecat` ani nenaimportuje, kdežto párovací pravidla
jsou čistá logika a mají být ověřitelná všude.
"""

import json
from unittest import mock

import pytest

from app.voice_fastlane import ZrcadloVymen, build_exchange_event, event_url


class Hodiny:
    """Ručně posouvaný čas — okno výměny se nemá testovat čekáním."""

    def __init__(self):
        self.t = 1000.0

    def __call__(self):
        return self.t


@pytest.fixture
def zrcadlo():
    poslane = []
    hodiny = Hodiny()
    z = ZrcadloVymen(odeslat=poslane.append, hodiny=hodiny)
    return z, poslane, hodiny


# --- to hlavní: po výměně se odešle událost typu "vymena" -------------------

def test_po_vymene_se_odesle_udalost_typu_vymena(zrcadlo):
    z, poslane, _ = zrcadlo
    z.clovek_rekl("jak dlouho se peče kuře")
    z.pusa_odpovedela("hodinu a půl na sto osmdesáti")

    assert len(poslane) == 1, "výměna se neodeslala vůbec"
    p = poslane[0]
    assert p["typ"] == "vymena"
    assert p["text_user"] == "jak dlouho se peče kuře"
    assert p["text_asistent"] == "hodinu a půl na sto osmdesáti"
    assert p["kanal"] == "realtime"
    assert p["ts"]


def test_odeslani_jde_opravdu_pres_http_post(monkeypatch):
    """Kontrolní strana k testu výš: „zavolal se callback" ještě neznamená,
    že payload dojde na `POST /event`. Tady se podvrhuje až `urlopen`."""
    from app import voice_fastlane as vf

    zachyceno = {}

    class FakeResp:
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def read(self):
            return b""

    def fake_urlopen(req, timeout=None):
        zachyceno["url"] = req.full_url
        zachyceno["telo"] = json.loads(req.data.decode("utf-8"))
        zachyceno["auth"] = req.headers.get("Authorization")
        return FakeResp()

    monkeypatch.setattr(vf.urllib.request, "urlopen", fake_urlopen)

    z = ZrcadloVymen(odeslat=lambda p: vf._post_event_blocking(
        event_url("http://krabice:8098/voice"), "tajny-token", p))
    z.clovek_rekl("dobrou noc")
    z.pusa_odpovedela("dobrou, spi dobře")

    assert zachyceno["url"].endswith("/event"), zachyceno["url"]
    assert zachyceno["telo"]["typ"] == "vymena"
    assert zachyceno["telo"]["text_user"] == "dobrou noc"
    assert zachyceno["auth"] == "Bearer tajny-token"


# --- co se zrcadlit NESMÍ ---------------------------------------------------

def test_tah_prevzaty_mozkem_se_nezrcadli(zrcadlo):
    """Server u `POST /voice` píše obě půlky do vlákna sám. Druhý zápis by
    znamenal celý rozhovor s mozkem ve vlákně dvakrát."""
    z, poslane, _ = zrcadlo
    z.clovek_rekl("kolik jsme včera utopili za elektřinu")
    z.mozek_to_prevzal()
    z.pusa_odpovedela("sto dvacet korun")
    assert poslane == []


def test_priznak_mozku_plati_jen_na_ten_jeden_tah(zrcadlo):
    z, poslane, _ = zrcadlo
    z.clovek_rekl("první")
    z.mozek_to_prevzal()
    z.pusa_odpovedela("odpověď mozku")
    z.clovek_rekl("druhá")
    z.pusa_odpovedela("odpověď pusy")
    assert [p["text_user"] for p in poslane] == ["druhá"]


def test_nova_promluva_rusi_priznak_mozku(zrcadlo):
    # Kdyby příznak přežil nový tah, ztratila by se výměna, která s mozkem
    # nemá nic společného — a to je přesně ta, kvůli které to celé je.
    z, poslane, _ = zrcadlo
    z.mozek_to_prevzal()
    z.clovek_rekl("a co počasí")
    z.pusa_odpovedela("zítra prší")
    assert len(poslane) == 1


def test_prazdna_vymena_se_neposila(zrcadlo):
    z, poslane, _ = zrcadlo
    z.clovek_rekl("")
    z.pusa_odpovedela("   ")
    assert poslane == []


def test_lidska_pulka_se_nepripoji_ke_druhe_odpovedi(zrcadlo):
    """Jinak by tatáž věta byla ve vlákně dvakrát, podruhé u cizí odpovědi."""
    z, poslane, _ = zrcadlo
    z.clovek_rekl("rozsviť v kuchyni")
    z.pusa_odpovedela("rozsvěcuju")
    z.pusa_odpovedela("ještě něco?")
    assert [p["text_user"] for p in poslane] == ["rozsviť v kuchyni", ""]
    assert poslane[1]["text_asistent"] == "ještě něco?"


def test_stara_pulka_se_k_odpovedi_nelepi(zrcadlo):
    z, poslane, hodiny = zrcadlo
    z.clovek_rekl("co je k večeři")
    hodiny.t += 10_000  # o hodiny později; tohle už není táž výměna
    z.pusa_odpovedela("je půlnoc, jdi spát")
    assert len(poslane) == 1
    assert poslane[0]["text_user"] == ""
    assert poslane[0]["text_asistent"] == "je půlnoc, jdi spát"


def test_pad_odesilace_neshodi_hlas(zrcadlo):
    z, _, _ = zrcadlo
    z2 = ZrcadloVymen(odeslat=mock.Mock(side_effect=RuntimeError("síť spadla")))
    z2.clovek_rekl("ahoj")
    assert z2.pusa_odpovedela("ahoj taky") is None  # nevyhodí, jen se to zaloguje


# --- tvar payloadu, na kterém stojí server ----------------------------------

def test_payload_ma_presne_pole_ktera_server_cte():
    """`handleEvent` si z těla vybere jen známá pole; větev `typ:"vymena"`
    čte `kanal`, `kdo`, `text_user`, `text_asistent`."""
    p = build_exchange_event("voice", "a", "b")
    for pole in ("typ", "source", "kanal", "kdo", "text_user", "text_asistent", "ts"):
        assert pole in p, pole
    assert p["typ"] == "vymena"


def test_event_url_vede_na_event_ne_na_voice():
    assert event_url("http://krabice:8098/voice") == "http://krabice:8098/event"
    assert event_url("") == ""
