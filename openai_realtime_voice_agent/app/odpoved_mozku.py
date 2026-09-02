"""Čtení odpovědi mozku — protokol `/voice`, bez pipecatu.

Proč samostatný modul: rozbor JSONu od Žán-Coda nemá s pipecatem nic
společného, ale bydlel v ``zan_bridge_tool.py``, který pipecat importuje.
Test na kontrakt s mozkem by tedy potřeboval celý pipecat stack. Tady je
čistá stdlib — ``tests/test_kratka_odpoved.py``.

Co protokol nese
----------------
``{"reply": "…"}`` nebo ``{"chunks": ["…", "…"]}`` (streamované věty),
volitelně ``local_confirmation: "success"`` (potvrzení už zaznělo lokálně
z knihovny frází, model ho NESMÍ říct znovu) a od 2. 9. 2026
``ceka_na_odpoved: true`` — **mozek položil otázku a čeká odpověď**.
"""

from __future__ import annotations

from typing import List, Tuple

#: Klíče, kterými smí mozek říct „položil jsem otázku a čekám odpověď".
#: Víc pravopisů schválně: kontrakt vzniká na dvou stranách naráz (most
#: tady, `zan-code-server` tam) a most nesmí být ten, kdo to shodí na
#: překlepu. Rozhoduje PRVNÍ nalezený klíč.
KLICE_PTAM_SE = ("ceka_na_odpoved", "cekam_na_odpoved", "otazka",
                 "awaiting_reply", "expects_reply")

_PRAVDA = ("1", "true", "ano", "yes")


def ptam_se_z_odpovedi(payload) -> bool:
    """Řekl mozek výslovně, že se ptá?

    Proč to nejde poznat z textu (nález 2. 9. 2026, rešerše režimu
    Učitel): sokratovská otázka učitele ani výzva ve hře nemusí končit
    otazníkem — „Řekni mi, kolik je pět a sedm.", „Teď ty." Dítě na to
    odpoví jedním slovem a to bez otevřeného okna spadne jako útržek
    (``prepis_ocista``). Kdo otázku položil, ten o ní ví; heuristika na
    otazník (``dispecer_reci.konci_otazkou``) zůstává jen jako záloha pro
    otázky, které si vymyslí sama pusa.

    Fail-closed: cokoli jiného než pravdivá hodnota = „neptám se", takže
    útržková pojistka platí dál v plné síle.
    """
    if not isinstance(payload, dict):
        return False
    for klic in KLICE_PTAM_SE:
        if klic in payload:
            hodnota = payload.get(klic)
            if isinstance(hodnota, str):
                return hodnota.strip().lower() in _PRAVDA
            return bool(hodnota)
    return False


def texty_z_odpovedi(payload: dict) -> List[str]:
    """Z jedné odpovědi mozku vytáhne N textů k vyslovení."""
    if not isinstance(payload, dict):
        return []
    for key in ("chunks", "parts"):
        value = payload.get(key)
        if isinstance(value, list):
            texty = [str(item).strip() for item in value if str(item).strip()]
            if texty:
                return texty
    reply = str(payload.get("reply", "")).strip()
    return [reply] if reply else []


def polozky(payload: dict) -> List[Tuple[str, bool, bool]]:
    """``(text, ať to model vysloví?, ptám se a čekám odpověď?)``.

    Značka „ptám se" patří jen POSLEDNÍ větě dávky: okno odpovědi se má
    otevřít až po tom, co Žán otázku doříkal, ne po prvním souvětí před ní.
    """
    vyslov = payload.get("local_confirmation") != "success" \
        if isinstance(payload, dict) else True
    ptam_se = ptam_se_z_odpovedi(payload)
    texty = texty_z_odpovedi(payload)
    posledni = len(texty) - 1
    return [(text, vyslov, ptam_se and i == posledni)
            for i, text in enumerate(texty)]
