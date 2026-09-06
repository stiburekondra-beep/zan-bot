# -*- coding: utf-8 -*-
"""Po neúspěchu rychlé dráhy musí něco zaznít — hlídka němoty.

Nález z první ostré večerní revize hovorů (30. 8. 2026, 18:58–19:02): pět
akcí za sebou skončilo `unconfirmed` a **ani u jedné nenásledovala odpověď
Žána**. Karta `2026-08-30-programator-zana-13`.

Testuje se rozhodovací logika (`app/nemluva_hlidka.NemluvaHlidka`) — čistá
funkce nad verdiktem a časem, bez pipecatu a bez sítě, s injektovanými
hodinami. Poslední případ je reálný úsek revize: tři němá selhání → tři
výplně.

Kontrolní strany (bez nich test nedokazuje nic):
  * `ok` výplň NEnatahuje (jinak by hlídka mluvila po každé povedené akci),
  * promluva DO lhůty výplň ruší (jinak by zněly dva hlasy),
  * promluva PO lhůtě už nic neruší (výplň je splatná, mělo se mluvit dřív),
  * druhé volání v tomtéž tahu nenatahuje druhou výplň,
  * `zrus()` (stopka „zmlkni") výplň zahodí.

Pouští se bez pytestu i s ním:

    python tests/test_nemluva_hlidka.py
    pytest tests/test_nemluva_hlidka.py
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.nemluva_hlidka import (  # noqa: E402
    NemluvaHlidka,
    NEME_VERDIKTY,
    VETY,
    ZAMER,
)


class Hodiny:
    """Injektovaný čas — test nesmí čekat reálné vteřiny."""

    def __init__(self, t=1000.0):
        self.t = float(t)

    def __call__(self):
        return self.t

    def posun(self, o):
        self.t += float(o)


def hlidka(ttl=6.0):
    h = Hodiny()
    return NemluvaHlidka(ttl_s=ttl, hodiny=h), h


class JadroBugu(unittest.TestCase):
    """`unconfirmed` + ticho → výplň. To je celý nález z 30. 8."""

    def test_unconfirmed_a_ticho_vyrobi_vypln(self):
        h, hodiny = hlidka()
        self.assertIsNotNone(h.po_akci('unconfirmed', tah=100.0))
        hodiny.posun(6.0)
        v = h.splatna()
        self.assertIsNotNone(v)
        self.assertEqual(v.verdikt, 'unconfirmed')

    def test_veta_je_doslova_ta_z_ustavy(self):
        """Kritérium SLUHY č. 4 (`MLUVENI-ZANA.md §9`) — znak po znaku."""
        h, hodiny = hlidka()
        h.po_akci('unconfirmed', tah=100.0)
        hodiny.posun(6.0)
        self.assertEqual(h.splatna().text,
                         'Povel odešel, ale zařízení stav nepotvrdilo.')

    def test_jmeno_zameru_z_knihovny_frazi_sedi(self):
        """Aby se dalo dohledat, že jde o tutéž větu jako `generovat-fraze.js`."""
        self.assertEqual(ZAMER, 'nepotvrdilo_stav')

    def test_pred_lhutou_se_nemluvi(self):
        h, hodiny = hlidka()
        h.po_akci('unconfirmed', tah=100.0)
        hodiny.posun(5.9)
        self.assertIsNone(h.splatna())


class KontrolniStrany(unittest.TestCase):

    def test_ok_vypln_nenatahuje(self):
        h, hodiny = hlidka()
        self.assertIsNone(h.po_akci('ok', tah=100.0))
        hodiny.posun(60.0)
        self.assertIsNone(h.splatna())

    def test_promluva_do_lhuty_vypln_rusi(self):
        h, hodiny = hlidka()
        h.po_akci('unconfirmed', tah=100.0)
        hodiny.posun(2.0)
        self.assertTrue(h.promluveno('model'))
        hodiny.posun(60.0)
        self.assertIsNone(h.splatna())

    def test_promluva_po_lhute_uz_nic_nerusi(self):
        """Splatná výplň se vydá; teprve pak je co rušit — a není."""
        h, hodiny = hlidka()
        h.po_akci('unconfirmed', tah=100.0)
        hodiny.posun(6.0)
        self.assertIsNotNone(h.splatna())
        self.assertFalse(h.promluveno('model'))

    def test_druhe_volani_v_temze_tahu_nenatahuje(self):
        """19:02:15 padla DVĚ volání `vypnout` v jedné větě — jedna věta stačí."""
        h, hodiny = hlidka()
        self.assertIsNotNone(h.po_akci('unconfirmed', tah=100.0))
        self.assertIsNone(h.po_akci('unconfirmed', tah=100.0))
        hodiny.posun(6.0)
        self.assertIsNotNone(h.splatna())
        self.assertIsNone(h.splatna())

    def test_dalsi_tah_se_zase_natahne(self):
        h, hodiny = hlidka()
        h.po_akci('unconfirmed', tah=100.0)
        hodiny.posun(6.0)
        h.splatna()
        self.assertIsNotNone(h.po_akci('unconfirmed', tah=101.5))

    def test_stopka_vypln_zahodi(self):
        """„Zmlkni" musí zavřít i cestu, která čeká mimo frontu."""
        h, hodiny = hlidka()
        h.po_akci('unconfirmed', tah=100.0)
        h.zrus('STOP')
        hodiny.posun(60.0)
        self.assertIsNone(h.splatna())

    def test_vydana_vypln_se_nevysloví_dvakrat(self):
        h, hodiny = hlidka()
        h.po_akci('unconfirmed', tah=100.0)
        hodiny.posun(6.0)
        self.assertIsNotNone(h.splatna())
        hodiny.posun(6.0)
        self.assertIsNone(h.splatna())


class OstatniVerdikty(unittest.TestCase):

    def test_kazdy_nemy_verdikt_ma_svou_vetu(self):
        for verdikt in NEME_VERDIKTY:
            self.assertIn(verdikt, VETY, verdikt)
            self.assertTrue(VETY[verdikt].strip(), verdikt)

    def test_ha_down_prizna_ze_nejde_overit(self):
        h, hodiny = hlidka()
        h.po_akci('ha_down', tah=100.0)
        hodiny.posun(6.0)
        self.assertIn('Home Assistant', h.splatna().text)

    def test_neznamy_verdikt_nic_nenatahne(self):
        h, _ = hlidka()
        self.assertIsNone(h.po_akci('neco_jineho', tah=100.0))


class UsekRevize20260830(unittest.TestCase):
    """Reálný úsek 18:58–19:02: tři němá selhání → tři výplně.

    Časy jsou z revize (`zan_data/revize/2026-08-30.md`); čtvrtý řádek
    (19:02:15) je druhé volání téhož tahu, a to se schválně NEpočítá.
    """

    UDALOSTI = [
        (0.0, 'unconfirmed', 100.0),    # 18:58:41 pustit hudbu
        (28.0, 'unconfirmed', 128.0),   # 18:59:09 pustit hudbu
        (114.0, 'unconfirmed', 214.0),  # 19:00:35 vypnout televizi
        (214.0, 'unconfirmed', 314.0),  # 19:02:15 vypnout (Lounge)
        (214.0, 'unconfirmed', 314.0),  # 19:02:15 vypnout (Bedroom) — týž tah
    ]

    def test_tri_nema_selhani_tri_vyplne(self):
        h, hodiny = hlidka()
        zaklad = hodiny.t
        vyplne = []
        for offset, verdikt, tah in self.UDALOSTI[:3]:
            hodiny.t = zaklad + offset
            h.po_akci(verdikt, tah=tah)
            hodiny.posun(6.0)
            v = h.splatna()
            if v is not None:
                vyplne.append(v)
        self.assertEqual(len(vyplne), 3)
        self.assertEqual(h.zaskocila, 3)

    def test_dve_volani_v_jedne_vete_daji_jednu_vypln(self):
        h, hodiny = hlidka()
        h.po_akci('unconfirmed', tah=314.0)
        h.po_akci('unconfirmed', tah=314.0)
        hodiny.posun(6.0)
        self.assertIsNotNone(h.splatna())
        self.assertIsNone(h.splatna())
        self.assertEqual(h.zaskocila, 1)


class VyplnDojdeAzDoUst(unittest.TestCase):
    """Kontrola CÍLE, ne jen rozhodnutí: výplň projde SKUTEČNOU frontou.

    Rozhodnutí „teď je splatná věta" je k ničemu, když ji fronta zahodí
    (neznámý druh, nevyslovitelná priorita). Tady jede opravdový
    `DispecerReci` nad opravdovou `FrontaTemat` s falešnou pusou —
    ověřuje se, že se ta věta doopravdy vysloví, a že se NEvysloví,
    dokud mluví pusa („mluví právě jeden").
    """

    def _dispecer(self):
        from app.dispecer_reci import DispecerReci

        stav = {'mluvi': False, 'receno': [], 'doslova': []}

        async def vyslov(text, run_llm=True):
            stav['receno'].append(text)
            return True

        async def rekni_doslova(text):
            stav['doslova'].append(text)
            return True

        d = DispecerReci(
            vyslov=vyslov,
            pusa_mluvi=lambda: stav['mluvi'],
            session_ziva=lambda: True,
            rozbeh_s=0.0,
            rekni_doslova=rekni_doslova,
        )
        return d, stav

    def _zarad(self, d):
        from app.nemluva_hlidka import ZNACKA
        return d.pridej_odpoved(
            VETY['unconfirmed'], 'fastlane-100.000',
            druh='chyba', znacka=ZNACKA, nyni=0.0,
        )

    def test_vypln_se_do_fronty_opravdu_zaradi(self):
        d, _ = self._dispecer()
        self.assertTrue(self._zarad(d))
        self.assertEqual(d.fronta.pocet(), 1)

    def test_dokud_pusa_mluvi_vypln_nezazni(self):
        import asyncio
        d, stav = self._dispecer()
        self._zarad(d)
        stav['mluvi'] = True
        self.assertIsNone(asyncio.run(d.tik(nyni=1.0)))
        self.assertEqual(stav['receno'] + stav['doslova'], [])
        self.assertEqual(d.fronta.pocet(), 1)

    def test_kdyz_pusa_mlci_vypln_zazni_doslova(self):
        import asyncio
        d, stav = self._dispecer()
        self._zarad(d)
        tema = asyncio.run(d.tik(nyni=1.0))
        self.assertIsNotNone(tema)
        vyslovene = ' '.join(stav['receno'] + stav['doslova'])
        self.assertIn('Povel odešel, ale zařízení stav nepotvrdilo.', vyslovene)

    def test_druh_chyba_je_doslovny(self):
        """Kdyby `chyba` z doslovných druhů vypadla, model by větu přebásnil."""
        from app.dispecer_reci import DOSLOVNE_DRUHY
        self.assertIn('chyba', DOSLOVNE_DRUHY)


if __name__ == '__main__':
    unittest.main(verbosity=2)
