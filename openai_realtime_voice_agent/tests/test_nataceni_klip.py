"""Natáčení jednoho klipu ze satelitu — most musí nahrát ZVUK, ne hlavičku.

CO SE STALO (živá sonda na krabici, 6. 9. 2026):

    ls -l /recordings | ...   ->  613 souborů, 20 680 bajtů  =  44 B na kus
    log:  "✅ Stopped input recording: 0 bytes"  u každé relace
    log:  "✅ Pipeline created"  BEZ  "🎙️ Audio recording enabled"

Ta poslední řádka je důkaz: `WebSocketHandler` dostal
`audio_recording_service=None`, protože se konstruoval DŘÍV, než služba
vznikla. Zapisovač se tedy do pipeline nikdy nezapojil, ale soubor se na
každou relaci poctivě otevřel a zavřel. Hlavička ano, zvuk nikdy.

CO SE TU HLÍDÁ (a co by tehdy padlo):
  * klip má po zapsání rámců VÍC než 44 B a je to platný WAV 16 kHz mono 16 bit,
  * prázdný proud skončí CHYBOU do jádra, ne tichým souborem,
  * jen ticho (mikrofon vypnutý) taky skončí chybou,
  * do běžícího rozhovoru se nenatáčí (409),
  * `kam` mimo složku natáčení a zpětné volání mimo loopback se odmítne,
  * hotový klip se ohlásí zpětným voláním, neúspěch taky,
  * během natáčení se zvuk NEPOUŠTÍ do pipeline (model se nevolá).

Testuje se přes SKUTEČNOU cestu požadavku (FastAPI routa + token), ne přes
vlastní představu o ní. Modul `app.nahravani` schválně nepotřebuje pipecat,
takže tenhle test běží i na stroji, kde pipecat není.

Spuštění bez pytestu:  python3 tests/test_nataceni_klip.py
"""
import asyncio
import os
import shutil
import sys
import tempfile
import unittest
import wave

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.nahravani import HZ_SATELIT, NahravaciRezim, wav_hlavicka  # noqa: E402

try:
    from fastapi.testclient import TestClient
    from app.nahravani_server import vytvor_api
    MAME_FASTAPI = True
except Exception:  # pragma: no cover - prostředí bez fastapi/httpx
    MAME_FASTAPI = False

TOKEN = "token-mostu"
ZPETNE = "http://127.0.0.1:8098/nataceni/klip"


def rec(ms: int, hlasitost: int = 6000, hz: int = HZ_SATELIT) -> bytes:
    """`ms` milisekund střídavého signálu — „někdo mluví"."""
    vzorku = int(hz * ms / 1000)
    kus = int(hlasitost).to_bytes(2, "little", signed=True)
    return (kus + (-hlasitost).to_bytes(2, "little", signed=True)) * (vzorku // 2)


def ticho(ms: int, hz: int = HZ_SATELIT) -> bytes:
    return bytes(2 * int(hz * ms / 1000))


class Zaznamnik:
    """Fake jádra: zapamatuje si, s čím most zavolal zpět."""

    def __init__(self, stav: int = 200):
        self.volani = []
        self.stav = stav

    def __call__(self, url, telo, token, timeout=8):
        self.volani.append({"url": url, "telo": telo, "token": token})
        return self.stav, '{"ok":true}'

    @property
    def posledni(self):
        return self.volani[-1]["telo"] if self.volani else None


class ZakladKlipu(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="nataceni-")
        self.jadro = Zaznamnik()
        self.mluvi = False
        self.rezim = NahravaciRezim(
            tmp_dir=self.tmp,
            posli_zpet=self.jadro,
            probiha_rozhovor=lambda: self.mluvi,
            token="token-jadra",
            hlidac=False,  # hlídač spí na wall-clocku; v testu řídíme čas rámci
        )

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def telo(self, **kw):
        z = {
            "klip_id": "a" * 32,
            "typ": "wake",
            "delka_s": 6,
            "hz": HZ_SATELIT,
            "kam": "satelit-wake-1.wav",
            "zpetne_volani": ZPETNE,
        }
        z.update(kw)
        return z

    def cesta(self, jmeno="satelit-wake-1.wav"):
        return os.path.join(self.tmp, jmeno)


class TestNahravani(ZakladKlipu):

    def test_klip_ma_zvuk_a_spravnou_hlavicku(self):
        """Po sekundě rámců je soubor VĚTŠÍ NEŽ HLAVIČKA a je to 16k mono 16 bit."""
        async def scenar():
            stav, odp = await self.rezim.start(self.telo())
            self.assertEqual((stav, odp["ok"]), (200, True))
            for _ in range(50):                      # 50 × 20 ms = 1 s řeči
                self.assertTrue(await self.rezim.prijmi(rec(20), HZ_SATELIT))
            await self.rezim.stop()
        asyncio.run(scenar())

        cesta = self.cesta()
        self.assertTrue(os.path.exists(cesta), "klip se neuložil")
        velikost = os.path.getsize(cesta)
        self.assertGreater(velikost, 44, "v souboru je jen hlavička — přesně ta stará chyba")
        self.assertEqual(velikost, 44 + 2 * HZ_SATELIT, "1 s @16 kHz mono int16")

        with wave.open(cesta, "rb") as w:
            self.assertEqual(w.getnchannels(), 1)
            self.assertEqual(w.getsampwidth(), 2)
            self.assertEqual(w.getframerate(), HZ_SATELIT)
            self.assertEqual(w.getnframes(), HZ_SATELIT)
        self.assertFalse(os.path.exists(cesta + ".part"), "zůstal rozdělaný soubor")

    def test_hotovy_klip_ohlasi_zpetnym_volanim(self):
        async def scenar():
            await self.rezim.start(self.telo())
            for _ in range(30):
                await self.rezim.prijmi(rec(20), HZ_SATELIT)
            await self.rezim.stop()
        asyncio.run(scenar())

        self.assertEqual(len(self.jadro.volani), 1, "jádro se nedozvědělo nic")
        volani = self.jadro.volani[0]
        self.assertEqual(volani["url"], ZPETNE)
        self.assertEqual(volani["token"], "token-jadra")
        self.assertEqual(volani["telo"], {"klip_id": "a" * 32, "soubor": "satelit-wake-1.wav"})

    def test_prazdny_proud_je_chyba_ne_tichy_soubor(self):
        """Nula rámců = `chyba` do jádra a ŽÁDNÝ soubor. Tohle je jádro pudla."""
        async def scenar():
            await self.rezim.start(self.telo())
            await self.rezim.stop()
        asyncio.run(scenar())

        self.assertFalse(os.path.exists(self.cesta()), "vznikl 44bajtový duch")
        self.assertFalse(os.path.exists(self.cesta() + ".part"))
        self.assertIn("chyba", self.jadro.posledni or {})
        self.assertNotIn("soubor", self.jadro.posledni)

    def test_jen_ticho_je_taky_chyba(self):
        """Mikrofon vypnutý: bajty tečou, zvuk ne. Ticho je horší zpráva než chyba."""
        async def scenar():
            await self.rezim.start(self.telo())
            for _ in range(50):
                await self.rezim.prijmi(ticho(20), HZ_SATELIT)
            await self.rezim.stop()
        asyncio.run(scenar())

        self.assertFalse(os.path.exists(self.cesta()))
        self.assertIn("ticho", (self.jadro.posledni or {}).get("chyba", ""))

    def test_ticho_po_promluve_klip_uzavre(self):
        """Půl sekundy řeči + 1,5 s ticha = hotovo, nečeká se na strop."""
        async def scenar():
            await self.rezim.start(self.telo(delka_s=30))
            for _ in range(25):
                await self.rezim.prijmi(rec(20), HZ_SATELIT)
            for _ in range(80):                      # 1,6 s ticha
                await self.rezim.prijmi(ticho(20), HZ_SATELIT)
            return self.rezim.aktivni()
        self.assertFalse(asyncio.run(scenar()), "režim po tichu neskončil")
        self.assertTrue(os.path.exists(self.cesta()))
        self.assertIn("soubor", self.jadro.posledni)

    def test_strop_delky_klip_uzavre(self):
        async def scenar():
            await self.rezim.start(self.telo(delka_s=1))
            for _ in range(200):                     # 4 s řeči proti stropu 1 s
                await self.rezim.prijmi(rec(20), HZ_SATELIT)
            return self.rezim.aktivni()
        self.assertFalse(asyncio.run(scenar()))
        self.assertEqual(os.path.getsize(self.cesta()), 44 + 2 * HZ_SATELIT)

    def test_behem_nataceni_se_zvuk_do_pipeline_nepusti(self):
        """`prijmi()` vrací True = rámec spolknut. Klip není dotaz pro model."""
        async def scenar():
            pred = await self.rezim.prijmi(rec(20), HZ_SATELIT)   # neaktivní
            await self.rezim.start(self.telo())
            behem = await self.rezim.prijmi(rec(20), HZ_SATELIT)
            await self.rezim.stop()
            po = await self.rezim.prijmi(rec(20), HZ_SATELIT)
            return pred, behem, po
        pred, behem, po = asyncio.run(scenar())
        self.assertFalse(pred, "mimo natáčení se zvuk brát nesmí")
        self.assertTrue(behem, "natáčený zvuk by šel i do modelu")
        self.assertFalse(po, "po skončení se mikrofon musí vrátit pipeline")

    def test_jina_rychlost_nekonci_prevzorkovanim(self):
        """24 kHz místo 16 kHz = chyba. Trenér chce originál, ne dopočet."""
        async def scenar():
            await self.rezim.start(self.telo())
            await self.rezim.prijmi(rec(100, hz=24000), 24000)
        asyncio.run(scenar())
        self.assertFalse(os.path.exists(self.cesta()))
        self.assertIn("24000", (self.jadro.posledni or {}).get("chyba", ""))


class TestHlidac(ZakladKlipu):
    """Uvázlé natáčení nesmí dům ohluchnout — mikrofon se musí vrátit sám."""

    def test_kdyz_satelit_mlci_hlidac_rezim_ukonci(self):
        rezim = NahravaciRezim(
            tmp_dir=self.tmp, posli_zpet=self.jadro, token="token-jadra",
            hlidac=True, rezerva_s=0.05,
        )

        async def scenar():
            stav, _ = await rezim.start(self.telo(delka_s=1))
            self.assertEqual(stav, 200)
            await asyncio.sleep(1.3)          # 1 s strop + 0,05 s rezerva
            return rezim.aktivni()

        self.assertFalse(asyncio.run(scenar()), "režim visí a drží mikrofon")
        self.assertIn("chyba", self.jadro.posledni or {},
                      "hlídač skončil potichu — jádro čeká do vypršení")
        self.assertFalse(os.path.exists(self.cesta()))


class TestOdmitani(ZakladKlipu):

    def test_pri_rozhovoru_odmitne(self):
        self.mluvi = True
        stav, odp = asyncio.run(self.rezim.start(self.telo()))
        self.assertEqual(stav, 409)
        self.assertEqual(odp["kod"], "probiha_rozhovor")
        self.assertFalse(os.path.exists(self.cesta()))

    def test_kdyz_nevim_o_hovoru_taky_odmitne(self):
        """Fail-closed: rozbité čidlo neznamená „je ticho, klidně nahrávej"."""
        def rozbite():
            raise RuntimeError("čidlo fáze spadlo")
        rezim = NahravaciRezim(tmp_dir=self.tmp, posli_zpet=self.jadro,
                               probiha_rozhovor=rozbite, hlidac=False)
        stav, odp = asyncio.run(rezim.start(self.telo()))
        self.assertEqual(stav, 409)
        self.assertEqual(odp["kod"], "nevim_o_hovoru")

    def test_druhy_klip_pri_bezicim_nataceni_odmitne(self):
        async def scenar():
            await self.rezim.start(self.telo())
            return await self.rezim.start(self.telo(klip_id="b" * 32, kam="druhy.wav"))
        stav, odp = asyncio.run(scenar())
        self.assertEqual(stav, 409)
        self.assertEqual(odp["kod"], "uz_nahravam")

    def test_kam_mimo_slozku_odmitne(self):
        for kam in ("../ven.wav", "pod/adresar.wav", "bez-pripony", ".skryty.wav", ""):
            stav, odp = asyncio.run(self.rezim.start(self.telo(kam=kam)))
            self.assertEqual((kam, stav), (kam, 400))
            self.assertEqual(odp["kod"], "cesta_mimo")

    def test_zpetne_volani_mimo_loopback_odmitne(self):
        stav, odp = asyncio.run(self.rezim.start(
            self.telo(zpetne_volani="http://example.com/nataceni/klip")))
        self.assertEqual(stav, 400)
        self.assertEqual(odp["kod"], "zpetne_volani_mimo")

    def test_spatny_klip_id_odmitne(self):
        stav, odp = asyncio.run(self.rezim.start(self.telo(klip_id="krátký")))
        self.assertEqual(stav, 400)
        self.assertEqual(odp["kod"], "spatny_klip_id")


@unittest.skipUnless(MAME_FASTAPI, "fastapi/httpx v prostředí nejsou")
class TestHttp(ZakladKlipu):
    """Skutečná cesta požadavku: routa, hlavička, návratový kód."""

    def setUp(self):
        super().setUp()
        self.klient = TestClient(vytvor_api(self.rezim, TOKEN), raise_server_exceptions=False)
        self.hlavicky = {"authorization": "Bearer " + TOKEN}

    def test_start_a_stop_projdou(self):
        r = self.klient.post("/nahravani/start", json=self.telo(), headers=self.hlavicky)
        self.assertEqual(r.status_code, 200, r.text)
        self.assertTrue(r.json()["ok"])

        stav = self.klient.get("/nahravani/stav", headers=self.hlavicky).json()
        self.assertTrue(stav["nahravam"])

        asyncio.run(self.rezim.prijmi(rec(500), HZ_SATELIT))

        r = self.klient.post("/nahravani/stop", headers=self.hlavicky)
        self.assertEqual(r.status_code, 200, r.text)
        self.assertTrue(r.json()["zastaveno"])
        self.assertGreater(os.path.getsize(self.cesta()), 44)

    def test_bez_tokenu_404(self):
        """Fail-closed a bez prozrazení: cizí se nedozví ani to, že endpoint je."""
        for hlavicky in ({}, {"authorization": "Bearer cizi"}):
            r = self.klient.post("/nahravani/start", json=self.telo(), headers=hlavicky)
            self.assertEqual(r.status_code, 404, r.text)
        self.assertFalse(self.rezim.aktivni())

    def test_rozhovor_vraci_409(self):
        self.mluvi = True
        r = self.klient.post("/nahravani/start", json=self.telo(), headers=self.hlavicky)
        self.assertEqual(r.status_code, 409, r.text)
        self.assertEqual(r.json()["kod"], "probiha_rozhovor")

    def test_stop_bez_nataceni_je_klid(self):
        r = self.klient.post("/nahravani/stop", headers=self.hlavicky)
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json(), {"ok": True, "zastaveno": False})


class TestHlavicka(unittest.TestCase):
    def test_wav_hlavicka_sedi_s_modulem_wave(self):
        """Hlavičku si píšeme sami — ať ji přečte i knihovna, ne jen naše oko."""
        data = rec(100)
        with tempfile.TemporaryDirectory() as d:
            cesta = os.path.join(d, "x.wav")
            with open(cesta, "wb") as f:
                f.write(wav_hlavicka(HZ_SATELIT, len(data)))
                f.write(data)
            with wave.open(cesta, "rb") as w:
                self.assertEqual((w.getnchannels(), w.getsampwidth(), w.getframerate()),
                                 (1, 2, HZ_SATELIT))
                self.assertEqual(w.readframes(w.getnframes()), data)


if __name__ == "__main__":
    unittest.main(verbosity=2)
