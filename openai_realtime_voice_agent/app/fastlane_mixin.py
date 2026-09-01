"""Rychlá dráha (přednahraná pusa) sdílená OBĚMA pusami Žána.

Proč mixin: od 30. 8. 2026 má most dvě „pusy" — OpenAI Realtime
(``SafeRealtimeLLMService`` v ``app/main.py``) a Gemini Live
(``SafeGeminiLiveLLMService`` v ``app/gemini_safety.py``). Rychlá dráha
(bezpečnostní brzda → průběhová fráze HNED + akce souběžně → ověření stavu
v HA → tón / retry / poctivé selhání) je vlastnost **Žána**, ne konkrétního
poskytovatele, takže se nesmí udržovat dvakrát: jedna kopie by se v tichosti
rozešla a s ní i brzda na nevratné úkony.

Mixin stojí na tom, co mají obě služby společné (obě dědí z
``pipecat.services.llm_service.LLMService``):

* ``register_function(...)`` se stejnou signaturou včetně
  ``cancel_on_interruption`` (definované v ``LLMService``, ne v potomcích),
* ``push_frame(...)`` z ``FrameProcessor`` — tudy jde přednahrané audio,
* atributy, které mu zvenčí nastaví ``main.py``: ``fastlane_enabled``,
  ``phrase_library``, ``zan_event_url``, ``zan_event_token``.

Použití je vždy ``class Safe…(FastLaneMixin, <PipecatService>)`` — mixin musí
být PRVNÍ, aby jeho ``register_function`` přebil ten z pipecatu a ``super()``
uvnitř mířil na skutečnou službu.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import time

from pipecat.frames.frames import (
    FunctionCallResultProperties,
    TTSAudioRawFrame,
    TTSStartedFrame,
    TTSStoppedFrame,
)

from app.phase_emitter import TURN_LIVENESS
from app import hovor_log
from app.voice_safety import (
    is_sensitive_actuation,
    saha_na_vlastni_hlas,
    bezcilny_zasah,
    oprav_domenu_a_tridu,
)
from app.voice_fastlane import (
    CHUNK_BYTES as FASTLANE_CHUNK_BYTES,
    SAMPLE_RATE as FASTLANE_SAMPLE_RATE,
    VERIFY_DELAY_S,
    VERIFY_TRIES,
    build_event,
    classify as fastlane_classify,
    fetch_states,
    judge as fastlane_judge,
    oprav_area,
    _norm,
    room_variant,
    _post_event_blocking,
)

logger = logging.getLogger(__name__)

#: Jak dlouho po přehrané frázi platí „model už k tomu nic neříká".
#:
#: DVOJHLAS (Ondra, 31. 8. 2026 08:58): „řekl jsem mu ať zhasne v obýváku a on
#: pustí to přednahrané a pak ještě dořekne". Z logu: rychlá dráha přehrála
#: `zhasinam__obyvak` + tón `vysledek_ok` a vrátila výsledek s
#: `run_llm=False` — a model přesto v 08:58:25 řekl „Hotovo, světlo v obýváku
#: je zhasnuté."
#:
#: PROČ `run_llm=False` NESTAČÍ: ten příznak umí zastavit jen JEDNU cestu —
#: `LLMAssistantAggregator._handle_function_call_result` (push_context_frame).
#: Jenže konec uživatelova tahu pošle do služby vlastní kontextový rámec a
#: `pipecat/services/openai/realtime/llm.py:_process_completed_function_calls`
#: si po odeslání výsledku nástroje zavolá `_create_response()` sám —
#: bez ohledu na `run_llm`. U Gemini Live je to ještě tvrdší: `send_tool_response`
#: rozmluví model přímo na serveru a klient s tím nemá co dělat.
#:
#: Proto je pravidlo vynucené KÓDEM a na úrovni Žána, ne poskytovatele:
#: **když frázi řekla rychlá dráha, model výsledek už nekomentuje.**
#: Okno je krátké schválně — dorovnává jen doběh téhož tahu, nesmí spolknout
#: odpověď na další povel.
FASTLANE_MUTE_S = 6.0

#: Okno, ve kterém se STEJNÉ volání STEJNÉHO nástroje bere jako duplicita.
#:
#: PROČ (31. 8. 2026, 09:42, Ondrův první povel na gemini puse): „Vypni
#: televizi." se provedlo DVAKRÁT — `HassTurnOff:fc_6104322742753481559`
#: v 09:42:30.640 a `HassTurnOff:fc_2373295578869622761` v 09:42:32.045.
#: Ondra slyšel čtyři fráze místo dvou a po deseti vteřinách to umlčel
#: tlačítkem. Mezi voláními je v logu vidět příčina:
#: `gemini_live.llm:_create_initial_response:1369` — pipecat po výsledku
#: nástroje nasype modelu celý kontext zpátky a model volání zopakuje.
#: `run_llm=False` na to nedosáhne (u Gemini vyrábí odpověď server).
#:
#: Stráž je proto na VRSTVĚ VÝKONU nástroje, ne u konkrétní pusy: sedí ve
#: `register_function`, kterým procházejí všechny nástroje obou pus, takže
#: chrání i OpenAI (tam se dvojité volání zatím neukázalo, ale příčina —
#: model, co po výsledku vidí kontext znovu — je společná).
#:
#: OD 1. 9. 2026 UŽ TOHLE ČÍSLO O DUPLICITĚ NEROZHODUJE. Zůstalo ve dvou
#: rolích, kde je čas na místě: (a) jak dlouho duplicita čeká na výsledek
#: prvního volání, (b) nouzové okno pro kanál BEZ přepisu, kde není podle
#: čeho poznat tah (viz `_dedup_je_duplicita`). O duplicitě rozhoduje TAH.
TOOL_DEDUP_S = 8.0

#: STROP EVIDENCE. Jak dlouho smí záznam nejdéle ležet, než ho úklid vyhodí.
#: NENÍ to rozhodovací znak duplicity — jen pojistka, aby evidence nerostla
#: donekonečna, kdyby přepis tahu nikdy nedorazil a razítko se nezměnilo.
#: Proto je štědrý: v praxi o ničem nerozhoduje, protože nový tah vyhodí
#: záznam mnohem dřív.
DEDUP_STROP_S = 60.0

#: Nástroje, u kterých je OPAKOVÁNÍ ZÁMĚR, ne porucha — ty se nikdy
#: nededuplikují:
#:
#: * čtení stavu a informací (`GetLiveContext`, `GetDateTime`,
#:   `todo_get_items`, `web_search`) — dvakrát přečíst nic nerozbije a
#:   zadržet druhé čtení by mohlo vrátit zastaralou pravdu o domě,
#: * RELATIVNÍ a krokové úkony (`HassSetVolumeRelative`, `HassMediaNext`,
#:   `HassMediaPrevious`) — „ztlum, ztlum" nebo „přeskoč, přeskoč" se má
#:   sečíst; deduplikovat je by znamenalo ignorovat druhé přání.
#:
#: Všechno ostatní je zásah do domu s absolutním cílem (rozsviť, zhasni,
#: zamkni seznam, pusť zálivku) — tam je druhé provedení do osmi vteřin
#: vždycky chyba, ne přání.
TOOL_DEDUP_VYJIMKY = frozenset({
    "GetLiveContext",
    "GetDateTime",
    "todo_get_items",
    "web_search",
    "HassSetVolumeRelative",
    "HassMediaNext",
    "HassMediaPrevious",
})


#: Co SMÍ rychlá dráha pustit z knihovny. Nic jiného — žádná přednahraná
#: řeč (viz `play_phrase`). Jsou to čtyři bezhlasé signály:
#:
#: * ``zvuk_zapnuti`` / ``zvuk_vypnuti`` — ~2 s, stoupavý „něco se zapíná"
#:   a klesavý „něco se vypíná" (Ondra 31. 8.: „na spouštění věcí tam dáme
#:   zvuk (nějaký uplifting 2s jak se něco zapíná) a vypínání zase jak se
#:   něco vypíná 2s"),
#: * ``vysledek_ok`` / ``vysledek_fail`` — krátké tóny po ověření stavu.
#:
#: Akce sama je potvrzení; slova k ní netřeba. Řeč zůstává modelu.
RYCHLA_DRAHA_ZVUKY = frozenset({
    "zvuk_zapnuti", "zvuk_vypnuti", "vysledek_ok", "vysledek_fail",
})

#: Okno, ve kterém se PROTICHŮDNÉ povely na tentýž cíl berou jako porucha.
#:
#: PROČ (31. 8. 2026, 10:15, dvakrát po sobě): Gemini rozseká jednu Ondrovu
#: promluvu na dva fragmenty, z nichž jeden je halucinace — do přepisu spadlo
#: i wake word:
#:
#:   🗣️ user: rozsvítit světla v obývákuA já, ne?
#:   🗣️ user: Vypni světlo v obýváku.
#:   ... a o milisekundu později:
#:   Calling function [HassTurnOn:fc_17354372043808562740]
#:   Calling function [HassTurnOff:fc_17354372043808559819]
#:
#: Model tedy vystřelí ZAPNI i VYPNI naráz. Dedup je nechytí — jsou to různé
#: nástroje s různými argumenty, takže do něj z definice nespadají. Výsledkem
#: byly dva dvousekundové zvuky PŘES SEBE a světlo, které blikne.
#:
#: Nikdo nikdy nemyslí „zapni a vypni to samé". Je to vždycky porucha vstupu,
#: takže druhý z protichůdné dvojice se NEPROVEDE a model se má doptat.
PROTISMER_S = 2.0

#: Jak dlouho po FINÁLNÍM přepisu se z něj ještě soudí, co model dělá.
#:
#: PROČ (31. 8. 2026, 10:46:12): přepis `ne baklažánu.` dorazil v 10:46:12.366
#: a o dvě milisekundy později model zavolal `HassTurnOff` na poslední zmíněné
#: světlo. Není to povel — je to zbytek wake wordu se záporem. Zásah do domu
#: postavený na útržku se NEPROVEDE.
#:
#: Okno je krátké schválně: má pokrýt doběh TÉHOŽ tahu (pozorováno < 5 ms),
#: ne zablokovat povel, který člověk řekne vzápětí správně. Záznam se navíc
#: SPOTŘEBUJE (`posledni_prepis_pouzit`), takže jeden útržek zablokuje nejvýš
#: jeden zásah.
UTRZEK_OKNO_S = 3.0

#: JAK DLOUHO SE CEKA NA PREPIS, KTERY JESTE NEDORAZIL (31. 8. 2026).
#:
#: Utrzkova pojistka se pta `posledni_prepis`. Jenze Gemini Live posila
#: PREPIS a VOLANI NASTROJE dvema nezavislymi proudy a volani umi prijit
#: DRIV. Doslovne z logu 18:49:36:
#:
#:     .271  Calling function [HassMediaSearchAndPlay] ...
#:     .272  user: Pusti koncert.        <- prepis az o 1 ms POZDEJI
#:
#: V ten okamzik drzi `posledni_prepis` jeste PREDCHOZI tah, takze pojistka
#: posuzuje uplne jinou vetu -- a smetli ji propusti. Presne tudy proslo
#: 18:48:37 "zazemi bobrivaku" (ocista to jako utrzek OZNACI, overeno
#: na vzorku), model z toho udelal HassTurnOff a v obyvaku se misto svetel
#: vypnula zasuvka.
#:
#: Proto se u zasahu do domu kratce POCKA, az prepis tohoto tahu dorazi.
#: Bezne to stoji jednotky milisekund (prepis uz je na ceste); plna cekaci
#: doba padne jen tam, kde prepis nedorazi vubec.
UTRZEK_CEKANI_S = float(os.environ.get("ZAN_UTRZEK_CEKANI_S", "0.4"))

#: Jak stary smi byt prepis, aby se jeste pocital za "tenhle tah".
UTRZEK_CERSTVY_S = 1.5

#: Slova, po kterych je jasne, ze clovek mluvi o SVETLE, ne o zasuvce.
_SVETLO_SLOVA = ("zhasni", "zhasnout", "rozsvit", "rozsvet", "rozsvec",
                 "svetl", "lampa", "lampu", "lustr")

#: Slova, po kterych je zasuvka opravdu mineny cil.
_ZASUVKA_SLOVA = ("zasuvk", "zastrck", "switch", "vypinac")

#: Nástroje, na které se útržková pojistka nevztahuje: čtení stavu (dvakrát
#: přečíst nic nerozbije), vlastní mosty (`ask_zan` si očistu dělá sám ve
#: `zan_bridge_tool`) a odpojení. Všechno ostatní JE zásah do domu.
UTRZEK_VYJIMKY = frozenset({
    "GetLiveContext",
    "GetDateTime",
    "todo_get_items",
    "web_search",
    "zeptej_se_mozku",
    "disconnect",
})

#: Průběhový záměr → zvuk, který ho zastoupí. Hlasitost a ztlumení tady
#: schválně NEJSOU: „ztlum" není zapnutí ani vypnutí, tam mluví model.
ZVUK_MISTO_RECI = {
    "rozsvecuju": "zvuk_zapnuti",
    "zapinam": "zvuk_zapnuti",
    "poustim_hudbu": "zvuk_zapnuti",
    "zhasinam": "zvuk_vypnuti",
    "vypinam": "zvuk_vypnuti",
    "zastavuju_hudbu": "zvuk_vypnuti",
}


def _dedup_klic(function_name: str, arguments) -> str:
    """Otisk volání: jméno nástroje + argumenty nezávisle na pořadí klíčů."""
    try:
        args = json.dumps(arguments or {}, sort_keys=True, ensure_ascii=False,
                          default=str)
    except Exception:  # pragma: no cover - otisk nesmí shodit tool
        args = repr(arguments)
    return f"{function_name}|{args}"


#: Jak poznat, ze vysledek nastroje je ve skutecnosti chyba. MCP je vraci
#: jako text, takze isinstance(..., Exception) je nechyti.
_CHYBOVE_ZNAKY = (
    "input validation error",
    "error calling tool",
    "matchfailederror",
    "no_match",
    "failed to",
    "traceback",
)


def _vysledek_je_chyba(vysledek):
    """True, kdyz vysledek nastroje hlasi chybu (vyjimkou i textem)."""
    if isinstance(vysledek, Exception):
        return True
    try:
        text = str(vysledek).lower()
    except Exception:  # pragma: no cover
        return False
    return any(z in text for z in _CHYBOVE_ZNAKY)


def _bez_diakritiky_lower(text: str) -> str:
    """Male pismeno bez diakritiky -- na porovnavani slov z prepisu."""
    import unicodedata
    nfkd = unicodedata.normalize("NFKD", str(text or ""))
    return "".join(c for c in nfkd if not unicodedata.combining(c)).lower()


class FastLaneMixin:
    """Bezpečnostní brzda + rychlá dráha nad libovolnou pipecat LLM službou."""

    # -----------------------------------------------------------------------
    # Umlčení modelu po přehrané frázi (obě pusy)
    # -----------------------------------------------------------------------

    # -----------------------------------------------------------------------
    # Útržková pojistka + hlášení anomálií
    # -----------------------------------------------------------------------

    def _rozbor(self, druh: str, **kw) -> None:
        """Anomálie výměny → Žánovi k rozboru (`app/anomalie.py`)."""
        rozbor = getattr(self, "rozbor", None)
        if rozbor is None:
            return
        try:
            if "prepis" not in kw:
                o = getattr(self, "posledni_prepis", None)
                kw["prepis"] = getattr(o, "puvodni", "") if o is not None else ""
            rozbor.nahlas(druh, **kw)
        except Exception:  # pragma: no cover - hlásič nesmí shodit tool
            logger.debug("nahlášení anomálie selhalo", exc_info=True)

    def _utrzek_blokuje(self, function_name: str) -> str:
        """Vrátí důvod, proč se zásah NEMÁ provést. Prázdný řetězec = jeď.

        Ptá se posledního finálního přepisu, který most slyšel (věší ho tam
        `websocket_handler.na_prepis`). Když to nebyl povel, model jedná na
        šumu a dům na to nemá reagovat. Záznam se spotřebuje, takže další
        (už správný) povel projde.
        """
        if function_name in UTRZEK_VYJIMKY:
            return ""
        o = getattr(self, "posledni_prepis", None)
        if o is None:
            return ""
        # PŘÍSNÝ verdikt schválně (1. 9. 2026). `o.utrzek` od zavedení okna
        # rozhovoru („Žán se právě zeptal") krátkou větu propouští — to je
        # správně pro MOZEK, ale ne pro RUCE. Kdyby se tahle brzda řídila
        # měkkým verdiktem, otevřelo by okno rozhovoru na dvacet sekund
        # i cestu k zásahu do domu ze slova „Eliška". Fallback na `utrzek`
        # je jen pro starší objekt bez toho pole.
        prisne = getattr(o, "utrzek_prisne", None)
        if prisne is None:
            prisne = getattr(o, "utrzek", False)
        if not prisne:
            return ""
        if getattr(self, "posledni_prepis_pouzit", False):
            return ""
        if time.monotonic() - getattr(self, "posledni_prepis_t", 0.0) > UTRZEK_OKNO_S:
            return ""
        self.posledni_prepis_pouzit = True
        # Prázdný `duvod` při přísném útržku znamená, že text pustilo dál
        # okno rozhovoru — ať je to v logu poznat, ne schované pod „útržek".
        return (getattr(o, "duvod", "") or
                "útržek propuštěný oknem rozhovoru — na dům se v něm nesahá")

    async def _pockej_na_prepis(self, function_name: str) -> None:
        """Kratce pocka, az dorazi prepis TOHOTO tahu (viz UTRZEK_CEKANI_S).

        Bez tohohle cekani posuzuje utrzkova pojistka vetu z predchoziho
        tahu, protoze volani nastroje umi predbehnout prepis. Nic nevraci --
        jen zdrzi, aby mel `_utrzek_blokuje` co cist.
        """
        if function_name in UTRZEK_VYJIMKY or UTRZEK_CEKANI_S <= 0:
            return

        def _cerstvy() -> bool:
            t = getattr(self, "posledni_prepis_t", 0.0)
            if not t or getattr(self, "posledni_prepis_pouzit", False):
                return False
            return (time.monotonic() - t) <= UTRZEK_CERSTVY_S

        if _cerstvy():
            return
        zacatek = time.monotonic()
        while (time.monotonic() - zacatek) < UTRZEK_CEKANI_S:
            await asyncio.sleep(0.02)
            if _cerstvy():
                logger.info(
                    "\u23f1\ufe0f utrzkova pojistka: prepis dorazil o %.0f ms pozdeji nez "
                    "volani %s -- cekani se vyplatilo",
                    (time.monotonic() - zacatek) * 1000.0, function_name,
                )
                return
        logger.info(
            "\u23f1\ufe0f utrzkova pojistka: prepis tohoto tahu nedorazil do %.0f ms "
            "(%s) -- posuzuju bez nej", UTRZEK_CEKANI_S * 1000.0, function_name,
        )

    def oprav_svetlo_vs_zasuvka(self, function_name: str, arguments) -> str:
        """"Zhasni" nesmi skoncit na zasuvce. Vraci popis zmeny pro log.

        Ziva zaminka (31. 8. 2026, 18:48:37): na "zhasni v obyvaku" poslal
        model `domain: ['switch']` a v obyvaku se vypnula VOLNA ZASUVKA
        (switch.sonoff_acc8007972), zatimco svetla svitila dal. Akce
        USPELA, takze zadna brzda na selhani nepomuze -- byl to spatny CIL.

        Prepisuje se jen tehdy, kdyz clovek prokazatelne mluvil o svetle
        a zaroven NEzminil zasuvku. Kdyz o zasuvce mluvil, nechava se byt --
        "vypni zasuvku v obyvaku" je legitimni povel.
        """
        if function_name not in ("HassTurnOn", "HassTurnOff", "HassLightSet"):
            return ""
        if not isinstance(arguments, dict) or arguments.get("name"):
            return ""
        domeny = arguments.get("domain")
        if isinstance(domeny, str):
            domeny = [domeny]
        if not domeny or [str(d).lower() for d in domeny] != ["switch"]:
            return ""
        o = getattr(self, "posledni_prepis", None)
        veta = _bez_diakritiky_lower(getattr(o, "text", "") or getattr(o, "puvodni", "") or "")
        if not veta:
            return ""
        if any(z in veta for z in _ZASUVKA_SLOVA):
            return ""
        if not any(s in veta for s in _SVETLO_SLOVA):
            return ""
        arguments["domain"] = ["light"]
        return "domain switch -> light (clovek mluvil o svetle, ne o zasuvce)"

    def fastlane_mute_model(self, duvod: str) -> None:
        """Zapne okno, ve kterém model nesmí komentovat výsledek."""
        self._fastlane_mute_until = time.monotonic() + FASTLANE_MUTE_S
        logger.info("🔇 fast-lane: model umlčen na %.0f s (%s)", FASTLANE_MUTE_S, duvod)

    def fastlane_muted(self) -> bool:
        """Platí právě teď „mluvila rychlá dráha, model mlčí"?"""
        return time.monotonic() < getattr(self, "_fastlane_mute_until", 0.0)

    def fastlane_unmute(self, duvod: str = "") -> None:
        """Zruší umlčení — nový tah uživatele, nebo jsme ho právě spotřebovali."""
        if getattr(self, "_fastlane_mute_until", 0.0):
            self._fastlane_mute_until = 0.0
            if duvod:
                logger.debug("🔈 fast-lane: umlčení zrušeno (%s)", duvod)

    # -----------------------------------------------------------------------
    # Dedup stráž: tentýž zásah do domu se do 8 s neprovede podruhé
    # -----------------------------------------------------------------------

    def _dedup_zaznamy(self) -> dict:
        """Evidence běžících/nedávných volání. Per relace (per satelit)."""
        zaznamy = getattr(self, "_tool_dedup", None)
        if zaznamy is None:
            zaznamy = {}
            self._tool_dedup = zaznamy
        return zaznamy

    def _dedup_uklid(self, ted: float) -> None:
        """Vyhodí, co překročilo strop — evidence nesmí růst donekonečna.

        Tohle NENÍ rozhodování o duplicitě (to dělá `_dedup_je_duplicita`
        podle tahu), jen úklid paměti.
        """
        zaznamy = self._dedup_zaznamy()
        for klic in [k for k, z in zaznamy.items()
                     if ted - z["t"] > DEDUP_STROP_S]:
            zaznamy.pop(klic, None)

    def _dedup_tah(self) -> float:
        """Razítko TAHU = jedné lidské promluvy.

        `websocket_handler.na_prepis` ho přepíše při KAŽDÉM finálním
        přepisu (`posledni_prepis_t`), takže dvě volání se stejným
        razítkem vznikla z TÉŽE věty — druhé je echo modelu, ne druhé
        přání člověka. `liveness_tracked` navíc nahoře awaituje
        `_pockej_na_prepis`, takže tady je přepis tohohle tahu už
        k dispozici (volání nástroje umí přepis o pár ms předběhnout).

        0.0 = razítko není (kanál bez přepisu, testy) → padá se na čas.
        """
        try:
            return float(getattr(self, "posledni_prepis_t", 0.0) or 0.0)
        except (TypeError, ValueError):  # pragma: no cover
            return 0.0

    def _dedup_je_duplicita(self, zaznam: dict, ted: float) -> bool:
        """Je tohle volání duplicitou dřívějšího záznamu?

        ROZHODUJE TAH, NE STOPKY (1. 9. 2026):

        * dokud první volání BĚŽÍ, je druhé duplicita vždycky — na tutéž
          otázku se druhý dotaz nezakládá,
        * doběhlé volání je duplicita, jen když je ze STEJNÉHO tahu;
          jakmile člověk promluví znovu, je to nové přání a projde
          okamžitě — i za půl vteřiny,
        * bez razítka tahu (kanál bez přepisu, testy) se padá na původní
          časové okno `TOOL_DEDUP_S`,
        * přes `DEDUP_STROP_S` už duplicita není nikdy (úklid paměti).

        PROČ PRYČ OD ČASU: časové okno je slabé z principu — ať se zvolí
        jakákoli hodnota, jednou přijde volání o chlup později. 31. 8.
        v 15:19:47,272 a 15:19:50,493 se `HassTurnOff` provedl dvakrát
        bez druhého vysloveného povelu: okno tehdy spadlo na 2,5 s
        (výsledek nebyl `verified_success`) a druhé volání přišlo za
        2,7 s. Tah je oproti tomu tvrdý znak: model si v jednom tahu
        nový přepis nevyrobí, člověk bez nového přepisu nepromluví.
        """
        if not zaznam["hotovo"].is_set():
            return True
        if ted - zaznam["t"] > DEDUP_STROP_S:
            return False
        tah_ted = self._dedup_tah()
        tah_zaznam = zaznam.get("tah", 0.0)
        if tah_ted and tah_zaznam:
            return tah_ted == tah_zaznam
        return (ted - zaznam["t"]) < TOOL_DEDUP_S

    def register_function(self, function_name, handler, start_callback=None, *,
                          cancel_on_interruption: bool = True):  # type: ignore[override]
        """Force cancel_on_interruption=False for every tool registration.

        pipecat cancels in-flight function-call tasks on EVERY user-speech
        interruption — and semantic_vad fires one per utterance fragment, so
        merely continuing your own sentence kills the tool call your previous
        fragment started. By then the HTTP request to Home Assistant has
        usually already been SENT: the action executes, but its result never
        reaches the model, which then tells the user it failed (observed
        live: the lights turned ON while the assistant claimed they
        wouldn't). Our tools are all short-lived (HA service calls, one web
        search), so letting them finish and report the truth always beats
        killing them halfway. This single override covers every registration
        path (MCP tools via pipecat's MCPClient, web_search, disconnect).

        The handler is also wrapped to tick TURN_LIVENESS around its run, so
        the PhaseEmitter's thinking-watchdog knows a tool is in flight and a
        slow tool (web search: 10-20 s of pipeline silence) is never mistaken
        for a dead turn. All our handlers use the single-param
        FunctionCallParams signature, so the wrapper does too (pipecat
        inspects the signature to pick the calling convention).
        """
        async def liveness_tracked(params):
            # ÚTRŽKOVÁ POJISTKA (2026-08-31): poslední věc, kterou most slyšel,
            # nebyl povel — jen wake word, "ne", citoslovce. Zásah do domu se
            # neprovede a model se má doptat. Sedí PŘED vším ostatním: nemá
            # smysl opravovat oblast ani deduplikovat něco, co se vůbec nemá
            # stát. (Živě 10:46:12: `ne baklažánu.` → HassTurnOff → fail.)
            # Nez se pojistky zeptame, musi mit CO cist: volani nastroje umi
            # predbehnout prepis teze promluvy (log 18:49:36, rozdil 1 ms).
            try:
                await self._pockej_na_prepis(function_name)
            except Exception as e:  # pragma: no cover - cekani nesmi shodit tool
                logger.warning("⚠️ cekani na prepis selhalo, jedu dal: %r", e)

            try:
                duvod_utrzku = self._utrzek_blokuje(function_name)
            except Exception as e:  # pragma: no cover - pojistka nesmí shodit tool
                logger.warning("⚠️ útržková pojistka selhala, propouštím tool: %r", e)
                duvod_utrzku = ""
            if duvod_utrzku:
                o = getattr(self, "posledni_prepis", None)
                logger.warning(
                    "🗑 útržek: %s(%r) NEPROVÁDÍM — poslední přepis %r nebyl povel (%s)",
                    function_name, getattr(params, "arguments", None),
                    getattr(o, "puvodni", ""), duvod_utrzku,
                )
                self._rozbor(
                    "utrzek-zasah",
                    volani="%s(%r)" % (function_name, getattr(params, "arguments", None)),
                    vysledek="neprovedeno",
                    poznamka="poslední přepis nebyl povel (%s)" % duvod_utrzku,
                )
                await params.result_callback(
                    "Poslední, co bylo slyšet, nebyl povel — nic jsem neprovedl. "
                    "Zeptej se jednou krátkou větou, co má Žán udělat."
                )
                return

            # TRVALY ZAZNAM (karta -21): "co z promluvy vzniklo". Sem se
            # dostane jen tah, ktery utrzkova pojistka NEBLOKOVALA (ten
            # pripad uz zapsal websocket_handler.na_prepis primo -- zna
            # presny duvod bez zavislosti na tomhle miste). POZOR: pise se
            # PRED dalsimi brzdami nize (safety-gate, vlastni hlas, bezcilny
            # zasah, dedup) -- radek tedy rika "model se pokusil zavolat
            # X", ne "X se provedlo". Kdyz zasah zablokuje NEKTERA z nich,
            # tenhle radek uz existuje a dalsi se neprepisuje (znamy
            # zjednoduseni v1, viz karta -21).
            try:
                if not getattr(self, "posledni_prepis_hovor_zapsano", False):
                    _o = getattr(self, "posledni_prepis", None)
                    _args = getattr(params, "arguments", None)
                    _vysledek = (
                        "delegovano_mozku" if function_name == "zeptej_se_mozku"
                        else "%s(%r)" % (function_name, _args)
                    )
                    hovor_log.zapis(
                        "clovek", kanal=getattr(self, "zan_client_id", None),
                        prepis=getattr(_o, "puvodni", None),
                        cisty=getattr(_o, "text", None),
                        vysledek=_vysledek,
                    )
                    self.posledni_prepis_hovor_zapsano = True
            except Exception as e:  # noqa: BLE001 - zapis nesmi shodit tool
                logger.debug("zápis volání nástroje do hovory selhal: %r", e)

            # HARD BEZPEČNOSTNÍ BRZDA (2026-08-22): nevratné/rizikové cíle
            # (zámky, alarm, brány/garážová vrata, kotel) se na rychlé dráze
            # NEPROVÁDĚJÍ — vždy přes ask_zan (elevace + potvrzení v Žán-Code).
            # Vynuceno kódem, ne jen promptem; čtení (GetLiveContext) a vlastní
            # mosty (ask_zan/web_search) jsou vyňaté ve voice_safety.
            try:
                if is_sensitive_actuation(function_name, getattr(params, "arguments", None)):
                    logger.warning(
                        "🛑 fast-lane blokoval citlivý úkon %s(%r) → přesměruj na ask_zan",
                        function_name, getattr(params, "arguments", None),
                    )
                    await params.result_callback(
                        "Tohle je bezpečnostní úkon — zámek, alarm, vrata nebo kotel. "
                        "Neprovedu ho napřímo. Zavolej ask_zan s přesným zněním, ať to potvrdíme."
                    )
                    return
            except Exception as e:  # pragma: no cover - brzda nesmí shodit tool
                logger.warning(f"⚠️ safety-gate check selhal, propouštím tool: {e!r}")

            # VLASTNI HLAS (2026-08-31). Zan si nesmi stahnout ani umlcet
            # prehravac, kterym mluvi. Fail-closed: pri nejistote NEPUSTIT --
            # nemy Zan je porucha, kterou nema jak ohlasit.
            try:
                duvod_hlas = saha_na_vlastni_hlas(
                    function_name, getattr(params, "arguments", None))
            except Exception as e:  # pragma: no cover - brzda nesmi shodit tool
                logger.warning("⚠️ brzda vlastniho hlasu selhala — NEPOUSTIM: %r", e)
                duvod_hlas = "brzda selhala, nepoustim naslepo"
            if duvod_hlas:
                logger.warning(
                    "🔊 BRZDA vlastniho hlasu: %s(%r) NEPROVADIM — %s",
                    function_name, getattr(params, "arguments", None), duvod_hlas,
                )
                self._rozbor(
                    "vlastni-hlas",
                    volani="%s(%r)" % (function_name, getattr(params, "arguments", None)),
                    vysledek="neprovedeno",
                    poznamka=duvod_hlas,
                )
                await params.result_callback(
                    "Hlasitost jsem neměnil. Takhle bez určení zařízení bych "
                    "ztlumil i sám sebe. Řekni, kterému zařízení se má "
                    "hlasitost změnit."
                )
                return

            # BEZCILNY ZASAH (2026-08-31). "Bez cile" v Home Assistantu neni
            # "nic", ale "vsechno, co odpovida" -- u zhasinani cely dum.
            try:
                duvod_bezcil = bezcilny_zasah(
                    function_name, getattr(params, "arguments", None))
            except Exception as e:  # pragma: no cover - brzda nesmi shodit tool
                logger.warning("⚠️ brzda bezcilneho zasahu selhala — NEPOUSTIM: %r", e)
                duvod_bezcil = "brzda selhala, nepoustim naslepo"
            if duvod_bezcil:
                logger.warning(
                    "🎯 BRZDA bezcilneho zasahu: %s(%r) NEPROVADIM — %s",
                    function_name, getattr(params, "arguments", None), duvod_bezcil,
                )
                self._rozbor(
                    "bezcilny-zasah",
                    volani="%s(%r)" % (function_name, getattr(params, "arguments", None)),
                    vysledek="neprovedeno",
                    poznamka=duvod_bezcil,
                )
                await params.result_callback(
                    "Neprovedl jsem to — nevím, čeho se to má týkat, a plošně "
                    "to udělat nechci. Řekni, které zařízení nebo místnost."
                )
                return

            # DOMENA vs DEVICE_CLASS (2026-08-31). Model plete "light" do
            # device_class, kam patri jen tridy jako door/window/tv. HA to
            # odmitne a navenek to vypada, ze Zan nechce poslechnout.
            try:
                _zmeny = oprav_domenu_a_tridu(getattr(params, "arguments", None))
                if _zmeny:
                    logger.warning("🔁 %s: %s (opraveno pred odeslanim do domu)",
                                   function_name, "; ".join(_zmeny))
            except Exception as e:  # pragma: no cover - oprava nesmi shodit tool
                logger.warning("⚠️ oprava domena/device_class selhala, jedu dal: %r", e)

            # SVETLO vs ZASUVKA (2026-08-31). "Zhasni v obyvaku" skoncilo
            # vypnutou zasuvkou, protoze model poslal domain: ['switch'].
            try:
                _z = self.oprav_svetlo_vs_zasuvka(
                    function_name, getattr(params, "arguments", None))
                if _z:
                    logger.warning("\U0001f4a1 %s: %s", function_name, _z)
            except Exception as e:  # pragma: no cover - oprava nesmi shodit tool
                logger.warning("⚠️ oprava svetlo/zasuvka selhala, jedu dal: %r", e)

            # OPRAVA OBLASTI (2026-08-31): model umí poslat `living_room`
            # místo „Obývák" a HA to odmítne jako INVALID_AREA — navenek to
            # vypadá, že Žán nechce poslechnout. Opraví se JEN když v domě
            # existuje právě jeden odpovídající pokoj (viz `oprav_area`).
            try:
                _args = getattr(params, "arguments", None)
                if isinstance(_args, dict) and _args.get("area"):
                    _opravena = oprav_area(_args["area"])
                    if _opravena:
                        logger.warning(
                            "🗺️ oblast %r neexistuje — opravuju na %r (%s)",
                            _args["area"], _opravena, function_name)
                        _args["area"] = _opravena
            except Exception as e:  # pragma: no cover - oprava nesmí shodit tool
                logger.warning("⚠️ oprava oblasti selhala, jedu dál: %r", e)

            # DEDUP STRÁŽ (2026-08-31): tentýž zásah do domu se do
            # `TOOL_DEDUP_S` neprovede podruhé. Model po výsledku nástroje
            # dostane kontext znovu a volání zopakuje (u Gemini prokazatelně,
            # viz `TOOL_DEDUP_S`) — dům by pak úkon udělal dvakrát a rychlá
            # dráha by přehrála dvě sady frází. Druhé volání dostane
            # VÝSLEDEK PRVNÍHO, ať model nezůstane bez ack a nezacyklí se.
            dedup_klic = None
            if function_name not in TOOL_DEDUP_VYJIMKY:
                ted = time.monotonic()
                self._dedup_uklid(ted)
                zaznamy = self._dedup_zaznamy()
                dedup_klic = _dedup_klic(function_name, getattr(params, "arguments", None))
                drivejsi = zaznamy.get(dedup_klic)
                if drivejsi is not None and not self._dedup_je_duplicita(drivejsi, ted):
                    # JINÝ TAH = člověk povel řekl ZNOVU. Není to echo
                    # modelu, je to nové přání — starý záznam zahodíme
                    # a volání pustíme dál. Brzda, která by spolkla
                    # i legitimní druhý povel, je horší než dvojí
                    # provedení.
                    logger.info(
                        "dedup: %s se stejnými argumenty už proběhl, ale v JINÉM "
                        "tahu — člověk to řekl znovu, PROVÁDÍM", function_name,
                    )
                    zaznamy.pop(dedup_klic, None)
                    drivejsi = None
                if drivejsi is not None:
                    logger.warning(
                        "⚠️ dedup: %s se stejnými argumenty už běží/proběhl před "
                        "%.1f s v TÉMŽ tahu — DRUHÉ VOLÁNÍ NEPROVÁDÍM "
                        "(první: %s, druhé: %s)",
                        function_name, ted - drivejsi["t"],
                        drivejsi.get("tool_call_id", "?"),
                        getattr(params, "tool_call_id", "?"),
                    )
                    self._rozbor(
                        "dedup",
                        volani="%s(%r)" % (function_name, getattr(params, "arguments", None)),
                        vysledek="druhé volání neprovedeno",
                        poznamka="stejný nástroj se stejnými argumenty v témž tahu",
                    )
                    # Počkej na výsledek prvního, ať vracíme pravdu, ne dohad.
                    if not drivejsi["hotovo"].is_set():
                        try:
                            await asyncio.wait_for(
                                drivejsi["hotovo"].wait(), timeout=TOOL_DEDUP_S
                            )
                        except asyncio.TimeoutError:
                            logger.warning(
                                "⚠️ dedup: první volání %s se do %.0f s neozvalo — "
                                "vracím neutrální potvrzení", function_name, TOOL_DEDUP_S,
                            )
                    if drivejsi["hotovo"].is_set():
                        await params.result_callback(
                            drivejsi["vysledek"], properties=drivejsi["properties"]
                        )
                    else:
                        await params.result_callback(
                            {"status": "duplicate_ignored",
                             "note": "Tentýž povel už probíhá. Nic neopakuj a mlč."},
                            properties=FunctionCallResultProperties(run_llm=False),
                        )
                    return

                # Zapiš se JAKO BĚŽÍCÍ dřív, než cokoli awaitneme — jinak by
                # dvě souběžná volání proklouzla obě.
                zaznam = {
                    "t": ted,
                    "tool_call_id": getattr(params, "tool_call_id", "?"),
                    "hotovo": asyncio.Event(),
                    "vysledek": None,
                    "properties": None,
                    # RAZÍTKO TAHU, ze kterého volání vzešlo. Podle něj se
                    # pozná echo modelu (týž tah) od druhého přání člověka
                    # (jiný tah). Viz `_dedup_je_duplicita`.
                    "tah": self._dedup_tah(),
                }
                zaznamy[dedup_klic] = zaznam

                # Výsledek si po cestě odchytneme, ať ho má čím dostat případná
                # duplicita. Musí obalit callback DŘÍV, než ho převezme
                # `_run_fast_lane` (ten si ho schovává jako `real_cb`).
                puvodni_cb = params.result_callback

                async def zapamatuj_a_posli(result, *, properties=None):
                    zaznam["vysledek"] = result
                    zaznam["properties"] = properties
                    # OKNO SE UŽ PODLE VÝSLEDKU NEUPRAVUJE (1. 9. 2026).
                    # Dřív se po neúspěchu srazilo na 2,5 s, aby člověk
                    # mohl povel zopakovat. Jenže `verified_success` vyrábí
                    # jediné místo (`_run_fast_lane`), takže na 2,5 s padala
                    # i delegace na mozek a všechno mimo rychlou dráhu —
                    # a druhé volání modelu se za tu hranici vešlo.
                    # Obojí teď řeší TAH: echo modelu je v témž tahu
                    # (blokuje se navždy), lidské zopakování je v jiném
                    # (projde hned). Viz `_dedup_je_duplicita`.
                    zaznam["hotovo"].set()
                    return await puvodni_cb(result, properties=properties)

                params.result_callback = zapamatuj_a_posli

            # RYCHLÁ DRÁHA (2026-08-22): u jednoduchých povelů, kde víme, co má
            # být po akci vidět ve stavu, jede tok „průběhová fráze HNED +
            # akce souběžně → ověření → tón". Cokoli jiného (a všechno, co
            # projde bezpečnostní brzdou výš) jde beze změny starou cestou.
            plan = None
            if getattr(self, "fastlane_enabled", False):
                try:
                    plan = fastlane_classify(function_name, getattr(params, "arguments", None))
                except Exception as e:  # pragma: no cover
                    logger.warning(f"⚠️ fast-lane klasifikace selhala: {e!r}")

            # Hlídač „myslím" musí koukat na nástroje TOHOTO satelitu. Kdyby se
            # sdílel (modulový TURN_LIVENESS), web search u televize by držel
            # hlídače i satelitu v domě a jeho mrtvá otočka by se neodblokovala.
            # `turn_liveness` na službu věší main.py při stavbě relace satelitu;
            # bez něj (starý/testovací kód) se spadne na modulový.
            # PROTICHŮDNÉ POVELY V JEDNOM TAHU (viz `PROTISMER_S`): zapni
            # i vypni totéž naráz nikdy není přání, vždycky porucha vstupu.
            # Druhý z dvojice se NEPROVEDE a model se má doptat.
            if plan is not None:
                smer = ZVUK_MISTO_RECI.get(plan.progress)
                if smer:
                    cil = _norm(plan.target or plan.area or "?")
                    ted2 = time.monotonic()
                    protismery = getattr(self, "_protismer", None)
                    if protismery is None:
                        protismery = {}
                        self._protismer = protismery
                    posl = protismery.get(cil)
                    if (posl and posl["smer"] != smer
                            and ted2 - posl["t"] < PROTISMER_S):
                        logger.warning(
                            "🚫 protichůdný povel na %r: %s vs %s do %.1f s — "
                            "NEPROVÁDÍM, model se má doptat",
                            cil, posl["smer"], smer, ted2 - posl["t"])
                        self._rozbor(
                            "protismer",
                            volani="%s(%r)" % (function_name, getattr(params, "arguments", None)),
                            vysledek="druhý z dvojice neproveden",
                            poznamka="protichůdné povely na %r do %.1f s" % (cil, PROTISMER_S),
                        )
                        self.fastlane_unmute("protichůdné povely — model se ptá")
                        await params.result_callback(
                            "V jednom tahu dorazily protichůdné povely (zapnout "
                            f"i vypnout {plan.target or plan.area or 'totéž'}). "
                            "Neprovedl jsem ten druhý. Zeptej se uživatele "
                            "jednou krátkou větou, co má platit.")
                        return
                    protismery[cil] = {"t": ted2, "smer": smer}

            liveness = getattr(self, "turn_liveness", None) or TURN_LIVENESS
            liveness.tool_started()
            try:
                if plan is not None:
                    return await self._run_fast_lane(plan, function_name, handler, params)
                return await handler(params)
            finally:
                liveness.tool_finished()
                # Kdyby nástroj spadl nebo callback nikdy nezavolal, ať
                # případná duplicita nečeká celé okno nadarmo.
                if dedup_klic is not None:
                    zaznam = self._dedup_zaznamy().get(dedup_klic)
                    if zaznam is not None and not zaznam["hotovo"].is_set():
                        zaznam["hotovo"].set()

        super().register_function(
            function_name, liveness_tracked, start_callback, cancel_on_interruption=False
        )

    # -----------------------------------------------------------------------
    # Rychlá dráha: přednahraná pusa místo modelu
    # -----------------------------------------------------------------------

    async def play_phrase(self, zamer: str, *, force: bool = False) -> bool:
        """Pustí přednahranou frázi/tón rovnou do pipeline — bez modelu.

        ``force=True`` obejde vypnutou knihovnu (``fastlane_phrases_enabled``).
        Používá to JEDINÁ věc: oznámení o pádu pusy v ``gemini_safety`` — to
        musí zaznít i tehdy, když model mluvit nemůže, protože je po session.

        Audio jde jako `TTSAudioRawFrame` po 20 ms kusech, tedy přesně tak,
        jak do pipeline padá řeč z modelu. Pro zařízení je to k nerozeznání
        od normální odpovědi, jen nestála nic a nečekalo se na model.

        Knihovna frází je v 24 kHz (`voice_fastlane.SAMPLE_RATE`), což je
        zároveň výstupní rychlost OBOU pus (OpenAI Realtime i Gemini Live
        vrací 24 kHz PCM), takže mixin nemusí nic převzorkovávat.
        """
        # JEN ZVUKY, ŽÁDNÁ PŘEDNAHRANÁ ŘEČ (Ondra, 31. 8. 2026). Knihovna je
        # namluvená jedním hlasem (`ash`), ale pusa mluví jiným — v jedné
        # výměně pak promluvili dva různí lidé: „pořád dva hlasy. Je to hnus."
        # Rozhodnutí: „nic negeneruj, říkal jsem že bude nějaký zvuk."
        # Rychlá dráha proto smí pustit POUZE bezhlasé signály
        # (`RYCHLA_DRAHA_ZVUKY`); mluvená fráze se nepřehraje nikdy. Když je
        # opravdu potřeba něco ŘÍCT, řekne to model — jedním hlasem.
        if not force and zamer not in RYCHLA_DRAHA_ZVUKY:
            logger.debug("🔇 rychlá dráha nemluví — %r nechávám modelu", zamer)
            return False
        lib = getattr(self, "phrase_library", None)
        if lib is None:
            return False
        pcm = lib.get(zamer)
        if not pcm:
            logger.info("🔇 fráze %r není v knihovně — nechávám mluvit model", zamer)
            return False
        # Vlastní hlas rychlé dráhy nesmí spadnout do filtru, který u Gemini
        # pusy zahazuje řeč modelu během umlčení (`fastlane_muted`).
        self._fastlane_playing = True
        try:
            await self.push_frame(TTSStartedFrame())
            for i in range(0, len(pcm), FASTLANE_CHUNK_BYTES):
                await self.push_frame(
                    TTSAudioRawFrame(
                        audio=pcm[i:i + FASTLANE_CHUNK_BYTES],
                        sample_rate=FASTLANE_SAMPLE_RATE,
                        num_channels=1,
                    )
                )
            await self.push_frame(TTSStoppedFrame())
            logger.info("🔊 přehráno z knihovny: %s (%d B)", zamer, len(pcm))
            return True
        except Exception as e:  # pragma: no cover - přehrání nesmí shodit tool
            logger.warning("⚠️ přehrání fráze %s selhalo: %r", zamer, e)
            return False
        finally:
            self._fastlane_playing = False

    # -----------------------------------------------------------------------
    # DOSLOVNÁ ŘEČ MOZKU (31. 8. 2026) — „mluví mozek, pusa je tlumočník"
    # -----------------------------------------------------------------------

    async def rekni_doslova(self, text: str) -> bool:
        """Vysloví text PŘESNĚ tak, jak přišel od mozku. Bez modelu.

        Tohle je jediný rozdíl mezi „Žán tlumočí" a „Žán si vymýšlí".
        Dosavadní cesta (vlož text do Live session + `response.create`)
        dává text jazykovému modelu jako PODNĚT, ne jako věty k vyslovení —
        a lite model ho přebásní. Živě z `hovory/2026-08-31.jsonl` 08:18:
        na „Ukaž mi mozek." pusa odpověděla o poště a kalendáři.

        Tady text do modelu nejde vůbec: `app/mluvci_piper.py` z něj udělá
        PCM a to se do pipeline vloží stejnými rámci jako přednahraná fráze
        (`play_phrase`). Pro zařízení je to k nerozeznání od řeči pusy.
        Doslovnost je vlastností KONSTRUKCE, ne slibu v promptu.

        Vrací False, když se to nepovedlo — volající pak smí sáhnout po
        záložní cestě (vstříknout do session a nechat mluvit pusu), aby
        Žán radši mluvil nepřesně než vůbec.
        """
        text = str(text or "").strip()
        if not text:
            return False
        try:
            from app import mluvci_piper
        except Exception as e:  # pragma: no cover - chybějící modul nesmí umlčet Žána
            logger.warning("⚠️ mluvčí není k dispozici (%r) — nechám mluvit pusu", e)
            return False

        zacatek = time.monotonic()
        try:
            pcm = await asyncio.to_thread(mluvci_piper.synth, text)
        except Exception as e:  # pragma: no cover
            logger.warning("⚠️ mluvčí selhal (%r) — nechám mluvit pusu", e)
            return False
        if not pcm:
            return False

        # Vlastní hlas nesmí spadnout do filtru, který zahazuje řeč modelu
        # během umlčení rychlou dráhou (`fastlane_muted`).
        self._fastlane_playing = True
        try:
            await self.push_frame(TTSStartedFrame())
            for i in range(0, len(pcm), FASTLANE_CHUNK_BYTES):
                await self.push_frame(
                    TTSAudioRawFrame(
                        audio=pcm[i:i + FASTLANE_CHUNK_BYTES],
                        sample_rate=FASTLANE_SAMPLE_RATE,
                        num_channels=1,
                    )
                )
            await self.push_frame(TTSStoppedFrame())
        except Exception as e:  # pragma: no cover - přehrání nesmí shodit most
            logger.warning("⚠️ přehrání řeči mozku selhalo: %r", e)
            return False
        finally:
            self._fastlane_playing = False

        # DŮKAZ NA SPRÁVNÉ VRSTVĚ (poučení 2026-08-24): logujeme text, který
        # SKUTEČNĚ šel do syntézy, ne text, který jsme měli v úmyslu říct.
        # Tenhle řádek je proto párový k „🧠 mozek řekl" a dá se porovnat
        # znak po znaku.
        logger.info(
            "🗣️ VYSLOVENO DOSLOVA (%d B, %.2f s od přijetí): %s",
            len(pcm), time.monotonic() - zacatek, text,
        )
        return True

    async def _verify_after_action(self, pre, plan) -> str:
        """Přečte stav PO akci a vrátí verdikt: ok / fail / unconfirmed / ha_down.

        Čte se opakovaně (HA stav se propíše se zpožděním), ale krátce —
        maximálně ~1,4 s. `unavailable`/`unknown` se nikdy nepovažuje za úspěch.
        """
        verdict = "unconfirmed"
        for attempt in range(VERIFY_TRIES):
            try:
                post = await asyncio.to_thread(fetch_states, plan.domains)
            except Exception as e:
                logger.warning("⚠️ fast-lane: HA stav nejde přečíst: %r", e)
                return "ha_down"
            verdict = fastlane_judge(pre, post, plan)
            if verdict == "ok":
                return "ok"
            if attempt < VERIFY_TRIES - 1:
                await asyncio.sleep(VERIFY_DELAY_S)
        return verdict

    def _mirror_to_zan(self, plan, function_name, args, verdict, note="") -> None:
        """Pošle událost do Žán-Code (`POST /event`) — asynchronně, hlas nečeká.

        Mozek má vědět, co se v domě dělo, i když to sám neprováděl: rychlá
        dráha jinak zůstane pro Žán-Code neviditelná.
        """
        url = getattr(self, "zan_event_url", "")
        if not url:
            return
        payload = build_event(plan, function_name, args, verdict, note)
        token = getattr(self, "zan_event_token", "")

        async def _send():
            try:
                await asyncio.to_thread(_post_event_blocking, url, token, payload)
                logger.debug("↪️ zrcadleno do Žán-Code: %s/%s", payload["action"], verdict)
            except Exception as e:
                logger.info("ℹ️ zrcadlení do Žán-Code neprošlo (hlas to neřeší): %r", e)

        try:
            asyncio.create_task(_send())
        except Exception as e:  # pragma: no cover
            logger.debug("zrcadlení se nepodařilo naplánovat: %r", e)

    async def _run_fast_lane(self, plan, function_name, handler, params):
        """Průběh HNED + akce souběžně → ověření → tón / retry / poctivé selhání."""
        lib = getattr(self, "phrase_library", None)
        args = dict(getattr(params, "arguments", None) or {})
        real_cb = params.result_callback
        captured = []

        async def capture(result, *, properties=None):
            captured.append(result)

        # Stav PŘED akcí — jen jako referenční snímek na porovnání.
        try:
            pre = await asyncio.to_thread(fetch_states, plan.domains)
        except Exception as e:
            logger.warning("⚠️ fast-lane: stav PŘED se nepodařilo přečíst: %r", e)
            pre = {}

        # SOUČASNĚ: pusť průběhovou frázi a odpal HA akci. Žádné čekání jednoho
        # na druhé — uživatel má slyšet „Rozsvěcuju." v tomtéž okamžiku, kdy
        # povel odchází do Home Assistanta.
        params.result_callback = capture
        # Zapnutí/vypnutí ohlásí ZVUK, ne věta — a je jedno, které místnosti
        # se to týká, takže se per-místnostní varianty vůbec neřeší.
        zamer = ZVUK_MISTO_RECI.get(plan.progress) or plan.progress
        started = time.time()
        speak_task = asyncio.create_task(self.play_phrase(zamer))
        action_task = asyncio.create_task(handler(params))
        spoke, action_res = await asyncio.gather(
            speak_task, action_task, return_exceptions=True
        )
        spoke = spoke is True
        if spoke:
            # Od téhle chvíle platí: mluvila rychlá dráha → model mlčí.
            # Zapíná se HNED po frázi (ne až u výsledku), protože odpověď
            # modelu umí spustit i konec uživatelova tahu, který přijde dřív,
            # než doběhne ověřování stavu v HA.
            self.fastlane_mute_model(f"{function_name}/{zamer}")
        if isinstance(action_res, Exception):
            logger.warning("⚠️ fast-lane: HA akce selhala: %r", action_res)
        logger.info(
            "⚡ fast-lane %s: fráze %s (%s), akce hotová za %.0f ms",
            function_name, zamer, "přehrána" if spoke else "chybí v knihovně",
            (time.time() - started) * 1000,
        )

        verdict = await self._verify_after_action(pre, plan)

        # NASTROJ SAM OHLASIL CHYBU (2026-08-31). MCP vraci chybu jako TEXT
        # vysledku, ne jako vyjimku -- "Tool 'HassTurnOn' completed
        # successfully" v logu znamena jen "HTTP probehlo". Zive v 17:46:05
        # skoncil HassTurnOn na "Input validation error: 'light' is not one
        # of [...]" (svetla jsou domena, ne device_class), do domu neodeslo
        # NIC -- a Zan presto prehral vysledek_ok. Potvrdil uspech neceho,
        # co se nestalo, coz je horsi nez mlceni (ustava: netvrdit nic,
        # co jsi neoveril).
        #
        # Porovnani stavu to nechyti: kdyz se v dome mezitim zmeni cokoli
        # jineho, vyjde "ok". Chybu proto bereme primo z vysledku nastroje.
        # Kontroluje se i `captured` -- handler vraci vysledek callbackem,
        # ne navratovou hodnotou, takze v `action_res` byva None.
        if verdict == "ok" and (_vysledek_je_chyba(action_res)
                                or any(_vysledek_je_chyba(c) for c in captured)):
            logger.warning(
                "🚫 fast-lane: %s vratil chybu, ale porovnani stavu rikalo ok "
                "— beru to jako NEUSPECH: %.200s",
                function_name, str(captured or action_res),
            )
            verdict = "fail"

        # Neúspěch → JEDEN pokus znovu (ústava, Princip 2 bod 4).
        if verdict == "fail":
            logger.info("🔁 fast-lane: %s neprošlo, zkouším jednou znovu", function_name)
            await self.play_phrase("vysledek_fail")
            # Vysledky DRUHEHO pokusu se musi posuzovat SAMOSTATNE. Kdyby se
            # koukalo na cely `captured`, chyba z prvniho pokusu by prebila
            # i povedeny druhy -- a ton uspechu by nezazněl ani po skutecnem
            # uspechu. Proto se bere jen to, co pribylo po retry.
            pred_retry = len(captured)
            retry_vyjimka = None
            try:
                await handler(params)
            except Exception as e:
                retry_vyjimka = e
                logger.warning("⚠️ fast-lane: druhý pokus selhal: %r", e)
            verdict = await self._verify_after_action(pre, plan)
            # TYZ FILTR I PO RETRY (2026-08-31). Rani oprava chytala jen prvni
            # pokus, takze retry vetev ji obchazela: v 18:45:51 selhaly OBA
            # pokusy na teze validacni chybe a Zan presto prehral vysledek_ok.
            # Ton uspechu smi zaznit jen po OVERENEM uspechu.
            po_retry = captured[pred_retry:]
            if verdict == "ok" and (retry_vyjimka is not None
                                    or any(_vysledek_je_chyba(c) for c in po_retry)):
                logger.warning(
                    "🚫 fast-lane: druhy pokus %s taky vratil chybu, ale porovnani "
                    "stavu rikalo ok — beru to jako NEUSPECH: %.200s",
                    function_name, str(po_retry or retry_vyjimka),
                )
                verdict = "fail"

        self._mirror_to_zan(plan, function_name, args, verdict)

        # ANOMÁLIE → ŽÁNOVI HNED (ne až do večerní revize). Úspěch se nehlásí:
        # rozbor stojí tokeny a Žán má řešit, co NEVYŠLO.
        if verdict != "ok":
            self._rozbor(
                "vysledek_%s" % verdict,
                volani="%s(%r)" % (function_name, args),
                vysledek=verdict,
                poznamka="rychlá dráha: %s" % plan.label,
            )

        # ÚSPĚCH = ZVUK A TÓN, ŽÁDNÁ SLOVA (Ondra, 31. 8.): „akce sama je
        # potvrzení". Zvuk zapnutí/vypnutí už zazněl, teď jen tón — a model
        # k tomu mlčí.
        if verdict == "ok" and spoke:
            await self.play_phrase("vysledek_ok")
            await real_cb(
                {"status": "verified_success",
                 "spoken_locally": "zvuk zapnutí/vypnutí + tón úspěchu"},
                properties=FunctionCallResultProperties(run_llm=False),
            )
            return

        # COKOLI JINÉHO NEŽ ÚSPĚCH SE MUSÍ ŘÍCT — a říká to MODEL, jedním
        # hlasem. Rychlá dráha na to nemá (a nesmí mít) přednahranou větu;
        # dřív ji měla a právě tím vznikal druhý hlas ve výměně.
        # `vysledek_fail` je bezhlasý tón, ať je hned slyšet, že něco není
        # v pořádku, ještě než model začne mluvit.
        if verdict != "ok":
            await self.play_phrase("vysledek_fail")
        self.fastlane_unmute("neúspěch nebo bez zvuku — pravdu musí říct model")
        params.result_callback = real_cb
        await real_cb(self._verdict_text(verdict, plan, captured))

    @staticmethod
    def _verdict_text(verdict: str, plan, captured) -> str:
        """Text pro model, když knihovna frází chybí — pořád jen ověřená pravda."""
        cil = plan.target or plan.area or "to"
        if verdict == "ok":
            return f"Ověřeno: {plan.label} — {cil} je v požadovaném stavu. Řekni jednu krátkou větu."
        if verdict == "unconfirmed":
            return ("Povel odešel, ale zařízení stav nepotvrdilo. Řekni přesně tohle, "
                    "netvrď úspěch.")
        if verdict == "ha_down":
            return "Home Assistant neodpovídá. Řekni to na rovinu, nic neslibuj."
        return (f"Nepovedlo se to ani napodruhé ({cil}). Řekni „Nepovedlo se mi to, "
                f"zjišťuju proč.\" a zavolej ask_zan s textem „proč nejde {cil}\".")
