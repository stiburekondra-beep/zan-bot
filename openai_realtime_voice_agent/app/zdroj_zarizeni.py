# -*- coding: utf-8 -*-
"""Ze které krabice ten hlas přišel.

Most obsluhuje víc satelitů (Voice PE u TV, reSpeaker v obýváku), ale
`/voice` na Žán-Code dneska dostane jen text — mozek nemá jak poznat,
komu odpovídá a kde je. Bez toho nejde ani „pusť pohádku tam, kde se
ptalo", ani „nemluv do ložnice, když se ptali v kuchyni".

Jediný identifikátor, který v transportu máme, je IP klienta
(`websocket_handler.extract_client_id`). Mapa IP → jméno je proto
v prostředí (`ZAN_ZARIZENI_MAPA`, JSON), ne v kódu — adresy se mění,
a když se změní, nemá se kvůli tomu vydávat nová verze add-onu.

Neznámá adresa se posílá **syrová**, ne zahozená: „192.168.0.77" je
pořád víc informace než nic, a v logu mozku je hned vidět, co doplnit
do mapy. Prázdný/žádný klient = pole se do payloadu nedává vůbec
(kompatibilita: server si pole zatím nečte a chybějící klíč nikoho
nerozbije).
"""
from __future__ import annotations

import json
import logging
import os
from typing import Dict, Optional

logger = logging.getLogger(__name__)

# Známé krabice v domě (2026-08-30). Přebít lze celou mapou v prostředí.
VYCHOZI_MAPA: Dict[str, str] = {
    "192.168.0.115": "voice_pe",
    "192.168.0.12": "respeaker",
}


def nacti_mapu(raw: Optional[str] = None) -> Dict[str, str]:
    """Mapa z `ZAN_ZARIZENI_MAPA` (JSON objekt), jinak výchozí.

    Rozbitý JSON není důvod ztratit identitu zařízení — spadne se zpátky
    na výchozí mapu a nahlásí se to.
    """
    text = (raw if raw is not None else os.environ.get("ZAN_ZARIZENI_MAPA", "")).strip()
    if not text:
        return dict(VYCHOZI_MAPA)
    try:
        data = json.loads(text)
    except ValueError as exc:
        logger.warning("⚠️ ZAN_ZARIZENI_MAPA není platný JSON (%r) — beru výchozí mapu", exc)
        return dict(VYCHOZI_MAPA)
    if not isinstance(data, dict):
        logger.warning("⚠️ ZAN_ZARIZENI_MAPA není objekt — beru výchozí mapu")
        return dict(VYCHOZI_MAPA)
    return {str(k).strip(): str(v).strip() for k, v in data.items() if str(k).strip() and str(v).strip()}


def normalizuj(client_id: Optional[str]) -> str:
    """Z `client_id` udělá holou adresu (bez `::ffff:`, hranatých závorek, portu)."""
    hodnota = str(client_id or "").strip()
    if not hodnota:
        return ""
    if hodnota.startswith("[") and "]" in hodnota:          # [::1]:1234
        hodnota = hodnota[1:hodnota.index("]")]
    elif hodnota.count(":") == 1:                            # 192.168.0.1:1234
        hodnota = hodnota.split(":", 1)[0]
    if hodnota.lower().startswith("::ffff:"):                # IPv4 v IPv6 obalu
        hodnota = hodnota[7:]
    return hodnota


def zdroj_zarizeni(client_id: Optional[str], mapa: Optional[Dict[str, str]] = None) -> Optional[str]:
    """Jméno krabice pro payload `/voice`, nebo None když není co poslat."""
    adresa = normalizuj(client_id)
    if not adresa:
        return None
    tabulka = mapa if mapa is not None else nacti_mapu()
    return tabulka.get(adresa, adresa)


def payload_voice(text: str, chat_id: Optional[int], zdroj: Optional[str]) -> Dict[str, object]:
    """Tělo POSTu na Žán-Code `/voice`. Jediné místo, kde se skládá.

    Žije tady (a ne v `zan_bridge_tool`) schválně: tohle je čistá práce
    nad daty a musí jít otestovat bez pipecatu, který v testovacím
    prostředí není. `ZanBridge._payload` je jen obálka nad tímhle.
    """
    payload: Dict[str, object] = {"text": text}
    if chat_id is not None:
        payload["chat_id"] = chat_id
    if zdroj:
        payload["zdroj_zarizeni"] = zdroj
    return payload
