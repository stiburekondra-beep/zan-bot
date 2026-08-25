"""Most z OpenAI Realtime na Žánův mozek (`/voice`) — architektura DVA MOZKY.

DNEŠEK (do 25. 8. 2026) — jeden blokující tah:
    Pusa (realtime lite model) zavolala `ask_zan`, handler poslal HTTP POST
    na Žán-Code a **čekal** na kompletní odpověď (natvrdo 45 s). Celou tu
    dobu pusa nemohla nic říct: function call drží turn, dokud nedorazí
    `result_callback`. Když mozek přemýšlel dvacet vteřin, uživatel dvacet
    vteřin poslouchal ticho.

OD TÉHLE VĚTVE — dva mozky, průběžné podsouvání
(rozhodnutí `projects/baklazan/rozhodnuti.md`, 2026-08-25 „DVA MOZKY",
karta `2026-08-25-programator-zana-13`):

    1. `ask_zan` se vrací **hned** se stavem `delegated` a `run_llm=False`.
       Pusa už před voláním řekla „jdu na to, dám vědět" (má to v ROUTING
       promptu v main.py), takže je slyšet lidská reakce a hovor běží dál.
    2. Dotaz na mozek jede na pozadí jako `asyncio.Task`.
    3. Každý výstup mozku se **vstříkne do BĚŽÍCÍ realtime session**:
       `conversation.item.create` (role `system`) + `response.create`, tedy
       přesně to, co pipecat 0.0.97 dělá interně při setupu konverzace
       (`OpenAIRealtimeLLMService._create_response`). Ověřeno čtením
       knihovny v kontejneru, ne z dokumentace:
         - `pipecat/services/openai/realtime/events.py`
           → `ConversationItemCreateEvent`, `ConversationItem`,
             `ItemContent`, `ResponseCreateEvent`
         - `.../llm.py` → `send_client_event()` (veřejná),
           `_create_response()`, `_messages_added_manually`
    4. Podsunutí smí být **N za jeden dotaz** — mechanismus je připravený
       (`chunks: [...]` v jedné odpovědi i NDJSON stream řádek po řádku).
       Žán-Code dnes vrací jednu odpověď; ten kus je na jeho straně.

MECHANISMUS PODSOUVÁNÍ (`deliver_text`) je záměrně veřejný: až Žán-Code
umí posílat průběžné nálezy (webhook / SSE / NDJSON), stačí zavolat
`bridge.deliver_text(...)` — nic dalšího se měnit nemusí.

POJISTKY (poučení `2026-08-23_pojistka-se-pri-pivotu-nepresouva-sama.md`
— brzdy jsou vlastnost konkrétní cesty kódu, tahle cesta je nová, takže
si je musí nést sama):

  * **Relace mezitím skončila** — před vstříknutím se kontroluje živé
    spojení (`_websocket` / `_disconnecting`). Když je po ptákách, výsledek
    se **zaloguje a tiše zahodí**; nikdy se nevstřikuje do mrtvé session.
  * **STOP** („zmlkni", tlačítko na Voice PE) — `cancel_all()` zruší
    všechny běžící dotazy, takže po stopce už nic nepromluví. Volá se
    z `websocket_handler._on_device_interrupt`.
  * **Souběžné dotazy** — víc dotazů najednou je povolené (každý má svoje
    pořadové číslo v logu), ale strop je `ZAN_ASK_MAX_PENDING`; při
    překročení padá nejstarší, aby se nedalo nasypat neomezeně úloh.
  * **Model si nesmí vymýšlet** — tool result říká výslovně, že
    `delegated` NENÍ odpověď (a `run_llm=False`, takže na něj model ani
    nemluví). Text odpovědi dostane až jako podsunutou systémovou zprávu.
  * **Nouzový vypínač** — `ZAN_ASK_ASYNC=false` vrátí staré blokující
    chování beze změny kódu (a bez `params.llm` se na něj přepne samo).

ENV:
  ZAN_ASK_TIMEOUT         (s, default 300)  — kolik času má mozek celkem
  ZAN_ASK_ASYNC           (bool, default true) — false = staré blokující chování
  ZAN_ASK_PROGRESS_AFTER  (s, default 25; 0 = vypnuto) — po téhle době
                          řekne pusa „ještě na tom dělám"
  ZAN_ASK_PROGRESS_EVERY  (s, default 45)   — a pak znovu po téhle době
  ZAN_ASK_PROGRESS_MAX    (default 3)       — nejvýš tolikrát
  ZAN_ASK_MAX_PENDING     (default 3)       — strop souběžných dotazů
  ZAN_ASK_QUIET_WAIT      (s, default 15)   — jak dlouho čekat, až pusa
                          domluví, než se podsune (aby se nekřížily odpovědi)
  ZAN_ASK_KEEP_THINKING   (bool, default true) — držet „thinking" LED,
                          dokud mozek počítá
"""
import asyncio
import json
import logging
import os
import time
import urllib.error
import urllib.request
from typing import Any, Awaitable, Callable, Dict, List, Optional, Tuple, TYPE_CHECKING

from pipecat.frames.frames import FunctionCallResultProperties
from pipecat.services.openai.realtime import events as rt_events

if TYPE_CHECKING:
    from pipecat.services.llm_service import FunctionCallParams

logger = logging.getLogger(__name__)

# Ukazatel „model ještě něco dělá" pro thinking-watchdog v PhaseEmitteru.
# Import je měkký: kdyby se modul přejmenoval, most tím nesmí spadnout.
try:  # pragma: no cover - obranný import
    from app.phase_emitter import TURN_LIVENESS
except Exception:  # pragma: no cover
    TURN_LIVENESS = None  # type: ignore[assignment]


# ---------------------------------------------------------------------------
# konfigurace
# ---------------------------------------------------------------------------

def _env_float(name: str, default: float) -> float:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        return float(raw)
    except ValueError:
        logger.warning("⚠️ %s=%r není číslo — beru default %s", name, raw, default)
        return default


def _env_int(name: str, default: int) -> int:
    return int(_env_float(name, float(default)))


def _env_bool(name: str, default: bool) -> bool:
    raw = os.environ.get(name, "").strip().lower()
    if not raw:
        return default
    return raw in ("1", "true", "yes", "on", "ano")


def get_ask_zan_tool_definition() -> Dict[str, Any]:
    return {
        "type": "function", "name": "ask_zan",
        "description": (
            "Send the exact request to Žán, the only brain with memory, permissions "
            "and Home Assistant tools. Returns IMMEDIATELY with status 'delegated' — "
            "that is NOT the answer. The answer arrives later on its own as a system "
            "message; do not invent one meanwhile. Call exactly once for every turn."
        ),
        "parameters": {"type": "object", "properties": {"text": {"type": "string", "description": "Exact user utterance."}}, "required": ["text"]},
    }


# ---------------------------------------------------------------------------
# HTTP na Žán-Code — jedna odpověď i NDJSON stream
# ---------------------------------------------------------------------------

def _post_stream(url: str, token: str, payload: dict, timeout: float):
    """Blokující generátor: vydá KAŽDÝ JSON objekt, co Žán-Code pošle.

    Dvě podoby odpovědi, obě podporované jedním čtením:

      * **dnešek** — jedno tělo, jeden JSON objekt (klidně pretty-printed).
        Vydá se jedna položka, až dorazí celé tělo. Chování 1:1 jako dřív.
      * **budoucnost** — NDJSON: každý řádek jeden JSON objekt, a každý se
        vydá HNED, jak dorazí. Tím vzniká průběžné podsouvání bez čekání
        na konec požadavku.

    Rozlišení je bezpečné: pretty-printed tělo začíná řádkem `{`, který se
    jako celý JSON objekt přečíst nedá → jde se cestou „celé tělo".
    Jednořádkový JSON i NDJSON začínají řádkem, který se přečíst dá.
    """
    request = urllib.request.Request(
        url, data=json.dumps(payload).encode("utf-8"),
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        streaming = False
        first_line = True
        buffered: List[str] = []
        for raw in response:
            line = raw.decode("utf-8", "replace")
            stripped = line.strip()
            if streaming:
                if not stripped:
                    continue
                try:
                    obj = json.loads(stripped)
                except ValueError:
                    logger.warning("⚠️ Žán-Code poslal nečitelný řádek, přeskakuji: %.120s", stripped)
                    continue
                if isinstance(obj, dict):
                    yield obj
                continue
            if first_line:
                first_line = False
                if stripped:
                    try:
                        obj = json.loads(stripped)
                    except ValueError:
                        obj = None
                    if isinstance(obj, dict):
                        streaming = True
                        yield obj
                        continue
            buffered.append(line)
        if not streaming:
            body = "".join(buffered).strip()
            if not body:
                return
            obj = json.loads(body)  # ValueError probublá výš = chyba jako dřív
            if isinstance(obj, dict):
                yield obj


def _post_json(url: str, token: str, payload: dict, timeout: float) -> dict:
    """Jedno volání, jedna odpověď — pro nouzové blokující chování."""
    request = urllib.request.Request(
        url, data=json.dumps(payload).encode("utf-8"),
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def _texts_from(payload: dict) -> List[str]:
    """Z jedné odpovědi mozku vytáhne N textů k vyslovení.

    `chunks`/`parts` je připravená cesta pro víc dílčích nálezů v jedné
    odpovědi; dnes Žán-Code posílá jen `reply`.
    """
    for key in ("chunks", "parts"):
        value = payload.get(key)
        if isinstance(value, list):
            texts = [str(item).strip() for item in value if str(item).strip()]
            if texts:
                return texts
    reply = str(payload.get("reply", "")).strip()
    return [reply] if reply else []


# ---------------------------------------------------------------------------
# vstřikování do běžící realtime session
# ---------------------------------------------------------------------------

def session_alive(service: Any) -> bool:
    """Je realtime session pořád živá? (Ne „byla, když jsme začínali.")

    Poučení `2026-08-23_health-na-portu-neni-funkcni-sluzba.md`: ptát se na
    STAV spojení, ne čekat na událost. pipecat drží websocket v
    `_websocket` a při odpojování zvedá `_disconnecting`; `_ws_send` se
    přesně podle nich rozhoduje, jestli vůbec pošle bajty.
    """
    if service is None:
        return False
    if getattr(service, "_disconnecting", False):
        return False
    return getattr(service, "_websocket", None) is not None


async def _wait_until_quiet(service: Any, limit_s: float) -> bool:
    """Počká, až pusa domluví, aby se podsunutí nekřížilo s její řečí.

    `_current_assistant_response` nastavuje pipecat na `conversation.item.added`
    (role assistant) a maže na `response.done` — je to tentýž signál, podle
    kterého se `websocket_handler` rozhoduje, jestli posílat `response.cancel`.
    Když se do limitu nedomluví, vstříkne se stejně: kolizi
    (`conversation_already_has_active_response`) má SafeRealtimeLLMService
    v BENIGN_ERROR_CODES, takže session nespadne — jen se odpověď nevysloví
    a zůstane v kontextu.
    """
    deadline = time.monotonic() + max(0.0, limit_s)
    while time.monotonic() < deadline:
        if not session_alive(service):
            return False
        if getattr(service, "_current_assistant_response", None) is None:
            return True
        await asyncio.sleep(0.2)
    logger.info("⏳ pusa pořád mluví po %.0f s — vstřikuju i tak", limit_s)
    return True


async def inject_into_session(service: Any, text: str, *, run_llm: bool = True) -> bool:
    """Vloží zprávu do BĚŽÍCÍ session a (volitelně) nechá model odpovědět.

    Vrací True, když se to poslalo; False, když už není kam.
    """
    if not session_alive(service):
        return False
    item = rt_events.ConversationItem(
        type="message",
        role="system",
        # role system/user → `input_text` (u assistant by to bylo `text`)
        content=[rt_events.ItemContent(type="input_text", text=text)],
    )
    event = rt_events.ConversationItemCreateEvent(item=item)
    # Stejná evidence, jakou si vede pipecat u položek, které pošle sám:
    # server je pošle zpátky jako `conversation.item.added` a tahle značka
    # zabrání tomu, aby se braly jako novinka od serveru.
    manual = getattr(service, "_messages_added_manually", None)
    if isinstance(manual, dict):
        manual[event.item.id] = True
    await service.send_client_event(event)
    if not run_llm:
        return True
    create_response = getattr(service, "_create_response", None)
    if callable(create_response):
        # Preferovaná cesta: kromě `response.create` řeší i metriky a případ
        # „session ještě není ready" (odloží se na `session.updated`).
        await create_response()
    else:  # pragma: no cover - jiná verze pipecatu
        await service.send_client_event(rt_events.ResponseCreateEvent())
    return True


# ---------------------------------------------------------------------------
# most
# ---------------------------------------------------------------------------

# Co uvidí model jako výsledek nástroje. Musí být neprůstřelně jasné, že
# tohle NENÍ odpověď — jinak si lite model odpověď domyslí (poučení
# „nikdy netvrď výsledek bez ověřeného stavu").
ACK_NOTE = (
    "Dotaz jsem předal Žán-Code. Tohle NENÍ odpověď — odpověď dorazí sama "
    "za chvíli jako systémová zpráva a teprve tu řekneš uživateli. Do té "
    "doby za mozek neodpovídej a nic si nevymýšlej."
)

# LIDSKÉ HLÁŠKY PŘI ČEKÁNÍ (Ondra, 25. 8.: „ať to zní lidsky, ne robot").
#
# KTERÁ VRSTVA MLUVÍ (poučení 2026-08-23_dva-zdroje-reci-a-protichudne-instrukce):
#   1) souběh s voláním nástroje  → řídí ROUTING prompt v main.py
#      („Moment, zamyslím se…" — varianty tam, ne tady)
#   2) po výsledku tool callu     → run_llm=False, model MLČÍ (žádný dvojhlas)
#   3) tenhle soubor              → text VSTŘÍKNUTÝ do běžící session; model
#      ho vysloví, takže jsou varianty tady
#   4) rychlá dráha               → knihovna přednahraných frází, nesaháme
#
# Střídání je tady v kódu (deterministicky podle kola), ne na modelu —
# jedna a tatáž věta třikrát za sebou zní jako porucha.
#
# ŽÁDNÉ ČÍSLICE v textu, který model vysloví (poučení
# 2026-08-05_ceske-tts-necist-cislice) — uplynulý čas jde do logu, ne do řeči.
PROGRESS_HINTS = (
    "Ještě na tom dělám, vydrž.",
    "Pořád nad tím přemýšlím.",
    "Chvilku to ještě potrvá, rozmýšlím to.",
    "Vteřinku, ještě to skládám dohromady.",
)


class ZanBridge:
    """Asynchronní most na Žán-Code s podsouváním do běžící session."""

    def __init__(
        self,
        url: str,
        token: str,
        chat_id: Optional[int],
        broadcast_json: Callable[[dict], Awaitable[None]],
        timeout: Optional[float] = None,
    ) -> None:
        self.url = url
        self.token = token
        self.chat_id = chat_id
        self.broadcast_json = broadcast_json
        self.timeout = timeout if timeout is not None else _env_float("ZAN_ASK_TIMEOUT", 300.0)
        self.async_enabled = _env_bool("ZAN_ASK_ASYNC", True)
        self.progress_after = _env_float("ZAN_ASK_PROGRESS_AFTER", 25.0)
        self.progress_every = _env_float("ZAN_ASK_PROGRESS_EVERY", 45.0)
        self.progress_max = _env_int("ZAN_ASK_PROGRESS_MAX", 3)
        self.max_pending = max(1, _env_int("ZAN_ASK_MAX_PENDING", 3))
        self.quiet_wait = _env_float("ZAN_ASK_QUIET_WAIT", 15.0)
        self.keep_thinking = _env_bool("ZAN_ASK_KEEP_THINKING", True)
        self._pending: Dict[int, asyncio.Task] = {}
        self._seq = 0
        logger.info(
            "🧠 ask_zan most: async=%s timeout=%.0fs progress=%.0f/%.0fs×%d "
            "max_pending=%d quiet_wait=%.0fs keep_thinking=%s",
            self.async_enabled, self.timeout, self.progress_after,
            self.progress_every, self.progress_max, self.max_pending,
            self.quiet_wait, self.keep_thinking,
        )

    # -- veřejné API ------------------------------------------------------

    @property
    def pending(self) -> int:
        return sum(1 for task in self._pending.values() if not task.done())

    def cancel_all(self, reason: str = "STOP") -> int:
        """Zruší všechny běžící dotazy — po stopce už nesmí nic promluvit.

        HTTP požadavek, co běží ve vlákně, se zrušit nedá (urllib to neumí),
        ale jeho výsledek se zahodí a nikam se nevstříkne. To je to, na čem
        záleží: uživatel řekl „zmlkni".
        """
        killed = 0
        for ask_id, task in list(self._pending.items()):
            if not task.done():
                task.cancel()
                killed += 1
            self._pending.pop(ask_id, None)
        if killed:
            logger.info("🛑 %s → zrušeno %d běžících dotazů na Žán-Code", reason, killed)
        return killed

    async def deliver_text(
        self, service: Any, text: str, *, run_llm: bool = True, label: str = "podsunutí"
    ) -> bool:
        """Podsune JEDEN text do běžící session. Použitelné i zvenčí.

        Tohle je ten „mechanismus na N zpráv": zavolej kolikrát chceš,
        pořadí drží volající. Až Žán-Code umí průběžné nálezy posílat sám
        (webhook/SSE), napojí se přesně sem.
        """
        if not session_alive(service):
            logger.info("🗑️ %s zahozeno — realtime session už neběží: %.200s", label, text)
            return False
        if not await _wait_until_quiet(service, self.quiet_wait):
            logger.info("🗑️ %s zahozeno — session skončila během čekání: %.200s", label, text)
            return False
        try:
            sent = await inject_into_session(service, text, run_llm=run_llm)
        except Exception as exc:  # pragma: no cover - obrana, ať nespadne task
            logger.error("❌ %s se nepodařilo vstříknout: %r", label, exc)
            return False
        if sent:
            logger.info("💉 %s vstříknuto do běžící session (run_llm=%s)", label, run_llm)
        else:
            logger.info("🗑️ %s zahozeno — session už neběží", label)
        return sent

    # -- tool handler -----------------------------------------------------

    async def handler(self, params: "FunctionCallParams") -> None:
        text = str((params.arguments or {}).get("text", "")).strip()
        if not text:
            await params.result_callback("Neslyšel jsem zadání.")
            return

        service = getattr(params, "llm", None)
        if not self.async_enabled or not session_alive(service):
            # Nouzová/stará cesta. Bez živé session není kam vstřikovat, tak
            # ať se aspoň odpoví postaru, než aby se mlčelo.
            if self.async_enabled:
                logger.warning("⚠️ ask_zan: není živá realtime session → blokující režim")
            await self._blocking(params, text)
            return

        self._seq += 1
        ask_id = self._seq
        while self.pending >= self.max_pending:
            oldest = min(self._pending)
            logger.warning(
                "⚠️ ask_zan: strop %d souběžných dotazů → ruším nejstarší #%d",
                self.max_pending, oldest,
            )
            task = self._pending.pop(oldest, None)
            if task is not None and not task.done():
                task.cancel()
            if not self._pending:
                break

        if self.keep_thinking and TURN_LIVENESS is not None:
            # Držíme „model ještě něco dělá" i po návratu nástroje, jinak
            # PhaseEmitter zhasne thinking a zařízení bude vypadat hotové,
            # zatímco mozek pořád počítá.
            TURN_LIVENESS.tool_started()

        task = asyncio.create_task(self._run(ask_id, text, service), name=f"ask_zan-{ask_id}")
        self._pending[ask_id] = task
        task.add_done_callback(lambda _t, i=ask_id: self._pending.pop(i, None))
        logger.info("🧠 ask_zan #%d delegováno na pozadí (běží %d): %.120s", ask_id, self.pending, text)

        await params.result_callback(
            {"status": "delegated", "note": ACK_NOTE},
            # run_llm=False: pusa už řekla „jdu na to" PŘED voláním (má to
            # v ROUTING promptu). Kdyby model mluvil i na tenhle výsledek,
            # zaznělo by to dvakrát — a hrozilo by, že si odpověď domyslí.
            properties=FunctionCallResultProperties(run_llm=False),
        )

    # -- vnitřek ----------------------------------------------------------

    async def _blocking(self, params: "FunctionCallParams", text: str) -> None:
        """Původní chování: počkej na celou odpověď a vrať ji jako výsledek."""
        payload: Dict[str, Any] = {"text": text}
        if self.chat_id is not None:
            payload["chat_id"] = self.chat_id
        try:
            result = await asyncio.to_thread(_post_json, self.url, self.token, payload, self.timeout)
        except (urllib.error.URLError, TimeoutError, OSError, ValueError) as exc:
            logger.error("Žán bridge failed: %r", exc)
            await params.result_callback("Teď se nedostanu ke svému mozku. Zkus to prosím znovu.")
            return
        reply = str(result.get("reply", "")).strip() or "Hotovo."
        if result.get("local_confirmation") == "success":
            await self.broadcast_json({"type": "local_confirmation", "value": "success", "text": reply})
            await params.result_callback(
                {"status": "verified_success", "reply_played_locally": reply},
                properties=FunctionCallResultProperties(run_llm=False),
            )
            return
        await params.result_callback(reply)

    async def _run(self, ask_id: int, text: str, service: Any) -> None:
        started = time.monotonic()
        progress = asyncio.create_task(self._progress(ask_id, service, started))
        delivered = 0
        try:
            try:
                delivered = await asyncio.wait_for(
                    self._consume(ask_id, text, service), timeout=self.timeout
                )
            except asyncio.TimeoutError:
                progress.cancel()
                logger.error("⏱️ ask_zan #%d: mozek se neozval do %.0f s", ask_id, self.timeout)
                await self.deliver_text(
                    service,
                    # bez číslic — model tenhle text vysloví (české TTS/číslovky)
                    "ŽÁN-CODE SE NEOZVAL v čase. Řekni uživateli krátce a lidsky, "
                    "že se ti to teď nepovedlo domyslet a ať to zkusí znovu — "
                    "třeba „Promiň, tohle jsem teď nedal dohromady, zkus to prosím "
                    "znovu.\" Žádná čísla. Nic si nevymýšlej.",
                    label=f"ask #{ask_id} timeout",
                )
                return
            except (urllib.error.URLError, TimeoutError, OSError, ValueError) as exc:
                progress.cancel()
                logger.error("❌ ask_zan #%d: most na mozek selhal: %r", ask_id, exc)
                await self.deliver_text(
                    service,
                    "ŽÁN-CODE JE TEĎ NEDOSTUPNÝ. Řekni uživateli krátce a lidsky, "
                    "že se teď nedostaneš ke svému mozku a ať to zkusí za chvilku "
                    "znovu. Nic si nevymýšlej.",
                    label=f"ask #{ask_id} chyba",
                )
                return
            if delivered == 0:
                logger.warning("⚠️ ask_zan #%d: mozek nevrátil žádný text", ask_id)
        except asyncio.CancelledError:
            logger.info("🛑 ask_zan #%d zrušeno (STOP / nový dotaz) — výsledek zahodím", ask_id)
            raise
        finally:
            progress.cancel()
            if self.keep_thinking and TURN_LIVENESS is not None:
                TURN_LIVENESS.tool_finished()
            logger.info(
                "🧠 ask_zan #%d hotovo za %.1f s, podsunuto %d zpráv",
                ask_id, time.monotonic() - started, delivered,
            )

    async def _consume(self, ask_id: int, text: str, service: Any) -> int:
        """Čte odpovědi mozku a podsouvá je jednu po druhé.

        Poslední se označí jako finální (pusa smí uzavřít), předchozí jako
        dílčí nález (pusa nesmí uzavřít, ještě něco přijde).
        """
        delivered = 0
        previous: Optional[Tuple[str, bool]] = None
        async for payload in self._stream(text):
            for item in self._items(payload):
                if previous is not None:
                    delivered += 1
                    await self._deliver(ask_id, service, previous, delivered, final=False)
                previous = item
        if previous is not None:
            delivered += 1
            await self._deliver(ask_id, service, previous, delivered, final=True)
        return delivered

    def _items(self, payload: dict) -> List[Tuple[str, bool]]:
        """Z jedné odpovědi mozku udělá seznam (text, ať to model vysloví?).

        `local_confirmation: success` znamená, že potvrzení už zaznělo
        lokálně z knihovny frází — text se do kontextu vloží kvůli
        kontinuitě, ale model ho NESMÍ vyslovit znovu.
        """
        speak = payload.get("local_confirmation") != "success"
        return [(chunk, speak) for chunk in _texts_from(payload)]

    async def _deliver(
        self, ask_id: int, service: Any, item: Tuple[str, bool], index: int, *, final: bool
    ) -> None:
        text, speak = item
        if not speak:
            await self.broadcast_json({"type": "local_confirmation", "value": "success", "text": text})
            await self.deliver_text(
                service,
                f"ŽÁN-CODE POTVRDIL: „{text}\" — potvrzení už zaznělo z knihovny frází, "
                f"NEOPAKUJ ho a čekej na další povel.",
                run_llm=False,
                label=f"ask #{ask_id} potvrzení",
            )
            return
        if final:
            head = (
                "ŽÁN-CODE ODPOVĚDĚL na dotaz, který jsi mu předal. Řekni to uživateli "
                "česky, krátce a beze změny významu — nic nepřidávej a nic si nedomýšlej"
            )
        else:
            # BEZ pořadového čísla v textu, který model vysloví — index je
            # v labelu/logu. („dílčí nález číslo dvě" = robot + číslovky.)
            head = (
                "ŽÁN-CODE POSÍLÁ DÍLČÍ NÁLEZ — další ještě může přijít. Řekni ho "
                "uživateli krátce, lidsky (klidně uveď „zatím to vypadá tak, že…\" "
                "nebo „prozatím jsem zjistil…\") a hovor NEUZAVÍREJ. Žádná čísla"
            )
        await self.deliver_text(
            service, f"{head}:\n„{text}\"",
            label=f"ask #{ask_id} {'odpověď' if final else f'nález {index}'}",
        )

    async def _progress(self, ask_id: int, service: Any, started: float) -> None:
        """„Ještě na tom dělám" — aby dlouhé přemýšlení neznělo jako výpadek."""
        if self.progress_after <= 0 or self.progress_max <= 0:
            return
        wait = self.progress_after
        for round_no in range(1, self.progress_max + 1):
            try:
                await asyncio.sleep(wait)
            except asyncio.CancelledError:
                return
            if not session_alive(service):
                return
            elapsed = int(time.monotonic() - started)
            hint = PROGRESS_HINTS[(round_no - 1) % len(PROGRESS_HINTS)]
            logger.info(
                "⏳ ask_zan #%d: %d. průběžná hláška po %d s → „%s\"",
                ask_id, round_no, elapsed, hint,
            )
            await self.deliver_text(
                service,
                "ŽÁN-CODE NA TOM POŘÁD PRACUJE. Řekni uživateli JEDNOU, krátce "
                f"a lidsky, že to ještě rozmýšlíš — přesně takhle: „{hint}\" "
                "Neříkej žádná čísla ani jak dlouho to trvá. Odpověď zatím NEMÁŠ — "
                "nic si nevymýšlej a nic neuzavírej.",
                label=f"ask #{ask_id} průběh {round_no}",
            )
            wait = self.progress_every

    async def _stream(self, text: str):
        """Async generátor nad blokujícím HTTP čtením ve vlákně.

        Vlákno se zrušit nedá; při zrušení (STOP) se prostě přestane číst
        a jeho výsledek nikdo nepřevezme — dojede si do timeoutu samo.
        """
        payload: Dict[str, Any] = {"text": text}
        if self.chat_id is not None:
            payload["chat_id"] = self.chat_id
        loop = asyncio.get_running_loop()
        queue: asyncio.Queue = asyncio.Queue()
        done = object()

        def worker() -> None:
            def put(value: Any) -> None:
                try:
                    loop.call_soon_threadsafe(queue.put_nowait, value)
                except RuntimeError:  # pragma: no cover - loop mezitím skončil
                    pass
            try:
                for chunk in _post_stream(self.url, self.token, payload, self.timeout):
                    put(chunk)
            except BaseException as exc:  # noqa: BLE001 - předáváme výš
                put(exc)
            finally:
                put(done)

        loop.run_in_executor(None, worker)
        while True:
            item = await queue.get()
            if item is done:
                return
            if isinstance(item, BaseException):
                raise item
            yield item


# ---------------------------------------------------------------------------
# zpětná kompatibilita
# ---------------------------------------------------------------------------

def create_ask_zan_tool_handler(
    url: str, token: str, chat_id: Optional[int],
    broadcast_json: Callable[[dict], Awaitable[None]], timeout: Optional[float] = None,
):
    """Vrátí handler i most (most drží běžící dotazy a umí je zrušit)."""
    bridge = ZanBridge(url, token, chat_id, broadcast_json, timeout)
    return bridge.handler
