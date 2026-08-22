# -*- coding: utf-8 -*-
"""Test konfigurační vrstvy mostu — oba světy, add-on i holý kontejner.

Pouští se bez pytestu i s ním:

    python tests/test_config_source.py        # z adresáře add-onu
    pytest tests/test_config_source.py

Netahá pipecat ani nic těžkého — `app.config_source` stojí jen na stdlib,
takže test běží i na Windows notebooku, kde most sám nikdy nepoběží.
"""
import json
import os
import sys
import tempfile

ADDON_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ADDON_DIR not in sys.path:
    sys.path.insert(0, ADDON_DIR)

from app import config_source  # noqa: E402

# Klíče, které si testy sahají do os.environ — po každém případu se uklidí.
_TOUCHED = [config_source.env_name(k) for k in config_source.OPTION_DEFAULTS]
_TOUCHED += [config_source.env_name(k) for k in config_source.OPTIONAL_KEYS]
_TOUCHED += ["ZAN_OPTIONS_PATH"]


def _clean_env():
    for name in _TOUCHED:
        os.environ.pop(name, None)
    config_source.reset_cache()


def _use_options(data):
    """Nastavit svět add-onu: dočasný options.json se zadaným obsahem."""
    handle = tempfile.NamedTemporaryFile(
        "w", suffix=".json", delete=False, encoding="utf-8"
    )
    json.dump(data, handle, ensure_ascii=False)
    handle.close()
    os.environ["ZAN_OPTIONS_PATH"] = handle.name
    config_source.reset_cache()
    return handle.name


def _use_env_world():
    """Nastavit svět kontejneru: options.json neexistuje."""
    os.environ["ZAN_OPTIONS_PATH"] = os.path.join(
        tempfile.gettempdir(), "options-ktery-neexistuje.json"
    )
    config_source.reset_cache()


def test_defaults_zrcadli_config_yaml():
    """OPTION_DEFAULTS se nesmí rozejít s `options:` v config.yaml."""
    try:
        import yaml
    except ImportError:  # pragma: no cover — na krabici PyYAML být nemusí
        print("   (přeskočeno: PyYAML není nainstalovaný)")
        return
    with open(os.path.join(ADDON_DIR, "config.yaml"), encoding="utf-8") as handle:
        options = yaml.safe_load(handle)["options"]

    assert set(options) == set(config_source.OPTION_DEFAULTS), (
        "config.yaml a OPTION_DEFAULTS mají jiné klíče: "
        "%s" % (set(options) ^ set(config_source.OPTION_DEFAULTS))
    )
    for key, value in options.items():
        expected = "true" if value is True else "false" if value is False else str(value)
        assert config_source.OPTION_DEFAULTS[key] == expected, (
            "default '%s' se rozešel: config.yaml=%r, config_source=%r"
            % (key, expected, config_source.OPTION_DEFAULTS[key])
        )


def test_env_svet_kontejneru():
    """Bez options.json vládne env; co v env není, doplní default z config.yaml."""
    _clean_env()
    _use_env_world()
    os.environ["ZAN_VOICE_URL"] = "http://127.0.0.1:8098/voice"
    os.environ["ZAN_BRIDGE_ENABLED"] = "true"
    os.environ["OPENAI_API_KEY"] = "sk-test"

    assert config_source.source() == "env"
    # 1) env vyhrává nad defaultem z config.yaml (8099)
    assert config_source.get("zan_voice_url") == "http://127.0.0.1:8098/voice"
    # 2) co v env není, přijde z config.yaml
    assert config_source.get("openai_model") == "gpt-realtime-2"
    assert config_source.get_int("websocket_port") == 8080
    assert config_source.get_bool("zan_bridge_enabled") is True
    assert config_source.get_float("openai_speed") == 1.0
    assert config_source.has_value("openai_api_key") is True

    applied = config_source.apply_to_environ()
    # env proměnná zadaná zvenčí se NIKDY nepřepisuje
    assert os.environ["ZAN_VOICE_URL"] == "http://127.0.0.1:8098/voice"
    assert "ZAN_VOICE_URL" not in applied
    # chybějící klíč se doplní defaultem
    assert os.environ["OPENAI_MODEL"] == "gpt-realtime-2"
    assert os.environ["PHASE_IDLE_DEBOUNCE_MS"] == "1500"
    # prázdný default se neexportuje (jinak by "" přebilo default v main.py)
    assert "HA_MCP_URL" not in os.environ
    assert "TRANSCRIPTION_LANGUAGE" not in os.environ
    # volitelné klíče bez hodnoty se neexportují (literál "null" rozbil float())
    assert "VAD_THRESHOLD" not in os.environ
    assert "OPENAI_MODEL_CUSTOM" not in os.environ
    _clean_env()


def test_addon_svet_options_json():
    """S options.json vládne options.json — chování add-onu beze změny."""
    _clean_env()
    cesta = _use_options(
        {
            "openai_api_key": "sk-z-options",
            "instructions": "Jsi Žán.",
            "openai_speed": 1.0,
            "zan_bridge_enabled": True,
            "enable_recording": False,
            "zan_voice_url": "http://127.0.0.1:8099/voice",
            "ha_mcp_url": "",
            "websocket_port": 8080,
            "vad_threshold": 0.42,
        }
    )
    # env se snaží tvrdit něco jiného — options.json ho musí přebít
    os.environ["OPENAI_API_KEY"] = "sk-z-env"

    try:
        assert config_source.source() == "addon"
        assert config_source.get("openai_api_key") == "sk-z-options"
        assert config_source.get("instructions") == "Jsi Žán."
        assert config_source.get_bool("zan_bridge_enabled") is True

        applied = config_source.apply_to_environ()
        assert os.environ["OPENAI_API_KEY"] == "sk-z-options"
        # bool -> text, který main.py očekává
        assert os.environ["ZAN_BRIDGE_ENABLED"] == "true"
        assert os.environ["ENABLE_RECORDING"] == "false"
        # prázdné ha_mcp_url = nenastaveno (main.py má vlastní supervisor default)
        assert "HA_MCP_URL" not in os.environ
        # volitelný klíč nastavený v options se exportuje
        assert os.environ["VAD_THRESHOLD"] == "0.42"
        # klíč, který v options.json chybí, dostane default z config.yaml
        assert os.environ["OPENAI_VOICE"] == "marin"
        assert "OPENAI_VOICE" in applied
    finally:
        os.unlink(cesta)
        _clean_env()


def test_rozbity_options_json_neshodi_start():
    """Nečitelný options.json = varování a jede se z env, ne pád."""
    _clean_env()
    handle = tempfile.NamedTemporaryFile(
        "w", suffix=".json", delete=False, encoding="utf-8"
    )
    handle.write("{tohle není JSON")
    handle.close()
    os.environ["ZAN_OPTIONS_PATH"] = handle.name
    config_source.reset_cache()
    try:
        assert config_source.source() == "env"
        assert config_source.get("openai_model") == "gpt-realtime-2"
    finally:
        os.unlink(handle.name)
        _clean_env()


def main():
    testy = [
        test_defaults_zrcadli_config_yaml,
        test_env_svet_kontejneru,
        test_addon_svet_options_json,
        test_rozbity_options_json_neshodi_start,
    ]
    for test in testy:
        test()
        print("OK   %s" % test.__name__)
    print("Hotovo: %d testů prošlo." % len(testy))


if __name__ == "__main__":
    main()
