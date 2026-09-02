"""Čisté převodní funkce pro Gemini Live pusu — BEZ třetích stran.

Schválně nemá jediný import mimo standardní knihovnu: díky tomu jde tenhle
modul (a jeho testy, ``tests/test_gemini_tools.py``) spustit i tam, kde není
nainstalovaný pipecat ani ``google-genai`` — tedy i na Ondrově Windows stroji
bez kontejneru. Vše, co potřebuje pipecat/google typy, žije vedle
v ``app/gemini_safety.py``.

Co se tu převádí:

* **schémata nástrojů** — most drží nástroje v OpenAI Realtime tvaru
  (``{"type": "function", "name": …, "parameters": {…}}``), protože z něj
  vychází i HA MCP větev. Gemini Live chce ``functionDeclarations`` bez
  obalu ``type`` a bez některých JSON-Schema klíčů.
* **VAD** — Gemini Live nemá sémantický VAD jako OpenAI, jen tichem řízený
  (``GeminiVADParams``). ``VAD_EAGERNESS`` se proto překládá na dvojici
  „citlivost konce řeči + délka ticha".

Důkazy k tvaru schématu (sonda 30. 8. 2026, ``gemini-3.1-flash-live-preview``,
14 volání Live API v kontejneru ``zan-realtime``):

* běh A1: ``[0.41s] {"toolCall": {"functionCalls": [{"name": "zapni_svetlo",
  "args": {"mistnost": "obývák"}, …}]}}`` — ``>>> TOOLCALL po 413 ms``
  s původním schématem OBJECT/STRING (VELKÝMI písmeny),
* běh C3: totéž schéma malými písmeny (``object``/``string``) server přijal
  bez chyby. Rozdíl v chování se nenaměřil, takže tady generujeme malá
  písmena — shodně s pipecatím ``GeminiLLMAdapter``.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional

#: JSON-Schema klíče, které Gemini Live v deklaraci funkce NECHCE. Pipecatí
#: ``GeminiLLMAdapter`` škrtá ``additionalProperties``; ostatní jsou
#: metadatová vata z MCP schémat, která pro chování modelu nic neznamenají
#: (``title``/``$schema``/``examples``) nebo ji Gemini Schema nezná
#: (``default``, ``$ref``). Sémantické klíče (``enum``, ``items``,
#: ``properties``, ``required``, ``description``, ``type``, ``format``,
#: ``nullable``, ``minimum``, ``maximum``) se NIKDY nezahazují.
DROPPED_SCHEMA_KEYS = frozenset(
    {"additionalProperties", "$schema", "$ref", "title", "default", "examples"}
)

#: Překlad ``VAD_EAGERNESS`` (OpenAI slovník, který si Ondra už nastavil)
#: na Gemini tichem řízený VAD. ``low`` = čeká nejdéle, než prohlásí promluvu
#: za ukončenou → nejméně useknutých vět uprostřed.
#:
#: Délky ticha vychází z průvodce Live API („silenceDurationMs 500–800 ms;
#: pod 200 ms se promluva trhá na fragmenty") a z měření sondy: s čistým
#: server VAD přišel toolCall za 525 ms, což byla nejrychlejší varianta ze
#: všech 14 běhů.
#: ``start_sensitivity`` (2. 9. 2026): most ho dosud NENASTAVOVAL vůbec,
#: takže začátek řeči řešil server po svém. ``START_SENSITIVITY_HIGH``
#: znamená „chytej začátek dřív" — první slabika po probuzení se pak
#: neztratí. Je to druhá půlka téhož nastavení: konec citlivý MÁLO (ať
#: neutíná), začátek citlivý HODNĚ (ať nic nezmešká).
VAD_EAGERNESS_PLANS: Dict[str, Dict[str, Optional[object]]] = {
    # `low` = to, co dům jede: nejdelší ticho, tedy nejmíň useknutých vět.
    # 1000 → 1200 ms (2. 9. 2026): vlastník hlásil „neposlouchá dlouho
    # a utne se mi". Průvodce Live API dává 500–800 ms jako běžné pásmo;
    # dítě i dospělý v půlce věty dělají pauzu delší, a cena omylu je tady
    # nesymetrická — o 400 ms delší čekání nikdo nepozná, useknutou větu ano.
    "low": {"end_sensitivity": "END_SENSITIVITY_LOW",
            "start_sensitivity": "START_SENSITIVITY_HIGH",
            "silence_duration_ms": 1200},
    "medium": {"end_sensitivity": "END_SENSITIVITY_LOW",
               "start_sensitivity": "START_SENSITIVITY_HIGH",
               "silence_duration_ms": 800},
    "high": {"end_sensitivity": "END_SENSITIVITY_HIGH",
             "start_sensitivity": "START_SENSITIVITY_HIGH",
             "silence_duration_ms": 500},
    # „auto" = nechat rozhodnout server, jen rozumná délka ticha.
    "auto": {"end_sensitivity": None, "start_sensitivity": None,
             "silence_duration_ms": 800},
}

#: Pod tuhle hranici se ticho nepustí ani na výslovné přání — Live API
#: průvodce varuje, že kratší okno trhá jednu promluvu na fragmenty.
MIN_SILENCE_DURATION_MS = 200

#: Výchozí model a hlas gemini pusy. Model se drží v env, ať jde přepnout
#: bez zásahu do kódu (``ZAN_GEMINI_MODEL`` / ``ZAN_GEMINI_VOICE``).
DEFAULT_GEMINI_MODEL = "gemini-3.1-flash-live-preview"
DEFAULT_GEMINI_VOICE = "Fenrir"


def normalize_model_name(model: str) -> str:
    """``gemini-3.1-flash-live-preview`` → ``models/gemini-3.1-flash-live-preview``.

    pipecat i ``google-genai`` očekávají u Live API jméno s prefixem
    ``models/`` (výchozí hodnota v pipecatu je ``models/gemini-2.0-flash-live-001``).
    Kdo si do env napíše plné jméno včetně prefixu, dostane ho zpátky beze změny.
    """
    name = (model or "").strip() or DEFAULT_GEMINI_MODEL
    return name if name.startswith("models/") else f"models/{name}"


def _clean_schema(node: Any) -> Any:
    """Rekurzivně vyhodí klíče z ``DROPPED_SCHEMA_KEYS``; zbytek nechá být."""
    if isinstance(node, dict):
        return {
            key: _clean_schema(value)
            for key, value in node.items()
            if key not in DROPPED_SCHEMA_KEYS
        }
    if isinstance(node, list):
        return [_clean_schema(item) for item in node]
    return node


def to_gemini_function_declarations(openai_tools: Optional[List[Dict[str, Any]]]
                                    ) -> List[Dict[str, Any]]:
    """OpenAI Realtime tvar nástrojů → Gemini ``functionDeclarations``.

    Vstup je seznam slovníků, jak je most skládá v ``main.py``
    (``get_ask_zan_tool_definition()``, ``get_web_search_tool_definition()``,
    HA MCP nástroje). Přijímá i vnořený Chat-Completions tvar
    (``{"type": "function", "function": {…}}``), aby se na něm nikdo nespálil.

    Pravidla:

    * co nemá jméno, se přeskočí (nemá se čím zavolat),
    * ``required`` se profiltruje na klíče, které opravdu existují v
      ``properties`` — Gemini na neexistující povinný parametr odpoví chybou
      setupu a spadl by celý setup, ne jen ten jeden nástroj,
    * nástroj bez parametrů se pošle BEZ klíče ``parameters`` (prázdný
      objektový schéma je zbytečný a některé verze API ho odmítají),
    * jméno se nesmí opakovat — druhý výskyt se zahodí a je vidět ve
      vráceném seznamu jen jednou.
    """
    declarations: List[Dict[str, Any]] = []
    seen: set = set()

    for tool in openai_tools or []:
        if not isinstance(tool, dict):
            continue
        # Chat-Completions tvar {"type": "function", "function": {...}}
        body = tool.get("function") if isinstance(tool.get("function"), dict) else tool
        tool_type = tool.get("type")
        if tool_type is not None and tool_type != "function":
            continue  # vestavěné nástroje (web_search_preview apod.) sem nepatří
        name = str(body.get("name") or "").strip()
        if not name or name in seen:
            continue
        seen.add(name)

        parameters = body.get("parameters") or {}
        properties = parameters.get("properties") or {}
        if not isinstance(properties, dict):
            properties = {}
        required = [
            key for key in (parameters.get("required") or [])
            if isinstance(key, str) and key in properties
        ]

        declaration: Dict[str, Any] = {
            "name": name,
            "description": str(body.get("description") or ""),
        }
        if properties:
            declaration["parameters"] = {
                "type": "object",
                "properties": _clean_schema(properties),
                "required": required,
            }
        declarations.append(declaration)

    return declarations


def vad_plan(eagerness: Optional[str],
             silence_duration_ms: Optional[int] = None,
             prefix_padding_ms: Optional[int] = None) -> Dict[str, Optional[object]]:
    """``VAD_EAGERNESS`` (+ volitelné přepisy) → plán pro ``GeminiVADParams``.

    Vrací čistý slovník s klíči ``end_sensitivity`` (název konstanty jako
    text, nebo ``None`` = nenastavovat), ``silence_duration_ms`` a
    ``prefix_padding_ms`` (``None`` = nenastavovat). Převod textu na enum
    ``google.genai.types.EndSensitivity`` dělá ``app/gemini_safety.py`` —
    tenhle modul zůstává bez závislostí.

    Neznámá eagerness spadne na ``low``, protože to je nastavení, které Ondra
    v mostě reálně jede (nejméně useknutých vět).
    """
    key = (eagerness or "").strip().lower()
    plan = dict(VAD_EAGERNESS_PLANS.get(key, VAD_EAGERNESS_PLANS["low"]))

    if silence_duration_ms is not None:
        try:
            plan["silence_duration_ms"] = max(MIN_SILENCE_DURATION_MS, int(silence_duration_ms))
        except (TypeError, ValueError):
            pass

    plan["prefix_padding_ms"] = None
    if prefix_padding_ms is not None:
        try:
            plan["prefix_padding_ms"] = max(0, int(prefix_padding_ms))
        except (TypeError, ValueError):
            plan["prefix_padding_ms"] = None

    return plan
