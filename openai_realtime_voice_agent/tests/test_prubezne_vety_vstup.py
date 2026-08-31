"""Průběžné věty ze VSTUPNÍHO přepisu (Gemini pusa).

PROČ TENHLE TEST EXISTUJE. Pipecatí ``GeminiLiveLLMService`` posílá
``TranscriptionFrame`` jen tehdy, když v nárazníku najde tečku — a nárazník
nevyprazdňuje ani na konci tahu (``gemini_live/llm.py:1587-1612``, jediné
vynulování je na řádku 694 při navázání spojení). Na krabici to 31. 8. 2026
vyrobilo tohle: povel v 17:45:38 ležel nepřečtený a ven vypadl slepený až
v 17:55:54 jako ``'světla v obývákutěchto hlavníchVypni televizi.'`` —
o deset minut později, s wake wordem uprostřed slova a s ``vysledek_fail``.
Očista ani reflex plátna do té doby nedostaly nic.

Testuje se vrstva ze ``SafeGeminiLiveLLMService``: kousky přepisu →
``SentenceAccumulator`` → jeden ``TranscriptionFrame`` na KAŽDOU uzavřenou
větu, plus dozávření po tichu a na hranici tahu. Služba se schválně
nekonstruuje (chtěla by klíč a spojení do Googlu) — metody se navěsí na holý
objekt, takže se testuje přesně ten kód, co běží v provozu.
"""
import asyncio

import pytest

from app.gemini_safety import SafeGeminiLiveLLMService as Pusa
from app.prepis_ocista import ocisti
from app.sentence_accumulator import SentenceAccumulator


class FalesnaPusa:
    """Žánovy metody bez pipecatí služby pod nimi."""

    _zavri_vety = Pusa._zavri_vety
    _posli_vety = Pusa._posli_vety
    _zrus_timer_vety = Pusa._zrus_timer_vety
    _naplanuj_dozavreni = Pusa._naplanuj_dozavreni
    _dozavri_po_tichu = Pusa._dozavri_po_tichu
    _dozavri_vetu = Pusa._dozavri_vetu

    def __init__(self, ticho_s: float = 0.12):
        self._vety = SentenceAccumulator()
        self._vety_segment = ""
        self._vety_verze = 0
        self._vety_timer = None
        self._vety_ticho_s = ticho_s
        self.poslane: list[str] = []

    async def push_frame(self, frame, direction=None):
        self.poslane.append(frame.text)

    async def slys(self, text: str) -> None:
        """Totéž co ``_handle_msg_input_transcription`` nad došlým kouskem."""
        await self._posli_vety(self._zavri_vety(text, final=False), "interpunkce")
        self._naplanuj_dozavreni()


@pytest.mark.asyncio
async def test_veta_odejde_drive_nez_clovek_domluvi():
    """Uzavřená věta jde ven HNED, ne až po celé promluvě."""
    pusa = FalesnaPusa()
    await pusa.slys("Rozsviť ")
    await pusa.slys("v obýváku.")
    assert pusa.poslane == ["Rozsviť v obýváku."]

    # člověk mluví dál — první věta je venku dávno předtím
    await pusa.slys(" A pusť ")
    await pusa.slys("hudbu.")
    assert pusa.poslane == ["Rozsviť v obýváku.", "A pusť hudbu."]
    pusa._zrus_timer_vety()


@pytest.mark.asyncio
async def test_mezery_se_neztraci():
    """Zbytek se nese SYROVÝ. Přes normalizovaný by vzniklo `Rozsviťv obýváku.`"""
    pusa = FalesnaPusa(ticho_s=0)
    await pusa.slys("Rozsviť ")
    await pusa.slys("v obýváku.")
    assert pusa.poslane == ["Rozsviť v obýváku."]


@pytest.mark.asyncio
async def test_povel_bez_tecky_uzavre_ticho():
    """Gemini krátké povely často nepunktuje — pak větu uzavře ticho."""
    pusa = FalesnaPusa(ticho_s=0.12)
    await pusa.slys("světla v obýváku")
    assert pusa.poslane == [], "dokud se mluví, nic se neposílá"
    await asyncio.sleep(0.3)
    assert pusa.poslane == ["světla v obýváku"]


@pytest.mark.asyncio
async def test_nic_se_neslepi_pres_hranici_tahu():
    """Regrese 17:55:54 — tři promluvy slepené do jednoho přepisu."""
    pusa = FalesnaPusa(ticho_s=0)  # timer vypnutý → drží to jen hranice tahu
    await pusa.slys("světla v obýváku")
    await pusa._dozavri_vetu("model volá nástroj")
    await pusa.slys("Vypni televizi.")
    assert pusa.poslane == ["světla v obýváku", "Vypni televizi."]
    assert not any("obývákuVypni" in t for t in pusa.poslane)


@pytest.mark.asyncio
async def test_veta_se_neposle_dvakrat():
    pusa = FalesnaPusa(ticho_s=0)
    await pusa.slys("Vypni televizi.")
    await pusa._dozavri_vetu("konec tahu")
    assert pusa.poslane == ["Vypni televizi."]


@pytest.mark.asyncio
async def test_ticho_nad_prazdnym_nic_neposle():
    pusa = FalesnaPusa(ticho_s=0)
    await pusa.slys("   ")
    await pusa._dozavri_vetu("konec tahu")
    assert pusa.poslane == []


@pytest.mark.asyncio
async def test_ocista_wake_wordu_plati_i_pro_prubeznou_vetu():
    """Průběžná věta jde TOUŽ cestou jako dřív celá promluva — přes očistu.

    Kdyby průběžné věty očistu obcházely, vrátilo by se přesně to, co se dnes
    dopoledne opravovalo: `baklažánrozsvítit…` jako povel a `ne baklažánu.`
    jako důvod k `HassTurnOff`.
    """
    pusa = FalesnaPusa(ticho_s=0)
    await pusa.slys("baklažánrozsvi")
    await pusa.slys("ť v obýváku.")
    assert len(pusa.poslane) == 1

    o = ocisti(pusa.poslane[0])
    assert o.zmeneno and "baklažán" not in o.text.lower()
    assert not o.utrzek, "povel po očistě musí projít dál"


@pytest.mark.asyncio
async def test_utrzkova_pojistka_plati_i_pro_prubeznou_vetu():
    pusa = FalesnaPusa(ticho_s=0)
    await pusa.slys("ne baklažánu.")
    o = ocisti(pusa.poslane[0])
    assert o.utrzek, "z útržku se nesmí stát povel ani průběžně"
