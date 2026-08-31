# -*- coding: utf-8 -*-
"""Dispečer řeči — **jediné hrdlo**, kterým Žán mluví.

Specifikace: `projects/baklazan/zan/MLUVENI-ZANA-TECHNICKY.md` §1
(karta `2026-08-27-programator-zana-04`).

Proč vlastní modul a ne kus `zan_bridge_tool.py`: most má na sobě pipecat
(realtime události, tool handler). Dispečer je čistá rozhodovací logika —
kdy se smí promluvit a co se vysloví — a musí jít otestovat **bez sítě
a bez pipecatu**, s falešnou pusou a injektovaným časem. Zároveň tím
zůstává splněné pravidlo ze specifikace: „nesmí být rozprostřený po
`zan_bridge_tool.py` a `phase_emitter.py` — jinak vznikne pátý zdroj řeči
místo dispečera."

Kdo do něj sype (jediné povolené vstupy):

| zdroj                      | priorita | platnost |
|----------------------------|----------|----------|
| odpověď `ask_zan`          | 0        | 120 s    |
| oprava (pozdní LVL2-RIGHT) | 1        | 60 s     |
| průběžná hláška            | 2        | 8 s      |
| smalltalk                  | 3        | 5 s      |

**Rychlá dráha (přednahrané fráze) jde MIMO frontu** — je to jiná vrstva
řeči (knihovna PCM, ne model) a specifikace ji nechává beze změny.

Dvě věci, které tenhle modul dělá navíc oproti holé frontě:

1. **Rozběh pusy.** Mezi vstříknutím a okamžikem, kdy pusa začne mluvit,
   je prodleva (fáze `replying` dorazí až s `BotStartedSpeaking`). Kdyby
   dispečer tikal dál, vystřelil by druhou položku do rozjeté odpovědi
   a OpenAI ji odmítne (`conversation_already_has_active_response`). Po
   každém vyslovení se tedy čeká, dokud pusa opravdu nemluví — nejdéle
   `rozbeh_s`, aby se dispečer nemohl zaseknout na tichu.
2. **Watchdog.** Fronta neprázdná a přes 30 s se nic nevyslovilo =
   zaseknuté hrdlo → zalogovat a vyprázdnit (jinak by Žán oněměl
   a nikdo by se to nedozvěděl).
"""

from __future__ import annotations

import asyncio
import logging
import time
from typing import Awaitable, Callable, Optional

from app.fronta_temat import (
    FrontaTemat,
    Tema,
    PRIORITA_ODPOVED,
    PRIORITA_OPRAVA,
    PRIORITA_PRUBEZNA,
    PRIORITA_SMALLTALK,
    TTL_ODPOVED,
    TTL_OPRAVA,
    TTL_PRUBEZNA,
    TTL_SMALLTALK,
    WATCHDOG_S,
)

logger = logging.getLogger("zan.dispecer_reci")

# Perioda dispečerské smyčky. ~200 ms je kompromis: dost husté, aby se
# odpověď vyslovila hned po dozvučení předchozí věty, a dost řídké, aby
# to nestálo CPU v kontejneru s realtime audiem.
TIK_S = 0.2

# Jak dlouho po vyslovení čekat, než pusa opravdu začne mluvit (viz
# docstring, bod 1). Po uplynutí se pokračuje i tak — čekání nesmí být
# nekonečné, jinak by ticho zaseklo hrdlo.
ROZBEH_S = 2.0

# Hlavičky podsunutých systémových zpráv. Model je NEVYSLOVUJE doslova —
# jsou to instrukce, co s obsahem udělat.
#
# ŽÁDNÉ ČÍSLICE v ničem, co model vysloví (poučení
# `2026-08-05_ceske-tts-necist-cislice.md`) — pořadová čísla, uplynulý čas
# a délky patří do logu, ne do řeči.
#: DRUHY, které se vyslovují DOSLOVA vlastním hlasem (`rekni_doslova`).
#:
#: PROČ (Ondra, 31. 8. 2026): „casto mluvi blbosti a opakuje fraze."
#: Text mozku poslaný do Live session je pro model PODNĚT, ne scénář —
#: přebásní ho, zkrátí, nebo si domyslí něco jiného. Cokoli, co je
#: OBSAHEM (odpověď, dílčí nález, oprava, konkrétní selhání), proto
#: vyslovuje mluvčí (Piper) znak po znaku a model to jen dostane do
#: kontextu, aby věděl, co zaznělo.
#:
#: `potvrzeni` tu není schválně — to už zaznělo z knihovny frází.
#: `prubeh` a `smalltalk` tu nejsou proto, že po přestavbě do fronty
#: vůbec nepadají (zamlouvání nahradil zvuk, viz `zan_bridge_tool`).
DOSLOVNE_DRUHY = frozenset({"odpoved", "nalez", "oprava", "chyba"})

HLAVICKY = {
    "odpoved": (
        "ŽÁN-CODE ODPOVĚDĚL na dotaz, který jsi mu předal. Řekni to uživateli "
        "česky, krátce a beze změny významu — nic nepřidávej a nic si nedomýšlej"
    ),
    "nalez": (
        "ŽÁN-CODE POSÍLÁ DÍLČÍ NÁLEZ — další ještě může přijít. Řekni ho "
        "uživateli krátce, lidsky (klidně uveď „zatím to vypadá tak, že…\" "
        "nebo „prozatím jsem zjistil…\") a hovor NEUZAVÍREJ. Žádná čísla"
    ),
    "oprava": (
        "OPRAVA K UŽ ŘEČENÉMU — dorazilo to až teď. Naval to jako doplnění, "
        "ne jako novou odpověď: začni „ještě k tomu…\" nebo „zpracoval jsem to "
        "až teď a vychází mi…\". Když to jen jinými slovy opakuje, co jsi řekl, "
        "MLČ. Žádná čísla navíc"
    ),
    "prubeh": (
        "ŽÁN-CODE NA TOM POŘÁD PRACUJE. Řekni uživateli JEDNOU, krátce a lidsky "
        "přesně tohle. Neříkej žádná čísla ani jak dlouho to trvá. Odpověď "
        "zatím NEMÁŠ — nic si nevymýšlej a nic neuzavírej"
    ),
    "smalltalk": (
        "DROBNÁ POZNÁMKA DO HOVORU. Řekni ji jednou větou, lidsky, a hovor "
        "neuzavírej ani nezačínej nové téma. Když se to k situaci nehodí, MLČ"
    ),
    "chyba": (
        "TOHLE SE NEPOVEDLO. Řekni uživateli krátce a lidsky přesně tenhle "
        "smysl, nic si nevymýšlej a žádná čísla"
    ),
    "potvrzeni": (
        "ŽÁN-CODE POTVRDIL provedení. Potvrzení už zaznělo z knihovny frází — "
        "NEOPAKUJ ho, jen si to pamatuj a čekej na další povel"
    ),
}


def obal(tema: Tema) -> str:
    """Z položky fronty udělá text podsunuté systémové zprávy.

    Fronta drží **co se má říct** (`obsah`), ne hotovou větu — teprve tady
    se k tomu přidá instrukce, jak s tím naložit. Neznámý `druh` se obalí
    nejobecnější hlavičkou, ne technickým názvem (nikdy nesmí zaznít
    interní slovo do reproduktoru).
    """
    hlavicka = HLAVICKY.get(tema.druh or "odpoved", HLAVICKY["odpoved"])
    return f"{hlavicka}:\n„{tema.obsah}\""


def kontext_po_doslovne(tema: Tema) -> str:
    """Co se pusa dozví o větě, kterou VYSLOVIL mluvčí, ne ona.

    Model musí vědět, co v místnosti zaznělo (jinak by na doplňující
    otázku odpovídal do prázdna), ale nesmí to zopakovat. Tvar je
    schválně holé konstatování minulého děje bez jediné instrukce
    „řekni" — poučení `2026-08-23_dva-zdroje-reci-a-protichudne-instrukce`:
    dvě protichůdná pravidla v jednom promptu dělají dvojhlas.
    """
    return (
        "TOHLE UŽ UŽIVATEL SLYŠEL — právě to nahlas zaznělo Žánovým hlasem "
        "z odpovědi mozku. Neopakuj to, nekomentuj to, jen si to pamatuj "
        "pro další otázky:\n"
        "„%s\u201c" % tema.obsah
    )


class DispecerReci:
    """Dispečerská smyčka nad `FrontaTemat`.

    Args:
        vyslov: `async (text: str, run_llm: bool) -> bool` — podsune text do
            běžící realtime session. Vrací True, když se to poslalo.
        pusa_mluvi: `() -> bool` — mluví teď pusa? (fáze `replying`
            z `phase_emitter`, případně živá odpověď v pipecatu)
        session_ziva: `() -> bool` — je kam vstřikovat? Když ne, fronta se
            vyprázdní; do mrtvé session se nikdy nic nevstřikuje.
    """

    def __init__(
        self,
        vyslov: Callable[[str, bool], Awaitable[bool]],
        pusa_mluvi: Callable[[], bool],
        session_ziva: Optional[Callable[[], bool]] = None,
        tik_s: float = TIK_S,
        rozbeh_s: float = ROZBEH_S,
        fronta: Optional[FrontaTemat] = None,
        rekni_doslova: Optional[Callable[[str], Awaitable[bool]]] = None,
    ) -> None:
        self.fronta = fronta if fronta is not None else FrontaTemat()
        self._vyslov = vyslov
        # Mluvčí mozku. Když chybí nebo selže, spadne se na starou cestu
        # (vstříknout do session a nechat mluvit pusu) — radši nepřesně
        # než němý dům. Každý takový pád se loguje, ať to nezůstane tiché.
        self._rekni_doslova = rekni_doslova
        self.vysloveno_doslova = 0
        self.doslova_selhalo = 0
        self._pusa_mluvi = pusa_mluvi
        self._session_ziva = session_ziva if session_ziva is not None else (lambda: True)
        self.tik_s = max(0.02, float(tik_s))
        self.rozbeh_s = max(0.0, float(rozbeh_s))
        self._task: Optional[asyncio.Task] = None
        # Do kdy se čeká, až se pusa rozjede po posledním vyslovení.
        self._rozbeh_do: Optional[float] = None
        self.vysloveno = 0
        self.zahozeno_watchdogem = 0

    # -- vstupy (jediná povolená cesta k řeči) ----------------------------

    def pridej_odpoved(
        self,
        text: str,
        interaction_id: str,
        *,
        druh: str = "odpoved",
        run_llm: bool = True,
        znacka: str = "",
        nyni: Optional[float] = None,
    ) -> bool:
        """Finální odpověď mozku (priorita 0, platnost 120 s).

        Zároveň maže čekající průběžné hlášky téže otázky — jakmile je
        odpověď hotová, „ještě to zjišťuju" už by lhalo.
        """
        if druh in ("odpoved", "nalez", "chyba", "potvrzeni"):
            smazano = self.fronta.zrus_prubezne(interaction_id)
            if smazano:
                logger.info(
                    "dispečer: odpověď (%s) smazala %d čekajících průběžných hlášek k %s",
                    druh, smazano, interaction_id,
                )
        return self._pridej(
            text, PRIORITA_ODPOVED, TTL_ODPOVED, interaction_id,
            druh=druh, run_llm=run_llm, znacka=znacka, nyni=nyni,
        )

    def pridej_opravu(
        self, text: str, interaction_id: str, *, znacka: str = "", nyni: Optional[float] = None
    ) -> bool:
        """Pozdní oprava už řečeného (priorita 1, platnost 60 s)."""
        return self._pridej(
            text, PRIORITA_OPRAVA, TTL_OPRAVA, interaction_id,
            druh="oprava", znacka=znacka, nyni=nyni,
        )

    def pridej_prubeh(
        self, text: str, interaction_id: str, *, nyni: Optional[float] = None
    ) -> bool:
        """Průběžná hláška (priorita 2, platnost 8 s — pak už je to lež)."""
        return self._pridej(
            text, PRIORITA_PRUBEZNA, TTL_PRUBEZNA, interaction_id,
            druh="prubeh", nyni=nyni,
        )

    def pridej_smalltalk(
        self, text: str, interaction_id: str = "", *, nyni: Optional[float] = None
    ) -> bool:
        """Drobná poznámka do hovoru (priorita 3, platnost 5 s)."""
        return self._pridej(
            text, PRIORITA_SMALLTALK, TTL_SMALLTALK, interaction_id,
            druh="smalltalk", nyni=nyni,
        )

    def _pridej(
        self, text: str, priorita: int, platnost_s: float, interaction_id: str,
        *, druh: str, run_llm: bool = True, znacka: str = "",
        nyni: Optional[float] = None,
    ) -> bool:
        obsah = str(text or "").strip()
        if not obsah:
            logger.info("dispečer: prázdný text (druh=%s) — nezařazuju", druh)
            return False
        self.fronta.pridej(Tema(
            obsah=obsah,
            priorita=priorita,
            platnost_s=platnost_s,
            interaction_id=interaction_id,
            vzniklo=time.monotonic() if nyni is None else nyni,
            znacka=znacka,
            druh=druh,
            run_llm=run_llm,
        ))
        logger.info(
            "dispečer: zařazeno (druh=%s priorita=%d TTL=%.0fs iid=%s): %.120s",
            druh, priorita, platnost_s, interaction_id, obsah,
        )
        return True

    def vyprazdni(self, duvod: str = "") -> None:
        """STOP / „zmlkni" / změna tématu — po tomhle už nesmí nic promluvit."""
        self.fronta.vyprazdni(duvod)
        self._rozbeh_do = None

    # -- smyčka -----------------------------------------------------------

    async def tik(self, nyni: Optional[float] = None) -> Optional[Tema]:
        """Jeden krok dispečera. Vrací vyslovenou položku, nebo `None`.

        Je to samostatná metoda (ne tělo `while`), aby se dala v testech
        volat synchronně s injektovaným časem — bez čekání na reálné
        sekundy a bez sítě.
        """
        nyni = time.monotonic() if nyni is None else nyni

        # 1. Watchdog dřív než cokoli jiného: zaseknuté hrdlo = němý Žán.
        if self.fronta.zaseknuti(nyni=nyni):
            pocet = self.fronta.pocet()
            logger.error(
                "🛑 dispečer ZASEKNUTÝ — %d položek čeká a přes %.0f s se nic "
                "nevyslovilo. Vyprazdňuju frontu, ať se hrdlo uvolní.",
                pocet, WATCHDOG_S,
            )
            self.zahozeno_watchdogem += pocet
            self.fronta.vyprazdni("watchdog")
            self._rozbeh_do = None
            return None

        if self.fronta.je_prazdna():
            return None

        # 2. Není kam vstřikovat — nedržet obsah pro mrtvou session.
        if not self._session_ziva():
            logger.info("dispečer: realtime session neběží → zahazuju, co čekalo")
            self.fronta.vyprazdni("session skončila")
            self._rozbeh_do = None
            return None

        mluvi = bool(self._pusa_mluvi())

        # 3. Rozběh pusy po posledním vyslovení (viz docstring třídy).
        if self._rozbeh_do is not None:
            if mluvi:
                self._rozbeh_do = None  # rozjelo se, dál platí normální pravidlo
            elif nyni < self._rozbeh_do:
                return None  # ještě mlčí, ale za chvíli promluví — nepřekřikovat
            else:
                logger.info("dispečer: pusa se do rozběhu nerozjela — pokračuju")
                self._rozbeh_do = None

        tema = self.fronta.dalsi(pusa_mluvi=mluvi, nyni=nyni)
        if tema is None:
            return None

        # --- 4a. DOSLOVNÁ CESTA: mluví mozek, pusa je jen reproduktor ---
        odeslano = False
        doslova = False
        if tema.druh in DOSLOVNE_DRUHY and self._rekni_doslova is not None:
            try:
                odeslano = await self._rekni_doslova(tema.obsah)
            except Exception as exc:  # pragma: no cover - mluvčí nesmí umřít
                logger.error("❌ dispečer: mluvčí spadl (%r)", exc)
                odeslano = False
            if odeslano:
                doslova = True
                self.vysloveno_doslova += 1
                # Pusa se musí dozvědět, co zaznělo — ale bez řeči.
                try:
                    await self._vyslov(kontext_po_doslovne(tema), False)
                except Exception as exc:  # pragma: no cover
                    logger.warning("⚠️ dispečer: kontext po doslovné řeči neprošel (%r)", exc)
            else:
                self.doslova_selhalo += 1
                logger.warning(
                    "⚠️ dispečer: mluvčí nevyslovil (%s) — padám na pusu, "
                    "text se může změnit: %.120s", tema.druh, tema.obsah,
                )

        # --- 4b. ZÁLOŽNÍ CESTA: nechat to říct pusu (může přebásnit) ---
        if not odeslano:
            text = obal(tema)
            try:
                odeslano = await self._vyslov(text, tema.run_llm)
            except Exception as exc:  # pragma: no cover - dispečer nesmí umřít
                logger.error("❌ dispečer: vyslovení selhalo (%r) — položka zahozena: %.120s",
                             exc, tema.obsah)
                return None

        if not odeslano:
            logger.info("🗑️ dispečer: %s zahozeno — nebylo kam vstříknout: %.120s",
                        tema.druh, tema.obsah)
            return None

        self.vysloveno += 1
        # Rozběh platí pro OBĚ cesty: i doslovná řeč chvíli hraje z reproduktoru
        # a druhá položka by ji překřičela.
        if (doslova or tema.run_llm) and self.rozbeh_s > 0:
            self._rozbeh_do = nyni + self.rozbeh_s
        logger.info("💉 dispečer: vysloveno (druh=%s priorita=%d cesta=%s): %.120s",
                    tema.druh, tema.priorita,
                    "doslova" if doslova else "pusa", tema.obsah)
        return tema

    async def _bezet(self) -> None:
        logger.info("🎙️ dispečer řeči běží (tik %.0f ms, rozběh %.1f s)",
                    self.tik_s * 1000.0, self.rozbeh_s)
        while True:
            await asyncio.sleep(self.tik_s)
            try:
                await self.tik()
            except asyncio.CancelledError:
                raise
            except Exception:  # pragma: no cover - smyčka nesmí spadnout
                logger.exception("dispečer: chyba v tiku — pokračuju dál")

    def spust(self) -> None:
        """Nastartuje smyčku, pokud už neběží."""
        if self._task is not None and not self._task.done():
            return
        self._task = asyncio.create_task(self._bezet(), name="dispecer-reci")

    async def zastav(self) -> None:
        task, self._task = self._task, None
        if task is None or task.done():
            return
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass
        logger.info("🎙️ dispečer řeči zastaven")

    @property
    def bezi(self) -> bool:
        return self._task is not None and not self._task.done()
