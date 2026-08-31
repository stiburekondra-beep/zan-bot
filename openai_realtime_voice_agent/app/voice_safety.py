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
import os
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


# ---------------------------------------------------------------------------
# BRZDA 31. 8. 2026: BEZCILNY ZASAH A VLASTNI HLAS
#
# Zive dolozeno (log zan-realtime 17:56:02, Ondra u toho stal):
#
#     Calling function [HassSetVolume] with arguments {'volume_level': 20}
#     -> success: Zan Media Player, Zan reSpeaker Media Player,
#        Televize v loznici, Stara televize v loznici, Zan
#
# Volani BEZ CILE zasahlo vsech pet prehravacu vcetne satelitu, kterym Zan
# mluvi -- hlasitost spadla z 1.0 na 0.2 a Zan si tim sam stahl hlas na
# petinu. Ondra o hlasitosti nerekl ani slovo; model si povel vyrobil
# z rozsypaneho prepisu "svetla v obyvakutechto hlavnichVypni televizi."
#
# Dve pravidla, obe fail-closed:
#
#  1. Nastroj na hlasitost/umlceni se NIKDY nedotkne prehravace, kterym Zan
#     mluvi -- ani jmenovite, ani plosne. Tohle je absolutni: nemy Zan je
#     porucha, kterou nikdo nema jak nahlasit, protoze nahlasit by ji mel
#     hlasem.
#  2. Zasah do domu BEZ CILE se neprovede vubec -- Zan se dopta. "Bez cile"
#     v Home Assistantu neznamena "nic", ale "vsechno, co odpovida", a to
#     je u zhasinani a vypinani cely dum.
# ---------------------------------------------------------------------------

#: Jak poznat prehravac, KTERYM ZAN MLUVI. Prepsatelne v prostredi
#: (`ZAN_VLASTNI_HLAS`, carkou oddelene vzory), aby se to dalo doladit
#: v jinem dome bez zasahu do kodu.
_VYCHOZI_VLASTNI_HLAS = "home_assistant_voice,respeaker,media_player.zan,voice_pe"


def _vzory_vlastniho_hlasu():
    raw = os.environ.get("ZAN_VLASTNI_HLAS", "").strip() or _VYCHOZI_VLASTNI_HLAS
    return tuple(_norm(v.strip()) for v in raw.split(",") if v.strip())


#: Nastroje, ktere sahaji na hlasitost nebo umlceni.
HLASITOST_NASTROJE = frozenset({
    "HassSetVolume", "HassSetVolumeRelative",
    "HassMediaPlayerMute", "HassMediaPlayerUnmute",
})

#: Nastroje, u kterych MUSI byt cil. Bez nej HA zasahne vsechno, co odpovida.
CIL_POVINNY = frozenset({
    "HassTurnOn", "HassTurnOff", "HassLightSet",
    "HassSetVolume", "HassSetVolumeRelative",
    "HassMediaPlayerMute", "HassMediaPlayerUnmute",
    "HassMediaPause", "HassMediaUnpause",
    "HassMediaNext", "HassMediaPrevious",
    "HassMediaSearchAndPlay",
})

#: Klice, kterymi jde zasah zacilit. `device_class`/`domain` se pocitaji --
#: "vypni vsechny televize" je cil, i kdyz ne jmenovity.
_CILOVE_KLICE = ("name", "area", "floor", "entity_id", "entity", "device",
                 "device_class", "domain")


def _cilovy_text(arguments):
    args = arguments or {}
    return _norm(" ".join(
        str(args.get(k, "")) for k in _CILOVE_KLICE if args.get(k)))


def saha_na_vlastni_hlas(function_name, arguments):
    """Dotkl by se tenhle povel prehravace, kterym Zan mluvi?

    Vraci DUVOD (text do logu), nebo prazdny retezec, kdyz je to v poradku.
    Bezcilne volani se pocita jako "ano" -- plosny zasah satelit zahrne.
    """
    if function_name not in HLASITOST_NASTROJE:
        return ""
    cil = _cilovy_text(arguments)
    if not cil:
        return "bez cile by to zasahlo i satelit, kterym Zan mluvi"
    for vzor in _vzory_vlastniho_hlasu():
        if vzor and vzor in cil:
            return "cilem je satelit, kterym Zan mluvi (%s)" % vzor
    return ""


def bezcilny_zasah(function_name, arguments):
    """Zasah do domu bez jedineho cile? Vraci duvod, nebo prazdny retezec."""
    if function_name in SAFE_READ_TOOLS or function_name in NEVER_GATE_TOOLS:
        return ""
    if function_name not in CIL_POVINNY:
        return ""
    if _cilovy_text(arguments):
        return ""
    return ("povel nema cil -- v Home Assistantu to neznamena nic, "
            "ale vsechno, co odpovida")
