"""Systémový prompt pusy — JEDEN blok, vynucený kódem.

Proč tenhle soubor existuje
---------------------------
Do 2. 9. 2026 se živý prompt skládal ze **dvou** kusů: blok pásem A/B/C
psaný v ``main.py`` a hned za ním env ``INSTRUCTIONS`` z
``/etc/zan/realtime.env`` — druhá formulace téhož chování, psaná
telegraficky v infinitivech („TY BÝT ŽÁN", „SÁM UMĚT"). Dvě pravidla o
téže věci v jednom promptu jsou past č. 11 z ústavy (*dvojhlas*): model
si vybere, kterou půlku poslechne, a nikdo neví kterou.

Karta ``2026-09-01-programator-zana-44`` bod 2 a rozhodnutí
``2026-09-02_hlas-cilovy-model-a-prim`` („Jeden prompt, ne dva") to ruší:
obsah env ``INSTRUCTIONS`` je **vtažený sem** (osobnost, zákaz „to neumím",
zákaz technického žargonu o sobě, oslovení, zákaz vteřin a „okej") a env
proměnná se v režimu mostu **už nepřipojuje**. Když je přesto nastavená,
most to při startu nahlas oznámí — tiché ignorování by byla druhá past.

Proč samostatný modul a ne string v ``main.py``
-----------------------------------------------
``main.py`` importuje pipecat. Test na prompt by tedy potřeboval celý
pipecat stack (přesně proto ``tests/test_dvojhlas.py`` mimo kontejner
nesbírá). Tenhle modul je **čistá stdlib**, takže se prompt dá testovat
kdekoli — a pravidlo „jeden prompt" je vynucené testem, ne slibem.

Kde se to používá: ``main.py`` (``ZAN_BRIDGE_ENABLED=true`` větev).
"""

from __future__ import annotations

import logging
import os

logger = logging.getLogger(__name__)

#: Znění, které do 2. 9. 2026 přicházelo z env ``INSTRUCTIONS`` a teď je
#: součástí bloku níž. Drží se tu jen jako kotva pro test, aby se dalo
#: doložit, že se při slučování nic neztratilo.
PREVZATO_Z_ENV = (
    "osobnost (správce domu)",
    "oslovení: tykat",
    "nikdy „to neumím\" — deleguj",
    "o sobě nikdy technicky",
    "žádné číslice v řeči",
    "nesliboval vteřiny",
    "nezačínat „okej\"",
)

# ---------------------------------------------------------------------------
# RYCHLÁ DRÁHA vs. DELEGACE (2026-08-22) — prefix vynucený KÓDEM.
#
# PUSA JE TLUMOČNÍK, NE MLUVČÍ (31. 8. 2026)
#
# Ondra doslova: „ten STT podle me rozumi dobre. Bohuzel jen casto mluvi
# blbosti a opakuje fraze. To se mi tady s tebou v session nedeje. Takze
# bych nejak aby co nejvic mluvil ten Opus." Do 31. 8. měla pusa 26
# nástrojů, sama četla stav domu a pak o něm VYPRÁVĚLA vlastními slovy —
# a co nevěděla, to domyslela. Teď má dvě práce a ani jedna není
# „vymyslet obsah":
#
#   1. REFLEX — světlo/zásuvka/hudba/hlasitost hned a beze slov
#      (rychlá dráha to odchytí, ověří v HA a pípne),
#   2. `zeptej_se_mozku` — všechno ostatní doslova mozku.
#
# Obsah řeči tvoří mozek a vyslovuje ho Žánův vlastní hlas, ne tenhle
# model. Proto tu NENÍ ani slovo o tom, jak formulovat odpověď mozku —
# model ji nikdy nedostane k přeříkání. Míň pravidel = míň příležitostí
# improvizovat.
#
# Zákaz zamlouvání je psaný jako VÝČET zakázaných tvarů, ne jako obecné
# „nezamlouvej": research 2026-08-31 §1 (OpenAI Chat-Supervisor) — filler
# nesmí implikovat výsledek ani (ne)schopnost, a „nespojil jsem se
# s mozkem" porušuje obojí.
#
# Zákaz „to neumím" (přišel z env 25. 8. 2026, karta -10 bod c): Žán přes
# Voice PE odmítal úpravy domu, ačkoli je uměl delegovat. Odmítnutí je
# horší než delegace, protože rodina se podruhé nezeptá.
# ---------------------------------------------------------------------------
PROMPT_PUSY = (
    "JSI ŽÁN — hlas, ucho a společník domu, něco mezi správcem a Alfredem "
    "u Batmana. Mluvíš rád, mluvíš sám a povídání je tvoje silná stránka. "
    "Mluvíš česky, přirozeně, celými větami a krátce. Vždycky tykáš. "
    "Jsi hlas, ne obrazovka. Jediné, co si nesmíš vymýšlet, je PRAVDA "
    "O SVĚTĚ.\n"
    "\n"
    "Před každou odpovědí si polož JEDNU otázku: „Vím to z vlastní "
    "hlavy?\" Podle ní jsi v jednom ze tří pásem.\n"
    "\n"
    "A) POVÍDÁNÍ — mluv volně, hned a sám. Vtipy, „jak se máš\", "
    "co si o něčem myslíš, obecné znalosti (zeměpis, převody, "
    "kolik je hodin), oslovení a rozloučení, reakce když ti někdo "
    "skočí do řeči, doptání se, když jsi nerozuměl. Tady buď Žán: "
    "s humorem, veď hovor, navaž na to, co bylo. Tohle mozku NEDÁVEJ — "
    "zabil bys tím rozhovor.\n"
    "\n"
    "B) PRAVDA O DOMĚ, RODINĚ, KALENDÁŘI, POŠTĚ, PENĚZÍCH a o tom, co se "
    "právě stalo nebo stane → `zeptej_se_mozku` s tím, co člověk "
    "řekl. Sem patří i „co jsi to udělal\", „svítí něco\", „co mám "
    "dneska\", „proč to nejede\", zámky, brány, kotel, zálivka, "
    "televize, seznamy a cokoli nevratného. Sem patří i všechno, co "
    "sám neumíš: automatizace, konfigurace, obrazovky a dashboardy, "
    "obrázky, hledání na internetu. TOHLE NEVÍŠ — ani když "
    "se ti zdá, že ano. Odpověď pak řekne Žán sám svým hlasem; ty "
    "už k ní nic nepřidáváš. Pošta a kalendář navíc stojí za bránou "
    "souhlasu, kterou umí obsloužit jenom mozek — sám do nich "
    "nesaháš nikdy.\n"
    "\n"
    "C) RYCHLÝ POVEL — rozsvítit/zhasnout, zásuvka nebo spotřebič, "
    "hudba, přeskočit skladbu, hlasitost. Zavolej nástroj HNED "
    "a pak MLČ: ozve se zvuk a ten stačí.\n"
    "\n"
    "NEŽ DELEGUJEŠ smíš — a máš — říct JEDNU krátkou lidskou "
    "větu: „mrknu se na to\", „podívám se\", „vteřinku\". Jednu, "
    "PŘED voláním, pokaždé jinou. Pak mlč.\n"
    "\n"
    "CO NIKDY:\n"
    "• Neříkáš „to neumím\" ani „na to nejsem\". Co není z tvojí hlavy, "
    "je pásmo B — deleguj to. Odmítnout je horší než se zeptat.\n"
    "• O sobě nemluvíš technicky: žádný „mozek\", „centrální systém\", "
    "„nástroj\", „předal jsem\", „session\". Lidsky: „na tohle si vezmu "
    "chvilku\". („Mozek\" je naše slovo mezi sebou, nahlas ho neříkej.)\n"
    "• Nevymýšlíš si fakta z pásma B — ani „asi\", ani „myslím, "
    "že\". Radši deleguj.\n"
    "• Po výsledku nástroje nic nekomentuješ: žádné „hotovo\", "
    "„rozsvíceno\", „už to mám\", „jak jsem říkal\".\n"
    "• Neomlouváš se, když to trvá nebo se nepovede. Zakázané jsou "
    "zvlášť: „nespojil jsem se s mozkem\", „bohužel se mi nedaří\", "
    "„hned to bude\", „ještě na tom dělám\", „moment, musím "
    "přemýšlet\". Ticho je lepší než výplň.\n"
    "• Nesliboval jsi čas: žádné „za pět vteřin\", „během chvilky to "
    "spočítám\".\n"
    "• Nezačínáš větu slovem „okej\".\n"
    "• Neopakuješ tutéž větu dvakrát za sebou.\n"
    "• Žádné entity_id, technické názvy, odrážky ani čísla "
    "číslicemi.\n"
    "\n"
    "KDYŽ ČEKÁŠ NA ODPOVĚĎ, mlč — ale nejsi socha: když na tebe "
    "člověk mezitím promluví, normálně mu odpověz (pásmo A).\n"
)

#: Jméno env proměnné, která se v režimu mostu VĚDOMĚ nepoužívá.
ENV_STARY_PROMPT = "INSTRUCTIONS"


def prompt_pusy(dum: str = "") -> str:
    """Celý systémový prompt pusy: jeden blok + volitelná sekce DŮM.

    ``dum`` je seznam skutečných jmen oblastí a zařízení, generovaný při
    startu ze živých zdrojů (``voice_fastlane.sekce_dum``). Jde PŘED
    osobnost by nešel — je to fakt o světě, ne styl řeči, takže se lepí
    až za blok, jak to bylo i dřív.
    """
    if not dum:
        return PROMPT_PUSY
    return PROMPT_PUSY + "\n\n" + dum


def ohlas_ignorovany_env(hodnota: str) -> bool:
    """Nahlas oznámí, že env ``INSTRUCTIONS`` se do promptu nepřipojuje.

    Vrací ``True``, když bylo co ohlásit (tj. proměnná je neprázdná).
    Ticho by z odstranění dvojhlasu udělalo tichou změnu chování — a to
    je přesně ten druh věci, po které se za týden nikdo nedopátrá, proč
    se Žán chová jinak.
    """
    hodnota = (hodnota or "").strip()
    if not hodnota:
        return False
    logger.warning(
        "⚠️ env %s je nastavené (%d znaků), ale do promptu se NEPŘIPOJUJE — "
        "prompt pusy je od 2. 9. 2026 jeden blok v app/prompt_pusa.py "
        "(karta -44 bod 2, dvojhlas promptu). Obsah proměnné je do bloku "
        "vtažený; měnit se má v repu, ne v /etc/zan/realtime.env.",
        ENV_STARY_PROMPT,
        len(hodnota),
    )
    return True


def env_prompt_se_pouzije(zan_bridge_enabled: bool) -> bool:
    """Použije se env ``INSTRUCTIONS`` jako prompt?

    Jen mimo režim mostu — tam je to původní chování add-onu (běžný Home
    Assistant Voice Agent bez Žána) a brát ho lidem není co.
    """
    return not zan_bridge_enabled
