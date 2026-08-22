"""Rychlá dráha hlasu: průběhová fráze HNED, akce souběžně, tón po ověření.

Ondrův tok (22. 8. 2026, ústava Žána, Princip 2 „Ověř před uzavřením — ale
neblokuj řeč"):

1. **Průběhová fráze zazní okamžitě** („Rozsvěcuju.") — přehraje se
   z knihovny přednahraných frází, SOUČASNĚ s odpálením HA akce. Žádná
   blokující kontrola předem. Průběhová věta netvrdí výsledek, takže
   poctivosti nevadí.
2. HA akce.
3. **Stav se čte AŽ PO akci** (`unavailable`/`unknown` není úspěch).
4. Povedlo → krátký **tón** `tada` (rychlejší i levnější než věta).
   Nepovedlo → tón `chyba`, **jeden pokus znovu**; pořád ne → mluvené
   „Nepovedlo se mi to, zjišťuju proč." a diagnostika se deleguje na
   Žán-Code (model dostane instrukci zavolat `ask_zan`).
5. Každá akce rychlé dráhy se **zrcadlí do Žán-Code** (`POST /event`),
   ať mozek ví, co se v domě dělo, i když to sám neprováděl. Asynchronně,
   hlas na to nikdy nečeká.

Poctivost: VÝSLEDEK („rozsvíceno", tón úspěchu) nesmí zaznít bez ověření.
Když se stav ověřit nedá, zazní přesně to („Povel odešel, ale zařízení stav
nepotvrdilo."), ne úspěch.

Bezpečnost: citlivé cíle (zámky, alarm, brány/garážová vrata, kotel) sem
vůbec nedojdou — `voice_safety.is_sensitive_actuation()` je odřízne dřív,
takže se u nich NEPŘEHRÁVÁ ani průběhové „Odemykám.". Knihovna ty fráze má
(`citlivy: true` v index.json), ale rychlá dráha je odmítá pustit.
"""
import json
import logging
import os
import time
import unicodedata
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple

logger = logging.getLogger(__name__)

# Knihovna frází žije na /config Home Assistanta. Add-on ho vidí přes
# `map: homeassistant_config:ro` jako /homeassistant; /config je fallback pro
# prostředí, kde je namapovaný přímo.
PHRASE_DIRS = [
    os.environ.get("FASTLANE_PHRASES_DIR", "").strip(),
    "/homeassistant/zan_data/fraze",
    "/config/zan_data/fraze",
]
# Pipeline i přednahrané .pcm jedou na 24 kHz PCM16 mono (viz
# websocket_handler.PIPELINE_SAMPLE_RATE a generovat-fraze.js).
SAMPLE_RATE = 24000
# 20 ms audia = 480 vzorků = 960 bajtů. Stejná zrnitost, jakou posílá OpenAI.
CHUNK_BYTES = 960

HA_BASE = os.environ.get("HA_BASE_URL", "http://supervisor/core/api")

# Kolik a jak dlouho po akci číst stav, než to prohlásíme za nepotvrzené.
VERIFY_TRIES = 4
VERIFY_DELAY_S = 0.35

_UNKNOWN = ("unavailable", "unknown", "none", "")


def _norm(text: str) -> str:
    """Malá písmena bez diakritiky — na porovnávání jmen a místností."""
    nfkd = unicodedata.normalize("NFKD", str(text))
    return "".join(c for c in nfkd if not unicodedata.combining(c)).lower().strip()


def _slug(text: str) -> str:
    """Stejná pravidla jako `slugify()` v generovat-fraze.js — klíče musí sedět."""
    base = _norm(text)
    out = []
    prev_dash = False
    for ch in base:
        if ch.isalnum() and ch.isascii():
            out.append(ch)
            prev_dash = False
        elif not prev_dash:
            out.append("-")
            prev_dash = True
    return "".join(out).strip("-")[:60]


# ---------------------------------------------------------------------------
# Knihovna přednahraných frází
# ---------------------------------------------------------------------------


class PhraseLibrary:
    """Přednahrané fráze a tóny z `zan_data/fraze/index.json`.

    Načítá se jednou při startu, PCM se drží v paměti (celá knihovna je řádově
    jednotky MB), takže přehrání stojí nula latence a nula peněz.
    """

    def __init__(self) -> None:
        self.dir: Optional[str] = None
        self.index: Dict[str, Any] = {}
        self.audio: Dict[str, bytes] = {}
        self.sensitive: set = set()
        self.load()

    def load(self) -> None:
        for d in PHRASE_DIRS:
            if not d:
                continue
            idx = os.path.join(d, "index.json")
            if not os.path.isfile(idx):
                continue
            try:
                with open(idx, "r", encoding="utf-8") as fh:
                    self.index = json.load(fh)
            except Exception as e:
                logger.warning("⚠️ knihovna frází %s se nedá přečíst: %r", idx, e)
                continue
            self.dir = d
            break

        if not self.dir:
            logger.warning(
                "⚠️ knihovna přednahraných frází nenalezena (%s) — rychlá dráha "
                "bude mluvit živě modelem",
                ", ".join(p for p in PHRASE_DIRS if p),
            )
            return

        zamery = self.index.get("zamery") or {}
        polozky = self.index.get("polozky") or {}
        loaded = 0
        for zamer, fname in zamery.items():
            if (polozky.get(zamer) or {}).get("citlivy"):
                # Zámky/brány/kotel: fráze existuje, ale rychlá dráha ji nesmí
                # pustit — ten cíl jde vždy přes ask_zan s potvrzením.
                self.sensitive.add(zamer)
                continue
            path = os.path.join(self.dir, fname)
            try:
                with open(path, "rb") as fh:
                    data = fh.read()
                if data:
                    self.audio[zamer] = data
                    loaded += 1
            except Exception as e:
                logger.warning("⚠️ fráze %s (%s) nešla načíst: %r", zamer, fname, e)

        logger.info(
            "🔊 knihovna frází: %d záměrů z %s (hlas %s), %d citlivých vynecháno",
            loaded, self.dir, self.index.get("hlas", "?"), len(self.sensitive),
        )

    def get(self, zamer: str) -> Optional[bytes]:
        """PCM přednahrané fráze, nebo None (pak se mluví živě)."""
        return self.audio.get(zamer)

    def has(self, zamer: str) -> bool:
        return zamer in self.audio


# ---------------------------------------------------------------------------
# Plán rychlé dráhy — co říct a co pak ověřit
# ---------------------------------------------------------------------------


@dataclass
class FastPlan:
    """Jak se má tenhle povel odbavit na rychlé dráze."""

    progress: str              # záměr průběhové fráze („rozsvecuju")
    domains: Tuple[str, ...]   # domény, jejichž stav se po akci čte
    expect: Optional[str]      # očekávaný stav ('on'/'off'/'playing'/'paused')
    attr: Optional[str] = None # nebo atribut, jehož změna je důkazem (volume_level)
    label: str = ""            # lidský popis pro zrcadlení do Žán-Code
    target: str = ""           # co uživatel pojmenoval (name/area) — na dohledání
    area: str = ""


# Jen povely, u kterých si jsme jistí, co má být po akci vidět ve stavu.
# Cokoli jiného jde starou cestou (model mluví sám) — radši nic neslibovat.
_LIGHT_HINTS = ("svetl", "lamp", "lustr", "led", "osvetlen")
_MEDIA_HINTS = ("hudb", "muzik", "spotify", "radio", "reprak", "televiz", "tv")


def classify(function_name: str, arguments: Optional[Dict[str, Any]]) -> Optional[FastPlan]:
    """Z volání nástroje odvodí plán rychlé dráhy, nebo None (běžná cesta)."""
    args = arguments or {}
    name = str(args.get("name") or "")
    area = str(args.get("area") or "")
    domain = _norm(args.get("domain") or "")
    hay = _norm(f"{name} {area} {domain}")
    target = name or area

    def guess() -> str:
        """Světlo / přehrávač / obyčejný spínač. Explicitní `domain` má přednost
        před nápovědou ze jména — „Zásuvka lampa" s domain=switch je zásuvka."""
        if domain:
            if "light" in domain:
                return "light"
            if "media_player" in domain:
                return "media"
            return "switch"
        if any(h in hay for h in _LIGHT_HINTS):
            return "light"
        if any(h in hay for h in _MEDIA_HINTS):
            return "media"
        return "switch"

    if function_name in ("HassTurnOn", "HassLightSet"):
        kind = "light" if function_name == "HassLightSet" else guess()
        if kind == "light":
            return FastPlan("rozsvecuju", ("light",), "on",
                            label="rozsvítit", target=target, area=area)
        if kind == "media":
            return FastPlan("poustim_hudbu", ("media_player",), "playing",
                            label="pustit", target=target, area=area)
        return FastPlan("zapinam", ("switch", "light"), "on",
                        label="zapnout", target=target, area=area)

    if function_name == "HassTurnOff":
        kind = guess()
        if kind == "light":
            return FastPlan("zhasinam", ("light",), "off",
                            label="zhasnout", target=target, area=area)
        if kind == "media":
            return FastPlan("zastavuju_hudbu", ("media_player",), "off",
                            label="vypnout", target=target, area=area)
        return FastPlan("vypinam", ("switch", "light"), "off",
                        label="vypnout", target=target, area=area)

    if function_name in ("HassMediaUnpause", "HassMediaSearchAndPlay"):
        return FastPlan("poustim_hudbu", ("media_player",), "playing",
                        label="pustit hudbu", target=target, area=area)
    if function_name == "HassMediaPause":
        return FastPlan("zastavuju_hudbu", ("media_player",), "paused",
                        label="pauza", target=target, area=area)
    if function_name in ("HassSetVolume", "HassSetVolumeRelative"):
        return FastPlan("ztlumuju", ("media_player",), None, attr="volume_level",
                        label="hlasitost", target=target, area=area)

    return None


def room_variant(library: PhraseLibrary, plan: FastPlan) -> str:
    """Když je pro danou místnost přednahraná CELÁ věta, použij ji.

    Nikdy se neslepuje „Rozsvěcuju" + „v" + „obýváku" — čeština skloňuje a
    slepenec zní strojově (závěr z 22. 8.). Buď máme hotovou větu pro tu
    místnost, nebo se řekne univerzální „Rozsvěcuju.".
    """
    room = plan.area or plan.target
    if not room:
        return plan.progress
    cand = f"{plan.progress}__{_slug(room)}"
    return cand if library.has(cand) else plan.progress


# ---------------------------------------------------------------------------
# Čtení stavu z Home Assistanta (ověření PO akci)
# ---------------------------------------------------------------------------


def _ha_token() -> str:
    return os.environ.get("LONGLIVED_TOKEN") or os.environ.get("SUPERVISOR_TOKEN") or ""


def fetch_states(domains: Tuple[str, ...]) -> Dict[str, Tuple[str, Any, str]]:
    """Stavy entit vybraných domén: entity_id → (state, attr_volume, friendly_name).

    Blokující (urllib) — volá se přes `asyncio.to_thread`, ať to nezdrží smyčku.
    """
    token = _ha_token()
    req = urllib.request.Request(
        f"{HA_BASE}/states",
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=8) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    out: Dict[str, Tuple[str, Any, str]] = {}
    for s in data:
        eid = s.get("entity_id", "")
        if eid.split(".")[0] in domains:
            attrs = s.get("attributes") or {}
            out[eid] = (
                str(s.get("state", "")),
                attrs.get("volume_level"),
                str(attrs.get("friendly_name") or ""),
            )
    return out


def judge(pre: Dict[str, Tuple[str, Any, str]],
          post: Dict[str, Tuple[str, Any, str]],
          plan: FastPlan) -> str:
    """Verdikt z porovnání stavu PŘED a PO: 'ok' | 'fail' | 'unconfirmed'.

    - `ok`         — pojmenovaná entita je v očekávaném stavu, nebo se do něj
                     něco prokazatelně přepnulo.
    - `fail`       — pojmenovaná entita je v JINÉM stavu (nebo unavailable).
    - `unconfirmed`— nic se nezměnilo a nemáme, čím to potvrdit. Tohle NENÍ
                     úspěch: řekne se „povel odešel, ale zařízení stav
                     nepotvrdilo" (ústava, Princip 2).
    """
    want = plan.expect
    needle = _norm(plan.target)

    matched = []
    if needle:
        for eid, (state, vol, fname) in post.items():
            if needle and (needle in _norm(fname) or needle in _norm(eid)):
                matched.append(eid)

    if plan.attr == "volume_level":
        pool = matched or list(post.keys())
        for eid in pool:
            if eid in pre and pre[eid][1] != post[eid][1] and post[eid][1] is not None:
                return "ok"
        return "unconfirmed"

    if matched:
        states = [post[e][0] for e in matched]
        if any(s == want for s in states):
            return "ok"
        if all(s in _UNKNOWN for s in states):
            return "fail"
        return "fail"

    changed_into = [
        eid for eid, val in post.items()
        if pre.get(eid, ("",))[0] != val[0] and val[0] == want
    ]
    if changed_into:
        return "ok"
    changed_any = [eid for eid, val in post.items() if pre.get(eid, ("",))[0] != val[0]]
    if changed_any:
        # Něco se hnulo, ale ne do žádaného stavu → to je selhání, ne úspěch.
        return "fail"
    return "unconfirmed"


# ---------------------------------------------------------------------------
# Zrcadlení do Žán-Code (POST /event) — mozek ať ví, co se v domě dělo
# ---------------------------------------------------------------------------


def _post_event_blocking(url: str, token: str, payload: dict, timeout: float = 5.0) -> None:
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        resp.read()


def event_url(zan_voice_url: str) -> str:
    """Z `…/voice` udělá `…/event` (jiný endpoint téhož Žán-Code serveru)."""
    if not zan_voice_url:
        return ""
    return zan_voice_url.rsplit("/", 1)[0] + "/event"


def build_event(plan: FastPlan, function_name: str, arguments: Optional[Dict[str, Any]],
                result: str, note: str = "") -> dict:
    return {
        "source": "voice-fastlane",
        "entity": plan.target or plan.area or "",
        "action": plan.label or function_name,
        "result": result,
        "tool": function_name,
        "arguments": arguments or {},
        "note": note,
        "ts": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
    }
