"""Kolik satelit čeká, než uslyší — a kdy prohlásí větu za dokončenou.

MĚŘENÍ 2. 9. 2026 (kontejner běžel 19:04:31–19:21, tedy 4 probuzení; malý
vzorek, ale jednoznačný):

    19:14:56,702  👋 device wake received   → žádné `listening`,
                  19:15:03,662 🛑 device interrupt   (6,96 s do ztracena)
    19:15:31,548  👋 device wake received
                  19:15:36,472 phase -> listening    = 4 924 ms
    19:19:25,852  👋 device wake received   → žádné `listening`,
                  19:19:32,819 🛑 device interrupt   (6,97 s do ztracena)
    19:19:45,676  👋 device wake received
                  19:19:46,864 phase -> listening    = 1 188 ms

Tedy: **2 ze 4 probuzení mikrofon vůbec neotevřela** a ze zbylých dvou
trvalo jedno skoro pět vteřin. Vlastník to popsal jako „než naskočí, tak
to trvá, a pak neposlouchá dlouho a utne se mi".

Co se z toho dá opravit v mostě (a co ne):

* prodleva otevření mikrofonu byla 700 ms po probuzení i po odpovědi;
* Gemini VAD jel `silence=800 ms`, `end=LOW`, `prefix=300 ms`
  a `start_sensitivity` se NENASTAVOVALA vůbec;
* nová Gemini session se při probuzení NEZAKLÁDÁ — na 4 probuzení jsou
  v logu 2 `Connected to Gemini service` a ten druhý je
  `session_resumption_handle: 90e4fd57-…`, tedy pokračování. Tuhle část
  není co opravovat a tenhle soubor ji hlídá, ať se to nerozbije.

Spuštění bez pytestu:  python3 tests/test_vad_a_prodlevy.py
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app import gemini_tools as G  # noqa: E402
from app.config_source import OPTION_DEFAULTS as DEFAULTS  # noqa: E402


class KonecVetySeNeuseka(unittest.TestCase):
    """`end` málo citlivý, ticho dlouhé — radši počkat než useknout."""

    def test_low_ceka_1200_ms(self):
        self.assertEqual(G.vad_plan('low')['silence_duration_ms'], 1200)

    def test_low_ma_malo_citlivy_konec(self):
        self.assertEqual(G.vad_plan('low')['end_sensitivity'],
                         'END_SENSITIVITY_LOW')

    def test_neznama_hodnota_spadne_na_low(self):
        self.assertEqual(G.vad_plan('nesmysl'), G.vad_plan('low'))

    def test_pod_minimum_se_ticho_nepusti(self):
        """Kratší okno trhá jednu promluvu na fragmenty."""
        self.assertEqual(
            G.vad_plan('low', silence_duration_ms=10)['silence_duration_ms'],
            G.MIN_SILENCE_DURATION_MS)


class ZacatekVetySeNezmeska(unittest.TestCase):
    """Druhá půlka téhož: začátek citlivý HODNĚ, ať nezmizí první slabika."""

    def test_vsechny_plany_krome_auto_chytaji_zacatek(self):
        for jmeno in ('low', 'medium', 'high'):
            self.assertEqual(G.vad_plan(jmeno)['start_sensitivity'],
                             'START_SENSITIVITY_HIGH', jmeno)

    def test_auto_nechava_rozhodnout_server(self):
        self.assertIsNone(G.vad_plan('auto')['start_sensitivity'])

    def test_prefix_padding_projde_beze_zmeny(self):
        self.assertEqual(
            G.vad_plan('low', prefix_padding_ms=300)['prefix_padding_ms'], 300)


class MikrofonSeOtviraDriv(unittest.TestCase):
    """700 → 400 ms. Ne 250: budicí pípnutí hraje a nesmí se nahrát."""

    def test_wake_open_delay_je_400(self):
        self.assertEqual(DEFAULTS['wake_open_delay_ms'], '400')

    def test_po_reci_bota_se_neceka_vubec(self):
        """Vlastník: „když on domluví, je pauza, pak se to chvilku vypne."

        Po Žánově řeči není co přeslechnout — budicí pípnutí zní jen
        u `wake`. Prodleva tady jen ukusovala začátek lidské odpovědi.
        """
        self.assertEqual(DEFAULTS['follow_up_open_delay_ms'], '0')

    def test_po_probuzeni_se_ceka_kvuli_pipnuti(self):
        """`switch.…_wake_sound` byl 2. 9. ZAPNUTÝ — pod 400 ms by si most
        vzal vlastní pípnutí jako začátek promluvy. Proto 400, ne 250."""
        self.assertGreaterEqual(int(DEFAULTS['wake_open_delay_ms']), 400)


if __name__ == '__main__':
    unittest.main(verbosity=2)
