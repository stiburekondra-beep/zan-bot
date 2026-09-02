"""Co rychlá dráha nedokázala, jde za mozkem — a nejvýš jednou za tah.

Živý nález 2. 9. 2026, 17:48:40 a 17:49:07: dvakrát `HassTurnOn` =
`unconfirmed`, a tím to skončilo. Vlastník: „a proč to nešlo až do hlavního
mozku!" Mozek má rejstřík domu, rychlá dráha jen jméno od modelu.

Spuštění bez pytestu:  python3 tests/test_predani_mozku.py
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app import predani_mozku as P  # noqa: E402


class KdySePreda(unittest.TestCase):

    def test_unconfirmed_jde_za_mozkem(self):
        self.assertTrue(P.predat('unconfirmed', tah=100.0, uz_predano_tah=0.0))

    def test_ok_za_mozkem_nejde(self):
        self.assertFalse(P.predat('ok', tah=100.0, uz_predano_tah=0.0))

    def test_chyba_i_selhani_jdou_taky(self):
        self.assertTrue(P.predat('error', tah=100.0, uz_predano_tah=0.0))
        self.assertTrue(P.predat('fail', tah=100.0, uz_predano_tah=0.0))

    def test_ha_down_se_nepreda(self):
        """Když Home Assistant nežije, nemá mozek čím pomoct."""
        self.assertFalse(P.predat('ha_down', tah=100.0, uz_predano_tah=0.0))


class PojistkaProtiSmycce(unittest.TestCase):

    def test_podruhe_ve_stejnem_tahu_uz_ne(self):
        self.assertFalse(P.predat('unconfirmed', tah=100.0, uz_predano_tah=100.0))

    def test_v_dalsim_tahu_zase_ano(self):
        self.assertTrue(P.predat('unconfirmed', tah=101.5, uz_predano_tah=100.0))

    def test_bez_razitka_se_predani_neblokuje(self):
        """Kanál bez přepisu (testy, satelit bez STT) nesmí přijít o pomoc."""
        self.assertTrue(P.predat('unconfirmed', tah=0.0, uz_predano_tah=0.0))


class ZadaniProMozek(unittest.TestCase):

    def test_veta_cloveka_je_prvni_a_cela(self):
        t = P.zadani('Rozsviť v ložnici', 'HassTurnOn',
                     {'area': 'Ložnice', 'domain': ['plug']}, 'unconfirmed')
        self.assertTrue(t.startswith('Rozsviť v ložnici'))

    def test_poznamka_nese_intent_argumenty_i_vysledek(self):
        t = P.zadani('Rozsviť v ložnici', 'HassTurnOn',
                     {'area': 'Ložnice', 'domain': ['plug']}, 'unconfirmed')
        self.assertIn('HassTurnOn', t)
        self.assertIn('Ložnice', t)
        self.assertIn('unconfirmed', t)

    def test_bez_prepisu_se_to_prizna_a_neco_posle_stejne(self):
        t = P.zadani('', 'HassTurnOn', {'name': 'TV ložnice'}, 'unconfirmed')
        self.assertIn('Nemám přepis', t)
        self.assertIn('TV ložnice', t)

    def test_zadani_je_kratke_at_mozek_necte_json(self):
        t = P.zadani('Zapni to', 'HassTurnOn',
                     {'name': 'x' * 500, 'area': 'y' * 500}, 'unconfirmed')
        self.assertLess(len(t), 400)


if __name__ == '__main__':
    unittest.main(verbosity=2)
