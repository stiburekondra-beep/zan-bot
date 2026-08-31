"""Testy převodu nástrojů a VAD pro Gemini pusu (``app/gemini_tools.py``).

Testovaný modul schválně nemá závislosti mimo standardní knihovnu, takže
tenhle soubor běží i tam, kde není nainstalovaný pipecat ani google-genai:

    python -m pytest tests/test_gemini_tools.py
    python tests/test_gemini_tools.py     # i bez pytestu
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.gemini_tools import (  # noqa: E402
    DEFAULT_GEMINI_MODEL,
    MIN_SILENCE_DURATION_MS,
    normalize_model_name,
    to_gemini_function_declarations,
    vad_plan,
)

# Přesně ten tvar, jak ho most skládá v main.py (ask_zan + jeden MCP nástroj).
ASK_ZAN = {
    "type": "function",
    "name": "zeptej_se_mozku",
    "description": "Send the exact request to Žán.",
    "parameters": {
        "type": "object",
        "properties": {"text": {"type": "string", "description": "Exact user utterance."}},
        "required": ["text"],
    },
}

HASS_TURN_ON = {
    "type": "function",
    "name": "HassTurnOn",
    "description": "Turns on a device.",
    "parameters": {
        "type": "object",
        "additionalProperties": False,
        "properties": {
            "name": {"type": "string", "title": "Name", "default": ""},
            "area": {"type": "string"},
            "domain": {"type": "array", "items": {"type": "string", "title": "Domain"}},
        },
        "required": ["name", "neexistuje"],
    },
}


def test_prevod_zachova_jmeno_popis_i_schema():
    declarations = to_gemini_function_declarations([ASK_ZAN])
    assert len(declarations) == 1
    decl = declarations[0]
    assert decl["name"] == "zeptej_se_mozku"
    assert decl["description"] == "Send the exact request to Žán."
    # Malá písmena (object/string) — shodně s pipecatím GeminiLLMAdapter;
    # sonda 30. 8. 2026 potvrdila, že server přijme velká i malá.
    assert decl["parameters"]["type"] == "object"
    assert decl["parameters"]["properties"]["text"]["type"] == "string"
    assert decl["parameters"]["required"] == ["text"]


def test_prevod_skrtne_nepodporovane_klice_i_vnorene():
    decl = to_gemini_function_declarations([HASS_TURN_ON])[0]
    params = decl["parameters"]
    assert "additionalProperties" not in params["properties"]
    assert "title" not in params["properties"]["name"]
    assert "default" not in params["properties"]["name"]
    # rekurzivně i uvnitř items
    assert "title" not in params["properties"]["domain"]["items"]
    # sémantika zůstává
    assert params["properties"]["domain"]["items"]["type"] == "string"


def test_required_se_filtruje_na_existujici_klice():
    decl = to_gemini_function_declarations([HASS_TURN_ON])[0]
    # "neexistuje" není v properties → Gemini by na něm shodil celý setup
    assert decl["parameters"]["required"] == ["name"]


def test_nastroj_bez_parametru_nema_klic_parameters():
    declarations = to_gemini_function_declarations([
        {"type": "function", "name": "nic", "description": "bez parametrů"}
    ])
    assert declarations == [{"name": "nic", "description": "bez parametrů"}]


def test_duplicity_a_nesmysly_se_zahodi():
    declarations = to_gemini_function_declarations([
        ASK_ZAN,
        dict(ASK_ZAN),                                  # duplicitní jméno
        {"type": "function", "description": "bez jména"},
        {"type": "web_search_preview"},                 # vestavěný nástroj
        "tohle není slovník",
    ])
    assert [d["name"] for d in declarations] == ["zeptej_se_mozku"]


def test_prijme_i_chat_completions_tvar():
    declarations = to_gemini_function_declarations([
        {"type": "function", "function": {
            "name": "web_search",
            "description": "hledej",
            "parameters": {"type": "object", "properties": {"query": {"type": "string"}},
                           "required": ["query"]},
        }}
    ])
    assert declarations[0]["name"] == "web_search"
    assert declarations[0]["parameters"]["required"] == ["query"]


def test_prazdny_vstup():
    assert to_gemini_function_declarations(None) == []
    assert to_gemini_function_declarations([]) == []


def test_vad_low_ceka_nejdele():
    plan = vad_plan("low")
    assert plan["end_sensitivity"] == "END_SENSITIVITY_LOW"
    assert plan["silence_duration_ms"] == 1000


def test_vad_high_utne_driv():
    plan = vad_plan("high")
    assert plan["end_sensitivity"] == "END_SENSITIVITY_HIGH"
    assert plan["silence_duration_ms"] == 500


def test_vad_neznama_hodnota_spadne_na_low():
    assert vad_plan("nesmysl") == vad_plan("low")
    assert vad_plan(None) == vad_plan("low")


def test_vad_prepis_ticha_ma_dolni_mez():
    # Live API průvodce: pod 200 ms se promluva trhá na fragmenty.
    assert vad_plan("low", silence_duration_ms=50)["silence_duration_ms"] == MIN_SILENCE_DURATION_MS
    assert vad_plan("low", silence_duration_ms=750)["silence_duration_ms"] == 750


def test_vad_prefix_padding():
    assert vad_plan("low")["prefix_padding_ms"] is None
    assert vad_plan("low", prefix_padding_ms=300)["prefix_padding_ms"] == 300
    assert vad_plan("low", prefix_padding_ms="nesmysl")["prefix_padding_ms"] is None


def test_normalizace_jmena_modelu():
    assert normalize_model_name("gemini-3.1-flash-live-preview") == \
        "models/gemini-3.1-flash-live-preview"
    assert normalize_model_name("models/gemini-2.5-flash-live") == "models/gemini-2.5-flash-live"
    assert normalize_model_name("") == f"models/{DEFAULT_GEMINI_MODEL}"


if __name__ == "__main__":
    failures = 0
    for name, fn in sorted(list(globals().items())):
        if name.startswith("test_") and callable(fn):
            try:
                fn()
                print(f"ok   {name}")
            except AssertionError as exc:
                failures += 1
                print(f"FAIL {name}: {exc}")
    print(f"\n{failures} selhání")
    sys.exit(1 if failures else 0)
