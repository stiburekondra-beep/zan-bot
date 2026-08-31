"""Gemini Live pusa Žána — druhá „pusa" vedle OpenAI Realtime.

Přepínač je env ``ZAN_PUSA`` (``openai`` = výchozí a beze změny chování,
``gemini`` = tahle větev). Modul se v ``main.py`` importuje AŽ uvnitř gemini
větve, protože táhne ``pipecat-ai[google]`` a ``google-genai`` — v openai
provozu se tedy nenačte vůbec a nemůže nic rozbít.

Co tenhle soubor přidává nad pipecatí ``GeminiLiveLLMService``:

1. **rychlou dráhu** (``FastLaneMixin``) — tatáž bezpečnostní brzda,
   přednahraná pusa a ověřování stavu v HA jako u OpenAI pusy. Sdílený kód,
   ne kopie: brzda na nevratné úkony se nesmí udržovat dvakrát,
2. **``languageCode`` podle modelu** — Live API ho v ``speechConfig`` posílá
   vždy (pipecat dosadí ``en-US``, když nic nenastavíš). Modely se v tomhle
   chovají PROTICHŮDNĚ: ``2.5`` (native-audio) ho s ``cs-CZ`` odmítá chybou
   1007 „Unsupported language code", zatímco ``3.1`` ho naopak PŘIJÍMÁ (sonda
   30. 8. 2026: ``poc_1`` s ``gemini-3.1-flash-live-preview`` a
   ``languageCode=cs-CZ`` prošel, přepisy i argumenty chodí v diakritice,
   ``{"mistnost": "obývák"}``). Proto se u ``2.5``/``native-audio`` pole
   zahazuje úplně a u ostatních (3.1) se posílá natvrdo ``cs-CZ``,
3. **žádné ``audioStreamEnd``** — pipecat posílá mikrofon výhradně přes
   ``send_realtime_input(audio=…)`` a konec tahu nechává na server VAD. To je
   přesně varianta, která v sondě vyšla nejrychleji (běh D3: toolCall za
   525 ms) a zároveň se vyhýbá jediné variantě, která na 3.1 tah ZAHODÍ bez
   jediné zprávy (běh B1: nárazový upload klipu + okamžitý ``audioStreamEnd``
   → 25 s ticha, ani ``inputTranscription``). Dokumentace k tomu doslova:
   server „treats the audio_stream_end signal as an immediate finalization
   prompt, bypassing the default server-side silence detection delay".
   V provozu jede mikrofon v reálném tempu, takže ta past nehrozí — ale
   kdyby někdo v budoucnu ``audioStreamEnd`` doplňoval, tohle je důvod, proč
   tady není.

Neřeší se tu (vědomě, viz zápis k úkolu): dopřednou detekci „uživatel mluví"
pro fáze ``listening``/``thinking`` — Gemini pusa na rozdíl od OpenAI
nevydává ``UserStartedSpeakingFrame``. Fáze ``replying``/``idle`` fungují,
protože je do pipeline vrací výstupní transport (a ty jsou pro LED to hlavní).
"""

from __future__ import annotations

import asyncio
import logging
import os
import re
import time
from typing import Any, Dict, List, Optional

from google.genai.types import Blob, EndSensitivity
from pipecat.frames.frames import (
    LLMTextFrame,
    TranscriptionFrame,
    TTSAudioRawFrame,
    TTSTextFrame,
)
from pipecat.processors.frame_processor import FrameDirection
from pipecat.utils.time import time_now_iso8601
from pipecat.adapters.schemas.function_schema import FunctionSchema
from pipecat.adapters.schemas.tools_schema import ToolsSchema
from pipecat.services.google.gemini_live.llm import (
    ContextWindowCompressionParams,
    GeminiLiveLLMService,
    GeminiModalities,
    GeminiVADParams,
    InputParams,
)

from app.fastlane_mixin import FastLaneMixin
from app.pusa_fallback import fallback_path, write_fallback
from app.sentence_accumulator import SentenceAccumulator
from app.gemini_tools import (
    DEFAULT_GEMINI_MODEL,
    DEFAULT_GEMINI_VOICE,
    normalize_model_name,
    to_gemini_function_declarations,
    vad_plan,
)

logger = logging.getLogger(__name__)

# =============================================================================
# ZASAH DO CIZI KNIHOVNY (pipecat-ai 0.0.97) -- cs-CZ na vstupni prepis.
# =============================================================================
#
# `pipecat.services.google.gemini_live.llm.GeminiLiveLLMService._connect()`
# posila Google Live API napevno:
#
#     input_audio_transcription=AudioTranscriptionConfig(),   # PRAZDNE
#     output_audio_transcription=AudioTranscriptionConfig(),
#
# -- zadny kwarg service/InputParams tohle neovlivni (overeno na zivem
# procesu 31. 8. 2026: `inspect.getsourcelines` na `_connect` a signatura
# `GeminiLiveLLMService.__init__`/`InputParams`). Vystup uz jazyk dostava
# jinudy (SpeechConfig.language_code, viz `_language_code` nize v tomhle
# souboru); vstup jede na autodetekci, i kdyz v dome vime, ze se mluvi
# cesky. Domacnost o tomhle stavela karta -21 (baklazan-hq/firma/ukoly).
#
# `AudioTranscriptionConfig` i `LiveConnectConfig` pipecat importuje JMENEM
# (`from google.genai.types import ...`) primo do sveho modulu -- Python je
# tedy za behu vyhledava v modulovem jmennem prostoru `pipecat...gemini_live.
# llm`, ne v nasem. Nahrazujeme tam `LiveConnectConfig` tenkym wrapperem: kdyz
# dostane PRAZDNY `input_audio_transcription` (zadne `language_codes`), dosadi
# `language_codes=["cs-CZ"]`. `output_audio_transcription` se NEDOTYKA --
# ukol 2 chtel vyslovene jen vstup.
try:
    import pipecat.services.google.gemini_live.llm as _gemini_llm_modul
    from google.genai.types import (
        AudioTranscriptionConfig as _GenAiAudioTranscriptionConfig,
        LiveConnectConfig as _GenAiLiveConnectConfig,
    )
except Exception as _e:  # pragma: no cover - gemini vetev se nenatahne vubec
    logger.error("⚠️ cs-CZ patch vstupniho prepisu: pipecat/google.genai se "
                 "nepodarilo importovat, patch se NEPROVEDL: %r", _e)
    _gemini_llm_modul = None


def _cscz_live_connect_config(*args, **kwargs):
    """Nahrazuje `LiveConnectConfig` uvnitr pipecat modulu -- viz banner výš."""
    iat = kwargs.get("input_audio_transcription")
    if (
        isinstance(iat, _GenAiAudioTranscriptionConfig)
        and not getattr(iat, "language_codes", None)
    ):
        kwargs["input_audio_transcription"] = _GenAiAudioTranscriptionConfig(
            language_codes=["cs-CZ"]
        )
    return _GenAiLiveConnectConfig(*args, **kwargs)


def _over_patch_input_transcription() -> None:
    """Sebekontrola: patch se OPRAVDU pouzije, jinak se to nema tise ztratit.

    Voláno z `build_gemini_service()` (jednou na start sluzby), ne pri
    importu modulu -- ať se log neopakuje pri kazdem `_connect`/reconnectu.
    """
    if _gemini_llm_modul is None:
        return
    if getattr(_gemini_llm_modul, "LiveConnectConfig", None) is not _cscz_live_connect_config:
        logger.error(
            "⚠️ cs-CZ patch vstupniho prepisu SE NEPROVEDL — "
            "pipecat.services.google.gemini_live.llm.LiveConnectConfig neni "
            "nas wrapper (pipecat asi zmenil import). Vstupni prepis jede na "
            "autodetekci jazyka, ne na cs-CZ."
        )
        return
    # Funkcni test na skutecnem typu z knihovny, ne jen na identite objektu --
    zkouska = _cscz_live_connect_config(
        input_audio_transcription=_GenAiAudioTranscriptionConfig(),
        output_audio_transcription=_GenAiAudioTranscriptionConfig(),
    )
    vstup_ok = list(getattr(zkouska.input_audio_transcription, "language_codes", None) or []) == ["cs-CZ"]
    vystup_nedotceno = not getattr(zkouska.output_audio_transcription, "language_codes", None)
    if vstup_ok and vystup_nedotceno:
        logger.info("🇨🇿 cs-CZ patch vstupniho prepisu: aktivni (output_audio_transcription nedotceny)")
    else:
        logger.error(
            "⚠️ cs-CZ patch vstupniho prepisu: funkcni sebekontrola SELHALA "
            "(vstup_ok=%s vystup_nedotceno=%s) — nevěř mu.", vstup_ok, vystup_nedotceno,
        )


if _gemini_llm_modul is not None:
    _gemini_llm_modul.LiveConnectConfig = _cscz_live_connect_config
# =============================================================================

#: Podřetězce ve jméně modelu, které signalizují „``languageCode`` odmítá".
#: Sonda 30. 8. 2026: ``gemini-2.5-flash-native-audio-preview…`` vrátí na
#: ``cs-CZ`` chybu 1007 „Unsupported language code"; ``gemini-3.1-flash-
#: live-preview`` ho naopak přijme. Jméno modelu jde přes ``normalize_model_name``
#: (prefix ``models/``), substring test to nerozhodí.
_LANGUAGE_UNSUPPORTED_MARKERS = ("2.5", "native-audio")

#: Kolik sekund necháme doznít oznámení, než proces ukončíme. Krátké schválně:
#: cílem je RYCHLÉ čisté selhání, ne elegantní odchod.
_EXIT_DELAY_S = 2.0

#: Návratový kód "dočasné selhání" (EX_TEMPFAIL) — v ``docker inspect`` je pak
#: vidět, že most odešel vlastní brzdou, ne že ho někdo zabil.
_EXIT_CODE = 75

#: Odstup, od kterého je pád POVAŽOVÁN ZA IZOLOVANÝ, ne za pokračování
#: sesypání.
#:
#: PROČ (incident 31. 8. 2026, 09:37): Ondra si vyžádal gemini pusu do LABu a
#: brzda mu ji za osm minut sebrala, aniž by se cokoli sesypalo. Dostal tři
#: OJEDINĚLÉ ``1008`` — 09:32:30, 09:35:03, 09:37:36 — každý se sám vrátil do
#: 0,4 s. Počítadlo ``_consecutive_failures`` je ale v pipecatu vynulované
#: jedině v ``_check_and_reset_failure_counter()``, a to se volá
#: (``gemini_live/llm.py:1194``) **uvnitř přijímací smyčky na každou došlou
#: zprávu**. Když se satelitem nikdo nemluví, žádná zpráva nechodí a stabilní
#: spojení se nezapočítá — takže „consecutive" ve skutečnosti znamená
#: „kumulativní za libovolně dlouhou dobu ticha". Tři nezávislé výpadky za pět
#: minut nečinnosti pak vypadají stejně jako sesypání.
#:
#: Brzda přitom vznikla na NĚCO JINÉHO: na 30. 8., kdy se pipecat zacyklil ve
#: spamu ``ErrorFrame`` (zdroj popisuje flood ~15/s) a most oněměl. Tam jdou
#: pády po sobě v řádu milisekund až sekund, tedy hluboko pod touhle hranicí —
#: pro ten případ zůstává brzda beze změny a vystřelí pořád na třetím pádu.
#: Ubývá jen falešný poplach, kdy se počítadlo plazí nahoru přes minuty ticha.
_IZOLOVANY_PAD_S = 60.0

#: Po jak dlouhém tichu ve VSTUPNÍM přepisu se nedopsaná věta uzavře sama.
#:
#: PROČ TO TU JE (důkaz z živého logu 31. 8. 2026): pipecatí
#: ``GeminiLiveLLMService._handle_msg_input_transcription`` sype došlé kousky
#: do ``self._user_transcription_buffer`` a ``TranscriptionFrame`` pošle
#: JEDINĚ, když v nárazníku najde tečku/otazník/vykřičník
#: (``gemini_live/llm.py:1587-1612``). Nárazník se přitom nevyprazdňuje ani
#: na konci tahu — jediné vynulování je na řádku 694 při navázání spojení.
#: Na krabici to vyrobilo tohle: povely v 17:45:38 a dál zůstaly ležet
#: nepřečtené, protože je Gemini přepsal bez tečky, a ven vypadly slepené
#: až v 17:55:54 jako ``'světla v obývákutěchto hlavníchVypni televizi.'``
#: — deset minut pozdě, s wake wordem uprostřed slova a s výsledkem
#: ``vysledek_fail``. Očista ani reflex plátna do té doby NEDOSTALY NIC.
#:
#: S timerem se věta uzavře po tomhle tichu i bez interpunkce, takže reflex
#: a očista jedou nad průběžnou větou, ne až nad slepencem celého tahu.
#: Vypnout: ``ZAN_VETA_TICHO_MS=0``.
_VETA_TICHO_MS_DEFAULT = 800

#: KEEPALIVE: po kolika sekundách BEZ JEDINÉHO KOUSKU ZVUKU pošleme Geminimu
#: dávku digitálního ticha, aby session nespadla na nečinnost.
#:
#: PROČ TO TU JE (změřeno 31. 8. 2026 sondou proti holému ``google-genai``,
#: tentýž klíč a model jako most): Gemini Live zavře session, do které klient
#: ~150 s nic nepošle, kódem ``1008 The operation was aborted.`` Sonda, která
#: ticho posílala průběžně, žila 400,1 s bez jediného pádu; sonda, která
#: neposlala NIC, umřela v t=150,3 s přesně tou hláškou, kterou máme v logu.
#: Náš satelit (HA Voice PE) mikrofon mezi tahy brání ("mic-streaming gate"),
#: takže most mezi promluvami Geminimu neposílá NIC — ten limit si tedy
#: vyrábíme sami, není to strop Googlu na délku session.
#:
#: DRUHÝ, HORŠÍ NÁSLEDEK: Google posílá ``sessionResumptionUpdate`` JEN jako
#: reakci na vstup od klienta. Táž dvojice sond: 433 handlů za 400 s když
#: ticho teklo, NULA za 127 s když neteklo nic. Bez handle se pipecat po pádu
#: připojí s ``handle=None`` → NOVÁ session → celý dosavadní rozhovor je pryč.
#: Keepalive tedy nedrží jen spojení, ale i paměť rozhovoru.
_KEEPALIVE_PERIOD_S = float(os.environ.get("ZAN_GEMINI_KEEPALIVE_S", "").strip() or 20.0)

#: Jak dlouhá dávka ticha se posílá. Účtuje se jako zvuk (25 tok/s), takže
#: 100 ms jednou za 20 s = 0,125 tok/s — v šumu.
_KEEPALIVE_BURST_MS = int(os.environ.get("ZAN_GEMINI_KEEPALIVE_MS", "").strip() or 100)

#: Vzorkovací frekvence keepalive ticha, dokud neznáme tu skutečnou z mikrofonu.
_KEEPALIVE_RATE_DEFAULT = 16000

#: TVRDÁ PODLAHA: i kdyby všechny měkké podmínky říkaly „teď ne" (Žán mluví,
#: vstup je pozastavený), po tolika sekundách bez JEDINÉHO bajtu odeslaného
#: Googlu se ticho pošle stejně. Brzda musí být fail-closed: měřená hranice
#: pádu je ~150 s, tohle je s rezervou pod ní.
_KEEPALIVE_STROP_S = float(os.environ.get("ZAN_GEMINI_KEEPALIVE_STROP_S", "").strip() or 100.0)

#: Konec věty v SYROVÉM přepisu. Musí sedět na `sentence_accumulator.split_closed`,
#: která dělí na tomtéž — jen nad normalizovaným textem.
_KONEC_VETY = re.compile(r"[.!?]+")


def _tvrdy_konec() -> None:
    """Doopravdy ukončí proces. ``sys.exit`` uvnitř tasku by zabil jen task."""
    logging.shutdown()
    os._exit(_EXIT_CODE)


class SafeGeminiLiveLLMService(FastLaneMixin, GeminiLiveLLMService):
    """Gemini Live se Žánovou rychlou dráhou a ``languageCode`` podle modelu.

    ``FastLaneMixin`` musí být v MRO PRVNÍ — jeho ``register_function``
    přebíjí ten z pipecatu a ``super()`` uvnitř pak míří na
    ``GeminiLiveLLMService``.
    """

    def __init__(self, *, drop_language_code: bool = True, **kwargs):
        """Args:
            drop_language_code: Zapíná chytrou volbu ``languageCode`` podle
                modelu (výchozí). Live API posílá pole v ``speechConfig``
                vždy (pipecat dosadí ``en-US``, když ``params.language``
                nenastavíš) — a modely se k němu chovají protichůdně:
                ``2.5``/``native-audio`` ho s ``cs-CZ`` ODMÍTAJÍ (chyba 1007),
                ``3.1`` ho naopak BEROU. Pro model s markerem z
                ``_LANGUAGE_UNSUPPORTED_MARKERS`` se pole vynuluje
                (``_settings["language"] = None`` → pydantic ``SpeechConfig``
                ho při serializaci vypustí úplně), pro ostatní se nastaví
                natvrdo na ``"cs-CZ"``. ``False`` tuhle logiku úplně vypne
                a nechá pipecatí výchozí chování (``en-US``).
            **kwargs: Předává se beze změny do ``GeminiLiveLLMService``.
        """
        super().__init__(**kwargs)
        # Brzda terminálního pádu smí proběhnout jen jednou za život služby.
        self._pusa_brzda_spustena = False
        # KEEPALIVE TICHA (viz `_KEEPALIVE_PERIOD_S`).
        self._keepalive_task: Optional[asyncio.Task] = None
        self._keepalive_rate = _KEEPALIVE_RATE_DEFAULT
        self._keepalive_posledni_vstup = time.monotonic()
        self._keepalive_odeslano = 0
        # PRŮBĚŽNÉ VĚTY ZE VSTUPU (viz `_handle_msg_input_transcription` níž).
        self._vety = SentenceAccumulator()
        self._vety_segment = ""
        self._vety_verze = 0
        self._vety_timer: Optional[asyncio.Task] = None
        try:
            self._vety_ticho_s = max(
                0.0,
                int(os.environ.get("ZAN_VETA_TICHO_MS", "").strip()
                    or _VETA_TICHO_MS_DEFAULT) / 1000.0,
            )
        except ValueError:
            self._vety_ticho_s = _VETA_TICHO_MS_DEFAULT / 1000.0
        logger.info(
            "✂️ průběžné věty ze vstupu: %s",
            ("dozávírám po %.0f ms ticha" % (self._vety_ticho_s * 1000))
            if self._vety_ticho_s > 0 else "jen na interpunkci (ZAN_VETA_TICHO_MS=0)",
        )
        if not drop_language_code:
            return
        model_name = str(getattr(self, "_model_name", "") or "")
        if any(marker in model_name for marker in _LANGUAGE_UNSUPPORTED_MARKERS):
            self._settings["language"] = None
            self._language_code = None
            logger.info(
                "🌐 Gemini: languageCode se NEposílá (%s odmítá cs-CZ)", model_name
            )
        else:
            self._settings["language"] = "cs-CZ"
            self._language_code = "cs-CZ"
            logger.info("🌐 Gemini: languageCode=cs-CZ (%s)", model_name)

    # ------------------------------------------------------------------
    # PRŮBĚŽNÉ VĚTY ZE VSTUPNÍHO PŘEPISU (zapojeno 31. 8. 2026)
    # ------------------------------------------------------------------
    #
    # Dosud platilo: dokud člověk nedomluvil CELOU promluvu a Gemini ji
    # neukončil tečkou, most z ní neviděl ANI PÍSMENO — a když tečka nikdy
    # nepřišla, viselo to v nárazníku pipecatu do dalšího tahu (viz
    # `_VETA_TICHO_MS_DEFAULT`). Reflex plátna i očista přepisu tak jely nad
    # slepencem, ne nad povelem.
    #
    # Nově se každý došlý kousek přepisu pouští přes `SentenceAccumulator`
    # (`app/sentence_accumulator.py`, napsaný a otestovaný 28. 8., do dneška
    # ho ale nikdo nevolal) a KAŽDÁ UZAVŘENÁ VĚTA jde ven jako samostatný
    # `TranscriptionFrame` HNED. Uzavřít větu umí dvě věci:
    #   1. interpunkce v přepisu (`split_closed`),
    #   2. ticho `ZAN_VETA_TICHO_MS` — pojistka pro povely bez tečky.
    #
    # OČISTA A ÚTRŽKOVÁ POJISTKA SE TÍM NEOBCHÁZEJÍ, PRÁVĚ NAOPAK. Posílá se
    # tatáž třída rámce týmž směrem jako dřív, takže věta projde
    # `transcript_logger` → `websocket_handler.na_prepis` → `prepis_ocista.ocisti()`
    # se vším, co k tomu patří (wake word ven, útržek se dál nepouští,
    # stopka řečí). Rozdíl je JEN v tom, kdy a jak velký kus tam doteče.
    def _zavri_vety(self, text: str, *, final: bool) -> list:
        """Přidá kousek přepisu a vrátí věty, které se tím uzavřely."""
        self._vety_segment += text
        if final and not self._vety_segment.strip():
            return []
        hotove, _, _ = self._vety.ingest(
            self._vety_segment, self._vety_verze, final=final,
        )
        self._vety_verze += 1
        # Neuzavřený zbytek si neseme dál — ale SYROVÝ, ne ten normalizovaný
        # z akumulátoru. `normalize()` totiž ořezává okraje, takže by se
        # z „Rozsviť " + „v obýváku." stalo „Rozsviťv obýváku." (chycen
        # testem `test_veta_odejde_pred_koncem_promluvy`). Kde věta skončila,
        # si najdeme v syrovém textu sami — je to tatáž hranice, na které
        # dělí `split_closed`.
        if final:
            self._vety_segment = ""
        else:
            konec = None
            for shoda in _KONEC_VETY.finditer(self._vety_segment):
                konec = shoda.end()
            if konec is not None:
                self._vety_segment = self._vety_segment[konec:]
        return hotove

    async def _posli_vety(self, hotove: list, duvod: str, message: Any = None) -> None:
        for veta in hotove:
            logger.info("✂️ věta ze vstupu (%s): %r", duvod, veta.text)
            await self.push_frame(
                TranscriptionFrame(
                    text=veta.text,
                    user_id="",
                    timestamp=time_now_iso8601(),
                    result=message,
                ),
                FrameDirection.UPSTREAM,
            )

    def _zrus_timer_vety(self) -> None:
        timer = self._vety_timer
        self._vety_timer = None
        if timer is not None and not timer.done():
            timer.cancel()

    def _naplanuj_dozavreni(self) -> None:
        if self._vety_ticho_s <= 0:
            return
        self._zrus_timer_vety()
        self._vety_timer = asyncio.create_task(self._dozavri_po_tichu())

    async def _dozavri_po_tichu(self) -> None:
        try:
            await asyncio.sleep(self._vety_ticho_s)
        except asyncio.CancelledError:
            return
        try:
            await self._posli_vety(
                self._zavri_vety("", final=True),
                "ticho %.0f ms" % (self._vety_ticho_s * 1000),
            )
        except Exception as e:  # noqa: BLE001 — dozávření nesmí shodit pusu
            logger.warning("⚠️ dozávření věty po tichu selhalo: %r", e)

    async def _dozavri_vetu(self, duvod: str) -> None:
        """Tvrdá hranice tahu: co zbylo, je věta, i kdyby chyběla tečka."""
        self._zrus_timer_vety()
        try:
            await self._posli_vety(self._zavri_vety("", final=True), duvod)
        except Exception as e:  # noqa: BLE001
            logger.warning("⚠️ dozávření věty (%s) selhalo: %r", duvod, e)

    async def _handle_msg_input_transcription(self, message):  # type: ignore[override]
        """Místo pipecatího nárazníku jede Žánův akumulátor vět.

        Pipecatí verze se schválně NEVOLÁ: dělala by touž práci podruhé nad
        vlastním nárazníkem a věta by se poslala dvakrát.
        """
        content = getattr(message, "server_content", None)
        prepis = getattr(content, "input_transcription", None) if content else None
        text = getattr(prepis, "text", None) if prepis else None
        if not text:
            return
        try:
            hotove = self._zavri_vety(text, final=False)
        except Exception as e:  # noqa: BLE001 — na akumulátoru hlas nestojí
            logger.warning("⚠️ akumulátor vět selhal, padám na pipecat: %r", e)
            return await super()._handle_msg_input_transcription(message)
        await self._posli_vety(hotove, "interpunkce", message)
        self._naplanuj_dozavreni()

    async def _handle_msg_model_turn(self, message):  # type: ignore[override]
        # Model začal odpovídat = člověk domluvil. Co zbylo v nárazníku, je
        # věta — jinak by se to slepilo s další promluvou.
        if self._vety_segment.strip():
            await self._dozavri_vetu("model začal odpovídat")
        return await super()._handle_msg_model_turn(message)

    async def _handle_msg_tool_call(self, message):  # type: ignore[override]
        if self._vety_segment.strip():
            await self._dozavri_vetu("model volá nástroj")
        return await super()._handle_msg_tool_call(message)

    async def _handle_msg_turn_complete(self, message):  # type: ignore[override]
        if self._vety_segment.strip():
            await self._dozavri_vetu("konec tahu")
        self._zrus_timer_vety()
        # Nový tah = nová paměť vyslovených vět (jinak by set rostl donekonečna
        # a Žán by po hodině hovoru zahodil větu, kterou už jednou slyšel).
        self._vety = SentenceAccumulator()
        self._vety_verze = 0
        return await super()._handle_msg_turn_complete(message)

    async def push_frame(self, frame, direction=FrameDirection.DOWNSTREAM):  # type: ignore[override]
        """Když frázi řekla rychlá dráha, řeč modelu se do zařízení nepustí.

        U OpenAI pusy se dvojhlas dá zastavit u zdroje (nepošle se
        ``response.create`` — viz ``SafeRealtimeLLMService._create_response``).
        Gemini Live tuhle páku NEMÁ: ``send_tool_response()`` rozmluví model
        přímo na serveru a klient odpověď dostane, ať chce nebo ne. Jediné
        místo, kde se dá pravidlo „mluvila rychlá dráha → model už výsledek
        nekomentuje" vynutit, je tedy cesta rámců ven.

        Zahazuje se jen OBSAH řeči (audio + text). Řídicí rámce (start/stop,
        fáze, metriky) jdou dál, aby transport ani LED prstenec neuvázly
        v „replying".
        """
        try:
            if (
                self.fastlane_muted()
                and not getattr(self, "_fastlane_playing", False)
                and isinstance(frame, (TTSAudioRawFrame, TTSTextFrame, LLMTextFrame))
            ):
                # Jednou za umlčení do INFO, ne u každého 20ms kusu audia:
                # jinak je brzda v provozu NEVIDITELNÁ (Gemini pusa navíc
                # nepíše `🤖 assistant:` do transcript_logu, takže by nebylo
                # čím doložit, že opravdu mlčí).
                znacka = getattr(self, "_fastlane_mute_until", 0.0)
                if getattr(self, "_fastlane_drop_logged", None) != znacka:
                    self._fastlane_drop_logged = znacka
                    logger.info(
                        "🔇 fast-lane (gemini): zahazuju řeč modelu — výsledek "
                        "už řekla přednahraná pusa (první zahozený: %s)",
                        type(frame).__name__,
                    )
                return
        except Exception as e:  # pragma: no cover - filtr nesmí shodit pipeline
            logger.warning("⚠️ fast-lane filtr (gemini) selhal, propouštím: %r", e)
        return await super().push_frame(frame, direction)

    # ------------------------------------------------------------------
    # KEEPALIVE TICHA — ať session nespadne na nečinnost (viz konstanty výš)
    # ------------------------------------------------------------------
    async def _send_user_audio(self, frame):  # type: ignore[override]
        """Orazítkuje ODESLANÝ zvuk a zapamatuje si jeho frekvenci.

        POZOR NA ROZDÍL (chyba z první verze, 31. 8. 18:49): rámec, který sem
        DOJDE, ještě není rámec, který Google DOSTANE — pipecat ho v
        ``_send_user_audio`` zahodí, když je ``_audio_input_paused``. Razítko
        na příchod tedy keepalivu lhalo: tvářilo se, že vstup teče, i když
        Googlu neodešlo nic, a keepalive pak nikdy nevystřelil. Razítkujeme
        proto jen tehdy, když rámec pipecatími guardy opravdu prošel.
        """
        rate = getattr(frame, "sample_rate", None)
        if rate:
            self._keepalive_rate = rate
        odeslano = not (
            getattr(self, "_audio_input_paused", False)
            or self._disconnecting
            or not self._session
        )
        await super()._send_user_audio(frame)
        if odeslano:
            self._keepalive_posledni_vstup = time.monotonic()

    async def _handle_session_ready(self, session):  # type: ignore[override]
        """Po každém (i obnoveném) spojení nastartuje keepalive."""
        await super()._handle_session_ready(session)
        self._keepalive_posledni_vstup = time.monotonic()
        if self._keepalive_task is None and _KEEPALIVE_PERIOD_S > 0:
            self._keepalive_task = self.create_task(self._keepalive_smycka())
            logger.info(
                "\U0001f493 keepalive gemini: %d ms ticha po %.0f s bez vstupu",
                _KEEPALIVE_BURST_MS, _KEEPALIVE_PERIOD_S,
            )

    async def _zastav_keepalive(self) -> None:
        if self._keepalive_task is not None:
            task, self._keepalive_task = self._keepalive_task, None
            try:
                await self.cancel_task(task, timeout=1.0)
            except Exception as e:  # pragma: no cover - úklid nesmí spadnout
                logger.debug("keepalive se nepodařilo zrušit: %r", e)

    async def _disconnect(self):  # type: ignore[override]
        await self._zastav_keepalive()
        await super()._disconnect()

    async def _keepalive_smycka(self) -> None:
        """Když dlouho nic neteče, pošli Geminimu dávku digitálního ticha.

        Posílá se JEN při skutečné nečinnosti — ne když mluví člověk (to teče
        mikrofon a razítko se obnovuje v ``_send_user_audio``) a ne když mluví
        Žán (``_bot_is_responding``), aby si most nepřerušil vlastní odpověď.
        """
        rate = self._keepalive_rate
        ticho = b"\x00" * (rate * 2 * _KEEPALIVE_BURST_MS // 1000)
        while True:
            await asyncio.sleep(1.0)
            if not self._session or self._disconnecting:
                continue
            od_vstupu = time.monotonic() - self._keepalive_posledni_vstup
            # Tvrdá podlaha přebíjí měkké podmínky — viz `_KEEPALIVE_STROP_S`.
            nouze = od_vstupu >= _KEEPALIVE_STROP_S
            if not nouze:
                if getattr(self, "_audio_input_paused", False):
                    continue
                if getattr(self, "_bot_is_responding", False):
                    continue
                if od_vstupu < _KEEPALIVE_PERIOD_S:
                    continue
            if self._keepalive_rate != rate:
                rate = self._keepalive_rate
                ticho = b"\x00" * (rate * 2 * _KEEPALIVE_BURST_MS // 1000)
            try:
                await self._session.send_realtime_input(
                    audio=Blob(data=ticho, mime_type="audio/pcm;rate=%d" % rate)
                )
            except Exception as e:
                logger.debug("keepalive neprošel (spojení se právě mění?): %r", e)
                continue
            self._keepalive_posledni_vstup = time.monotonic()
            self._keepalive_odeslano += 1
            if self._keepalive_odeslano in (1, 10) or self._keepalive_odeslano % 30 == 0:
                logger.info(
                    "\U0001f493 keepalive gemini: %d. dávka ticha "
                    "(%d ms @ %d Hz, %.0f s bez vstupu%s)",
                    self._keepalive_odeslano, _KEEPALIVE_BURST_MS, rate,
                    od_vstupu, ", TVRDÁ PODLAHA" if nouze else "",
                )

    async def _handle_connection_error(self, error: Exception) -> bool:  # type: ignore[override]
        """Terminální pád gemini pusy nesmí skončit smyčkou ``ErrorFrame``.

        CO SE DĚJE BEZ TÉHLE BRZDY (incident 30. 8. 2026, 18:34 — Ondra stál
        u němé krabičky): pipecat po třetím selhání v řadě
        (``MAX_CONSECUTIVE_FAILURES``) vrátí z ``_handle_connection_error``
        ``False``, čímž ``_connection_task_handler`` skončí ``break``. Tou
        cestou se ale NIKDY nezavolá ``_disconnect()``, takže ``self._session``
        zůstane viset jako ZAVŘENÝ, ale pravdivý objekt. Guardy
        ``not self._session`` v ``_send_user_audio`` i ``_handle_send_error``
        ho propustí, takže každý dvacetimilisekundový kus mikrofonu vyrobí
        další ``push_error`` — tisíce ``ErrorFrame`` za minutu a most, který
        už nikdy nepromluví.

        CO DĚLÁME MÍSTO TOHO: (1) vynulujeme session, čímž se ty dva pipecatí
        guardy začnou chytat a spam ustane u zdroje, (2) jednou poctivě
        zalogujeme příčinu, (3) řekneme to člověku u krabičky, (4) necháme po
        sobě značku a rychle a čistě spadneme — ``restart: unless-stopped``
        most do ~15 s zvedne a ``_resolve_pusa()`` ho podle značky pustí na
        openai pusu.

        PROČ NE VÝMĚNA SLUŽBY ZA BĚHU: pipeline se v pipecatu 0.0.97 staví
        jednou a instance služby je zadrátovaná v řetězu procesorů. Výměna za
        provozu je řádově složitější než restart a most tu nemá co držet —
        session je stejně po smrti. Jednoduchost je tady ta bezpečnější volba.
        """
        # IZOLOVANÝ PÁD NENÍ SESYPÁNÍ (viz `_IZOLOVANY_PAD_S`). Když od
        # minulého pádu uběhla víc než minuta, počítadlo se vynuluje HNED
        # TEĎ — pipecat by to sám udělal jen tehdy, kdyby zrovna chodily
        # zprávy, takže při tichu v pokoji se plazí nahoru donekonečna.
        # Musí to být PŘED `super()`, protože ten počítadlo zvedá a nad
        # `MAX_CONSECUTIVE_FAILURES` rovnou vrací False.
        ted = time.monotonic()
        predchozi = getattr(self, "_posledni_pad_t", None)
        if predchozi is not None and (ted - predchozi) > _IZOLOVANY_PAD_S:
            logger.info(
                "🔁 Gemini: od minulého pádu uběhlo %.0f s (> %.0f s) — beru to "
                "jako ojedinělý výpadek, ne sesypání; počítadlo z %s zpět na 0.",
                ted - predchozi, _IZOLOVANY_PAD_S,
                getattr(self, "_consecutive_failures", "?"),
            )
            self._consecutive_failures = 0
        self._posledni_pad_t = ted

        should_reconnect = await super()._handle_connection_error(error)
        if should_reconnect:
            return True
        if self._pusa_brzda_spustena:
            return False
        self._pusa_brzda_spustena = True
        try:
            await self._predej_pusu_openai(error)
        except Exception as e:  # pragma: no cover - brzda nesmí sama spadnout
            logger.exception("💥 brzda gemini pusy sama selhala: %r", e)
        return False

    async def _predej_pusu_openai(self, error: Exception) -> None:
        """Zastaví sesypání, oznámí to a předá pusu zpět OpenAI přes restart."""
        # 1) ZASTAVIT SPAM HNED — musí být první, ještě než cokoli awaitneme.
        self._session = None
        self._disconnecting = True
        logger.error(
            "💀 Gemini pusa terminálně selhala (%s selhání v řadě, poslední: %s: %s). "
            "Session vynulována, sesypání do ErrorFrame zastaveno.",
            getattr(self, "_consecutive_failures", "?"),
            type(error).__name__,
            error,
        )

        # 2) Člověk u krabičky musí vědět, co se stalo. Obojí jde MIMO Gemini:
        #    play_phrase tlačí PCM rovnou do výstupního transportu, takže
        #    funguje i s mrtvou session. Když fráze nahraná není, jen se to
        #    zaloguje — nic se nepředstírá.
        try:
            # force: tohle zaznít MUSÍ i s vypnutou knihovnou (nesoulad hlasů) —
            # model už nemá čím promluvit, session je po smrti.
            await self.play_phrase("zaloha_pusa", force=True)
        except Exception as e:
            logger.warning("⚠️ oznámení o přepnutí pusy se nepovedlo: %r", e)
        try:
            broadcast = getattr(self, "zan_broadcast_json", None)
            if broadcast is not None:
                # LED nesmí zůstat viset v "thinking" nad mrtvou session.
                await broadcast({"type": "phase", "value": "idle"})
        except Exception as e:
            logger.warning("⚠️ fáze 'idle' po pádu pusy neodešla: %r", e)

        # 3) Značka MUSÍ být ověřeně na disku, teprve pak smíme spadnout. Pád
        #    bez značky = restart zpátky do gemini = restart-smyčka, což je
        #    horší než němý most. Proto fail-closed směrem k "nepadat".
        if not write_fallback("%s: %s" % (type(error).__name__, error)):
            logger.error(
                "🛑 POPLACH: značku pádu (%s) NEJDE zapsat — proto NEPADÁM, "
                "restart by naběhl zpátky do gemini a zacyklil se. Most zůstává "
                "stát potichu (bez ErrorFrame) a čeká na ruku: ZAN_PUSA=openai "
                "v /etc/zan/realtime.env + recreate.",
                fallback_path(),
            )
            return

        logger.error(
            "🛟 Značka zapsána (%s) — za %.1f s ukončuji proces (exit %d). "
            "Docker mě zvedne a most naběhne na openai pusu.",
            fallback_path(), _EXIT_DELAY_S, _EXIT_CODE,
        )
        asyncio.get_running_loop().call_later(_EXIT_DELAY_S, _tvrdy_konec)

    async def _handle_msg_usage_metadata(self, message):  # type: ignore[override]
        """Nechá pipecat spočítat metriky a k tomu jeden řádek do logu.

        Nezrcadlí se do zařízení jako u OpenAI pusy: 40k/min okno je limit
        OpenAI účtu, u Gemini pro něj nemáme ověřený protějšek. Až bude
        z A/B jasné, co se má na displeji ukazovat, doplní se to sem.
        """
        await super()._handle_msg_usage_metadata(message)
        try:
            usage = getattr(message, "usage_metadata", None)
            if usage is None:
                return
            logger.info(
                "Žán usage (gemini): total=%s prompt=%s response=%s",
                getattr(usage, "total_token_count", None),
                getattr(usage, "prompt_token_count", None),
                getattr(usage, "response_token_count", None),
            )
        except Exception as e:  # pragma: no cover - log nesmí shodit relaci
            logger.debug("usage log (gemini) selhal: %r", e)


def build_gemini_tools_schema(openai_tools: Optional[List[Dict[str, Any]]]) -> Optional[ToolsSchema]:
    """Nástroje v OpenAI tvaru → pipecatí ``ToolsSchema`` pro Gemini adaptér.

    Vlastní převod (co se škrtá, jak se filtruje ``required``) dělá čistý
    ``app/gemini_tools.py``; tady se výsledek jen zabalí do ``FunctionSchema``,
    aby ho ``GeminiLLMAdapter.to_provider_tools_format`` uměl vysypat jako
    ``functionDeclarations``.
    """
    declarations = to_gemini_function_declarations(openai_tools)
    if not declarations:
        return None
    schemas = [
        FunctionSchema(
            name=declaration["name"],
            description=declaration["description"],
            properties=(declaration.get("parameters") or {}).get("properties", {}),
            required=(declaration.get("parameters") or {}).get("required", []),
        )
        for declaration in declarations
    ]
    return ToolsSchema(standard_tools=schemas)


def build_gemini_vad_params(eagerness: Optional[str],
                            silence_duration_ms: Optional[int] = None,
                            prefix_padding_ms: Optional[int] = None) -> GeminiVADParams:
    """``VAD_EAGERNESS`` → ``GeminiVADParams`` (tichem řízený VAD).

    Gemini Live nemá sémantický VAD; má jen citlivost začátku/konce řeči a
    délku ticha. ``low`` proto mapujeme na ``END_SENSITIVITY_LOW`` + delší
    ticho — tedy „raději počkej, než mě useknout uprostřed věty", což je to,
    co ``eagerness=low`` znamená na OpenAI straně.
    """
    plan = vad_plan(eagerness, silence_duration_ms, prefix_padding_ms)
    end_name = plan.get("end_sensitivity")
    # Jméno konstanty držíme jako text (čistý gemini_tools nemá závislosti),
    # takže sem doputuje řetězec. Kdyby ho google-genai v dané verzi neznal,
    # radši jedeme bez explicitní citlivosti než abychom shodili celou pusu —
    # délka ticha (to hlavní) platí i tak.
    end_sensitivity = None
    if end_name:
        end_sensitivity = getattr(EndSensitivity, str(end_name), None)
        if end_sensitivity is None:
            logger.warning(
                "⚠️ google.genai.types.EndSensitivity nezná %r — jedu bez ní", end_name
            )
            end_name = None
    params = GeminiVADParams(
        end_sensitivity=end_sensitivity,
        silence_duration_ms=plan.get("silence_duration_ms"),
        prefix_padding_ms=plan.get("prefix_padding_ms"),
    )
    logger.info(
        "🎚️ Gemini VAD: eagerness=%s → end_sensitivity=%s, silence=%sms, prefix=%sms",
        eagerness, end_name or "(server default)",
        plan.get("silence_duration_ms"), plan.get("prefix_padding_ms"),
    )
    return params


def build_gemini_service(*,
                         api_key: str,
                         model: str = DEFAULT_GEMINI_MODEL,
                         voice: str = DEFAULT_GEMINI_VOICE,
                         instructions: str = "",
                         openai_tools: Optional[List[Dict[str, Any]]] = None,
                         vad_eagerness: Optional[str] = "low",
                         vad_silence_duration_ms: Optional[int] = None,
                         vad_prefix_padding_ms: Optional[int] = None,
                         max_output_tokens: Optional[int] = None,
                         ) -> SafeGeminiLiveLLMService:
    """Postaví Gemini pusu se stejnými nástroji a promptem jako OpenAI pusa.

    ``inference_on_context_initialization=False`` je záměr, ne detail: bez
    něj pipecat při prvním kontextu nasype systémový prompt do
    ``send_client_content(turn_complete=True)`` a zařízení hned po startu
    samo od sebe promluví. Na OpenAI straně se týž problém řeší předsazením
    prázdného kontextu v ``main.run()``; tady stačí tenhle přepínač.
    """
    _over_patch_input_transcription()
    tools = build_gemini_tools_schema(openai_tools)
    params = InputParams(
        modalities=GeminiModalities.AUDIO,
        vad=build_gemini_vad_params(
            vad_eagerness, vad_silence_duration_ms, vad_prefix_padding_ms
        ),
        # KONTEXTOVÉ OKNO SE MUSÍ SAMO OŘEZÁVAT, jinak session skončí, až se
        # naplní. Google to říká natvrdo: „Without compression, audio-only
        # sessions are limited to 15 minutes ... you can use context window
        # compression to extend sessions to an unlimited amount of time."
        # (ai.google.dev/gemini-api/docs/live-session). Bez tohohle by
        # keepalive výš problém jen odsunul z 2,5 minuty na čtvrt hodiny.
        # `trigger_tokens=None` = výchozích 80 % okna (128k → ~102k).
        context_window_compression=ContextWindowCompressionParams(enabled=True),
    )
    if max_output_tokens:
        params.max_tokens = max_output_tokens

    service = SafeGeminiLiveLLMService(
        api_key=api_key,
        model=normalize_model_name(model),
        voice_id=voice or DEFAULT_GEMINI_VOICE,
        system_instruction=instructions or None,
        tools=tools,
        params=params,
        inference_on_context_initialization=False,
    )
    logger.info(
        "✅ Gemini pusa: model=%s hlas=%s nástrojů=%d",
        normalize_model_name(model), voice or DEFAULT_GEMINI_VOICE,
        len(tools.standard_tools) if tools else 0,
    )
    return service
