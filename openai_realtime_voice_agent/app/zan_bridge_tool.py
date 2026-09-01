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
from app.prepis_ocista import ocisti
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
        "type": "function", "name": "zeptej_se_mozku",
        # Popis je česky (model je promptovaný česky) a SCHVÁLNĚ neříká,
        # jak vypadá výsledek — Pipecat na tomhle pohořel (PR #5278): když
        # model zná tvar dat, zavolá nástroj podruhé a data si vymyslí.
        "description": (
            "Předej dotaz Žánovu mozku. Mozek jediný má paměť, oprávnění "
            "a nástroje domu. Vrátí se OKAMŽITĚ — to není odpověď a odpověď "
            "od tebe se pak nečeká: mozek promluví sám. Zavolej ho jednou "
            "za promluvu a pak mlč."
        ),
        "parameters": {"type": "object", "properties": {"text": {"type": "string", "description": "Přesně to, co člověk řekl."}}, "required": ["text"]},
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
    STAV spojení, ne čekat na událost.

    KAŽDÁ PUSA TO DRŽÍ JINDE (nalezeno 31. 8. 2026 živým testem):

    * OpenAI Realtime (`OpenAIRealtimeLLMService`) — `self._websocket`,
    * Gemini Live (`GeminiLiveLLMService`) — `self._session`; `_websocket`
      na ní NEEXISTUJE.

    Do dneška se ptalo jen na `_websocket`, takže u Gemini pusy vracela
    tahle funkce VŽDY False. Následek nebyl vidět jako chyba, ale jako
    povaha: `ask_zan` spadl do nouzového blokujícího režimu, odpověď mozku
    se vrátila jako VÝSLEDEK NÁSTROJE a model ji převyprávěl vlastními
    slovy — přesně to, co Ondra popisoval jako „mluví blbosti". Zároveň
    tím byl mrtvý celý dispečer (fronta, TTL, priority) i doslovná řeč.

    Doloženo v logu 15:20:27: `⚠️ ask_zan: není živá realtime session →
    blokující režim`, ačkoli tatáž relace o vteřinu dřív v pořádku
    přijala povel a zavolala nástroj.

    Poučení `2026-08-23_pojistka-se-pri-pivotu-nepresouva-sama.md`: brzdy
    a mechaniky jsou vlastností KONKRÉTNÍ CESTY kódu; při přesunu na
    druhého poskytovatele se nepřestěhují samy a chybějící mechanika se
    navenek tváří jako vlastnost modelu.
    """
    if service is None:
        return False
    if getattr(service, "_disconnecting", False):
        return False
    if getattr(service, "_websocket", None) is not None:
        return True
    return getattr(service, "_session", None) is not None


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


async def _inject_gemini(service: Any, text: str, run_llm: bool) -> bool:
    """Vstříknutí do Gemini Live session.

    Gemini nemá `conversation.item.create` ani `response.create` — má
    `send_client_content(turns=…, turn_complete=…)`. A `turn_complete`
    dělá přesně to, co potřebujeme rozlišit:

    * `False` — text jen PŘIBUDE do kontextu a model nezačne mluvit.
      Tudy jde záznam „tohle už zaznělo Žánovým hlasem" po doslovné řeči.
    * `True` — model na text odpoví (záložní cesta, když mluvčí selže).

    Role je `user`: Live API v `send_client_content` bere `user` a `model`,
    systémová role tu neexistuje (ta se posílá jen jako
    `system_instruction` při navazování spojení).
    """
    session = getattr(service, "_session", None)
    if session is None:
        return False
    try:
        await session.send_client_content(
            turns=[{"role": "user", "parts": [{"text": text}]}],
            turn_complete=bool(run_llm),
        )
    except Exception as exc:  # pragma: no cover - vstříknutí nesmí shodit most
        logger.warning("⚠️ vstříknutí do Gemini session selhalo: %r", exc)
        return False
    return True


async def inject_into_session(service: Any, text: str, *, run_llm: bool = True) -> bool:
    """Vloží zprávu do BĚŽÍCÍ session a (volitelně) nechá model odpovědět.

    Vrací True, když se to poslalo; False, když už není kam. Volá to
    **jedině dispečer** — nikdo jiný do session nevstřikuje.
    """
    if not session_alive(service):
        return False
    # Gemini pusa: jiné API, jiná cesta (viz `_inject_gemini`). Pozná se
    # podle toho, že nemá websocket OpenAI Realtime klienta.
    if getattr(service, "_websocket", None) is None:
        return await _inject_gemini(service, text, run_llm)
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
# Co uvidí model jako výsledek nástroje.
#
# TVAR JE ZKOPÍROVANÝ Z PIPECAT 1.8.0 (`async_tool_messages.py`, viz research
# `2026-08-31_realtime-hlas-jak-to-dela-svet.md` §3.1) — jsme na 0.0.97, ale
# wording je jen text a funguje i bez upgradu. Dvě pravidla z jejich chyb
# (PR #5278): (a) NIKDY nepopisovat tvar dat, které přijdou — model se je
# pak snaží reprodukovat a zavolá nástroj podruhé s vymyšleným výsledkem;
# (b) říct výslovně „nevolej znovu".
#
# A jedna věc navíc, která platí až po 31. 8. 2026: odpověď mozku uživateli
# NEŘEKNE MODEL. Řekne ji Žánův vlastní hlas (mluvčí) a modelu přijde jen
# záznam, co zaznělo. Proto tu nesmí zůstat „teprve tu řekneš uživateli" —
# to by byl slib, na který model nemá dosah (poučení
# `2026-08-25_slib-v-ustave-bez-dosahu.md`), a čekal by na svou repliku.
ACK_NOTE = (
    "Úloha běží. Tohle NENÍ odpověď a odpověď od tebe se nečeká. "
    "Nevolej nástroj znovu a nic si nedomýšlej. Až bude hotovo, řekne to "
    "Žán sám; ty mlč a čekej na další promluvu člověka."
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
#
# 31. 8. 2026 SE PŘESTALY ŘÍKAT NAHLAS (Ondra: „casto mluvi blbosti
# a opakuje fraze"; zadání: „žádné ‚moment, musím přemýšlet\u2018").
#
# Proč ticho a ne jiná věta: Home Assistant řeší čekání na Voice PE
# VÝHRADNĚ vizuálně — pulzující LED „Thinking", žádný hlasový filler
# (research §1, HA Assist pipeline). Tenhle most drží thinking fázi po
# celou dobu běhu nástroje (`TURN_LIVENESS.tool_started()`), takže na
# satelitu svítí prstenec a uživatel VIDÍ, že se pracuje. Přidávat k tomu
# každých pětadvacet sekund větu je hluk, ne informace.
#
# Zůstávají jako LOG (a jako záloha, kdyby se `ZAN_ASK_PROGRESS_MAX`
# vědomě zapnul na zařízení bez indikace stavu).
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
        # 0 = nemluvit při čekání vůbec (viz PROGRESS_HINTS). Ticho + LED.
        self.progress_max = _env_int("ZAN_ASK_PROGRESS_MAX", 0)
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
            rekni_doslova=self._rekni_doslova,
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

        Volá se při každém `_create_openai_service` — služba se vytváří
        znovu pro každé připojení zařízení. Co viselo ve frontě pro starou
        session, se zahazuje: patřilo to k jinému rozhovoru.

        POZOR (multiklient, 30. 8. 2026): most je JEDEN na celý běh, ale
        satelitů může být víc a každý má vlastní relaci. `pripoj()` proto
        přepne frontu na tu NAPOSLEDY připojenou — dispečer mluví jednou
        pusou, ne dvěma. Dokud jsou satelity dva a mozek jeden, je to
        záměr; kdyby měl každý satelit mluvit vlastní frontou, musel by
        být `ZanBridge` per slot (nezavedeno — jeden mozek, jedna paměť).
        """
        if self._service is not service:
            self.dispecer.vyprazdni("nová realtime session")
        self._service = service
        if faze_getter is not None:
            self._faze_getter = faze_getter
        self.dispecer.spust()

    def nastav_zdroj(self, client_id: Optional[str]) -> None:
        """Zapamatuj si, ze kterého satelitu teď hlas přichází.

        Volá se z `_create_openai_service` (tam je client_id ze slotu).
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

    async def _rekni_doslova(self, text: str) -> bool:
        """Vyslovit text mozku PŘESNĚ (mluvčí Piper). Volá to jenom dispečer.

        Vrací False, když pusa mixin nemá (starší služba) nebo mluvčí
        selhal — dispečer pak spadne na starou cestu přes model.
        """
        service = self._service
        rekni = getattr(service, "rekni_doslova", None)
        if rekni is None:
            return False
        return bool(await rekni(text))

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

        # OČISTA ZADÁNÍ (31. 8. 2026). Model do `text` přepošle, co slyšel —
        # včetně wake wordu a šumu. Živě z logu 10:44:44:
        # `ask_zan {'text': 'baklažán'}`, a v 10:45:11
        # `{'text': 'baklažán rozsvítit jedno světlo…'}`. Mozek má dostat
        # POVEL, ne oslovení; útržek se mu neposílá vůbec.
        #
        # OKNO ROZHOVORU (1. 9. 2026) — TÁŽ výjimka jako v mostu
        # (`websocket_handler.na_prepis`), protože tudy vede DRUHÁ cesta
        # k mozku: pusa přepošle, co slyšela, do `ask_zan`. Kdyby okno
        # platilo jen v mostu, onboardingová odpověď („Eliška") by prošla
        # očistou přepisu a zaraženě skončila tady. Stav je týž objekt,
        # takže se obě cesty nemůžou rozejít.
        ceka = False
        try:
            ceka = bool(self.dispecer.ceka_na_odpoved())
        except Exception:  # noqa: BLE001 — stav nesmí shodit dotaz
            logger.debug("stav okna rozhovoru se nepodařilo zjistit", exc_info=True)
        ocista = ocisti(text, ceka_na_odpoved=ceka)
        if ocista.utrzek:
            logger.warning("🗑 útržek: ask_zan(%r) — %s (ceka_na_odpoved=%s), "
                           "mozku to neposílám", text, ocista.duvod, ceka)
            rozbor = getattr(self, "rozbor", None)
            if rozbor is not None:
                try:
                    rozbor.nahlas("utrzek-ask", prepis=text,
                                  volani="ask_zan(%r)" % text,
                                  vysledek="nedelegováno",
                                  poznamka="zadání není povel (%s, ceka_na_odpoved=%s)"
                                           % (ocista.duvod, ceka))
                except Exception:  # noqa: BLE001
                    logger.debug("nahlášení anomálie selhalo", exc_info=True)
            await params.result_callback(
                {"status": "ignored",
                 "note": "To nebyl povel, jen zbytek oslovení nebo šum. "
                         "Nic jsem nepředal. Mlč, nebo se zeptej jednou krátkou větou."},
                properties=FunctionCallResultProperties(run_llm=False),
            )
            return
        if ocista.zmeneno:
            logger.info("🧽 ask_zan: %r → %r", text, ocista.text)
        text = ocista.text

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

        # JEDNA OTAZKA = JEDNA ODPOVED (31. 8. 2026). Ondra: "asi odpovedel
        # 2x - zkontroluj". Doslovne z logu 18:44:
        #
        #   .40.447  Calling [zeptej_se_mozku] {'text': 'Kolik je stupnu v obyvaku?'}
        #   .43.147  Calling [zeptej_se_mozku] {'text': 'Kolik je stupnu v obyvaku?'}
        #
        # Tentyz nastroj s IDENTICKYMI argumenty dvakrat, 2,7 s po sobe.
        # Vznikly dva interaction_id, mozek bezel dvakrat a Zan rekl totez
        # dvakrat jinymi slovy ("Dvacet sest stupnu, z cidla vzduchu
        # v obyvaku" / "Dvacet sest stupnu rovnych, z cidla vzduchu SAWF-07P").
        #
        # Proc to nechytila dedup straz: jeji plne osmisekundove okno drzi
        # jen OVERENY USPECH. `ask_zan` vraci hned {"status": "delegated"},
        # coz uspech neni, takze okno spadlo na DEDUP_MILOST_S = 2,5 s --
        # a druhe volani prislo o 2,7 s pozdeji, tesne za nim.
        #
        # Tady se to resi presne a bez casovych oken: dokud na tutez otazku
        # BEZI dotaz, druhy se nezalozi. Az prvni dobehne, evidence se uklidi,
        # takze pozdejsi lidske zopakovani teze otazky projde normalne.
        _norm = " ".join(text.lower().split())
        _bezici = getattr(self, "_pending_texty", None)
        if _bezici is None:
            _bezici = self._pending_texty = {}
        _bezici = {i: t for i, t in _bezici.items() if i in self._pending}
        self._pending_texty = _bezici
        if _norm in set(_bezici.values()):
            logger.warning(
                "🔁 ask_zan: na tutez otazku uz bezi dotaz — DRUHY NEZAKLADAM "
                "(model zopakoval volani): %.120s", text,
            )
            rozbor = getattr(self, "rozbor", None)
            if rozbor is not None:
                try:
                    rozbor.nahlas("dvojity-dotaz", prepis=text,
                                  volani="ask_zan(%r)" % text,
                                  vysledek="nedelegovano podruhe",
                                  poznamka="tataz otazka uz bezi")
                except Exception:  # noqa: BLE001
                    logger.debug("nahlaseni anomalie selhalo", exc_info=True)
            await params.result_callback(
                {"status": "delegated", "note": ACK_NOTE},
                properties=FunctionCallResultProperties(run_llm=False),
            )
            return

        self._seq += 1
        ask_id = self._seq
        interaction_id = uuid.uuid4().hex
        _bezici[ask_id] = _norm
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
        # Evidence textu se uklidi spolu s dotazem, at pozdejsi zopakovani
        # teze otazky uz neni blokovane.
        task.add_done_callback(
            lambda _t, i=ask_id: getattr(self, "_pending_texty", {}).pop(i, None))
        # Čas POLOŽENÍ otázky — z něj dispečer pozná, že odpověď dorazila
        # do jiného hovoru, než ke kterému patří (pravidlo čerstvosti).
        try:
            self.dispecer.zaznamenej_otazku(interaction_id)
        except Exception:  # pragma: no cover - evidence nesmí shodit dotaz
            logger.debug("evidence času otázky selhala", exc_info=True)
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
            await params.result_callback("Tohle mi teď nejde zjistit. Zkus to prosím znovu.")
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
                    # BEZ ŽARGONU: „mozek" je slovo z naší architektury, ne
                    # z domácnosti — osobnost pusy ho má zakázané, a od
                    # 31. 8. tuhle větu vyslovuje Žán DOSLOVA, takže by ji
                    # prozradil nahlas. Konkrétně, bez omluvy, s cestou ven.
                    "Tohle mi teď nejde zjistit, zkus to prosím za chvilku znovu.",
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
        """Čte odpovědi mozku a zařazuje je do fronty HNED, jak přijdou.

        PROČ SE TO 31. 8. 2026 ZMĚNILO. Původní kód držel každou položku
        v ruce, dokud nedorazila NÁSLEDUJÍCÍ — jen aby té poslední mohl
        dát druh `odpoved` místo `nalez`. U jednovětné odpovědi (což je
        většina) to znamenalo čekat na UZAVŘENÍ streamu, tedy zahodit
        celý smysl streamování: první věta se dala vyslovit hned, ale
        čekalo se.

        Ta cena byla placená za ROZDÍL VE FORMULACI — `nalez` říkal
        modelu „hovor neuzavírej", `odpoved` „uzavři". Jenže odpověď
        mozku od dneška vyslovuje mluvčí DOSLOVA, takže druh už na text
        nemá vliv; platí jen za tou hranicí, kde se padá zpátky na model.
        Latence je důležitější než odstín zálohy.

        (Research 2026-08-31 §3.5: streaming vět je největší jednotlivá
        latency páka vůbec — HA Voice měřil >5 s → ~0,5 s.)
        """
        zarazeno = 0
        posledni: Optional[Tuple[str, bool]] = None
        async for payload in self._stream(text):
            for item in self._items(payload):
                zarazeno += 1
                if zarazeno == 1:
                    logger.info("⚡ ask_zan #%d: první věta mozku jde do řeči hned", ask_id)
                await self._zarad(ask_id, interaction_id, item, final=False)
                posledni = item
        if posledni is not None and zarazeno:
            # Stream skončil. Nic se už nevysloví (to je hotové), jen se
            # modelu potvrdí, že téma je uzavřené — jinak by čekal dál.
            logger.info("🏁 ask_zan #%d: mozek dořekl (%d vět)", ask_id, zarazeno)
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
