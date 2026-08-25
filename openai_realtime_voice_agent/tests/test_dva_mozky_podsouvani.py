# -*- coding: utf-8 -*-
"""Offline overeni mechanismu DVA MOZKY (bez OpenAI, bez zarizeni).

Fake HTTP server misto Zan-Code + fake pipecat sluzba misto realtime session.
Testuje presne to, co se u stolu overit DA: ze se handler vraci hned, ze se
odpovedi vstrikuji do bezici session, ze jich muze byt N, a ze pojistky
(mrtva session, STOP, timeout, prubeh) opravdu strili.

CO TENHLE TEST NEDOKAZUJE: ze OpenAI Realtime prijme vstriknutou polozku a
vysloví ji. Tvar udalosti je overeny proti pipecat 0.0.97 (test 13) a proti
tomu, jak si je pipecat posila sam pri setupu konverzace — ale skutecny dukaz
je promluvit na Voice PE. Viz test plan v karte 2026-08-25-programator-zana-13.

Pousti se bez pytestu i s nim (potrebuje pipecat, takze prakticky
v kontejneru mostu):

    python tests/test_dva_mozky_podsouvani.py

Diakritika je v tomhle souboru zamerne jen v testovanych retezcich —
vystup se cte pres `docker run` z Windows terminalu.
"""
import asyncio
import json
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ADDON_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ADDON_DIR not in sys.path:
    sys.path.insert(0, ADDON_DIR)

FAILS = []


def check(name, ok, detail=""):
    print(("  OK   " if ok else "  FAIL ") + name + ((" -- " + str(detail)) if detail else ""))
    if not ok:
        FAILS.append(name)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        self.rfile.read(length)
        path = self.path
        if path == "/single":
            time.sleep(2.0)
            body = json.dumps({"reply": "Kotel jede na 45 stupnu."}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        elif path == "/pretty":
            time.sleep(0.2)
            body = json.dumps({"reply": "Pekne naformatovana odpoved."}, indent=2).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        elif path == "/ndjson":
            self.send_response(200)
            self.send_header("Content-Type", "application/x-ndjson")
            self.end_headers()
            for i, text in enumerate(["Prvni nalez.", "Druhy nalez.", "Zaver."]):
                time.sleep(0.4)
                self.wfile.write((json.dumps({"reply": text}) + "\n").encode())
                self.wfile.flush()
        elif path == "/chunks":
            time.sleep(0.2)
            body = json.dumps({"chunks": ["Kus jedna.", "Kus dva."]}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        elif path == "/slow":
            time.sleep(30.0)
            body = b'{"reply": "pozde"}'
            self.send_response(200)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        else:
            self.send_response(404)
            self.end_headers()


class FakeService:
    """Minimalni napodobenina OpenAIRealtimeLLMService, jak ji most pouziva."""

    def __init__(self):
        self._websocket = object()
        self._disconnecting = False
        self._current_assistant_response = None
        self._messages_added_manually = {}
        self.events = []
        self.responses = 0

    async def send_client_event(self, event):
        self.events.append(event)

    async def _create_response(self):
        self.responses += 1

    # -- pomocne pro testy
    def texts(self):
        out = []
        for e in self.events:
            item = getattr(e, "item", None)
            if item is not None and getattr(item, "content", None):
                out.append(item.content[0].text)
        return out

    def die(self):
        self._websocket = None


class FakeParams:
    def __init__(self, text, llm):
        self.arguments = {"text": text}
        self.llm = llm
        self.results = []

    async def result_callback(self, result, properties=None):
        self.results.append((result, properties))


def make_bridge(url, **env):
    for key in list(os.environ):
        if key.startswith("ZAN_ASK_"):
            del os.environ[key]
    for key, value in env.items():
        os.environ[key] = str(value)
    import importlib
    import app.zan_bridge_tool as mod
    importlib.reload(mod)

    async def broadcast(_payload):
        return None

    return mod, mod.ZanBridge(url, "tok", None, broadcast)


async def main(base):
    print("== 1) handler se vraci HNED, odpoved dorazi az potom ==")
    mod, bridge = make_bridge(base + "/single", ZAN_ASK_QUIET_WAIT=2)
    svc = FakeService()
    params = FakeParams("proc netopi kotel", svc)
    t0 = time.monotonic()
    await bridge.handler(params)
    dt = time.monotonic() - t0
    check("handler se vratil do 0,5 s", dt < 0.5, "%.2f s" % dt)
    check("vratil status delegated", params.results and params.results[0][0].get("status") == "delegated")
    check("a run_llm=False (pusa uz rekla sve)", params.results[0][1].run_llm is False)
    check("hned po navratu nic vstriknuto neni", svc.texts() == [])
    check("dotaz bezi na pozadi", bridge.pending == 1)
    await asyncio.sleep(3.0)
    texts = svc.texts()
    check("po dobehnuti je vstriknuta prave 1 zprava", len(texts) == 1, texts)
    check("nese odpoved mozku", texts and "45 stupnu" in texts[0])
    check("je oznacena jako ODPOVED", texts and "ODPOVEDEL" in texts[0].replace("Ě", "E").replace("ě", "e").upper().replace("Ď", "D"))
    check("model dostal pokyn odpovedet", svc.responses == 1, svc.responses)
    check("registrovana v _messages_added_manually", len(svc._messages_added_manually) == 1)
    check("po dobehnuti uz nic nebezi", bridge.pending == 0)

    print("== 2) NDJSON = N prubeznych podsunuti ==")
    mod, bridge = make_bridge(base + "/ndjson", ZAN_ASK_QUIET_WAIT=2)
    svc = FakeService()
    await bridge.handler(FakeParams("co je v dome novyho", svc))
    await asyncio.sleep(0.9)
    partial_seen = len(svc.texts())
    await asyncio.sleep(2.0)
    texts = svc.texts()
    check("prvni nalez dorazil driv nez konec", partial_seen >= 1, partial_seen)
    check("celkem 3 podsunuti", len(texts) == 3, len(texts))
    check("prvni dva jsou DILCI NALEZ", all("DILCI" in t.replace("Í", "I").replace("Č", "C").upper() for t in texts[:2]))
    check("posledni je finalni odpoved", "ODPOVEDEL" in texts[2].replace("Ě", "E").replace("ě", "e").upper().replace("Ď", "D"))
    check("tri response.create", svc.responses == 3, svc.responses)

    print("== 3) chunks v jedne odpovedi = N zprav ==")
    mod, bridge = make_bridge(base + "/chunks", ZAN_ASK_QUIET_WAIT=2)
    svc = FakeService()
    await bridge.handler(FakeParams("shrn to", svc))
    await asyncio.sleep(1.5)
    check("dve podsunuti", len(svc.texts()) == 2, svc.texts())

    print("== 4) pretty-printed JSON (dnesni tvar) se necte po radcich ==")
    mod, bridge = make_bridge(base + "/pretty", ZAN_ASK_QUIET_WAIT=2)
    svc = FakeService()
    await bridge.handler(FakeParams("ahoj", svc))
    await asyncio.sleep(1.5)
    texts = svc.texts()
    check("jedno podsunuti s celou odpovedi", len(texts) == 1 and "naformatovana" in texts[0], texts)

    print("== 5) session mezitim skoncila -> tise zahodit ==")
    mod, bridge = make_bridge(base + "/single", ZAN_ASK_QUIET_WAIT=2)
    svc = FakeService()
    await bridge.handler(FakeParams("neco", svc))
    svc.die()
    await asyncio.sleep(3.0)
    check("nic se nevstriklo", svc.texts() == [])
    check("zadny response.create", svc.responses == 0)
    check("task dobehl bez vyjimky", bridge.pending == 0)

    print("== 6) STOP -> cancel_all zabije bezici dotaz ==")
    mod, bridge = make_bridge(base + "/single", ZAN_ASK_QUIET_WAIT=2)
    svc = FakeService()
    await bridge.handler(FakeParams("neco", svc))
    killed = bridge.cancel_all("test STOP")
    check("zruseno prave 1", killed == 1, killed)
    await asyncio.sleep(3.0)
    check("po stopce nic nepromluvilo", svc.texts() == [], svc.texts())

    print("== 7) timeout je konfigurovatelny (ZAN_ASK_TIMEOUT) ==")
    mod, bridge = make_bridge(base + "/slow", ZAN_ASK_TIMEOUT=2, ZAN_ASK_QUIET_WAIT=2, ZAN_ASK_PROGRESS_AFTER=0)
    check("most cte timeout z env", bridge.timeout == 2.0, bridge.timeout)
    svc = FakeService()
    await bridge.handler(FakeParams("dlouhy ukol", svc))
    await asyncio.sleep(3.5)
    texts = svc.texts()
    check("po timeoutu prisla poctiva hlaska", len(texts) == 1 and "NEOZVAL" in texts[0], texts)
    bridge.cancel_all("uklid")

    print("== 8) default timeoutu je 300 s (bylo 45 natvrdo) ==")
    mod, bridge = make_bridge(base + "/single")
    check("default 300", bridge.timeout == 300.0, bridge.timeout)

    print("== 9) 'jeste na tom delam' pri dlouhem premysleni ==")
    mod, bridge = make_bridge(base + "/slow", ZAN_ASK_TIMEOUT=30, ZAN_ASK_PROGRESS_AFTER=1,
                              ZAN_ASK_PROGRESS_EVERY=1, ZAN_ASK_PROGRESS_MAX=2, ZAN_ASK_QUIET_WAIT=2)
    svc = FakeService()
    await bridge.handler(FakeParams("dlouhy ukol", svc))
    await asyncio.sleep(3.0)
    texts = svc.texts()
    check("dorazila aspon jedna hlaska o prubehu", any("PORAD PRACUJE" in t.replace("Ř", "R").replace("Á", "A").upper() for t in texts), texts)
    check("nejvys 2 (PROGRESS_MAX)", len(texts) <= 2, len(texts))
    bridge.cancel_all("uklid")

    print("== 10) soubezne dotazy: strop MAX_PENDING ==")
    mod, bridge = make_bridge(base + "/slow", ZAN_ASK_TIMEOUT=30, ZAN_ASK_MAX_PENDING=2,
                              ZAN_ASK_PROGRESS_AFTER=0, ZAN_ASK_QUIET_WAIT=2)
    svc = FakeService()
    for i in range(4):
        await bridge.handler(FakeParams("dotaz %d" % i, svc))
    check("bezi nejvys 2 soubezne", bridge.pending <= 2, bridge.pending)
    check("zrusene se zahodily bez vstriknuti", svc.texts() == [])
    bridge.cancel_all("uklid")

    print("== 11) nouzovy vypinac ZAN_ASK_ASYNC=false = stare blokujici chovani ==")
    mod, bridge = make_bridge(base + "/pretty", ZAN_ASK_ASYNC="false")
    svc = FakeService()
    params = FakeParams("ahoj", svc)
    t0 = time.monotonic()
    await bridge.handler(params)
    dt = time.monotonic() - t0
    check("handler cekal na odpoved", dt > 0.15, "%.2f s" % dt)
    check("odpoved prisla jako vysledek nastroje", params.results and "naformatovana" in str(params.results[0][0]))
    check("nic se nevstrikovalo", svc.texts() == [])

    print("== 12) bez zive session se prepne na blokujici rezim sam ==")
    mod, bridge = make_bridge(base + "/pretty")
    svc = FakeService()
    svc.die()
    params = FakeParams("ahoj", svc)
    await bridge.handler(params)
    check("odpoved prisla vysledkem nastroje", params.results and "naformatovana" in str(params.results[0][0]))

    print("== 13) vstrikovana polozka ma tvar, ktery Realtime API zna ==")
    mod, bridge = make_bridge(base + "/pretty", ZAN_ASK_QUIET_WAIT=2)
    svc = FakeService()
    await bridge.handler(FakeParams("ahoj", svc))
    await asyncio.sleep(1.5)
    evt = svc.events[0]
    dump = evt.model_dump(exclude_none=True)
    check("typ udalosti", dump.get("type") == "conversation.item.create", dump.get("type"))
    check("item.type=message", dump["item"]["type"] == "message")
    check("role=system", dump["item"]["role"] == "system")
    check("content type=input_text", dump["item"]["content"][0]["type"] == "input_text")
    check("json serializovatelne", isinstance(json.dumps(dump), str))

    print("== 14) pusa mluvi -> podsunuti pocka, az domluvi ==")
    mod, bridge = make_bridge(base + "/pretty", ZAN_ASK_QUIET_WAIT=10)
    svc = FakeService()
    svc._current_assistant_response = "mluvim"
    await bridge.handler(FakeParams("ahoj", svc))
    await asyncio.sleep(1.5)
    check("dokud mluvi, nevstrikuje se", svc.texts() == [], svc.texts())
    svc._current_assistant_response = None
    await asyncio.sleep(0.8)
    check("po domluveni se vstrikne", len(svc.texts()) == 1, svc.texts())


if __name__ == "__main__":
    server = ThreadingHTTPServer(("127.0.0.1", 8899), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        asyncio.run(main("http://127.0.0.1:8899"))
    finally:
        server.shutdown()
    print()
    if FAILS:
        print("FAILED (%d): %s" % (len(FAILS), ", ".join(FAILS)))
        sys.exit(1)
    print("VSE PROSLO")
