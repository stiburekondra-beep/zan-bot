"""Řídicí HTTP endpoint mostu pro Žánovu obrazovku (LAB 23. 8. 2026).

zan-obrazovka (127.0.0.1:8790, kiosk na TV) po zobrazení očíslované nabídky
zavolá GET /follow_up — most pošle satelitu {"type":"request_follow_up"}
a Voice PE otevře mikrofon BEZ wake wordu (firmware to umí, va_client.cpp:516;
serverová strana dosud chyběla). Dítě řekne „trojku" → běžný turn → ask_zan →
Žán-Code /voice → curl 127.0.0.1:8790/pust?n=3.

Poslouchá jen na 127.0.0.1 — stejný práh důvěry jako CDP kiosku (9222)
a zan-obrazovka (8790). Žádný token: kdo je na krabici, ovládá i TV.
"""
import asyncio
import json
import logging

logger = logging.getLogger(__name__)


async def start_tv_control(broadcast_json, host: str = "127.0.0.1", port: int = 8791):
    """Spustí mini HTTP server; broadcast_json je WebSocketHandler.broadcast_json."""

    async def handle(reader: asyncio.StreamReader, writer: asyncio.StreamWriter):
        try:
            request_line = await asyncio.wait_for(reader.readline(), 5)
            parts = request_line.decode("latin1", "replace").split()
            path = parts[1] if len(parts) > 1 else "/"
            while True:  # hlavičky zahazujeme, tělo nepotřebujeme
                line = await asyncio.wait_for(reader.readline(), 5)
                if line in (b"\r\n", b"\n", b""):
                    break
            if path.startswith("/follow_up"):
                await broadcast_json({"type": "request_follow_up"})
                logger.info("📺 tv_control: request_follow_up poslán satelitům")
                status, body = "200 OK", json.dumps({"ok": True})
            else:
                status, body = "404 Not Found", json.dumps({"ok": False, "chyba": "neznámá cesta"})
            writer.write((
                f"HTTP/1.1 {status}\r\nContent-Type: application/json\r\n"
                f"Content-Length: {len(body.encode())}\r\nConnection: close\r\n\r\n{body}"
            ).encode())
            await writer.drain()
        except Exception as e:  # jeden vadný požadavek nesmí shodit most
            logger.warning(f"tv_control: chyba požadavku: {e!r}")
        finally:
            try:
                writer.close()
            except Exception:
                pass

    server = await asyncio.start_server(handle, host, port)
    logger.info(f"📺 tv_control poslouchá na http://{host}:{port}/follow_up")
    return server
