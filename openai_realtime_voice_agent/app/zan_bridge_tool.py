# -*- coding: utf-8 -*-
"""Most z OpenAI Realtime na Žánův mozek (`/voice`) — přes FRONTU TÉMAT.

Specifikace: `projects/baklazan/zan/MLUVENI-ZANA-TECHNICKY.md` §1,
karta `2026-08-27-programator-zana-04`.

DŘÍV (jednotah): `ask_zan` poslal HTTP POST na Žán-Code a **čekal** na
celou odpověď. Function call přitom drží turn, takže když mozek přemýšlel
dvacet vteřin, uživatel dvacet vteřin poslouchal ticho.

TEĎ: `ask_zan` se vrací **hned** se stavem `delegated` a `run_llm=False`;
dotaz jede na pozadí a **všechno, co z něj vypadne, jde do fronty témat**
(`app/fronta_temat.py`), odkud to vydává dispečer (`app/dispecer_reci.py`)
podle jediného pravidla: **mluví právě jeden**.

JEDINÝ VSTUP DO ŘEČI JE `dispecer.pridej_*()`. Přímé `deliver_text()`
z různých míst je zrušené — bylo to pátý zdroj řeči vedle promptu,
tool resultu, rychlé dráhy a modelu samotného. Zrušený je i časovač
`ZAN_ASK_QUIET_WAIT` (15 s „pak to risknu"): kdy je ticho, ví dispečer
z `phase_emitter`, ne z hodinek.

`ZAN_ASK_TIMEOUT` **zůstává** — ale odpověď, která dorazí po platnosti
tématu, se ve frontě zahodí, což je správně (po pěti minutách už to není
odpověď, je to překvapení).

**Rychlá dráha (přednahrané fráze) jde MIMO frontu** — jiná vrstva řeči,
specifikace ji nechává beze změny.

POJISTKY (poučení `2026-08-23_pojistka-se-pri-pivotu-nepresouva-sama.md`
— brzdy jsou vlastnost konkrétní cesty kódu, tahle cesta je nová, takže
si je musí nést sama):

  * **Relace mezitím skončila** — před vstříknutím se kontroluje živé
    spojení (`session_alive`); do mrtvé session se nikdy nevstřikuje
    a dispečer frontu vyprázdní.
  * **STOP** („zmlkni", tlačítko na Voice PE) — `stop()` zruší běžící
    dotazy **i vyprázdní frontu**. Volá se z
    `websocket_handler._on_device_interrupt`.
  * **Souběžné dotazy** — strop `ZAN_ASK_MAX_PENDING`; při překročení
    padá nejstarší.
  * **Model si nesmí vymýšlet** — tool result říká výslovně, že
    `delegated` NENÍ odpověď (a `run_llm=False`, takže na něj model ani
    nemluví).
  * **Nouzový vypínač** — `ZAN_ASK_ASYNC=false` vrátí staré blokující
    chování beze změny kódu (a bez živé session se na něj přepne samo).

ENV:
  ZAN_ASK_TIMEOUT         (s, default 300)  — kolik času má mozek celkem
  ZAN_ASK_ASYNC           (bool, default true) — false = staré blokující chování
  ZAN_ASK_PROGRESS_AFTER  (s, default 25; 0 = vypnuto) — po téhle době
                          jde do fronty první „ještě na tom dělám"
  ZAN_ASK_PROGRESS_EVERY  (s, default 45)   — a pak znovu po téhle době
  ZAN_ASK_PROGRESS_MAX    (default 3)       — nejvýš tolikrát
  ZAN_ASK_MAX_PENDING     (default 3)       — strop souběžných dotazů
  ZAN_ASK_KEEP_THINKING   (bool, default true) — držet „thinking" LED,
                          dokud mozek počítá
  ZAN_DISPECER_TIK        (s, default 0.2)  — perioda dispečerské smyčky
  ZAN_DISPECER_ROZBEH     (s, default 2.0)  — jak dlouho čekat, až se pusa
                          po vstříknutí rozjede, než se pokračuje
"""
import asyncio
import json
import logging
import os
import time
import urllib.error
import urllib.request
import uuid
from typing import Any, Awaitable, Callable, Dict, List, Optional, Tuple, TYPE_CHECKING

from pipecat.frames.frames import FunctionCallResultProperties
from pipecat.services.openai.realtime import events as rt_events

from app.dispecer_reci import DispecerReci
from app.zdroj_zarizeni import payload_voice, zdroj_zarizeni

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
        Vydá se jedna položka, až dorazí celé tělo.
      * **budoucnost** — NDJSON: každý řádek jeden JSON objekt, a každý se
        vydá HNED, jak dorazí. Tím vzniká průběžné podsouvání bez čekání
        na konec požadavku.

    Rozlišení je bezpečné: pretty-printed tělo začíná řádkem `{`, který se
    jako celý JSON objekt přečíst nedá → jde se cestou „celé tělo".
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
    """Z jedné odpovědi mozku vytáhne N textů k vyslovení."""
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
    `_websocket` a při odpojování zvedá `_disconnecting`.
    """
    if service is None:
        return False
    if getattr(service, "_disconnecting", False):
        return False
    return getattr(service, "_websocket", None) is not None


def mluvi_prave(service: Any) -> bool:
    """Má pipecat rozjetou odpověď asistenta?

    `_current_assistant_response` nastavuje pipecat na
    `conversation.item.added` (role assistant) a maže na `response.done` —
    je to tentýž signál, podle kterého se `websocket_handler` rozhoduje,
    jestli posílat `response.cancel`. Dispečer ho bere jako druhý zdroj
    vedle fáze `replying` z `phase_emitter`: fáze říká „z reproduktoru jde
    zvuk", tohle „model ještě generuje". Vstřikovat se nesmí ani v jednom.
    """
    return getattr(service, "_current_assistant_response", None) is not None


async def inject_into_session(service: Any, text: str, *, run_llm: bool = True) -> bool:
    """Vloží zprávu do BĚŽÍCÍ session a (volitelně) nechá model odpovědět.

    Vrací True, když se to poslalo; False, když už není kam. Volá to
    **jedině dispečer** — nikdo jiný do session nevstřikuje.
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
# tohle NENÍ odpověď — jinak si lite model odpověď domyslí.
ACK_NOTE = (
    "Dotaz jsem předal Žán-Code. Tohle NENÍ odpověď — odpověď dorazí sama "
    "za chvíli jako systémová zpráva a teprve tu řekneš uživateli. Do té "
    "doby za mozek neodpovídej a nic si nevymýšlej."
)

# LIDSKÉ HLÁŠKY PŘI ČEKÁNÍ (Ondra, 25. 8.: „ať to zní lidsky, ne robot").
#
# KTERÁ VRSTVA MLUVÍ (poučení 2026-08-23_dva-zdroje-reci-a-protichudne-instrukce):
#   1) souběh s voláním nástroje  → řídí ROUTING prompt v main.py
#   2) po výsledku tool callu     → run_llm=False, model MLČÍ (žádný dvojhlas)
#   3) tenhle soubor              → jde do FRONTY jako priorita 2 (TTL 8 s)
#   4) rychlá dráha               → knihovna přednahraných frází, nesaháme
#
# Střídání je tady v kódu (deterministicky podle kola), ne na modelu —
# jedna a tatáž věta třikrát za sebou zní jako porucha.
#
# ŽÁDNÉ ČÍSLICE (poučení 2026-08-05_ceske-tts-necist-cislice) — uplynulý
# čas jde do logu, ne do řeči.
PROGRESS_HINTS = (
    "Ještě na tom dělám, vydrž.",
    "Pořád nad tím přemýšlím.",
    "Chvilku to ještě potrvá, rozmýšlím to.",
    "Vteřinku, ještě to skládám dohromady.",
)


class ZanBridge:
    """Asynchronní most na Žán-Code. Všechna řeč jde přes dispečer."""

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
        self.keep_thinking = _env_bool("ZAN_ASK_KEEP_THINKING", True)
        self._pending: Dict[int, asyncio.Task] = {}
        self._seq = 0
        # Aktuální realtime service + zdroj fáze. Obojí se mění s každým
        # připojením zařízení, proto `pripoj()`.
        self._service: Any = None
        self._faze_getter: Optional[Callable[[], Optional[str]]] = None
        # Ze které krabice se ptali (`app/zdroj_zarizeni.py`). Mění se
        # s připojeným zařízením, proto `nastav_zdroj()`.
        self._zdroj: Optional[str] = None
        self.dispecer = DispecerReci(
            vyslov=self._vyslov,
            pusa_mluvi=self.pusa_mluvi,
            session_ziva=lambda: session_alive(self._service),
            tik_s=_env_float("ZAN_DISPECER_TIK", 0.2),
            rozbeh_s=_env_float("ZAN_DISPECER_ROZBEH", 2.0),
        )
        logger.info(
            "🧠 ask_zan most: async=%s timeout=%.0fs progress=%.0f/%.0fs×%d "
            "max_pending=%d keep_thinking=%s (řeč jde přes frontu témat)",
            self.async_enabled, self.timeout, self.progress_after,
            self.progress_every, self.progress_max, self.max_pending,
            self.keep_thinking,
        )

    # -- napojení na běžící session --------------------------------------

    def pripoj(self, service: Any, faze_getter: Optional[Callable[[], Optional[str]]] = None) -> None:
        """Přepne most na novou realtime session a nastartuje dispečera.

        Volá se při každém `_ensure_openai_service` — služba se vytváří
        znovu pro každé připojení zařízení. Co viselo ve frontě pro starou
        session, se zahazuje: patřilo to k jinému rozhovoru.
        """
        if self._service is not service:
            self.dispecer.vyprazdni("nová realtime session")
        self._service = service
        if faze_getter is not None:
            self._faze_getter = faze_getter
        self.dispecer.spust()

    def nastav_zdroj(self, client_id: Optional[str]) -> None:
        """Zapamatuj si, ze kterého satelitu teď hlas přichází.

        Volá se z `_ensure_openai_service` (tam je client_id z transportu).
        Do payloadu `/voice` pak jde `zdroj_zarizeni` — server ho zatím
        ignoruje, takže je to čistě aditivní.
        """
        novy = zdroj_zarizeni(client_id)
        if novy != self._zdroj:
            logger.info("📍 zdroj hlasu: %s (klient %s)", novy or "neznámý", client_id)
        self._zdroj = novy

    def _payload(self, text: str) -> Dict[str, Any]:
        """Tělo POSTu na `/voice` — obálka nad `zdroj_zarizeni.payload_voice`.

        Skládání je schválně mimo tenhle modul, aby šlo testovat bez
        pipecatu (`tests/test_session_klient.py`).
        """
        return payload_voice(text, self.chat_id, self._zdroj)

    def nastav_faze_getter(self, faze_getter: Callable[[], Optional[str]]) -> None:
        """Zdroj fáze (`listening`/`thinking`/`replying`/`idle`) z PhaseEmitteru."""
        self._faze_getter = faze_getter

    def pusa_mluvi(self) -> bool:
        """Mluví teď pusa? Fail-closed: při nejistotě radši mlčet.

        Dva nezávislé zdroje, stačí jeden:
          * fáze `replying` z `phase_emitter` (BotStartedSpeaking →
            BotStoppedSpeaking + debounce) — to je signál ze specifikace,
          * `_current_assistant_response` v pipecatu (model generuje).
        """
        if self._faze_getter is not None:
            try:
                if self._faze_getter() == "replying":
                    return True
            except Exception:  # pragma: no cover - zdroj fáze nesmí shodit dispečer
                logger.warning("⚠️ zdroj fáze selhal — beru to jako „pusa mluví\"")
                return True
        return mluvi_prave(self._service)

    async def _vyslov(self, text: str, run_llm: bool = True) -> bool:
        """Jediná cesta z fronty do session. Volá to jenom dispečer."""
        return await inject_into_session(self._service, text, run_llm=run_llm)

    # -- veřejné API ------------------------------------------------------

    @property
    def pending(self) -> int:
        return sum(1 for task in self._pending.values() if not task.done())

    def cancel_all(self, reason: str = "STOP") -> int:
        """Zruší běžící dotazy — po stopce už nesmí nic promluvit.

        HTTP požadavek běžící ve vlákně se zrušit nedá (urllib to neumí),
        ale jeho výsledek se zahodí a do fronty se nedostane.
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

    def stop(self, reason: str = "STOP") -> int:
        """„Zmlkni" / tlačítko na Voice PE: zrušit dotazy **i vyprázdnit frontu**.

        Obojí je nutné: samotné `cancel_all()` nechá ve frontě, co už do ní
        stihlo spadnout (průběžné hlášky, dílčí nálezy), a to by po stopce
        promluvilo.
        """
        killed = self.cancel_all(reason)
        self.dispecer.vyprazdni(reason)
        return killed

    def prijmi_prubeh(self, interaction_id: str, text: str, druh: str = "prubeh") -> bool:
        """Vstupní bod endpointu `/prubeh` (MLUVENI-ZANA-TECHNICKY.md §2).

        Mozek sem fire-and-forget posílá průběžné nálezy. Neznámý druh se
        bere jako průběžná hláška — nikdy se z toho nestane odpověď.
        """
        druh = (druh or "prubeh").strip().lower()
        if druh in ("odpoved", "odpověď", "reply"):
            return self.dispecer.pridej_odpoved(text, interaction_id)
        if druh in ("oprava", "correction"):
            return self.dispecer.pridej_opravu(text, interaction_id)
        if druh in ("smalltalk", "poznamka", "poznámka"):
            return self.dispecer.pridej_smalltalk(text, interaction_id)
        return self.dispecer.pridej_prubeh(text, interaction_id)

    # -- tool handler -----------------------------------------------------

    async def handler(self, params: "FunctionCallParams") -> None:
        text = str((params.arguments or {}).get("text", "")).strip()
        if not text:
            await params.result_callback("Neslyšel jsem zadání.")
            return

        service = getattr(params, "llm", None)
        if service is not None and service is not self._service:
            # Tool call zná svoji službu líp než my — držme se jí.
            self._service = service
            self.dispecer.spust()

        if not self.async_enabled or not session_alive(service):
            # Nouzová/stará cesta. Bez živé session není kam vstřikovat, tak
            # ať se aspoň odpoví postaru, než aby se mlčelo.
            if self.async_enabled:
                logger.warning("⚠️ ask_zan: není živá realtime session → blokující režim")
            await self._blocking(params, text)
            return

        self._seq += 1
        ask_id = self._seq
        interaction_id = uuid.uuid4().hex
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

        task = asyncio.create_task(
            self._run(ask_id, interaction_id, text), name=f"ask_zan-{ask_id}"
        )
        self._pending[ask_id] = task
        task.add_done_callback(lambda _t, i=ask_id: self._pending.pop(i, None))
        logger.info("🧠 ask_zan #%d delegováno na pozadí (iid=%s, běží %d): %.120s",
                    ask_id, interaction_id, self.pending, text)

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
        payload = self._payload(text)
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

    async def _run(self, ask_id: int, interaction_id: str, text: str) -> None:
        started = time.monotonic()
        progress = asyncio.create_task(self._progress(ask_id, interaction_id, started))
        delivered = 0
        try:
            try:
                delivered = await asyncio.wait_for(
                    self._consume(ask_id, interaction_id, text), timeout=self.timeout
                )
            except asyncio.TimeoutError:
                progress.cancel()
                logger.error("⏱️ ask_zan #%d: mozek se neozval do %.0f s", ask_id, self.timeout)
                self.dispecer.pridej_odpoved(
                    # bez číslic — model tenhle text vysloví (české TTS/číslovky)
                    "Tohle jsem teď nedal dohromady, zkus to prosím znovu.",
                    interaction_id, druh="chyba",
                )
                return
            except (urllib.error.URLError, TimeoutError, OSError, ValueError) as exc:
                progress.cancel()
                logger.error("❌ ask_zan #%d: most na mozek selhal: %r", ask_id, exc)
                self.dispecer.pridej_odpoved(
                    "Teď se nedostanu ke svému mozku, zkus to prosím za chvilku znovu.",
                    interaction_id, druh="chyba",
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
                "🧠 ask_zan #%d hotovo za %.1f s, do fronty šlo %d zpráv",
                ask_id, time.monotonic() - started, delivered,
            )

    async def _consume(self, ask_id: int, interaction_id: str, text: str) -> int:
        """Čte odpovědi mozku a zařazuje je do fronty jednu po druhé.

        Poslední se označí jako finální (`odpoved` — pusa smí uzavřít),
        předchozí jako dílčí nález (`nalez` — ještě něco přijde).
        """
        zarazeno = 0
        previous: Optional[Tuple[str, bool]] = None
        async for payload in self._stream(text):
            for item in self._items(payload):
                if previous is not None:
                    zarazeno += 1
                    await self._zarad(ask_id, interaction_id, previous, final=False)
                previous = item
        if previous is not None:
            zarazeno += 1
            await self._zarad(ask_id, interaction_id, previous, final=True)
        return zarazeno

    def _items(self, payload: dict) -> List[Tuple[str, bool]]:
        """Z jedné odpovědi mozku udělá seznam (text, ať to model vysloví?).

        `local_confirmation: success` znamená, že potvrzení už zaznělo
        lokálně z knihovny frází — text se do kontextu vloží kvůli
        kontinuitě, ale model ho NESMÍ vyslovit znovu.
        """
        speak = payload.get("local_confirmation") != "success"
        return [(chunk, speak) for chunk in _texts_from(payload)]

    async def _zarad(
        self, ask_id: int, interaction_id: str, item: Tuple[str, bool], *, final: bool
    ) -> None:
        text, speak = item
        if not speak:
            await self.broadcast_json(
                {"type": "local_confirmation", "value": "success", "text": text}
            )
            self.dispecer.pridej_odpoved(
                text, interaction_id, druh="potvrzeni", run_llm=False,
            )
            return
        self.dispecer.pridej_odpoved(
            text, interaction_id, druh="odpoved" if final else "nalez",
        )

    async def _progress(self, ask_id: int, interaction_id: str, started: float) -> None:
        """„Ještě na tom dělám" — aby dlouhé přemýšlení neznělo jako výpadek.

        Jde to do FRONTY s platností osmi sekund, ne rovnou do session:
        když se mezitím pusa rozmluví nebo dorazí odpověď, hláška se sama
        zahodí a nikdo neuslyší „ještě to zjišťuju" po hotové odpovědi.
        """
        if self.progress_after <= 0 or self.progress_max <= 0:
            return
        wait = self.progress_after
        for round_no in range(1, self.progress_max + 1):
            try:
                await asyncio.sleep(wait)
            except asyncio.CancelledError:
                return
            if not session_alive(self._service):
                return
            elapsed = int(time.monotonic() - started)
            hint = PROGRESS_HINTS[(round_no - 1) % len(PROGRESS_HINTS)]
            logger.info(
                "⏳ ask_zan #%d: %d. průběžná hláška po %d s → „%s\"",
                ask_id, round_no, elapsed, hint,
            )
            self.dispecer.pridej_prubeh(hint, interaction_id)
            wait = self.progress_every

    async def _stream(self, text: str):
        """Async generátor nad blokujícím HTTP čtením ve vlákně.

        Vlákno se zrušit nedá; při zrušení (STOP) se prostě přestane číst
        a jeho výsledek nikdo nepřevezme — dojede si do timeoutu samo.
        """
        payload = self._payload(text)
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
    """Vrátí jen handler — pro volající, který most sám nedrží.

    `main.py` most drží (potřebuje `pripoj()` a `stop()`), takže si
    `ZanBridge` staví přímo; tahle funkce zůstává kvůli starším volajícím.
    """
    bridge = ZanBridge(url, token, chat_id, broadcast_json, timeout)
    return bridge.handler
