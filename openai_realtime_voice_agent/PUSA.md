# Dvě pusy Žána — přepínač `ZAN_PUSA`

Most umí mluvit dvěma modely. Přepíná se **jednou env proměnnou**, výchozí
hodnota nechává všechno přesně jak bylo.

| `ZAN_PUSA` | služba | soubor |
|---|---|---|
| `openai` (výchozí) | OpenAI Realtime (`gpt-realtime-2`) | `app/main.py` → `SafeRealtimeLLMService` |
| `gemini` | Gemini Live | `app/gemini_safety.py` → `SafeGeminiLiveLLMService` |

Cokoli jiného než tyhle dvě hodnoty se zaloguje jako varování a spadne na
`openai` (`_resolve_pusa()` v `app/main.py`).

## Jak se přepne

Do env kontejneru (docker `env_file` / `.env`), **ne** do voleb add-onu — add-on
o téhle větvi nic neví a záměrně se nemění:

```
ZAN_PUSA=gemini
GEMINI_API_KEY=…                 # povinné, když ZAN_PUSA=gemini
ZAN_GEMINI_MODEL=gemini-3.1-flash-live-preview   # volitelné (tohle je default)
ZAN_GEMINI_VOICE=Fenrir                          # volitelné (tohle je default)
```

`OPENAI_API_KEY` zůstává v gemini režimu **volitelný** — pořád ho používá
nástroj `web_search` (OpenAI Responses API). Když chybí, `web_search` se sám
vypne a napíše o tom varování; most nespadne.

Ostatní volby zůstávají společné: `INSTRUCTIONS`, `VAD_EAGERNESS`,
`MAX_OUTPUT_TOKENS`, `ZAN_BRIDGE_ENABLED`, `MCP_TOOL_ALLOWLIST`,
`FASTLANE_PHRASES`, follow-up okno…

## Jak se to vrátí zpátky (rollback)

1. **Nejrychleji:** smazat `ZAN_PUSA` z env (nebo `ZAN_PUSA=openai`) a
   restartovat kontejner. Openai větev je bit po bitu původní kód.
2. **Úplně:** větev `gemini-pusa` nenasazovat / vrátit nasazený obraz na
   `main`. Do `main` nic z tohohle nezasahuje, dokud se nesloučí.

Poznávací znamení v logu při startu:

```
👄 Pusa: gemini (ZAN_PUSA)
✅ WebSocket transport created … (pusa=gemini, vstup 16000 Hz, výstup 24000 Hz)
🎚️ Gemini VAD: eagerness=low → end_sensitivity=END_SENSITIVITY_LOW, silence=1000ms…
🌐 Gemini: languageCode se NEposílá (cs-CZ 2.5 odmítá)
🔁 ConnectionRecovery vynechána (pusa=gemini) …
✅ Pusa 'gemini' vytvořena: SafeGeminiLiveLLMService
```

## Co je společné a co se liší

**Společné (jeden kód, ne kopie):**

- rychlá dráha — `app/fastlane_mixin.py`: bezpečnostní brzda na nevratné úkony,
  průběhová fráze z knihovny, ověření stavu v HA, retry, zrcadlení do Žán-Code.
  Obě služby ji dědí jako `class Safe…(FastLaneMixin, <pipecat služba>)`,
- nástroje (ask_zan, web_search, HA MCP) — pro Gemini se převádějí
  v `app/gemini_tools.py` (`to_gemini_function_declarations`),
- prompt, session manager, fáze pro LED, nahrávání, follow-up okno.

**Liší se:**

| věc | openai | gemini |
|---|---|---|
| vstupní zvuk | 16k → 24k (`InputResampler`) | 16k rovnou (Live API to chce tak) |
| obnova spojení | `ConnectionRecovery` v pipeline | vestavěná session resumption v pipecatu |
| „stop" ze zařízení | `input_audio_buffer.clear` + `response.cancel` + kill racing response | jen srovnání pipeline (Live API protějšky nemá) |
| řeč hned po startu | předsazený prázdný `LLMContext` v `run()` | `inference_on_context_initialization=False` |
| `languageCode` | neposílá se (řeší `INSTRUCTIONS`) | vypnuto explicitně — `cs-CZ` model 2.5 odmítá |
| VAD | `semantic_vad` s eagerness | tichem řízený, eagerness → citlivost + délka ticha |

## Neověřené — čeká na LAB A/B

Všechno níž je **napsáno, ale živě neodzkoušeno** (žádný deploy):

1. fáze `listening` / `thinking` na LED prstenci — Gemini pusa nevydává
   `UserStartedSpeakingFrame`, `replying`/`idle` fungují (ty dodává výstupní
   transport, ne služba),
2. „stop" ze zařízení v gemini režimu — zařízení si přehrávání umlčí samo,
   ale generování na serveru se nepřeruší,
3. obnova kontextu po reconnectu (`_needs_turn_complete_message` se flushuje na
   `UserStoppedSpeakingFrame`, který Gemini pusa nedostává),
4. jestli Live API přijme vstup 16 kHz z reálného mikrofonu stejně dobře jako
   v sondě (ta jela ze souboru),
5. názvy konstant `EndSensitivity.END_SENSITIVITY_*` v nainstalované verzi
   `google-genai` (kód je psaný fail-soft: když je nezná, jede se bez explicitní
   citlivosti a platí jen délka ticha),
6. chování rychlé dráhy nad Gemini toolCally (formát `args` se liší od OpenAI
   `arguments` jen na úrovni pipecatu, ale ověřeno to není).

## Kde jsou důkazy k rozhodnutím

Sonda 30. 8. 2026, 14 volání Live API v kontejneru `zan-realtime`:

- function calling na `gemini-3.1-flash-live-preview` **funguje** — 11 úspěšných
  toolCallů ze 14 běhů, nejrychleji 387 ms (text) a 525 ms (audio),
- schéma OBJECT/STRING i lowercase `object`/`string` server přijme,
- `audioStreamEnd` poslaný hned po nárazovém uploadu klipu tah na 3.1 **zahodí**
  bez jediné zprávy (běh B1: 25 s ticha). Pipecat ho neposílá vůbec a nechává
  konec tahu na server VAD — což byla v měření zároveň nejrychlejší varianta.
