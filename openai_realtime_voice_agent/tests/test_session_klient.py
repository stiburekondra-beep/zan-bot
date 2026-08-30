# -*- coding: utf-8 -*-
"""Test drátů mezi mostem a plátnem: session gate + zdroj zařízení.

Co se ověřuje (a proč zrovna tohle):

  * **gate** — `listening=false` zavře mikrofon, `listening=true` ho otevře,
    a hlavně: **mrtvé plátno pouští dál** (fail-safe „dům nesmí ohluchnout
    kvůli UI"). Plus wake grace: po wake wordu se pustí i při `false`,
    protože wake je výslovný lidský akt.
  * **heard / mute** — jde ven správné tělo na správnou adresu, a odpověď
    plátna (`{accepted, session}`) rovnou aktualizuje známé `listening`.
  * **zdroj zařízení** — mapování IP → jméno, neznámá adresa syrová,
    rozbitá `ZAN_ZARIZENI_MAPA` nesmí shodit identitu.

Bez sítě a bez pipecatu — HTTP vrstva se injektuje (`http=`), čas taky
(`ted=`), takže test nezávisí na časování stroje ani na běžícím plátně.

    python tests/test_session_klient.py        # z adresáře add-onu
    pytest tests/test_session_klient.py
"""
import asyncio
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.session_klient import SessionKlient  # noqa: E402
from app.zdroj_zarizeni import (  # noqa: E402
    nacti_mapu,
    normalizuj,
    payload_voice,
    zdroj_zarizeni,
    VYCHOZI_MAPA,
)


class FalesneHttp:
    """Falešné plátno. Zaznamenává volání, vrací co mu řekneš."""

    def __init__(self, odpoved=None, vyjimka=None):
        self.odpoved = odpoved if odpoved is not None else {}
        self.vyjimka = vyjimka
        self.volani = []

    def __call__(self, url, token, payload, timeout):
        self.volani.append({"url": url, "token": token, "payload": payload})
        if self.vyjimka is not None:
            raise self.vyjimka
        return self.odpoved


def klient(http, **kw):
    kw.setdefault("url", "http://127.0.0.1:4600")
    kw.setdefault("gate", True)
    kw.setdefault("wake_grace_s", 30.0)
    return SessionKlient(http=http, **kw)


# --- gate -----------------------------------------------------------------

def test_gate_listening_false_zavre():
    http = FalesneHttp({"listening": False, "mode": "spi"})
    k = klient(http)
    assert k.pusti_audio() is True, "před prvním dotazem se poslouchá"
    asyncio.run(k.tik())
    assert k.posloucha is False
    assert k.pusti_audio() is False, "listening=false musí zavřít mikrofon"
    print("✅ gate: listening=false → audio se zahazuje")


def test_gate_listening_true_pusti():
    http = FalesneHttp({"listening": True, "mode": "session"})
    k = klient(http)
    asyncio.run(k.tik())
    assert k.posloucha is True
    assert k.pusti_audio() is True
    print("✅ gate: listening=true → audio prochází")


def test_gate_mrtve_platno_pusti():
    """FAIL-SAFE. Výpadek plátna nesmí ohluchnout dům."""
    zive = FalesneHttp({"listening": False, "mode": "spi"})
    k = klient(zive)
    asyncio.run(k.tik())
    assert k.pusti_audio() is False, "kontrola: nejdřív opravdu zavřeno"

    k._http = FalesneHttp(vyjimka=OSError("connection refused"))
    ok = asyncio.run(k.tik())
    assert ok is False, "tik musí přiznat, že se nepovedl"
    assert k.posloucha is True
    assert k.pusti_audio() is True, "mrtvé plátno → poslouchej jako dosud"
    print("✅ gate: plátno nedostupné → audio prochází (fail-safe)")


def test_gate_odpoved_bez_listening_pusti():
    """Nesmyslná odpověď se nepočítá jako 'nemá poslouchat'."""
    k = klient(FalesneHttp({"neco": "jineho"}))
    asyncio.run(k.tik())
    assert k.pusti_audio() is True
    print("✅ gate: odpověď bez `listening` → poslouchej")


def test_gate_vypnuty_pusti_vzdy():
    k = klient(FalesneHttp({"listening": False}), gate=False)
    asyncio.run(k.tik())
    assert k.posloucha is False, "stav se sleduje i s vypnutým gatem"
    assert k.pusti_audio() is True, "vypnutý gate nesmí nikdy zavřít"
    print("✅ gate vypnutý: hlásí stav, ale nezavírá")


def test_gate_wake_grace():
    """Wake word je výslovný akt — otevře cestu i v režimu SPÍ."""
    cas = {"t": 100.0}
    k = klient(FalesneHttp({"listening": False, "mode": "spi"}),
               ted=lambda: cas["t"], wake_grace_s=30.0)
    asyncio.run(k.tik())
    assert k.pusti_audio() is False
    k.note_wake()
    assert k.pusti_audio() is True, "hned po wake se pouští"
    cas["t"] += 29.0
    assert k.pusti_audio() is True, "uvnitř okna se pořád pouští"
    cas["t"] += 2.0
    assert k.pusti_audio() is False, "po vypršení okna se zase zavírá"
    print("✅ gate: wake grace otevře na 30 s a pak se zavře")


# --- dráty ven ------------------------------------------------------------

def test_heard_posle_spravne_telo():
    http = FalesneHttp({"accepted": True, "session": {"listening": True, "mode": "session"}})
    k = klient(http)
    k._posli_blokujici({"action": "heard"})    # bez smyčky, deterministicky
    assert len(http.volani) == 1
    v = http.volani[0]
    assert v["url"] == "http://127.0.0.1:4600/api/session"
    assert v["payload"] == {"action": "heard"}
    assert k.posloucha is True, "odpověď POSTu rovnou aktualizuje stav"
    print("✅ heard: POST {action:'heard'} na /api/session + převzetí stavu")


def test_mute_posle_muted():
    http = FalesneHttp({"accepted": True, "session": {"listening": False, "mode": "mute"}})
    k = klient(http)
    k.mute(True)
    for _ in range(200):          # `mute()` mimo smyčku běží ve vlákně
        if http.volani:
            break
        import time as _t
        _t.sleep(0.01)
    assert http.volani, "POST se neodeslal"
    payload = http.volani[0]["payload"]
    assert payload["action"] == "mute" and payload["muted"] is True
    print("✅ mute: POST {action:'mute', muted:true}")


def test_selhany_post_neshodi_a_pusti():
    k = klient(FalesneHttp(vyjimka=OSError("nikdo doma")))
    k._posli_blokujici({"action": "heard"})    # nesmí vyhodit
    assert k.pusti_audio() is True
    print("✅ selhaný POST: hlas neshodí, ucho zůstane otevřené")


def test_token_jde_do_hlavicky():
    http = FalesneHttp({"listening": True})
    k = klient(http, token="tajne")
    asyncio.run(k.tik())
    assert http.volani[0]["token"] == "tajne"
    print("✅ token se předává HTTP vrstvě (Authorization: Bearer)")


# --- zdroj zařízení -------------------------------------------------------

def test_mapovani_znamych_ip():
    assert zdroj_zarizeni("192.168.0.115", VYCHOZI_MAPA) == "voice_pe"
    assert zdroj_zarizeni("192.168.0.12", VYCHOZI_MAPA) == "respeaker"
    print("✅ zdroj: 192.168.0.115→voice_pe, 192.168.0.12→respeaker")


def test_neznama_ip_zustane_syrova():
    assert zdroj_zarizeni("192.168.0.77", VYCHOZI_MAPA) == "192.168.0.77"
    print("✅ zdroj: neznámá adresa jde syrová, nezahazuje se")


def test_prazdny_klient_je_none():
    assert zdroj_zarizeni("", VYCHOZI_MAPA) is None
    assert zdroj_zarizeni(None, VYCHOZI_MAPA) is None
    print("✅ zdroj: bez klienta se pole do payloadu nedává")


def test_normalizace_adresy():
    assert normalizuj("::ffff:192.168.0.115") == "192.168.0.115"
    assert normalizuj("192.168.0.115:51234") == "192.168.0.115"
    assert normalizuj("[::1]:8080") == "::1"
    assert zdroj_zarizeni("::ffff:192.168.0.12", VYCHOZI_MAPA) == "respeaker"
    print("✅ zdroj: ::ffff: obal i port se odloupnou před mapováním")


def test_mapa_z_env():
    mapa = nacti_mapu('{"10.0.0.5": "kuchyne"}')
    assert mapa == {"10.0.0.5": "kuchyne"}
    assert zdroj_zarizeni("10.0.0.5", mapa) == "kuchyne"
    print("✅ zdroj: ZAN_ZARIZENI_MAPA přebije výchozí mapu")


def test_rozbita_mapa_spadne_na_vychozi():
    assert nacti_mapu("{tohle není json") == VYCHOZI_MAPA
    assert nacti_mapu('["seznam"]') == VYCHOZI_MAPA
    assert nacti_mapu("") == VYCHOZI_MAPA
    print("✅ zdroj: rozbitá mapa → výchozí, identita se neztratí")


def test_payload_voice_nese_zdroj():
    """Kompatibilita: `zdroj_zarizeni` přibude, nic jiného se nemění.

    Testuje se OPRAVDU ta funkce, kterou volá `ZanBridge._payload`
    (proto je skládání payloadu v `zdroj_zarizeni.py` a ne v mostu —
    `app.zan_bridge_tool` táhne pipecat, který v testech není).
    """
    assert payload_voice("ahoj", 7, "voice_pe") == {
        "text": "ahoj", "chat_id": 7, "zdroj_zarizeni": "voice_pe"}
    assert payload_voice("ahoj", 7, None) == {"text": "ahoj", "chat_id": 7}
    assert payload_voice("ahoj", None, "respeaker") == {
        "text": "ahoj", "zdroj_zarizeni": "respeaker"}
    print("✅ payload: `zdroj_zarizeni` je aditivní, bez zdroje klíč chybí")


TESTY = [v for k, v in sorted(globals().items()) if k.startswith("test_")]

if __name__ == "__main__":
    for t in TESTY:
        t()
    print(f"\n🎉 {len(TESTY)} testů prošlo")
