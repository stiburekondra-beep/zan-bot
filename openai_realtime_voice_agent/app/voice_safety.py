"""Hard safety gate for the voice fast lane (2026-08-22).

Irreversible / risky targets — locks, alarm, gates & the garage DOOR, the boiler
circuit — must NEVER be actuated directly on the fast lane. They stay exposed to
the family, but a command that targets one is refused here and re-routed through
``ask_zan`` -> Žán-Code, where elevation + explicit confirmation apply. This gate
lives in code (wired into ``SafeRealtimeLLMService.register_function``), not only
in the prompt, so a model slip cannot open the garage or switch the boiler.

Design notes:
- Only *actuation* HA MCP tools are gated. ``GetLiveContext`` (read) and our own
  bridge tools (``ask_zan``/``web_search``/``disconnect_client`` — whose args
  carry free user text that may legitimately mention "kotel"/"zámek") are exempt.
- Matching is on the tool's *target* args (name/area/entity_id/domain),
  diacritics-insensitive, so "Zásuvka kotel" and "garáž dveře" are caught while a
  garage *light* ("rozsviť v garáži") stays on the fast lane.
"""
import unicodedata
from typing import Any, Dict, Optional

# HA MCP read-only tool — never gated (reading a lock/boiler state is harmless).
SAFE_READ_TOOLS = frozenset({"GetLiveContext"})
# Our own bridge/util tools carry free user text in their args; never gate them.
NEVER_GATE_TOOLS = frozenset({"zeptej_se_mozku", "web_search", "disconnect_client"})
# Normalized (lowercase, diacritics-stripped) keywords marking a risky target.
_SENSITIVE_KEYWORDS = (
    "kotel", "kotl", "boiler",      # topný okruh / kotel
    "zamek", "lock",                # zámky
    "alarm",                        # alarm / zabezpečení
    "brana", "vrata", "gate",       # brány a vrata
)
# Whole-domain addressing of a sensitive domain (belt & suspenders if these get
# exposed to Assist later — today they are not exposed at all).
_SENSITIVE_DOMAINS = ("lock", "alarm_control_panel", "cover")
_TARGET_KEYS = ("name", "area", "entity_id", "entity", "device", "domain")


def _norm(text: str) -> str:
    nfkd = unicodedata.normalize("NFKD", text)
    return "".join(c for c in nfkd if not unicodedata.combining(c)).lower()


def is_sensitive_actuation(function_name: str,
                           arguments: Optional[Dict[str, Any]]) -> bool:
    """True if this tool call would actuate a sensitive/irreversible target and
    must be re-routed through ask_zan instead of run on the fast lane."""
    if function_name in SAFE_READ_TOOLS or function_name in NEVER_GATE_TOOLS:
        return False
    args = arguments or {}
    target = _norm(" ".join(str(args.get(k, "")) for k in _TARGET_KEYS if args.get(k)))
    if not target:
        return False
    if any(d in target for d in _SENSITIVE_DOMAINS):
        return True
    if any(k in target for k in _SENSITIVE_KEYWORDS):
        return True
    # Garage: gate the DOOR/GATE only, so garage lights stay on the fast lane.
    if "garaz" in target and ("dver" in target or "vrat" in target):
        return True
    return False
