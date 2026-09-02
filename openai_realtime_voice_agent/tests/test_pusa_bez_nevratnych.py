"""Pusa nesmí mít v ruce nevratné — a nesmí mít dva prompty.

Karta ``2026-09-01-programator-zana-44``, body 1 a 2; podmínky 1 a 2
rozhodnutí ``2026-09-02_hlas-cilovy-model-a-prim`` („Co v A-prim musí
ještě doběhnout").

Proč tenhle soubor existuje: obojí bylo do 2. 9. 2026 pravda **jen
konfigurací**. `MCP_TOOL_ALLOWLIST` v `/etc/zan/realtime.env` náhodou
neobsahoval zámek a prompt měl náhodou obě půlky ve shodě. Konfigurace se
mění bez code review; test ne. Tenhle soubor je ta „strukturální pojistka",
bez které se poučení opakuje (ústava, pravidlo 12).

Testy schválně NEIMPORTUJÍ ``app.main`` — ten tahá pipecat a mimo
kontejner se nesbírá. Obě hlídaná pravidla proto žijí v čistě stdlib
modulech (``app.voice_safety``, ``app.prompt_pusa``).
"""
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.prompt_pusa import (  # noqa: E402
    ENV_STARY_PROMPT,
    PREVZATO_Z_ENV,
    PROMPT_PUSY,
    env_prompt_se_pouzije,
    ohlas_ignorovany_env,
    prompt_pusy,
)
from app.voice_safety import (  # noqa: E402
    citliva_trida_nebo_domena,
    is_sensitive_actuation,
    je_nevratny_nastroj,
    nevratne_nastroje,
    procisti_allowlist,
)

# Přesně to, co má pusa v ruce k 2. 9. 2026 (živě odečteno z
# MCP_TOOL_ALLOWLIST na krabici). Když se sem něco přidá, ať to projde
# stejnou branou jako všechno ostatní.
ZIVY_ALLOWLIST = [
    "HassTurnOn", "HassTurnOff", "HassLightSet",
    "HassMediaPause", "HassMediaUnpause", "HassMediaNext", "HassMediaPrevious",
    "HassSetVolume", "HassSetVolumeRelative",
    "HassMediaPlayerMute", "HassMediaPlayerUnmute",
    "HassMediaSearchAndPlay",
]


# ---------------------------------------------------------------------------
# 1) NEVRATNÉ NÁSTROJE SE PUSE NEVYSTAVÍ
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("nastroj", ZIVY_ALLOWLIST)
def test_zive_nastroje_projdou(nastroj):
    """Žádný z dnešních dvanácti nesmí spadnout do brzdy.

    Falešně pozitivní brzda je horší než žádná — vypne ji první člověk,
    kterému kvůli ní přestane fungovat světlo.
    """
    assert je_nevratny_nastroj(nastroj) == ""


@pytest.mark.parametrize("nastroj", [
    "HassLockLock",
    "HassLockUnlock",
    "HassOpenCover",
    "HassCloseCover",
    "HassSetPosition",
    "alarm_control_panel_disarm",
    "zahrada_voda_garaz_start",
    "zahrada_voda_studna_start",
    "garaz_vrata_otevri",
    "kotel_zapni",
    "plyn_uzavri",
    "HassTurnOnValve",
    "sirena_test",
    "rolety_shutter_down",
])
def test_nevratne_nastroje_neprojdou(nastroj):
    """Kdyby se kterýkoli z nich dostal do allowlistu, tenhle test spadne."""
    assert je_nevratny_nastroj(nastroj) != ""


def test_procisti_allowlist_zahodi_jen_nevratne():
    otraveny = ZIVY_ALLOWLIST + ["HassLockUnlock", "zahrada_voda_garaz_start"]
    povolene, zahozene = procisti_allowlist(otraveny)
    assert povolene == ZIVY_ALLOWLIST
    assert zahozene == ["HassLockUnlock", "zahrada_voda_garaz_start"]


def test_zivy_allowlist_je_cely_vratny():
    """Hlavní tvrzení karty: dnešní seznam neobsahuje nic nevratného."""
    assert nevratne_nastroje(ZIVY_ALLOWLIST) == []


def test_most_na_mozek_se_nebrzdi():
    """`zeptej_se_mozku` nese volný text uživatele — může v něm padnout
    „odemkni", „zálivka" i „kotel". Brzdit ho by zavřelo právě tu cestu,
    kudy se nevratné věci mají delegovat."""
    assert je_nevratny_nastroj("zeptej_se_mozku") == ""
    assert je_nevratny_nastroj("GetLiveContext") == ""


# ---------------------------------------------------------------------------
# 2) NEVRATNÁ device_class / domain NEPROJDE ANI ZA BĚHU
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("args", [
    {"device_class": "water"},
    {"device_class": ["water"]},
    {"device_class": ["gas"], "area": "Kotelna"},
    {"device_class": "garage"},
    {"device_class": ["gate"]},
    {"device_class": "shutter", "area": "Cimra"},
    {"domain": "lock"},
    {"domain": ["cover"], "area": "Garáž"},
    {"domain": ["alarm_control_panel"]},
])
def test_nevratna_trida_je_citliva(args):
    """Díra, kvůli které karta vznikla: `device_class` nebyl v cílových
    klíčích, takže `HassTurnOn {'device_class': ['water']}` prošlo
    branou jako „bezcílné, tedy neškodné"."""
    assert citliva_trida_nebo_domena(args) != ""
    assert is_sensitive_actuation("HassTurnOn", args) is True


@pytest.mark.parametrize("args", [
    {"area": "Obývák", "domain": "light"},
    {"area": "Ložnice", "device_class": "outlet"},
    {"name": "Venkovní světlo"},          # „outdoor" nesmí chytit „door"
    {"device_class": "outdoor"},
    {"device_class": ["tv"], "area": "Ložnice"},
    {"area": "Garáž", "domain": "light"},  # světlo v garáži zůstává reflex
])
def test_bezne_povely_se_nebrzdi(args):
    assert citliva_trida_nebo_domena(args) == ""
    assert is_sensitive_actuation("HassTurnOn", args) is False


def test_shoda_tridy_je_presna_ne_podretezcova():
    """„door" jako podřetězec by chytilo „outdoor" a plošně odmítalo
    venkovní světla — brzdu, která otravuje, někdo za týden vypne."""
    assert citliva_trida_nebo_domena({"device_class": "outdoor"}) == ""
    assert citliva_trida_nebo_domena({"device_class": "door"}) != ""


# ---------------------------------------------------------------------------
# 3) JEDEN PROMPT, NE DVA
# ---------------------------------------------------------------------------

def test_prompt_neobsahuje_stary_env_blok():
    """Živý env INSTRUCTIONS byl psaný infinitivy („TY BÝT ŽÁN"). Kdyby se
    do promptu vrátil, tohle spadne."""
    for telegraf in ("TY BÝT", "SÁM UMĚT", "Ty mluvit", "BÝT ZKRATKA"):
        assert telegraf not in PROMPT_PUSY


def test_prompt_je_jeden_blok_i_se_sekci_dum():
    """Sekce DŮM se lepí za blok — je to fakt o světě, ne druhý styl řeči."""
    dum = "DŮM: Obývák, Ložnice, Cimra"
    cely = prompt_pusy(dum)
    assert cely.startswith(PROMPT_PUSY)
    assert cely.endswith(dum)
    assert prompt_pusy() == PROMPT_PUSY


def test_env_instructions_se_v_rezimu_mostu_nepouzije():
    assert env_prompt_se_pouzije(zan_bridge_enabled=True) is False
    # Mimo most zůstává původní chování add-onu.
    assert env_prompt_se_pouzije(zan_bridge_enabled=False) is True


def test_ignorovany_env_se_ohlasi_nahlas(caplog):
    """Tiché zahození cizí konfigurace je druhá past, ne oprava první."""
    assert ohlas_ignorovany_env("") is False
    assert ohlas_ignorovany_env("   ") is False
    with caplog.at_level("WARNING"):
        assert ohlas_ignorovany_env("TY BÝT ŽÁN. Správce dům.") is True
    assert ENV_STARY_PROMPT in caplog.text


@pytest.mark.parametrize("veta", [
    "to neumím",          # zákaz odmítání (hotfix 25. 8., karta -10 bod c)
    "tykáš",              # oslovení
    "technicky",          # zákaz žargonu o sobě
    "číslicemi",          # žádné číslice v řeči
    "okej",               # nezačínat „okej"
    "Nesliboval",         # žádné sliby času
])
def test_prevzaty_obsah_z_env_v_promptu_zustal(veta):
    """Slučování nesmí nic ztratit — tohle jsou kotvy pro každou položku
    ze seznamu `PREVZATO_Z_ENV`."""
    assert veta in PROMPT_PUSY


def test_seznam_prevzateho_je_neprazdny():
    assert len(PREVZATO_Z_ENV) >= 5
