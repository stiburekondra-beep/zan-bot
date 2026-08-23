"""Docker HEALTHCHECK: zelená jen když hlas může doopravdy fungovat.

Starý healthcheck jen otevřel socket na WEBSOCKET_PORT — to je „proces žije",
ne „hlas funguje". Kontejner zůstal `healthy`, i když byl dům hluchý: OpenAI
Realtime socket byl po tichém pádu prvního připojení mrtvý a `_ws_send` beze
slova zahazoval každý frame (živě 2026-08-23, čtyři wake-words do prázdna,
LED prstenec červený). Poučení:
`docs/learnings/2026-08-23_health-na-portu-neni-funkcni-sluzba.md`.

Zdroj pravdy je heartbeat soubor, který píše `Application._health_heartbeat_loop`
každých ~5 s podle reálného stavu OpenAI websocketu (`openai_service._websocket
is not None`). Healthcheck se tak ptá „existuje TEĎ platné spojení?", ne
„naslouchá port?". Stavy v souboru: `connected` (živý OpenAI socket),
`idle` (služba ještě nevznikla — krátké okno při startu) nebo `disconnected`
(služba je, ale socket chybí = přesně stav incidentu).

Exit 0 = healthy, exit 1 = unhealthy. Docker HEALTHCHECK má `--retries=3
--interval=30s`, takže krátká reconnect mezera (~3 s, socket dočasně None)
tři cykly nepřežije a status nerozbliká.
"""
import os
import socket
import sys
import time

# Heartbeat se píše každých ~5 s; 30 s = šest zmeškaných zápisů → smyčka
# zamrzlá / proces zaseklý. Menší okno by rozblikávalo status na běžném GC/IO
# zpomalení.
MAX_AGE_S = 30.0

HEALTH_FILE = os.environ.get("REALTIME_HEALTH_FILE", "/tmp/zan-realtime-health")


def _read_state(path):
    """Vrátí (stav, epoch) z heartbeat souboru, nebo vyhodí výjimku."""
    with open(path, "r") as f:
        parts = f.read().split()
    return parts[0], float(parts[1])


def _port_ok():
    """Fallback na starý port-check — použije se JEN když heartbeat soubor
    ještě není (startovní okno, kryté `--start-period`). Degradace na dřívější
    chování je bezpečnější než tvrdý pád kontejneru, kdyby se heartbeat
    nezaložil."""
    port = int(os.environ.get("WEBSOCKET_PORT", "8080"))
    try:
        socket.create_connection(("127.0.0.1", port), 3).close()
        return 0
    except OSError:
        return 1


def check(path=HEALTH_FILE):
    try:
        state, ts = _read_state(path)
    except FileNotFoundError:
        # Heartbeat ještě nevznikl → startovní okno. Nepadej tvrdě, spadni na
        # port-check (kryto `--start-period`).
        return _port_ok()
    except Exception:
        # Poškozený soubor = nevíme → unhealthy.
        return 1
    if time.time() - ts > MAX_AGE_S:
        return 1  # heartbeat stojí → smyčka/proces zamrzlý
    if state == "disconnected":
        return 1  # zařízení připojené, ale žádný OpenAI socket → hluchý dům
    return 0  # `connected` nebo `idle`


if __name__ == "__main__":
    sys.exit(check())
