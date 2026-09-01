# -*- coding: utf-8 -*-
"""Dvojhlas: tyz povel dvakrat -> JEDNOU, dva ruzne povely -> OBA.

Nesaha na dum. Handler jen zapisuje do seznamu, co by se bylo provedlo.
Spousti se s korenem balicku `app` jako argumentem, aby sel tyz test pustit
proti STAREMU i NOVEMU kodu:

    python3 test-dvojhlas.py /            # stary (bezici kontejner)
    python3 test-dvojhlas.py /tmp/novy    # novy (opraveny)
"""
import asyncio, sys, time

sys.path.insert(0, sys.argv[1])
from app.fastlane_mixin import FastLaneMixin  # noqa: E402

KOREN = sys.argv[1]
provedeno = []


class Prepis:
    """Nahrada za ocisteny prepis. utrzek=False => utrzkova pojistka pusti."""
    utrzek = False
    stop = False
    zmeneno = False
    puvodni = "rozsviť v obýváku"
    text = "rozsviť v obýváku"
    duvod = ""


class Params:
    def __init__(self, name, args, tid):
        self.function_name, self.arguments, self.tool_call_id = name, args, tid
        self.llm = None
        self.prijato = []

        async def cb(result, *, properties=None):
            self.prijato.append((result, properties))
        self.result_callback = cb


class FakeLLM:
    def register_function(self, name, handler, start_callback=None, *,
                          cancel_on_interruption=True):
        self.zaregistrovano = handler


class Sluzba(FastLaneMixin, FakeLLM):
    fastlane_enabled = False        # dedup musi fungovat i bez rychle drahy


def novy_tah(s):
    """Simuluje NOVOU lidskou promluvu -- presne to, co dela
    `websocket_handler.na_prepis` pri kazdem finalnim prepisu."""
    s.posledni_prepis = Prepis()
    s.posledni_prepis_t = time.monotonic()
    s.posledni_prepis_pouzit = False
    # NESMI SE PSAT DO SVEDKA. `hovor_log` je nezavisly dukaz o tom, co
    # clovek REKL a co z toho vzniklo -- kdyby do nej suchá zkouška psala,
    # znehodnotila by presne ten zaznam, kterym se dvoji provedeni dokazuje.
    # Mixin zapis preskoci, kdyz uz je tah "zapsany" (fastlane_mixin ~r. 491).
    # (Behy 1. 9. v 11:39, 13:13 a 13:17 tuhle pojistku jeste nemely a
    # nechaly v /opt/zan/hovory/2026-09-01.jsonl 32 radku s prepisem
    # "rozsviť v obýváku", ktere nikdo nevyslovil.)
    s.posledni_prepis_hovor_zapsano = True


async def volej(s, name, args, tid, vysledek=None):
    """Jedno volani nastroje. `vysledek` = co handler vrati.

    Default schvalne NENI `verified_success` -- presne tak se chova
    delegace na mozek i kazdy nastroj mimo rychlou drahu, a prave tudy
    vada 31. 8. prosla.
    """
    async def handler(params):
        provedeno.append((name, tid))
        await asyncio.sleep(0.02)
        await params.result_callback(vysledek or {"status": "ok", "kdo": tid})
    s.register_function(name, handler)
    p = Params(name, args, tid)
    await s.zaregistrovano(p)
    return p


def hlas(nadpis):
    print("\n" + "=" * 72)
    print(nadpis)
    print("=" * 72)


async def main():
    global provedeno
    chyb = 0

    def zkontroluj(popis, skutecnost, ocekavani):
        nonlocal chyb
        ok = skutecnost == ocekavani
        if not ok:
            chyb += 1
        print("  %-11s %s" % ("OK" if ok else "!! CHYBA !!", popis))
        print("  %-11s cekam=%s  realne=%s" % ("", ocekavani, skutecnost))

    # ------------------------------------------------------------------
    hlas("A) TYZ POVEL DVAKRAT V TEMZ TAHU, ODSTUP 3,2 s "
         "(reprodukce incidentu 15:19:47,272 -> 15:19:50,493)")
    provedeno = []
    s = Sluzba()
    novy_tah(s)                       # clovek rekl "zhasni v loznici" JEDNOU
    await volej(s, "HassTurnOff", {"area": "Ložnice"}, "fc_PRVNI")
    print("  ... cekam 3,2 s (bez druhe lidske promluvy) ...")
    await asyncio.sleep(3.2)
    await volej(s, "HassTurnOff", {"area": "Ložnice"}, "fc_DRUHE")
    zkontroluj("povel se provedl JEDNOU", provedeno, [("HassTurnOff", "fc_PRVNI")])

    # ------------------------------------------------------------------
    hlas("B) DVA RUZNE POVELY -> OBA MUSI PROJIT")
    provedeno = []
    s = Sluzba()
    novy_tah(s)
    await volej(s, "HassTurnOff", {"area": "Ložnice"}, "fc_A")
    await volej(s, "HassTurnOn", {"area": "Obývák"}, "fc_B")
    zkontroluj("oba povely se provedly",
               provedeno, [("HassTurnOff", "fc_A"), ("HassTurnOn", "fc_B")])

    provedeno = []
    s = Sluzba()
    novy_tah(s)
    await volej(s, "HassTurnOff", {"area": "Ložnice"}, "fc_A")
    await volej(s, "HassTurnOff", {"area": "Obývák"}, "fc_B")
    zkontroluj("tyz nastroj, JINA mistnost -> oba",
               provedeno, [("HassTurnOff", "fc_A"), ("HassTurnOff", "fc_B")])

    # ------------------------------------------------------------------
    hlas("C) CLOVEK POVEL ZOPAKOVAL (NOVY TAH) -> MUSI PROJIT ZNOVU")
    provedeno = []
    s = Sluzba()
    novy_tah(s)
    await volej(s, "HassTurnOff", {"area": "Ložnice"}, "fc_PRVNI")
    await asyncio.sleep(0.3)
    novy_tah(s)                       # <- clovek promluvil ZNOVU, hned
    await volej(s, "HassTurnOff", {"area": "Ložnice"}, "fc_ZNOVU")
    zkontroluj("druhy (lidsky) povel prosel i za 0,3 s",
               provedeno,
               [("HassTurnOff", "fc_PRVNI"), ("HassTurnOff", "fc_ZNOVU")])

    # ------------------------------------------------------------------
    hlas("D) SOUBEZNA DUPLICITA -> zalivka se spusti JEDNOU")
    provedeno = []
    s = Sluzba()
    novy_tah(s)
    await asyncio.gather(
        volej(s, "zahrada_voda_studna_start", {}, "fc_A"),
        volej(s, "zahrada_voda_studna_start", {}, "fc_B"),
    )
    zkontroluj("zalivka spustena jednou",
               provedeno, [("zahrada_voda_studna_start", "fc_A")])

    # ------------------------------------------------------------------
    hlas("E) VYJIMKY: opakovani je ZAMER (ztlum, ztlum / precti stav)")
    # POZOR: musi mit CIL. Bez cile je zastavi brzda bezcilneho zasahu
    # (jina, spravna pojistka) a s dedupem to nema nic spolecneho.
    for nastroj, argy in (
        ("HassSetVolumeRelative", {"name": "Televize v ložnici",
                                   "volume_step": "down"}),
        ("GetLiveContext", {}),
        ("HassMediaNext", {"name": "Televize v ložnici"}),
    ):
        provedeno = []
        s = Sluzba()
        novy_tah(s)
        await volej(s, nastroj, argy, "a")
        await volej(s, nastroj, argy, "b")
        zkontroluj("%s dvakrat -> dvakrat" % nastroj, len(provedeno), 2)

    print("\n" + "=" * 72)
    print("KOREN: %s     CHYB CELKEM: %d" % (KOREN, chyb))
    print("=" * 72)
    return chyb


sys.exit(asyncio.run(main()))
