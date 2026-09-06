# -*- coding: utf-8 -*-
"""Řídicí HTTP endpoint mostu: `POST /nahravani/start` a `/nahravani/stop`.

Most dosud poslouchal JEN websocket satelitu (`WEBSOCKET_PORT`) a `/prubeh`
(`prubeh_server.py`). Jádro tedy nemělo kam poslat „natoč jeden vzorek" —
`mozek/nataceni/zdroj-satelit.js` čeká přesně na tenhle port.

Slupka a nic víc: veškeré rozhodování (co je platný požadavek, kdy se
odmítá, kdy je klip hotový) bydlí v `app/nahravani.NahravaciRezim`, aby
se dalo testovat bez fastapi i bez pipecatu.

Fail-closed, stejně jako `/prubeh`: **bez tokenu se server nespustí.**
Otevřený endpoint, který umí zapnout mikrofon v obýváku, je horší než
chybějící funkce.

ENV:
  ZAN_MOST_HTTP_PORT   (default 8091; 0 = vypnuto)
  ZAN_MOST_HTTP_HOST   (default 127.0.0.1 — jádro běží na téže krabici)
  ZAN_MOST_TOKEN       (jinak ZAN_VOICE_TOKEN; bez obou se nespustí)
  ZAN_NATACENI_TMP     (default /homeassistant/zan_data/nataceni/tmp)
  ZAN_AKCE_TOKEN       (token pro zpětné volání jádru; jinak ZAN_VOICE_TOKEN)
"""
import contextlib
import logging
import os
from typing import Callable, Optional

# POZOR: tenhle modul NESMÍ mít `from __future__ import annotations` — viz
# stejná past v `prubeh_server.py`: FastAPI si typy dohledává přes
# `typing.get_type_hints` a `Request` se sem importuje až uvnitř funkce.

from app.nahravani import NahravaciRezim, nastav_rezim

logger = logging.getLogger("zan.nahravani_server")

VYCHOZI_PORT = 8091


def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        return int(raw)
    except ValueError:
        logger.warning("⚠️ %s=%r není číslo — beru default %d", name, raw, default)
        return default


def vytvor_api(rezim: NahravaciRezim, token: str):
    """Postaví FastAPI aplikaci nad hotovým režimem.

    Oddělené od `spust_nahravani_server`, aby se dala otestovat SKUTEČNÁ
    cesta požadavku (routa, token, návratový kód) bez otevírání portu.
    """
    from fastapi import FastAPI, Header, HTTPException, Request
    from fastapi.responses import JSONResponse

    if not token:
        # Pojistka i tady: `vytvor_api` je veřejná a nesmí jít obejít.
        raise ValueError("nahrávací endpoint bez tokenu se nestaví")

    api = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)

    def _over(authorization: str) -> None:
        if authorization.removeprefix("Bearer ").strip() != token:
            # 404, ne 403 — neprozrazovat, že tu endpoint je.
            raise HTTPException(status_code=404, detail="not found")

    @api.post("/nahravani/start")
    async def _start(request: Request, authorization: str = Header(default="")):
        _over(authorization)
        try:
            telo = await request.json()
        except Exception:
            raise HTTPException(status_code=400, detail="bad json")
        stav, odpoved = await rezim.start(telo)
        return JSONResponse(status_code=stav, content=odpoved)

    @api.post("/nahravani/stop")
    async def _stop(authorization: str = Header(default="")):
        _over(authorization)
        stav, odpoved = await rezim.stop()
        return JSONResponse(status_code=stav, content=odpoved)

    @api.get("/nahravani/stav")
    async def _stav(authorization: str = Header(default="")):
        """Diagnostika pro `curl` z loopbacku: nahrává se právě teď?"""
        _over(authorization)
        return {"ok": True, "tmp": rezim.tmp_dir, **rezim.stav()}

    return api


async def spust_nahravani_server(
    probiha_rozhovor: Optional[Callable[[], bool]] = None,
    rezim: Optional[NahravaciRezim] = None,
    host: Optional[str] = None,
    port: Optional[int] = None,
    token: Optional[str] = None,
):
    """Nastartuje HTTP server nahrávacího režimu.

    Vrací dvojici `(task, rezim)`, nebo `(None, None)`, když se nespustil
    (vypnuto portem, chybějící token, chybějící knihovna). Režim se zároveň
    zaregistruje jako procesový (`nahravani.nastav_rezim`), aby si ho
    `RawAudioSerializer` našel bez protahování přes půl mostu.
    """
    import asyncio

    port = _env_int("ZAN_MOST_HTTP_PORT", VYCHOZI_PORT) if port is None else int(port)
    if port <= 0:
        logger.info("ℹ️ nahrávací režim vypnut (ZAN_MOST_HTTP_PORT=%d)", port)
        return None, None

    host = host or os.environ.get("ZAN_MOST_HTTP_HOST", "127.0.0.1").strip() or "127.0.0.1"
    token = token if token is not None else (
        os.environ.get("ZAN_MOST_TOKEN", "").strip()
        or os.environ.get("ZAN_VOICE_TOKEN", "").strip()
    )
    if not token:
        logger.error(
            "🛑 /nahravani NESPUŠTĚNO — chybí ZAN_MOST_TOKEN i ZAN_VOICE_TOKEN. "
            "Neotevírám nechráněné zapnutí mikrofonu."
        )
        return None, None

    rezim = rezim or NahravaciRezim(probiha_rozhovor=probiha_rozhovor)

    try:
        import uvicorn
        api = vytvor_api(rezim, token)
    except Exception as exc:  # pragma: no cover - závislost chybí
        logger.error("🛑 /nahravani NESPUŠTĚNO — nejde načíst fastapi/uvicorn: %r", exc)
        return None, None

    nastav_rezim(rezim)

    class _TichyServer(uvicorn.Server):
        """uvicorn, který NEPŘEBÍRÁ signály (viz `prubeh_server._TichyServer`)."""

        @contextlib.contextmanager
        def capture_signals(self):
            yield

    config = uvicorn.Config(
        api, host=host, port=port, log_level="warning", access_log=False, lifespan="off",
    )
    server = _TichyServer(config)
    task = asyncio.create_task(server.serve(), name="nahravani-server")
    logger.info("🎙️ /nahravani naslouchá na http://%s:%d (token vyžadován), klipy -> %s",
                host, port, rezim.tmp_dir)
    return task, rezim
