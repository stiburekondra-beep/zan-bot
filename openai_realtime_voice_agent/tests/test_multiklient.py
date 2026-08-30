# -*- coding: utf-8 -*-
"""Testy multiklientního mostu — dva satelity na jednom portu.

Pouští se bez pytestu i s ním:

    python tests/test_multiklient.py        # z adresáře add-onu
    pytest tests/test_multiklient.py

Co se tu OVĚŘUJE (a co ne):

* **Registr a rozpočet** jsou čistý Python — testují se doopravdy, včetně
  stropu, odmítnutí třetího a sdílené peněženky.
* **Vstupní brána mostu** se testuje s falešnými websockety a falešnou
  pipeline. Ověřuje se NAŠE logika: kdo se přijme, kdo odmítne, kam míří
  fáze a co udělá odpojení jednoho satelitu s tím druhým.
* Co se tady ověřit **nedá**: že pipecatí transport na krabici opravdu
  obslouží dvě spojení naráz a že satelity nemluví jeden přes druhého.
  To je živý LAB test (postup v kartě `2026-08-26-programator-zana-23`).

Na Windows notebooku, kde pipecat ani websockets nejsou, se chybějící
knihovny podstrčí prázdnou atrapou — testuje se náš kód, ne cizí.
"""
import asyncio
import importlib.util
import json
import os
import sys
import types

ADDON_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ADDON_DIR not in sys.path:
    sys.path.insert(0, ADDON_DIR)


# ── atrapy chybějících knihoven ─────────────────────────────────────────
def _stub_missing_libs():
    """Podstrčit prázdné moduly za pipecat/websockets, když nejsou k dispozici.

    Atrapa nahrazuje JEN to, co potřebují importy na úrovni modulu (definice
    tříd). Žádná z nich se v testu nevolá — pipeline i transport jsou falešné.
    """
    if importlib.util.find_spec("pipecat") is None:
        _install_pipecat_stub()
    if importlib.util.find_spec("websockets") is None:
        _install_websockets_stub()


class _StubBase:
    """Základ atrapy: spolkne libovolné argumenty konstruktoru."""

    def __init__(self, *args, **kwargs):
        self._websocket = None


def _mod(name):
    """Prázdný modul, který si jméno třídy vyrobí, až se o ni někdo řekne.

    Import list v `app/*.py` je dlouhý a mění se — ruční výčet by se rozešel.
    PEP 562 `__getattr__` na modulu je proti tomu odolný.
    """
    module = types.ModuleType(name)
    vyrobene = {}

    def __getattr__(attr):
        if attr.startswith("__"):
            raise AttributeError(attr)
        if attr not in vyrobene:
            vyrobene[attr] = type(attr, (_StubBase,), {})
        return vyrobene[attr]

    module.__getattr__ = __getattr__
    sys.modules[name] = module
    return module


def _install_pipecat_stub():
    _mod("pipecat")
    _mod("pipecat.pipeline")
    _mod("pipecat.pipeline.pipeline")
    _mod("pipecat.pipeline.runner")
    _mod("pipecat.pipeline.task")
    _mod("pipecat.transports")
    _mod("pipecat.transports.websocket")
    _mod("pipecat.transports.websocket.server")
    _mod("pipecat.services")
    # `llm_service` (nadtyp LLMService) přibyl 30. 8. 2026 s druhou pusou:
    # do pipeline může přijít i GeminiLiveLLMService, takže websocket_handler
    # anotuje obecným typem místo OpenAIRealtimeLLMService.
    _mod("pipecat.services.llm_service")
    _mod("pipecat.services.openai")
    _mod("pipecat.services.openai.realtime")
    _mod("pipecat.services.openai.realtime.llm")
    _mod("pipecat.services.openai.realtime.events")
    _mod("pipecat.frames")
    _mod("pipecat.frames.frames")
    _mod("pipecat.audio")
    _mod("pipecat.processors")
    _mod("pipecat.processors.aggregators")
    _mod("pipecat.processors.aggregators.llm_context")
    _mod("pipecat.processors.aggregators.llm_response_universal")
    _mod("pipecat.serializers")

    # Tyhle dvě mají hodnoty, ne jen jména — atrapa je musí umět nabídnout.
    proc = _mod("pipecat.processors.frame_processor")
    proc.FrameDirection = type("FrameDirection", (), {"DOWNSTREAM": 1, "UPSTREAM": 2})
    ser = _mod("pipecat.serializers.base_serializer")
    ser.FrameSerializerType = type("FrameSerializerType", (), {"BINARY": "binary"})
    _mod("pipecat.audio.utils").create_stream_resampler = lambda *a, **k: None


def _install_websockets_stub():
    _mod("websockets")
    _mod("websockets.asyncio")
    _mod("websockets.asyncio.server").serve = lambda *a, **k: None


_stub_missing_libs()

from app import budget as budget_mod  # noqa: E402
from app import client_registry as reg  # noqa: E402
from app.websocket_handler import WebSocketHandler, SingleClientOutputTransport  # noqa: E402


# ── falešné okolí ────────────────────────────────────────────────────────
class FakeWS:
    """Websocket satelitu: pamatuje si, co se poslalo a jestli ho někdo zavřel."""

    def __init__(self, ip):
        self.remote_address = (ip, 50000)
        self.sent = []
        self.closed = None
        self._closed = asyncio.Event()

    async def send(self, payload):
        self.sent.append(json.loads(payload))

    async def close(self, code=1000, reason=""):
        if self.closed is None:
            self.closed = (code, reason)
        self._closed.set()

    async def wait_closed(self):
        await self._closed.wait()

    def types(self):
        return [m.get("type") for m in self.sent]

    def phases(self):
        return [m.get("value") for m in self.sent if m.get("type") == "phase"]


class FakeTransport:
    def __init__(self):
        self.attached = None
        self._fin = asyncio.Event()

    def attach(self, websocket):
        self.attached = websocket

    async def wait_finished(self):
        await self._fin.wait()

    def finish(self):
        self._fin.set()


class FakeTask:
    def __init__(self):
        self.cancelled = False

    async def cancel(self):
        self.cancelled = True


class FakeSessionManager:
    def __init__(self):
        self.cached = []

    def handle_client_disconnect(self, client_id, service=None):
        self.cached.append(client_id)


async def _build_fake_session(slot):
    slot.transport = FakeTransport()
    slot.serializer = object()
    slot.service = object()
    slot.task = FakeTask()
    slot.runner_task = None


async def _until(predicate, tries=200):
    """Počkat na podmínku bez pevného sleepu (rychlé a nezávislé na stroji)."""
    for _ in range(tries):
        if predicate():
            return True
        await asyncio.sleep(0)
    return False


def _handler(max_clients=2, budget=None, session_manager=None):
    h = WebSocketHandler(
        host="127.0.0.1", port=8080,
        session_manager=session_manager,
        max_clients=max_clients,
        budget=budget,
    )
    # V provozu to nastaví `serve_forever`; tady stavíme falešnou relaci,
    # protože se testuje brána, ne pipecat.
    h._build_client_session = _build_fake_session
    return h


async def _connect(handler, ws):
    """Spustit obsluhu spojení na pozadí a počkat, až se satelit usadí."""
    task = asyncio.create_task(handler._front_door(ws))
    await _until(lambda: handler.clients.get(handler.extract_client_id(ws)) is not None
                 or task.done())
    await _until(lambda: task.done()
                 or (handler.clients.get(handler.extract_client_id(ws)) is not None
                     and handler.clients.get(handler.extract_client_id(ws)).transport is not None
                     and handler.clients.get(handler.extract_client_id(ws)).transport.attached is ws))
    return task


# ── A. registr satelitů ──────────────────────────────────────────────────
def test_registr_strop_odmitne_tretiho():
    """Třetí satelit se ODMÍTNE — a první dva zůstanou beze změny."""
    r = reg.ClientRegistry(max_clients=2)
    v1, s1, _ = r.reserve("192.168.0.115")
    v2, s2, _ = r.reserve("192.168.0.12")
    v3, s3, old3 = r.reserve("192.168.0.99")
    assert (v1, v2) == (reg.ACCEPTED, reg.ACCEPTED), (v1, v2)
    assert v3 == reg.REJECTED_FULL and s3 is None and old3 is None
    assert r.count == 2
    assert r.get("192.168.0.115") is s1
    assert r.get("192.168.0.12") is s2


def test_registr_reconnect_tehoz_zarizeni_neprojida_strop():
    """Reconnect téhož satelitu nahradí JEHO slot, nesebere místo druhému."""
    r = reg.ClientRegistry(max_clients=2)
    _, first, _ = r.reserve("192.168.0.115")
    _, other, _ = r.reserve("192.168.0.12")
    verdict, fresh, old = r.reserve("192.168.0.115")
    assert verdict == reg.REPLACED
    assert old is first and fresh is not first
    assert r.count == 2
    assert r.get("192.168.0.12") is other


def test_registr_release_nesmi_uvolnit_cizi_slot():
    """Pozdní úklid starého spojení nesmí smazat jeho čerstvý reconnect."""
    r = reg.ClientRegistry(max_clients=2)
    _, first, _ = r.reserve("192.168.0.115")
    _, fresh, old = r.reserve("192.168.0.115")
    assert r.release(first) is False        # starý slot už neplatí
    assert r.get("192.168.0.115") is fresh  # nový přežil
    assert r.release(fresh) is True
    assert r.count == 0


# ── B. sdílený rozpočet ──────────────────────────────────────────────────
def test_rozpocet_scita_oba_satelity_do_jednoho_okna():
    """Peněženka je jedna: 15k + 15k = 30k, ne dvakrát 15k."""
    b = budget_mod.SharedBudget(tpm_limit=40000)
    b.note_usage("192.168.0.115", 15000)
    snap = b.note_usage("192.168.0.12", 15000)
    assert snap["window_tokens"] == 30000, snap
    assert snap["remaining"] == 10000, snap


def test_rozpocet_minutove_okno_se_preklopi():
    """Po minutě se okno vynuluje (hodiny jdou parametrem)."""
    ticks = {"t": 0.0}
    b = budget_mod.SharedBudget(tpm_limit=40000, monotonic=lambda: ticks["t"])
    b.note_usage("a", 30000)
    ticks["t"] = 61.0
    snap = b.note_usage("b", 1000)
    assert snap["window_tokens"] == 1000, snap
    assert snap["remaining"] == 39000, snap


def test_rozpocet_denni_strop_meky_varuje_ale_pusti():
    """Bez tvrdého režimu se strop jen hlásí — dům nesmí oněmět kvůli účtu."""
    b = budget_mod.SharedBudget(tpm_limit=40000, daily_limit=1000)
    b.note_usage("a", 900)
    b.note_usage("b", 900)
    assert b.is_day_exhausted() is True
    allowed, reason = b.allow_new_client()
    assert allowed is True and reason == ""


def test_rozpocet_denni_strop_tvrdy_odmitne_dalsiho():
    """V tvrdém režimu se po vyčerpání stropu NOVÝ satelit nepřipojí."""
    b = budget_mod.SharedBudget(tpm_limit=40000, daily_limit=1000, hard_stop=True)
    assert b.allow_new_client()[0] is True
    b.note_usage("a", 1200)
    allowed, reason = b.allow_new_client()
    assert allowed is False and "1200/1000" in reason, reason


def test_rozpocet_novy_den_nuluje():
    """Přes půlnoc se denní počítadlo vynuluje."""
    den = {"t": 1756500000.0}   # nějaký pevný okamžik
    b = budget_mod.SharedBudget(tpm_limit=0, daily_limit=1000, wallclock=lambda: den["t"])
    b.note_usage("a", 900)
    den["t"] += 26 * 3600
    snap = b.note_usage("a", 10)
    assert snap["day_tokens"] == 10, snap


# ── C. vstupní brána mostu ───────────────────────────────────────────────
def test_dva_satelity_soubezne_a_nikdo_se_neodkopava():
    async def scenar():
        h = _handler(max_clients=2)
        pe = FakeWS("192.168.0.115")     # Voice PE
        rs = FakeWS("192.168.0.12")      # reSpeaker
        t1 = await _connect(h, pe)
        t2 = await _connect(h, rs)
        assert h.clients.count == 2, h.clients.ids()
        # Ani jeden socket nikdo nezavřel — to je celé jádro karty.
        assert pe.closed is None and rs.closed is None
        # Oba dostali handshake a oba mají svoje spojení v pipeline.
        assert pe.types() == ["hello"] and rs.types() == ["hello"]
        assert h.clients.get("192.168.0.115").transport.attached is pe
        assert h.clients.get("192.168.0.12").transport.attached is rs
        for ws, task in ((pe, t1), (rs, t2)):
            await ws.close()
            await task
    asyncio.run(scenar())


def test_treti_satelit_dostane_busy_a_prvni_dva_bezi_dal():
    async def scenar():
        h = _handler(max_clients=2)
        pe, rs = FakeWS("192.168.0.115"), FakeWS("192.168.0.12")
        t1 = await _connect(h, pe)
        t2 = await _connect(h, rs)
        treti = FakeWS("192.168.0.99")
        await h._front_door(treti)       # doběhne rovnou, nečeká se
        assert treti.types() == ["busy"], treti.sent
        assert treti.sent[0]["reason"] == "max_clients"
        assert treti.closed[0] == 1013, treti.closed
        # Stávající satelity: pořád na mostě, pořád otevřené.
        assert h.clients.count == 2 and sorted(h.clients.ids()) == [
            "192.168.0.115", "192.168.0.12"
        ]
        assert pe.closed is None and rs.closed is None
        for ws, task in ((pe, t1), (rs, t2)):
            await ws.close()
            await task
    asyncio.run(scenar())


def test_faze_miri_jen_na_zdrojovy_satelit():
    async def scenar():
        h = _handler(max_clients=2)
        pe, rs = FakeWS("192.168.0.115"), FakeWS("192.168.0.12")
        t1 = await _connect(h, pe)
        t2 = await _connect(h, rs)
        # Povel padl u televize → fáze jde jen tam.
        send = h.phase_sender("192.168.0.12")
        for faze in ("listening", "thinking", "replying", "idle"):
            await send(faze)
        assert rs.phases() == ["listening", "thinking", "replying", "idle"]
        assert pe.phases() == []          # satelit v domě zůstal v klidu
        for ws, task in ((pe, t1), (rs, t2)):
            await ws.close()
            await task
    asyncio.run(scenar())


def test_odpojeni_jednoho_nechá_druheho_bezet():
    async def scenar():
        sm = FakeSessionManager()
        h = _handler(max_clients=2, session_manager=sm)
        pe, rs = FakeWS("192.168.0.115"), FakeWS("192.168.0.12")
        t1 = await _connect(h, pe)
        t2 = await _connect(h, rs)
        slot_rs = h.clients.get("192.168.0.12")
        # Voice PE zmizí ze sítě.
        await pe.close()
        await t1
        assert h.clients.count == 1 and h.clients.ids() == ["192.168.0.12"]
        assert sm.cached == ["192.168.0.115"]        # jeho kontext se uschoval
        assert slot_rs.task.cancelled is False       # druhá pipeline běží dál
        assert rs.closed is None
        # A pořád mu chodí fáze.
        await h.send_phase_to("192.168.0.12", "listening")
        assert rs.phases() == ["listening"]
        await rs.close()
        await t2
    asyncio.run(scenar())


def test_faze_pro_odpojeny_satelit_nespadne():
    async def scenar():
        h = _handler(max_clients=2)
        await h.send_phase_to("192.168.0.115", "idle")   # nikdo připojený
        assert h.clients.count == 0
    asyncio.run(scenar())


def test_reconnect_tehoz_zarizeni_neodkopne_druheho():
    async def scenar():
        h = _handler(max_clients=2)
        pe_stary, rs = FakeWS("192.168.0.115"), FakeWS("192.168.0.12")
        t1 = await _connect(h, pe_stary)
        t2 = await _connect(h, rs)
        pe_novy = FakeWS("192.168.0.115")
        t3 = await _connect(h, pe_novy)
        await t1                                   # staré spojení se uklidilo
        assert pe_stary.closed is not None         # zavřelo se JEHO staré
        assert rs.closed is None                   # druhý satelit nedotčen
        assert h.clients.count == 2
        assert h.clients.get("192.168.0.115").transport.attached is pe_novy
        for ws, task in ((pe_novy, t3), (rs, t2)):
            await ws.close()
            await task
    asyncio.run(scenar())


def test_vystup_nezavira_cizi_spojeni():
    """`set_client_connection` v režimu 1:1 nikoho nezavírá ani nevaruje.

    Pipecatí originál by tady zavřel dosavadní socket a zalogoval
    `Only one client allowed, using new connection` — a to i při ÚPLNĚ běžném
    odpojení (`set_client_connection(None)`).
    """
    async def scenar():
        out = SingleClientOutputTransport.__new__(SingleClientOutputTransport)
        ws = FakeWS("192.168.0.115")
        await SingleClientOutputTransport.set_client_connection(out, ws)
        assert out._websocket is ws
        await SingleClientOutputTransport.set_client_connection(out, None)
        assert out._websocket is None
        assert ws.closed is None
    asyncio.run(scenar())


def test_rozpocet_v_tvrdem_rezimu_nepusti_satelit_na_most():
    async def scenar():
        b = budget_mod.SharedBudget(tpm_limit=40000, daily_limit=100, hard_stop=True)
        b.note_usage("a", 500)
        h = _handler(max_clients=2, budget=b)
        ws = FakeWS("192.168.0.115")
        await h._front_door(ws)
        assert ws.types() == ["busy"] and ws.sent[0]["reason"] == "budget"
        assert h.clients.count == 0
    asyncio.run(scenar())


def _run_all():
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for fn in tests:
        fn()
        print(f"OK   {fn.__name__}")
    print(f"Hotovo: {len(tests)} testů prošlo.")


if __name__ == "__main__":
    _run_all()
