"""Když přepis tahu nedorazí, rozhoduje argument — a jen u měkkých věcí.

Večer 2. 9. 2026 spolkla útržková pojistka dětskou prosbu o pohádku:
model zavolal ``HassMediaSearchAndPlay(search_query='Rachotík nechce
nastartovat')``, přepis té promluvy nedorazil vůbec a pojistka soudila
podle staršího útržku ``hotýlek``. Titul přitom stojí v knihovně pohádek.

Dvě věty, které tenhle soubor hlídá:

* přepis nedorazil + ``search_query`` z knihovny  → **provést**
* přepis nedorazil + ``HassTurnOn`` bez přepisu   → **neprovést**

Spuštění bez pytestu (na krabici není):  python3 tests/test_utrzek_argumenty.py
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app import utrzek_argumenty as U  # noqa: E402


# Doslovně to, co runner vrací na `GET /knihovna` (zkráceno na tři tituly).
KNIHOVNA = {
    "ok": True,
    "pohadky": [
        {"slug": "01-jak-lubos-spravil-hraz",
         "nazev": "01 — Jak Luboš spravil hráz", "hrdina": "bobr-lubos"},
        {"slug": "03-rachotik-nechce-nastartovat",
         "nazev": "03 — Rachotík nechce nastartovat", "hrdina": "bobr-lubos"},
        {"slug": "lubos-a-ztracena-hraz",
         "nazev": "Bobr Luboš a ztracená hráz", "hrdina": "bobr-lubos"},
    ],
    "hrdinove": [{"slug": "bobr-lubos", "jmeno": "Bobr Luboš"}],
}


def nazvy():
    return U._Knihovna._z_odpovedi(KNIHOVNA)


class ZaminkaVecera(unittest.TestCase):
    """Přesně ten tah z 18:02:55, řádek po řádku z logu."""

    VOLANI = {"media_class": "episode",
              "search_query": "Rachotík nechce nastartovat"}
    UTRZEK = "hotýlek"

    def test_prepis_nedorazil_a_titul_je_z_knihovny_PROVEST(self):
        duvod = U.omluva("HassMediaSearchAndPlay", self.VOLANI,
                         prepis_dorazil=False, utrzek=self.UTRZEK,
                         nazvy=nazvy())
        self.assertTrue(duvod, 'pohádka ze seznamu se zase nepustila')
        self.assertIn("Rachotík nechce nastartovat", duvod)

    def test_kdyz_prepis_DORAZIL_a_nebyl_povel_zakaz_plati(self):
        """Argument je náhradní svědek, ne odvolací instance."""
        self.assertEqual(
            U.omluva("HassMediaSearchAndPlay", self.VOLANI,
                     prepis_dorazil=True, utrzek=self.UTRZEK, nazvy=nazvy()),
            "")


class DumZustavaFailClosed(unittest.TestCase):
    """Cena omylu u světla a zásuvky je jiná než u pohádky."""

    def test_prepis_nedorazil_HassTurnOn_NEPROVEST(self):
        self.assertEqual(
            U.omluva("HassTurnOn", {"name": "lampa", "domain": ["light"]},
                     prepis_dorazil=False, utrzek="hotýlek", nazvy=nazvy()),
            "")

    def test_ani_kdyz_argument_vypada_jako_veta(self):
        self.assertEqual(
            U.omluva("HassTurnOff",
                     {"search_query": "Rachotík nechce nastartovat"},
                     prepis_dorazil=False, utrzek="hotýlek", nazvy=nazvy()),
            "")

    def test_v_mekkych_nastrojich_neni_nic_co_saha_na_dum(self):
        for jmeno in U.MEKKE_NASTROJE:
            self.assertNotIn("TurnOn", jmeno)
            self.assertNotIn("TurnOff", jmeno)
            self.assertNotIn("LightSet", jmeno)


class CoJesteNeniDukaz(unittest.TestCase):

    def test_prazdny_dotaz_nic_nedokazuje(self):
        self.assertEqual(
            U.omluva("HassMediaSearchAndPlay", {"search_query": ""},
                     prepis_dorazil=False, utrzek="hotýlek", nazvy=nazvy()), "")

    def test_ozvena_utrzku_neni_dukaz(self):
        """Model jen zopakoval, co spadlo do přepisu — to nic nepřidává."""
        self.assertEqual(
            U.omluva("HassMediaSearchAndPlay",
                     {"search_query": "hotýlek"},
                     prepis_dorazil=False, utrzek="hotýlek", nazvy=nazvy()), "")
        self.assertEqual(
            U.omluva("HassMediaSearchAndPlay",
                     {"search_query": "ver"},
                     prepis_dorazil=False, utrzek="A ver.", nazvy=nazvy()), "")

    def test_jedno_slovo_mimo_knihovnu_neni_veta(self):
        self.assertEqual(
            U.omluva("HassMediaSearchAndPlay", {"search_query": "hotýlek"},
                     prepis_dorazil=False, utrzek="", nazvy=nazvy()), "")

    def test_souvisla_veta_mimo_knihovnu_projde(self):
        """Hudba: cena omylu je jedna skladba a slovo „dost"."""
        duvod = U.omluva("HassMediaSearchAndPlay",
                         {"media_class": "music",
                          "search_query": "vánoční koledy"},
                         prepis_dorazil=False, utrzek="hotýlek", nazvy=nazvy())
        self.assertTrue(duvod)


class ShodaSKnihovnou(unittest.TestCase):

    def test_titul_s_poradovym_cislem_se_pozna_i_bez_nej(self):
        self.assertEqual(
            U.shoda_s_knihovnou("Rachotík nechce nastartovat", nazvy()),
            "03 — Rachotík nechce nastartovat")

    def test_diakritika_nerozhoduje(self):
        self.assertEqual(
            U.shoda_s_knihovnou("rachotik nechce nastartovat", nazvy()),
            "03 — Rachotík nechce nastartovat")

    def test_castecna_shoda_dvema_vyznamnymi_slovy(self):
        self.assertEqual(
            U.shoda_s_knihovnou("ztracená hráz", nazvy()),
            "Bobr Luboš a ztracená hráz")

    def test_hrdina_se_pozna(self):
        self.assertTrue(U.shoda_s_knihovnou("Bobr Luboš", nazvy()))

    def test_cizi_vec_se_netrefi(self):
        self.assertEqual(U.shoda_s_knihovnou("zprávy z rádia", nazvy()), "")

    def test_jedno_kratke_slovo_netrefi_nic(self):
        self.assertEqual(U.shoda_s_knihovnou("a", nazvy()), "")


class KnihovnaSeNecteKazdeVolani(unittest.TestCase):

    def test_druhy_dotaz_jde_z_pameti(self):
        k = U._Knihovna(nacti=lambda: KNIHOVNA, ttl_s=60)
        self.assertTrue(k.nazvy())
        self.assertTrue(k.nazvy())
        self.assertEqual(k.dotazu, 1, 'runner se ptá při každém volání')

    def test_kdyz_runner_nebezi_pojistka_nespadne(self):
        def rozbite():
            raise OSError('spojení odmítnuto')
        k = U._Knihovna(nacti=rozbite, ttl_s=60)
        self.assertEqual(k.nazvy(), ())
        # a rozhodování pak stojí na druhém kritériu, ne na výjimce
        self.assertTrue(U.povel_z_argumentu(
            "HassMediaSearchAndPlay",
            {"search_query": "Rachotík nechce nastartovat"},
            utrzek="hotýlek", nazvy=k.nazvy()))


if __name__ == '__main__':
    unittest.main(verbosity=2)
