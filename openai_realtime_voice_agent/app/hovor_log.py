# -*- coding: utf-8 -*-
"""Trvalý JSONL záznam OBOU stran hovoru — karta -21 (baklazan-hq/firma/ukoly).

PROČ (Ondra, 31. 8. 2026). Na krabici NEEXISTOVAL trvalý záznam přepisů:
`hovory/*.jsonl` nikde nebyl a logy kontejneru `zan-realtime` mizí při
KAŽDÉM `docker compose recreate`. Důsledek: kvalitu STT nešlo měřit ani
porovnat a nešlo ani dohledat, co Žán řekl (dispečerská větev "vysloveno"
se nikam neukládala) — takže nešlo posoudit, jestli si nevymýšlí.

Tenhle modul píše JEDEN řádek JSON na KAŽDOU promluvu (člověka i Žána) do
adresáře namountovaného MIMO vrstvu kontejneru — `/hovory` uvnitř,
`/opt/zan/hovory` na hostu (bind mount v `docker-compose.yml`, service
`zan-realtime`). Tím řádek přežije `recreate` i rebuild image.

SOUKROMÍ: tohle je osobní záznam rodiny (co se v domě řekne). Zůstává na
krabici, mimo git, mimo produktový repo `zan-internal` — nikdy nikam
neodchází (žádná síť, žádný upload).

Modul je čistě zapisovací: nerozhoduje, CO se zapíše ani KDY je "výsledek"
už jistý — to dělá volající (`websocket_handler.na_prepis`,
`fastlane_mixin.liveness_tracked`, `dispecer_reci`, `transcript_logger`).
Zápis nesmí NIKDY shodit hlasovou rouru: každá chyba se polkne a jen
zaloguje. Žádný `await` mezi otevřením a zavřením souboru — proces je
jednovláknový (asyncio), takže zápis je vůči ostatním korutinám atomický
bez zámku.
"""

from __future__ import annotations

import json
import logging
import os
import time
from pathlib import Path
from typing import Any, Optional

logger = logging.getLogger(__name__)

#: Adresář mimo kontejnerovou vrstvu — MUSÍ být bind mount, ne obyčejný
#: adresář uvnitř image (jinak `recreate` záznam smaže, přesně poučení
#: karty -21). Přepsatelné env proměnnou jen pro testy.
HOVORY_DIR = os.environ.get("ZAN_HOVORY_DIR", "/hovory")


def _soubor_dnes() -> Path:
    """Jeden soubor na kalendářní den (lokální čas kontejneru, TZ=Europe/Prague
    je nastavená v docker-compose.yml) — ať jeden soubor neroste donekonečna."""
    den = time.strftime("%Y-%m-%d")
    return Path(HOVORY_DIR) / f"{den}.jsonl"


def zapis(
    smer: str,
    *,
    kanal: Optional[str] = None,
    kdo: Optional[str] = None,
    prepis: Optional[str] = None,
    cisty: Optional[str] = None,
    vysledek: Optional[str] = None,
    utrzek: bool = False,
    stop: bool = False,
    zdroj: Optional[str] = None,
    poznamka: Optional[str] = None,
    **extra: Any,
) -> None:
    """Připojí JEDEN řádek JSON na konec dnešního souboru. Nikdy nevyhodí.

    Args:
        smer: "clovek" nebo "zan" — kdo mluvil.
        kanal: satelit/klient (typicky `client_id` z websocket_handler, např.
            IP adresa satelitu).
        kdo: kdo mluvil, pokud to systém ví (zatím většinou None — most
            hlasy nerozlišuje).
        prepis: syrový přepis (co skutečně přišlo ze STT), pro `smer=clovek`.
        cisty: přepis po `prepis_ocista.ocisti()`, pokud se liší.
        vysledek: co z promluvy vzniklo — jméno nástroje s argumenty,
            "delegovano_mozku", "zahozeno_utrzek", "zruseno_stopkou",
            nebo text, který Žán skutečně řekl (pro `smer=zan`).
        utrzek: True = útržková pojistka (`prepis_ocista`) to označila
            jako nesmysl.
        stop: True = holé "ne/stop/zmlkni" v okně po akci (zrušení, ne povel).
        zdroj: u `smer=zan` odkud věta pochází — "dispecer" (doslovná řeč,
            spolehlivé) nebo "model" (surový TTSTextFrame přepis Gemini,
            best-effort — viz poznámka v `transcript_logger.py`).
        poznamka: volný text pro cokoli dalšího.
    """
    try:
        radek = {
            "cas": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
            "smer": smer,
        }
        if kanal is not None:
            radek["kanal"] = kanal
        if kdo is not None:
            radek["kdo"] = kdo
        if prepis is not None:
            radek["prepis"] = prepis
        if cisty is not None and cisty != prepis:
            radek["cisty"] = cisty
        if vysledek is not None:
            radek["vysledek"] = vysledek
        if utrzek:
            radek["utrzek"] = True
        if stop:
            radek["stop"] = True
        if zdroj is not None:
            radek["zdroj"] = zdroj
        if poznamka is not None:
            radek["poznamka"] = poznamka
        radek.update(extra)

        cesta = _soubor_dnes()
        cesta.parent.mkdir(parents=True, exist_ok=True)
        # Žádný await mezi open a close -- viz docstring modulu.
        with open(cesta, "a", encoding="utf-8") as f:
            f.write(json.dumps(radek, ensure_ascii=False) + "\n")
    except Exception:  # noqa: BLE001 - zápis nesmí shodit hlas
        logger.warning("⚠️ zápis do hovory/*.jsonl selhal", exc_info=True)
