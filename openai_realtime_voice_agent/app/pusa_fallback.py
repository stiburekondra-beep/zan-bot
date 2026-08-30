"""Značka „gemini pusa spadla" — jak se záchrana dožije restartu.

Proč soubor a ne přepsání ``ZAN_PUSA``: env čte compose při VYTVOŘENÍ
kontejneru, běžící proces ho nemá jak změnit. Po pádu by se most zvedl
zpátky do gemini, znovu spadl, a z „rychlého čistého selhání" by byla
restart-smyčka — tedy horší stav než dnes.

Kde značka leží (a proč tam): uvnitř kontejneru, ne na svazku.

* ``docker restart`` — což dělá ``restart: unless-stopped`` po našem pádu —
  filesystém kontejneru ZACHOVÁ, takže záchrana platí a most naběhne na
  openai pusu,
* ``docker compose up -d`` / recreate značku ZAHODÍ, takže vědomé nasazení
  začíná s čistým štítem a gemini dostane novou šanci.

Tím se značka nemůže stát blokátorem, který přežije svůj důvod — sama se
uklidí prvním záměrným nasazením a nikdo ji nemusí hlídat.

Modul smí sahat JEN do stdlib: čte ho i openai větev, která ``google-genai``
nemá vůbec nainstalované.
"""

from __future__ import annotations

import datetime
import logging
import os
from typing import Optional

logger = logging.getLogger(__name__)

#: Výchozí umístění značky. Přepsatelné kvůli testům a kvůli tomu, aby šlo
#: značku vědomě položit na svazek, kdyby ji někdo chtěl přežít i recreate.
DEFAULT_FALLBACK_FILE = "/tmp/zan-pusa-fallback"


def fallback_path() -> str:
    """Cesta ke značce (env ``ZAN_PUSA_FALLBACK_FILE``, jinak výchozí)."""
    return os.environ.get("ZAN_PUSA_FALLBACK_FILE", "").strip() or DEFAULT_FALLBACK_FILE


def read_fallback() -> Optional[str]:
    """Vrátí důvod pádu, pokud značka existuje a dá se přečíst, jinak ``None``.

    Fail-safe směrem k provozu: nečitelná/prázdná značka se bere jako „není",
    protože zbytečné shození na openai je menší škoda než pád na startu.
    """
    cesta = fallback_path()
    try:
        with open(cesta, "r", encoding="utf-8") as f:
            duvod = f.read().strip()
    except OSError:
        return None
    return duvod or None


def write_fallback(duvod: str) -> bool:
    """Zapíše značku a hned si ji přečte zpátky. ``True`` = ověřeně zapsáno.

    Návratovou hodnotu MUSÍ volající respektovat: bez zapsané značky se
    nesmí padat, jinak restart naběhne zpátky do gemini a zacyklí se.
    """
    cesta = fallback_path()
    kdy = datetime.datetime.now().astimezone().isoformat(timespec="seconds")
    try:
        with open(cesta, "w", encoding="utf-8") as f:
            f.write(f"{kdy} gemini pusa selhala: {duvod}\n")
        return read_fallback() is not None
    except OSError as e:
        logger.error("⚠️ značku pádu pusy (%s) nejde zapsat: %r", cesta, e)
        return False
