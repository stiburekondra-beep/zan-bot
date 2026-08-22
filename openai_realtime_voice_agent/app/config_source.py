"""Jeden zdroj konfigurace pro DVA světy: HA add-on i obyčejný Docker kontejner.

Proč to je: v add-onu ukládá Supervisor volby z Configuration tabu do
``/data/options.json`` (klíče přesně jako ``options:`` v ``config.yaml``) a
``root/run.sh`` je přes ``bashio::config`` překlápí do env proměnných. Na
Ubuntu krabici po migraci z HAOS žádný Supervisor ani bashio není — most tam
běží jako obyčejný kontejner a konfigurace přijde z env proměnných (docker
``env_file``). Jméno proměnné = klíč VELKÝMI PÍSMENY:
``zan_voice_url`` → ``ZAN_VOICE_URL``.

Pořadí zdrojů (jeden kód pro oba světy):

1. ``/data/options.json``, pokud existuje  → svět add-onu, vyhrává,
2. env proměnná                            → svět kontejneru (a ``.env``),
3. výchozí hodnota z ``config.yaml``       → tabulka ``OPTION_DEFAULTS``.

``apply_to_environ()`` z toho poskládá env proměnné a zbytek aplikace
(``main.py``, ``phase_emitter``, ``voice_fastlane``) čte dál ``os.environ``
jako dosud. **V add-onu se tím nic nemění**: hodnoty jsou tytéž, které do env
dával ``run.sh`` — včetně jeho dvou pravidel (prázdné ``ha_mcp_url`` se
NEexportuje, aby platil výchozí ``http://supervisor/core/api/mcp``, a
volitelné klíče bez defaultu se exportují jen když jsou opravdu nastavené,
jinak by literál ``null`` rozbil ``float()``/``int()`` v main.py).

``run.sh`` zůstává beze změny (add-on ho pořád spouští), jen už na něm nestojí
život — kdyby zmizel, add-on poběží dál z ``/data/options.json``.
"""

from __future__ import annotations

import json
import logging
import os
from typing import Dict, List, Optional

logger = logging.getLogger(__name__)

#: Kde hledat volby add-onu. Přebitelné kvůli testům (``ZAN_OPTIONS_PATH``).
DEFAULT_OPTIONS_PATH = "/data/options.json"

#: Výchozí hodnoty = ZRCADLO ``options:`` z ``config.yaml`` (jako text, protože
#: cílem jsou env proměnné). ``tests/test_config_source.py`` hlídá, že se tahle
#: tabulka s config.yaml nerozejde.
OPTION_DEFAULTS: Dict[str, str] = {
    # --- Basics ---
    'openai_api_key': '',
    'instructions': 'You are the cheerful, friendly voice assistant of Home Assistant and you control the smart home. LANGUAGE: Speak and understand only English, with a natural, neutral accent. Never switch language, not even for stray foreign words or an accent; do not infer the language from accent or a single word. STYLE: Your replies are read aloud, so keep them short and natural. Do not read out entity IDs, lists, or technical names; use ordinary names ("the bedroom lamp"). Call your tools silently — say nothing like "Okay, let me check" or "one moment" beforehand; just do it and then give one complete answer. Do not start every answer with "Okay"; vary your confirmation naturally, e.g. "The bedroom lamp is on now" or "Done, the light is off". BEHAVIOR: Carry out requested actions immediately with your tools and never guess. If you are unsure which device, room, or action is meant, ask a short clarifying question first. If something fails, briefly say what went wrong.',
    'transcription_language': '',
    # --- Model & voice ---
    'openai_model': 'gpt-realtime-2',
    'openai_voice': 'marin',
    'openai_speed': '1.0',
    'max_output_tokens': '0',
    # --- Conversation ---
    'follow_up_listen_seconds': '8',
    'follow_up_open_delay_ms': '700',
    'wake_open_delay_ms': '700',
    'vad_eagerness': 'low',
    'phase_idle_debounce_ms': '1500',
    # --- Web search ---
    'enable_web_search': 'true',
    'web_search_model': 'gpt-5.5',
    # --- Audio ---
    'playback_prebuffer_ms': '150',
    'noise_reduction': 'off',
    # --- Home Assistant ---
    'ha_mcp_url': '',
    'longlived_token': '',
    'mcp_tool_allowlist': '',
    'zan_bridge_enabled': 'false',
    'zan_voice_url': 'http://127.0.0.1:8099/voice',
    'zan_voice_token': '',
    'zan_voice_chat_id': '',
    # --- Advanced ---
    'websocket_port': '8080',
    'session_reuse_timeout_seconds': '300',
    'max_context_messages': '12',
    'transcription_model': 'gpt-4o-transcribe',
    # --- Debug ---
    'enable_recording': 'false',
}

#: Volitelné klíče BEZ defaultu (v config.yaml schéma ``str?`` / skryté escape
#: hatche). Exportují se jen když jsou opravdu nastavené — přesně jako
#: ``bashio::config.has_value`` v run.sh.
OPTIONAL_KEYS = (
    "openai_model_custom",
    "openai_voice_custom",
    "web_search_model_custom",
    "transcription_model_custom",
    "turn_detection_type",
    "vad_threshold",
    "vad_prefix_padding_ms",
    "vad_silence_duration_ms",
)

#: Klíče, kde prázdná hodnota znamená „nenastaveno" — nesmí se exportovat,
#: protože prázdný string by v main.py přebil jeho vlastní výchozí hodnotu.
EMPTY_MEANS_UNSET = frozenset({"ha_mcp_url"})

_options_cache: Optional[Dict[str, object]] = None
_options_loaded = False


def options_path() -> str:
    """Cesta k options.json (env ``ZAN_OPTIONS_PATH`` má přednost — testy)."""
    return os.environ.get("ZAN_OPTIONS_PATH", DEFAULT_OPTIONS_PATH)


def reset_cache() -> None:
    """Zapomenout načtený options.json (jen pro testy)."""
    global _options_cache, _options_loaded
    _options_cache = None
    _options_loaded = False


def _load_options() -> Dict[str, object]:
    """Načíst ``/data/options.json``; když není (kontejner), vrátit prázdno."""
    global _options_cache, _options_loaded
    if _options_loaded:
        return _options_cache or {}
    _options_loaded = True
    path = options_path()
    try:
        with open(path, "r", encoding="utf-8") as handle:
            data = json.load(handle)
        if not isinstance(data, dict):
            logger.warning("⚠️ %s není objekt — ignoruju a jedu z env", path)
            data = {}
        _options_cache = data
    except FileNotFoundError:
        _options_cache = {}
    except (OSError, ValueError) as exc:
        # Rozbitý options.json nesmí shodit start: raději env + defaulty.
        logger.warning("⚠️ %s se nepodařilo přečíst (%s) — jedu z env", path, exc)
        _options_cache = {}
    return _options_cache or {}


def source() -> str:
    """``"addon"`` když existuje options.json, jinak ``"env"``."""
    return "addon" if _load_options() else "env"


def env_name(key: str) -> str:
    """``zan_voice_url`` → ``ZAN_VOICE_URL``."""
    return key.upper()


def _as_text(value: object) -> Optional[str]:
    """Hodnota z options.json jako text pro env (bool → ``true``/``false``)."""
    if value is None:
        return None
    if isinstance(value, bool):
        return "true" if value else "false"
    return str(value)


def get(key: str, default: Optional[str] = None) -> Optional[str]:
    """Hodnota volby jako text: options.json → env → default z config.yaml."""
    options = _load_options()
    if key in options:
        text = _as_text(options[key])
        if text is not None:
            return text
    from_env = os.environ.get(env_name(key))
    if from_env is not None and from_env != "":
        return from_env
    if key in OPTION_DEFAULTS:
        return OPTION_DEFAULTS[key]
    return default


def has_value(key: str) -> bool:
    """Je klíč opravdu nastavený (ne prázdný)? — obdoba ``config.has_value``."""
    value = get(key)
    return value is not None and value != ""


def get_str(key: str, default: str = "") -> str:
    """Volba jako text."""
    value = get(key)
    return default if value is None else value


def get_bool(key: str, default: bool = False) -> bool:
    """Volba jako bool (``true``/``1``/``yes``/``on`` = pravda)."""
    value = get(key)
    if value is None or value == "":
        return default
    return value.strip().lower() in ("true", "1", "yes", "on")


def get_int(key: str, default: int = 0) -> int:
    """Volba jako celé číslo; nesmysl → ``default``."""
    value = get(key)
    try:
        return int(str(value).strip())
    except (TypeError, ValueError):
        return default


def get_float(key: str, default: float = 0.0) -> float:
    """Volba jako desetinné číslo; nesmysl → ``default``."""
    value = get(key)
    try:
        return float(str(value).strip())
    except (TypeError, ValueError):
        return default


def apply_to_environ(environ: Optional[Dict[str, str]] = None) -> List[str]:
    """Poskládat env proměnné ze zvoleného zdroje. Vrací jména, která zapsala.

    * svět add-onu — hodnota z options.json PŘEPÍŠE env (je to zdroj pravdy,
      run.sh dělá totéž),
    * svět kontejneru — co už v env je, se NIKDY nepřepisuje; doplní se jen
      chybějící klíče výchozí hodnotou z config.yaml.
    """
    target = os.environ if environ is None else environ
    options = _load_options()
    applied: List[str] = []

    for key in list(OPTION_DEFAULTS) + list(OPTIONAL_KEYS):
        name = env_name(key)
        from_options = key in options
        if not from_options and target.get(name) not in (None, ""):
            continue  # env (docker env_file / .env) už hodnotu má — neplést se
        value = get(key)
        if value is None:
            continue
        if value == "" and (key in EMPTY_MEANS_UNSET or key in OPTIONAL_KEYS):
            continue  # prázdné = nenastaveno (viz run.sh)
        if value == "" and not from_options:
            continue  # prázdný default nemá co exportovat
        target[name] = value
        applied.append(name)

    return applied


def describe() -> str:
    """Jednořádkový popis do logu — odkud konfigurace přišla."""
    if source() == "addon":
        return "zdroj = volby add-onu (%s)" % options_path()
    return "zdroj = env proměnné (options.json není) + výchozí hodnoty z config.yaml"
