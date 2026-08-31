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
import re
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


# ---------------------------------------------------------------------------
# Oprava oblasti: model umí poslat anglický slug místo české oblasti
# ---------------------------------------------------------------------------

#: Anglický název oblasti → české slovo, pod kterým ji hledáme v HA.
#:
#: PROČ (31. 8. 2026, 10:17, Ondra: „vypnutí světel nešlo a nechce to udělat"):
#:
#:   🗣️ user: Vypni světla v obýváku.
#:   Calling function [HassTurnOff:…] with arguments
#:       {'area': 'living_room', 'domain': ['light']}
#:   Final response: Error calling tool: <MatchFailedError …
#:       no_match_reason=<MatchFailedReason.INVALID_AREA: 9>
#:
#: Model si „obývák" přeložil do angličtiny. V HA je oblast `obyvak` =
#: „Obývák", žádný `living_room` neexistuje, takže povel spadl na neplatné
#: oblasti — a navenek to vypadalo, že Žán „nechce" poslechnout.
#:
#: Přepisuje se JEN tehdy, když v domě opravdu existuje právě jeden
#: odpovídající kandidát. Když je kandidátů víc (koupelna dolní/horní) nebo
#: žádný, argument se nechá být — radši poctivé selhání než tipovat pokoj.
_ANGLICKE_OBLASTI = {
    "living_room": "obyvak", "livingroom": "obyvak", "living room": "obyvak",
    "lounge": "obyvak",
    "kitchen": "kuchyne",
    "bedroom": "loznice",
    "bathroom": "koupelna",
    "hall": "chodba", "hallway": "chodba", "corridor": "chodba",
    "attic": "puda",
    "cellar": "sklep", "basement": "sklep",
    "terrace": "terasa",
    "yard": "dvur", "courtyard": "dvur",
    "laundry": "pradelka",
    "pantry": "spajzka",
    "storage": "sklad", "storeroom": "sklad",
    "toilet": "zachod", "wc": "zachod",
    "utility_room": "technicka-mistnost",
    # Doplněno 31. 8. po kontrole proti živému seznamu: garáž, dílna i
    # zahrada v domě JSOU (do prvního výpisu se nevešly, `head -25` je
    # uřízl a já z toho ukvapeně napsal „garáž v domě není").
    "garage": "garaz",
    "workshop": "dilna",
    "garden": "zahrada",
}

#: Oblasti z HA se čtou jednou za tenhle čas (dům je nepřestavuje každou chvíli).
_OBLASTI_TTL_S = 300.0
_oblasti_cache: Dict[str, Any] = {"t": 0.0, "seznam": []}


def fetch_areas() -> List[Tuple[str, str]]:
    """Skutečné oblasti domu: [(id, název), …]. Cachované, chyba = prázdno."""
    now = time.time()
    if _oblasti_cache["seznam"] and now - _oblasti_cache["t"] < _OBLASTI_TTL_S:
        return _oblasti_cache["seznam"]
    sablona = "{% for a in areas() %}{{ a }}\t{{ area_name(a) }}\n{% endfor %}"
    req = urllib.request.Request(
        f"{HA_BASE}/template",
        data=json.dumps({"template": sablona}).encode("utf-8"),
        headers={"Authorization": f"Bearer {_ha_token()}",
                 "Content-Type": "application/json"},
        method="POST")
    try:
        with urllib.request.urlopen(req, timeout=6) as resp:
            text = resp.read().decode("utf-8")
    except Exception as e:
        logger.warning("⚠️ oblasti z HA nejdou přečíst: %r", e)
        return _oblasti_cache["seznam"]
    seznam = []
    for radek in text.splitlines():
        if "\t" in radek:
            ident, _, nazev = radek.partition("\t")
            if ident.strip():
                seznam.append((ident.strip(), nazev.strip()))
    if seznam:
        _oblasti_cache.update({"t": now, "seznam": seznam})
    return seznam


def oprav_area(hodnota: str) -> Optional[str]:
    """Anglický/nepřesný název oblasti → skutečný název z HA, nebo None.

    None = neměnit (buď to sedí, nebo nevíme — a tipovat pokoj se nesmí).
    """
    syrove = str(hodnota or "").strip()
    if not syrove:
        return None
    oblasti = fetch_areas()
    if not oblasti:
        return None
    hledane = _norm(syrove)
    # Už to sedí na id nebo název? Pak nic neopravujeme.
    for ident, nazev in oblasti:
        if hledane in (_norm(ident), _norm(nazev)):
            return None
    klic = _ANGLICKE_OBLASTI.get(hledane) or _ANGLICKE_OBLASTI.get(
        hledane.replace("_", " "))
    if not klic:
        return None
    kandidati = [
        (ident, nazev) for ident, nazev in oblasti
        if _norm(ident) == klic or _norm(nazev) == klic
        or _norm(ident).startswith(klic + "_") or _norm(nazev).startswith(klic + " ")
    ]
    if len(kandidati) != 1:
        # Nula = takový pokoj v domě není. Víc = nevíme který (koupelna
        # dolní/horní). Obojí = nechat spadnout poctivě, ne tipovat.
        logger.info("ℹ️ oblast %r → %r: kandidátů %d, nechávám být",
                    syrove, klic, len(kandidati))
        return None
    return kandidati[0][1]


# ---------------------------------------------------------------------------
# Sekce „Dům" do promptu — skutečná jména, ne domněnky modelu
# ---------------------------------------------------------------------------

#: Kde žijí Žánovy vlastní rejstříky. Most vidí /config Home Assistanta jako
#: /homeassistant (read-only mount); /config je fallback.
ZAN_DATA_DIRS = ("/homeassistant/zan_data", "/config/zan_data")


def _cti_zan_data(relativni: str) -> str:
    for d in ZAN_DATA_DIRS:
        cesta = os.path.join(d, relativni)
        if os.path.isfile(cesta):
            try:
                with open(cesta, "r", encoding="utf-8") as fh:
                    return fh.read()
            except OSError as e:
                logger.warning("⚠️ %s se nedá přečíst: %r", cesta, e)
    return ""


def _tucna_jmena(text: str, stop_nadpis: str = "") -> List[str]:
    """Jména z odrážek `- **Jméno** — …`.

    Oba rejstříky mají tenhle tvar jako VLASTNÍ psané pravidlo („Jeden řádek
    na kus/místnost"), takže se parsuje jejich konvence, ne náhodný tvar.
    """
    jmena = []
    for radek in text.splitlines():
        if stop_nadpis and radek.strip().startswith(stop_nadpis):
            break
        m = re.match(r"\s*-\s+\*\*(.+?)\*\*", radek)
        if m:
            jmeno = m.group(1).strip()
            if jmeno and jmeno not in jmena:
                jmena.append(jmeno)
    return jmena


def sekce_dum() -> str:
    """Blok do systémového promptu: skutečné místnosti a zařízení domu.

    PROČ (31. 8. 2026, 10:17): model si „obývák" přeložil na `living_room`,
    HA povel odmítla (`INVALID_AREA`) a navenek to vypadalo, že Žán nechce
    poslechnout. Nebyla to chyba chování, ale chyba ZNALOSTI — seznam
    pokojů nikdy neviděl. Ondra na to: „A Žán má už tahák — má půdorys a má
    Žapku a má teď i HA!!!" Má pravdu: nečeká se na nic, ta znalost existuje.

    Skládá se ze tří ŽIVÝCH zdrojů, nikdy z natvrdo psaného seznamu:
      * oblasti z Home Assistanta (`fetch_areas`) — jediná autorita na to,
        jak se místnosti doopravdy jmenují,
      * `zan_data/zarizeni/REJSTRIK.md` — lidská jména kusů HW,
      * `zan_data/dum/MISTNOSTI.md` — místnosti, o kterých Žán něco ví.

    Jen JMÉNA, žádné popisy: prompt se posílá v každém kole, takže se platí
    za každé slovo znovu.
    """
    casti = []

    oblasti = fetch_areas()
    if oblasti:
        nazvy = ", ".join(n for _, n in oblasti)
        casti.append(
            "MÍSTNOSTI (jediné, které v domě existují): " + nazvy + ".\n"
            "Do nástroje piš přesně tenhle český název. NIKDY ho nepřekládej "
            "do angličtiny („living_room\" neexistuje, je to „Obývák\") a "
            "nevymýšlej si pokoje, které v seznamu nejsou — na takový se zeptej."
        )

    zarizeni = _tucna_jmena(_cti_zan_data("zarizeni/REJSTRIK.md"))
    if zarizeni:
        casti.append("ZAŘÍZENÍ, která znám jménem: " + ", ".join(zarizeni) + ".")

    mistnosti = _tucna_jmena(_cti_zan_data("dum/MISTNOSTI.md"),
                             stop_nadpis="## Co tu ještě není")
    if mistnosti:
        casti.append("MÍSTNOSTI, o kterých mám poznámky: " + ", ".join(mistnosti) + ".")

    if not casti:
        logger.warning("⚠️ sekce DŮM je prázdná — model zůstává bez jmen domu")
        return ""
    return "DŮM:\n" + "\n".join(casti) + "\n\n"


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


def build_exchange_event(kdo: str, text_user: str, text_asistent: str) -> dict:
    """Zápis JEDNÉ konverzační výměny do denní paměti (karta -zana-12, bod
    „most Realtime: … zapisovat i výměny vyřízené Realtime sám").

    Realtime session je efemérní — co model vyřídí sám (small talk, žádný
    `delegate_task`/HA nástroj), do denní paměti jinak vůbec nedoteče a
    noční kompilace (`zan-code-server.js: runPametExtrakce`) má slepou
    skvrnu. Tenhle záznam jde do stejného `POST /event` a stejného
    `zan_data/udalosti.jsonl` jako akce rychlé dráhy (`build_event` výše),
    jen s `typ: "vymena"` — server ho z večerního souhrnu akcí vyřadí
    (viz `buildDenik` filtr `u.typ !== 'vymena'`), ale noční paměťová
    extrakce čte celý soubor a výměnu uvidí.
    """
    return {
        "typ": "vymena",
        "source": "voice-realtime",
        "kanal": "realtime",
        "kdo": kdo or "voice",
        "text_user": text_user or "",
        "text_asistent": text_asistent or "",
        "ts": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
    }
