"""Anomálie hlasové výměny → rovnou Žánovi k rozboru, ne až večer.

PROČ (Ondra, 31. 8. 2026): „tohle presne si ma Zan rozebirat ve sve bezici
session a vyhodnocovat.." Večerní revize ve 22:30 (`zan-revize.timer` →
`/opt/zan/nastroje/vecerni-revize.sh`, tahák `revize-hovoru.md`) zůstává jako
TREND a kontrola, že se rozebrané věci nevracejí. Ale konkrétní porucha —
zahozený útržek, `vysledek_fail`, dvojité volání, protichůdné povely — má
dorazit Žánovi HNED, dokud si ještě pamatuje kontext dne.

DVA KANÁLY, KAŽDÝ NA NĚCO JINÉHO (ověřeno ve `zan-code-server.js`):

* ``POST /event`` (`handleEvent`, auth ``ZAN_VOICE_TOKEN``) je **append-only
  kronika** — jen `appendEvent(record)`, žádný `runClaude`. Uloží se, Žánovu
  session to NESPUSTÍ. Posíláme sem KAŽDOU anomálii, ať existuje důkaz i když
  rozbor neprojde.
* ``POST /ask`` (`handleAsk`, auth ``ZAN_CODE_TOKEN``) volá
  ``runClaude(..., kanal:'ask')`` — tohle Žánovu session opravdu rozjede
  a vrátí jeho odpověď v HTTP odpovědi (nic se nevysloví do místnosti).
  Sem jde SHRNUTÍ výměny, s prefixem ``ROZBOR HOVORU:``.

BRZDY (tokeny stojí peníze a hlas na tomhle nikdy nesmí stát):

* posílají se **jen anomálie**, ne každý úspěch,
* anomálie jedné výměny se **slučují** do jednoho rozboru (debounce),
* mezi dvěma rozbory je **minimální odstup** a je **strop za hodinu**;
  co se přes strop nevejde, zůstane aspoň v kronice ``/event``,
* celé je to **fire-and-forget v samostatném tasku** — hlasová roura na
  odpověď nikdy nečeká a výjimka odsud nesmí shodit tah.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field

logger = logging.getLogger(__name__)

#: Kolik sekund po poslední anomálii se ještě čeká, jestli nepřiletí další
#: z téže výměny. Jedna výměna umí vyrobit útržek + fail + dedup naráz a
#: Žánovi se to má přečíst jako JEDEN příběh, ne tři nesouvislé zprávy.
DEBOUNCE_S = 4.0

#: Nejmenší odstup dvou rozborů. Co přiletí dřív, počká na další dávku.
MIN_ODSTUP_S = 45.0

#: Strop rozborů za hodinu. Nad ním se anomálie pořád zapisují do kroniky,
#: ale Žánovu session už nebudí — jinak by rozbité STT vyžralo denní budget.
MAX_ZA_HODINU = 12

#: Kde má Žán návod, co s tím. Cesta je v JEHO kontejneru (`zan-code` má
#: `/opt/ha/config` namountované jako `/config`), ne v mostu.
TAHAK = "/config/.zan-code/tahaky/rozbor-hovoru.md"

PREFIX = "ROZBOR HOVORU:"


def _env_float(name: str, default: float) -> float:
    raw = os.environ.get(name, "").strip()
    try:
        return float(raw) if raw else default
    except ValueError:
        return default


def _env_int(name: str, default: int) -> int:
    return int(_env_float(name, float(default)))


def _post(url: str, token: str, payload: dict, timeout: float) -> dict:
    req = urllib.request.Request(
        url,
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={"Authorization": "Bearer %s" % token,
                 "Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        telo = resp.read().decode("utf-8", "replace")
    try:
        return json.loads(telo or "{}")
    except ValueError:
        return {"result": telo}


@dataclass
class Anomalie:
    """Jeden nález. `prepis` je DOSLOVA to, co systém slyšel."""

    druh: str
    prepis: str = ""
    volani: str = ""
    vysledek: str = ""
    poznamka: str = ""
    ts: str = field(default_factory=lambda: time.strftime("%Y-%m-%dT%H:%M:%S%z"))
    cas: str = field(default_factory=lambda: time.strftime("%H:%M:%S"))

    def radek(self, poradi: int) -> str:
        casti = ["%d) [%s] %s" % (poradi, self.druh, self.cas)]
        if self.prepis:
            casti.append('   přepis doslova: "%s"' % self.prepis)
        if self.volani:
            casti.append("   co se volalo: %s" % self.volani)
        if self.vysledek:
            casti.append("   výsledek: %s" % self.vysledek)
        if self.poznamka:
            casti.append("   most: %s" % self.poznamka)
        return "\n".join(casti)


class RozborHovoru:
    """Sbírá anomálie výměny a po doběhu je pošle Žánovi k posouzení."""

    def __init__(self, ask_url: str, ask_token: str, chat_id, *,
                 event_url: str = "", event_token: str = "",
                 session_key: str = "", zapnuto: bool = True) -> None:
        self.ask_url = (ask_url or "").strip()
        self.ask_token = (ask_token or "").strip()
        self.chat_id = chat_id
        self.event_url = (event_url or "").strip()
        self.event_token = (event_token or "").strip()
        self.session_key = (session_key
                            or os.environ.get("ZAN_ROZBOR_SESSION", "").strip()
                            or "rozbor-hovoru")
        self.zapnuto = bool(zapnuto) and bool(self.ask_url) and bool(self.ask_token)
        self.debounce_s = _env_float("ZAN_ROZBOR_DEBOUNCE_S", DEBOUNCE_S)
        self.min_odstup_s = _env_float("ZAN_ROZBOR_ODSTUP_S", MIN_ODSTUP_S)
        self.max_za_hodinu = _env_int("ZAN_ROZBOR_MAX_HOD", MAX_ZA_HODINU)
        self.timeout_s = _env_float("ZAN_ROZBOR_TIMEOUT_S", 240.0)
        self._davka: list[Anomalie] = []
        self._task = None
        self._posledni_odeslano = 0.0
        self._odeslane_casy: list[float] = []
        if not self.zapnuto:
            logger.info("ℹ️ rozbor hovoru vypnutý (chybí ZAN_CODE_URL/ZAN_CODE_TOKEN "
                        "nebo ZAN_ROZBOR_ENABLED=false) — anomálie půjdou jen do kroniky")

    # -- veřejné ----------------------------------------------------------

    def nahlas(self, druh: str, *, prepis: str = "", volani: str = "",
               vysledek: str = "", poznamka: str = "") -> None:
        """Zapiš nález. NIKDY nečeká a nikdy nevyhodí ven výjimku."""
        try:
            a = Anomalie(druh=druh, prepis=str(prepis or "")[:600],
                         volani=str(volani or "")[:300],
                         vysledek=str(vysledek or "")[:300],
                         poznamka=str(poznamka or "")[:400])
            logger.info("🔎 anomálie hlasu [%s]: %s", druh,
                        (a.prepis or a.volani or a.poznamka or "?")[:160])
            self._do_kroniky(a)
            if not self.zapnuto:
                return
            self._davka.append(a)
            self._naplanuj()
        except Exception as e:  # pragma: no cover - hlásič nesmí shodit tah
            logger.debug("nahlášení anomálie selhalo: %r", e)

    # -- vnitřek ----------------------------------------------------------

    def _do_kroniky(self, a: Anomalie) -> None:
        """`POST /event` — append-only. Musí projít i bez rozboru.

        TVAR PAYLOADU NENÍ LIBOVOLNÝ. ``handleEvent`` ve ``zan-code-server.js``
        si z těla vybere přesně osm polí (``source, entity, action, result,
        tool, arguments, note`` + vlastní ``ts``) a **všechno ostatní zahodí**;
        rozšíření o ``typ/kanal/kdo/text_user`` má jen větev
        ``body.typ === 'vymena'``. První pokus (31. 8. 11:13) proto zapsal
        anomálii bez druhu i bez přepisu — prázdné ``action`` a ``result``.
        Doslovný přepis se tedy veze v ``arguments`` (to je volný JSON).
        """
        if not self.event_url:
            return
        payload = {
            "source": "voice-most",
            "entity": a.druh,
            "action": "anomalie-hlasu/%s" % a.druh,
            "result": a.vysledek or "zaznamenano",
            "tool": a.volani or None,
            "arguments": {"druh": a.druh, "prepis": a.prepis, "ts": a.ts},
            "note": a.poznamka,
        }

        async def _send():
            try:
                await asyncio.to_thread(_post, self.event_url, self.event_token,
                                        payload, 5.0)
            except Exception as e:
                logger.info("ℹ️ anomálie do kroniky neprošla: %r", e)

        self._task_bezpecne(_send())

    def _naplanuj(self) -> None:
        if self._task is not None and not self._task.done():
            return
        self._task = self._task_bezpecne(self._odloz_a_posli())

    def _task_bezpecne(self, coro):
        try:
            return asyncio.create_task(coro)
        except RuntimeError:  # mimo smyčku (testy) — nic se neděje
            coro.close()
            return None

    def _smi_ted(self) -> bool:
        ted = time.monotonic()
        self._odeslane_casy = [t for t in self._odeslane_casy if ted - t < 3600.0]
        if len(self._odeslane_casy) >= self.max_za_hodinu:
            logger.warning("🚦 rozbor hovoru: strop %d/h vyčerpán — anomálie "
                           "zůstávají v kronice, Žána teď nebudím",
                           self.max_za_hodinu)
            return False
        return True

    async def _odloz_a_posli(self) -> None:
        # Debounce: dokud přilétají další nálezy téže výměny, čekej.
        while True:
            pocet = len(self._davka)
            await asyncio.sleep(self.debounce_s)
            if len(self._davka) == pocet:
                break

        cekat = self.min_odstup_s - (time.monotonic() - self._posledni_odeslano)
        if cekat > 0:
            await asyncio.sleep(cekat)

        davka, self._davka = self._davka, []
        if not davka or not self._smi_ted():
            return

        self._posledni_odeslano = time.monotonic()
        self._odeslane_casy.append(self._posledni_odeslano)
        text = self._text(davka)
        payload = {"text": text, "chat_id": str(self.chat_id),
                   "session_key": self.session_key}
        try:
            odpoved = await asyncio.to_thread(
                _post, self.ask_url, self.ask_token, payload, self.timeout_s
            )
        except (urllib.error.URLError, TimeoutError, OSError, ValueError) as e:
            logger.warning("⚠️ rozbor hovoru neprošel k Žánovi: %r", e)
            return
        vysledek = str(odpoved.get("result", "") or "").strip()
        logger.info("🧠 rozbor hovoru (%d nález/ů) → Žán odpověděl: %.400s",
                    len(davka), vysledek or "(prázdno)")

    def _text(self, davka: list[Anomalie]) -> str:
        radky = "\n".join(a.radek(i + 1) for i, a in enumerate(davka))
        return (
            "%s hlasový most hlásí %d anomálii/e z právě doběhlé výměny.\n"
            "Nejdřív si přečti svůj tahák %s a řiď se jím.\n\n"
            "%s\n\n"
            "Posuď u každé: byla to MOJE chyba (špatně jsem to vyhodnotil), "
            "CHYBA PŘEPISU (STT/wake word), nebo to ČLOVĚK TAK NEMYSLEL? "
            "Drobnou opravu, na kterou dosáhneš ve svém repu, udělej rovnou "
            "a řekni si o nasazení; větší zapiš jako nález do své fronty úkolů. "
            "Nikdy to mlčky nezahazuj. Odpověz stručně, tohle nikdo nahlas "
            "neposlouchá." % (PREFIX, len(davka), TAHAK, radky)
        )
