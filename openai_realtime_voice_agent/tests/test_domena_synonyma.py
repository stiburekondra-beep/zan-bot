"""Domena, kterou Home Assistant nezna, nesmi tise sezrat povel.

ZIVA ZAMINKA 2. 9. 2026 17:48:40. Clovek rekl "Zapni zasuvku v loznici."
a model poslal HassTurnOn {area: "Loznice", domain: ["plug"]}. Vysledek:
`unconfirmed`. V registru pritom bylo vsechno v poradku -- zasuvka mela
jmeno "Zasuvka televize v loznici", spravnou oblast i vystaveni Assistovi.
Chybelo jedine to, ze domena zasuvky je v HA "switch", ne "plug".

Prohazovaci logika `oprav_domenu_a_tridu` takovou hodnotu nechytila: "plug"
neni ani v `_DOMENY`, ani v `_DEVICE_CLASSES`, takze propadla obema vetvemi
beze zmeny. Vlastnik z toho mel "zasuvka nechce zapnout" a hledal chybu tam,
kde zadna nebyla.

Testy nize hlidaji obe strany opravy:
  * neznama hodnota se prelozi na tu, kterou HA opravdu zna,
  * kdyz se prelozit neda, je o tom HLASITA stopa (ne tiche selhani),
  * a znama hodnota se nesmi zmenit -- oprava nesmi rozbit, co chodilo.
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "app"))

from voice_safety import oprav_domenu_a_tridu  # noqa: E402


def test_plug_se_prelozi_na_switch():
    """Ta konkretni veta z 2. 9. 2026 -- po oprave uz mysli na `switch`."""
    args = {"area": "Loznice", "domain": ["plug"]}
    zmeny = oprav_domenu_a_tridu(args)
    assert args["domain"] == ["switch"], args
    # device_class se ZAMERNE nedoplnuje -- "outlet" by hledani zuzilo na
    # entity, ktere tu tridu hlasi, a to u ZHA spolehnout nejde.
    assert "device_class" not in args, args
    assert any("plug -> switch" in z for z in zmeny), zmeny
    # A hlavne: po prekladu uz nesmi zbyt varovani, ze HA domenu nezna.
    assert not any("VAROVANI" in z for z in zmeny), zmeny


def test_zasuvka_cesky_i_s_diakritikou():
    for slovo in ("zasuvka", "zásuvka", "socket", "smart_plug"):
        args = {"area": "Loznice", "domain": slovo}
        oprav_domenu_a_tridu(args)
        assert args["domain"] == ["switch"], (slovo, args)


def test_neznama_domena_je_videt_v_logu():
    """Co prelozit neumime, musi aspon hlasite rict, ze povel nenajde nic."""
    args = {"area": "Loznice", "domain": ["kuchynsky_robot"]}
    zmeny = oprav_domenu_a_tridu(args)
    assert args["domain"] == ["kuchynsky_robot"], args
    assert any("VAROVANI" in z for z in zmeny), zmeny


def test_znama_domena_se_nemeni():
    """Regresni pojistka: co chodilo, musi chodit dal."""
    args = {"area": "Obývák", "domain": ["light"]}
    zmeny = oprav_domenu_a_tridu(args)
    assert args["domain"] == ["light"], args
    assert zmeny == [], zmeny


def test_prohazovani_domain_device_class_stale_funguje():
    """Puvodni chovani: "tv" je device_class, ne domena -- a naopak."""
    args = {"domain": ["tv"]}
    oprav_domenu_a_tridu(args)
    assert args.get("device_class") == ["tv"], args
    assert "domain" not in args, args

    args = {"device_class": ["light"]}
    oprav_domenu_a_tridu(args)
    assert args.get("domain") == ["light"], args
    assert "device_class" not in args, args


def test_prelozene_synonymum_projde_i_prohazovanim():
    """"televize" -> media_player je domena, takze v `domain` zustane."""
    args = {"domain": ["televize"]}
    oprav_domenu_a_tridu(args)
    assert args["domain"] == ["media_player"], args


def test_smiseny_seznam_prelozi_jen_neznamou_cast():
    args = {"domain": ["light", "plug"]}
    oprav_domenu_a_tridu(args)
    assert args["domain"] == ["light", "switch"], args


if __name__ == "__main__":
    selhalo = 0
    for jmeno, fn in sorted(list(globals().items())):
        if jmeno.startswith("test_") and callable(fn):
            try:
                fn()
                print("OK   %s" % jmeno)
            except AssertionError as e:
                selhalo += 1
                print("CHYBA %s: %s" % (jmeno, e))
    sys.exit(1 if selhalo else 0)
