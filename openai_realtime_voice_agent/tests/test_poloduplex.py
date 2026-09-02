"""Dokud Žán mluví, mikrofon do Gemini nejde — satelit slyší sám sebe.

DOSLOVNĚ Z LOGU 2. 9. 2026:

    19:23:28.879  Bot started speaking
    19:23:31.645  Bot stopped speaking
    19:23:38,667  🗣️ user: To není.
    19:23:38,669  🗣️ user: Je 19:23.        <- tohle řekl BOT

    19:24:25.902  Bot started speaking
    19:24:28.193  👋 device wake received    <- probuzeno vlastním hlasem
    19:24:43.832  👋 device wake received

AEC na zařízení nestačí. Model si vlastní slova přepsal jako `user` a
odpovídal sám sobě; vlastník to slyší jako „promluvil dvojitě" a jako
„utne se mi".

CO SE HLÍDÁ: audio během řeči se nepředá; `wake` během řeči se ignoruje;
`interrupt` (slovo „Stop") projde VŽDYCKY — firmware ho posílá jako jinou
zprávu, takže přerušení Žána zůstává funkční.

Testuje se přes SKUTEČNÝ `deserialize()`, ne přes vlastní představu.

Spuštění bez pytestu:  python3 tests/test_poloduplex.py
"""
import asyncio
import json
import os
import sys
import types
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# pipecat je jen kvůli typům rámců; když v prostředí není, test se přeskočí
# (na krabici i ve vývoji ale je).
try:
    from app.raw_audio_serializer import RawAudioSerializer
    import app.raw_audio_serializer as R
    MAME_PIPECAT = True
except Exception as _e:  # pragma: no cover
    MAME_PIPECAT = False
    DUVOD = repr(_e)


def bezi(korutina):
    return asyncio.new_event_loop().run_until_complete(korutina)


@unittest.skipUnless(MAME_PIPECAT, 'pipecat není k dispozici')
def _serializer():
    """Serializer bez pipeline okolo — testuje se `deserialize`, ne pipecat."""
    if True:
        s = RawAudioSerializer.__new__(RawAudioSerializer)
        s._on_interrupt = None
        s._on_session_start = None
        s._on_mic_flush = None
        s._on_wake = None
        s._on_ping = None
        s._on_mute = None
        s._mic_byl_zavren = False
        s._posledni_vystup = 0.0
        s._input_sample_rate = 16000
        s._tap_file = None
        s._lookback = bytearray()
        return s


@unittest.skipUnless(MAME_PIPECAT, 'pipecat neni k dispozici')
class MikrofonBehemReci(unittest.TestCase):

    def test_audio_behem_reci_se_nepreda(self):
        s = _serializer()
        s._posledni_vystup = R.time.monotonic()      # bot právě mluví
        self.assertIsNone(bezi(s.deserialize(b'\x00\x01' * 160)))

    def test_audio_po_dobehu_projde(self):
        s = _serializer()
        s._posledni_vystup = R.time.monotonic() - (R.POLODUPLEX_DOBEH_S + 0.05)
        ramec = bezi(s.deserialize(b'\x00\x01' * 160))
        self.assertIsNotNone(ramec, 'po dobění musí mikrofon zase slyšet')

    def test_kdyz_jeste_nic_neznelo_mikrofon_slysi(self):
        """Zavřený mikrofon je výjimka, otevřený výchozí stav."""
        s = _serializer()
        self.assertFalse(s.mic_zavren())
        self.assertIsNotNone(bezi(s.deserialize(b'\x00\x01' * 160)))

    def test_wake_behem_reci_se_ignoruje(self):
        s = _serializer()
        probuzeni = []

        async def na_wake():
            probuzeni.append(1)
        s._on_wake = na_wake
        s._posledni_vystup = R.time.monotonic()
        bezi(s.deserialize(json.dumps({'type': 'wake'})))
        self.assertEqual(probuzeni, [], 'vlastní hlas probudil Žána')

    def test_wake_mimo_rec_projde(self):
        s = _serializer()
        probuzeni = []

        async def na_wake():
            probuzeni.append(1)
        s._on_wake = na_wake
        bezi(s.deserialize(json.dumps({'type': 'wake'})))
        self.assertEqual(probuzeni, [1], 'člověk Žána probudit musí')

    def test_stop_prerusi_i_kdyz_bot_mluvi(self):
        """Slovo „Stop" chodí jako `interrupt` — to nesmí poloduplex spolknout."""
        s = _serializer()
        preruseni = []

        async def na_interrupt():
            preruseni.append(1)
        s._on_interrupt = na_interrupt
        s._posledni_vystup = R.time.monotonic()      # bot mluví
        bezi(s.deserialize(json.dumps({'type': 'interrupt'})))
        self.assertEqual(preruseni, [1], 'Stop přestal Žána přerušovat')


@unittest.skipUnless(MAME_PIPECAT, 'pipecat není k dispozici')
class PrvniSlabikaSeNeutne(unittest.TestCase):

    def test_dobeh_se_neztrati_ale_posle_zpetne(self):
        """Vlastník: „ztratí se tam začátek odpovědi." Nesmí."""
        s = _serializer()
        s._posledni_vystup = R.time.monotonic()
        dobeh = bytes([0x11, 0x22]) * 80     # 160 B = 5 ms pri 16 kHz
        nove = bytes([0x33, 0x44]) * 80
        bezi(s.deserialize(dobeh))               # spadne do dobehu
        s._posledni_vystup = R.time.monotonic() - (R.POLODUPLEX_DOBEH_S + 0.05)
        ramec = bezi(s.deserialize(nove))        # mikrofon otevren
        self.assertEqual(len(ramec.audio), len(dobeh) + len(nove),
                         'dobeh se zahodil')
        self.assertTrue(ramec.audio.startswith(dobeh), 'dobeh neni napred')

    def test_follow_up_delay_je_nula(self):
        from app.config_source import OPTION_DEFAULTS
        self.assertEqual(OPTION_DEFAULTS['follow_up_open_delay_ms'], '0')

    def test_prebuffer_je_400ms(self):
        from app.config_source import OPTION_DEFAULTS
        self.assertEqual(OPTION_DEFAULTS['playback_prebuffer_ms'], '400')

    def test_nabeh_ticha_uz_existuje_a_nezmizel(self):
        """280 ms ticha před promluvou je z 31. 8. — druhá půlka téhož."""
        self.assertGreaterEqual(R.NABEH_TICHA_MS, 250)


if __name__ == '__main__':
    if not MAME_PIPECAT:
        print('PŘESKOČENO — pipecat není k dispozici:', DUVOD)
        sys.exit(0)
    unittest.main(verbosity=2)
