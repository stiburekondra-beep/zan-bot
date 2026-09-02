# -*- coding: utf-8 -*-
"""Endpoint `/prubeh` — kudy mozek posílá mostu průběžné nálezy.

Specifikace: `projects/baklazan/zan/MLUVENI-ZANA-TECHNICKY.md` §2.
Žán-Code (`claude-stream-pool.js`, `onProgress`) sem **fire-and-forget**
posílá `{interaction_id, text, druh}`; hlas na to nikdy nečeká a chyba se
jen zaloguje. Most z toho udělá `fronta.pridej(...)` s prioritou 2
a platností osmi sekund — po ní už by to byla lež.

Fail-closed (poučení `2026-08-23_overeno-false-u-pojistky-je-poplach.md`):
**bez tokenu se server vůbec nespustí.** Otevřený zápisový endpoint do
úst domácího asistenta je horší než chybějící funkce; když není čím
ověřit volajícího, neposloucháme.

ENV:
  ZAN_PRUBEH_PORT   (default 8090; 0 = vypnuto)
  ZAN_PRUBEH_HOST   (default 127.0.0.1 — mozek běží na stejném stroji)
  ZAN_PRUBEH_TOKEN  (default = ZAN_VOICE_TOKEN, tedy tentýž sdílený token,
                     kterým se most autentizuje k mozku)
"""
import contextlib
import logging
import os
from typing import Callable, Optional

# POZOR: tenhle modul NESMÍ mít `from __future__ import annotations`.
# FastAPI si typy parametrů dohledává přes `typing.get_type_hints`, a to
# u odložených (řetězcových) anotací hledá jméno v globálech MODULU.
# `Request` se sem ale importuje až uvnitř funkce (aby chybějící fastapi
# neshodil celý most), takže by se nenašel a FastAPI by `request` považoval
# za query parametr → každé volání by skončilo `422 Field required`.
# Ověřeno požadavkem na běžící server, ne přečtením kódu.

logger = logging.getLogger("zan.prubeh_server")

MAX_TEXT = 2000


def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        return int(raw)
    except ValueError:
        logger.warning("⚠️ %s=%r není číslo — beru default %d", name, raw, default)
        return default


async def spust_prubeh_server(
    prijmi: Callable[[str, str, str], bool],
    host: Optional[str] = None,
    port: Optional[int] = None,
    token: Optional[str] = None,
    drzi: Optional[Callable[[Optional[str]], dict]] = None,
):
    """Nastartuje HTTP server s jediným endpointem `POST /prubeh`.

    Args:
        prijmi: `(interaction_id, text, druh) -> bool` — obvykle
            `ZanBridge.prijmi_prubeh`. Vrací False, když se nezařadilo.

    Vrací `asyncio.Task` běžícího serveru, nebo `None`, když se nespustil
    (vypnuto portem, chybějící token, chybějící knihovna).
    """
    import asyncio

    port = _env_int("ZAN_PRUBEH_PORT", 8090) if port is None else int(port)
    if port <= 0:
        logger.info("ℹ️ /prubeh vypnut (ZAN_PRUBEH_PORT=%d)", port)
        return None

    host = host or os.environ.get("ZAN_PRUBEH_HOST", "127.0.0.1").strip() or "127.0.0.1"
    token = token if token is not None else (
        os.environ.get("ZAN_PRUBEH_TOKEN", "").strip()
        or os.environ.get("ZAN_VOICE_TOKEN", "").strip()
    )
    if not token:
        # FAIL-CLOSED. Brzda, která při „nevím" pustí, je zároveň slepá vůči
        # vlastní nefunkčnosti — radši endpoint vůbec nemít.
        logger.error(
            "🛑 /prubeh NESPUŠTĚN — chybí ZAN_PRUBEH_TOKEN i ZAN_VOICE_TOKEN. "
            "Neotevírám nechráněný zápis do úst asistenta."
        )
        return None

    try:
        import uvicorn
        from fastapi import FastAPI, Header, HTTPException, Request
    except Exception as exc:  # pragma: no cover - závislost chybí
        logger.error("🛑 /prubeh NESPUŠTĚN — nejde načíst fastapi/uvicorn: %r", exc)
        return None

    api = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)

    @api.post("/prubeh")
    async def _prubeh(request: Request, authorization: str = Header(default="")):
        if authorization.removeprefix("Bearer ").strip() != token:
            # 404, ne 403 — neprozrazovat, že tu endpoint je
            # (poučení `2026-08-12_clenstvi-v-datech-neni-ochrana.md`).
            raise HTTPException(status_code=404, detail="not found")
        try:
            telo = await request.json()
        except Exception:
            raise HTTPException(status_code=400, detail="bad json")
        if not isinstance(telo, dict):
            raise HTTPException(status_code=400, detail="bad body")
        text = str(telo.get("text", "")).strip()[:MAX_TEXT]
        interaction_id = str(telo.get("interaction_id", "")).strip()[:128]
        druh = str(telo.get("druh", "prubeh")).strip()[:32]
        if not text:
            return {"ok": False, "duvod": "prázdný text"}
        try:
            zarazeno = bool(prijmi(interaction_id, text, druh))
        except Exception as exc:  # pragma: no cover - endpoint nesmí shodit most
            logger.error("❌ /prubeh: zařazení selhalo: %r", exc)
            return {"ok": False, "duvod": "vnitřní chyba"}
        return {"ok": zarazeno}

    @api.get("/drzim")
    async def _drzim(zarizeni: str = "", authorization: str = Header(default="")):
        """Drží most tohle zařízení? JEDEN MLUVČÍ NA ZAŘÍZENÍ.

        PROČ (2. 9. 2026): vlastník hlásil „Voice PE promluvil dvojitě".
        Na satelit vedou DVĚ zvukové cesty — most posílá vlastní PCM po
        websocketu a jádro (nebo runner) umí témuž zařízení poslat announce
        přes Home Assistant `media_player`. Když se potkají, mluví dva
        hlasy z jednoho repráku. Runner pohádek proti tomu má `GET /mluvim`
        („kdo se ptá, ať mlčí — jeden vypravěč") — most takové čidlo dosud
        neměl, takže se ho nikdo nemohl zeptat.

        Odpověď je ÚDAJ, ne rozkaz: `drzim` = most má se zařízením živou
        relaci, `mluvim` = právě z něj zní řeč. Co s tím volající udělá,
        rozhoduje volající.

        FAIL-OPEN JE NA STRANĚ VOLAJÍCÍHO, a schválně: když se most neozve,
        má announce PROBĚHNOUT. Ticho je horší než dvojhlas — dvojhlas je
        trapný, ticho vypadá jako rozbitý dům.
        """
        if authorization.removeprefix("Bearer ").strip() != token:
            raise HTTPException(status_code=404, detail="not found")
        if drzi is None:
            # Čidlo není zapojené. Přiznat to je důležitější než hádat:
            # `drzim: false` by volajícího pustil announcovat vždycky.
            return {"ok": False, "duvod": "čidlo není zapojené"}
        try:
            stav = drzi(zarizeni.strip() or None)
        except Exception as exc:  # pragma: no cover - čidlo nesmí shodit most
            logger.error("❌ /drzim: čtení stavu selhalo: %r", exc)
            return {"ok": False, "duvod": "vnitřní chyba"}
        return {"ok": True, **stav}

    @api.get("/zdravi")
    async def _zdravi():
        return {"ok": True}

    class _TichyServer(uvicorn.Server):
        """uvicorn, který NEPŘEBÍRÁ signály.

        `Server.capture_signals()` v hlavním vlákně přepíše SIGINT/SIGTERM
        na svůj `handle_exit` — v tomhle procesu je ale řídí pipeline
        runner a `main()`. Necháváme je být; server se ukončí zrušením
        tasku, ne signálem.
        """

        @contextlib.contextmanager
        def capture_signals(self):
            yield

    # `lifespan="off"`: žádné startup/shutdown handlery nemáme, a při zrušení
    # tasku by lifespan smyčka vypsala do journalu ERROR + traceback z běžné
    # `CancelledError` — falešný poplach při normálním vypínání mostu.
    config = uvicorn.Config(
        api, host=host, port=port, log_level="warning", access_log=False, lifespan="off",
    )
    server = _TichyServer(config)
    task = asyncio.create_task(server.serve(), name="prubeh-server")
    logger.info("📨 /prubeh naslouchá na http://%s:%d (token vyžadován)", host, port)
    return task
