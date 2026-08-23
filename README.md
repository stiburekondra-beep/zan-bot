# Žán Bot 🏠

AI správce domu pro Home Assistant ovládaný přes Telegram.

## Instalace jako HA Add-on

1. V Home Assistant jdi do **Settings → Add-ons → Add-on Store**
2. Klikni na 3 tečky vpravo nahoře → **Repositories**
3. Přidej: `https://github.com/stiburekondra-beep/zan-bot`
4. Najdi **Žán Bot** a klikni **Install**
5. V záložce **Configuration** vyplň tokeny
6. Klikni **Start**

## Konfigurace

| Pole | Popis |
|------|-------|
| TELEGRAM_TOKEN | Token od @BotFather |
| CHAT_ID_ONDRA | Telegram Chat ID Ondry |
| CHAT_ID_JANA | Telegram Chat ID Jany |
| ZAN_HOME_NAME | Název této instalace/domácnosti |
| CHAT_NAME_ONDRA | Jméno hlavního admina této instalace |
| CHAT_NAME_JANA | Jméno druhého člena domácnosti |
| ANTHROPIC_API_KEY | Klíč z console.anthropic.com |
| OPENAI_API_KEY | Klíč z platform.openai.com |
| PLANTID_API_KEY | Klíč z plant.id (volitelné) |
| ZAN_VOICE_TOKEN | Sdílený secret hlasového mostu — musí sedět s tokenem v HA integraci `zan_conversation` (volitelné; bez něj je hlas vypnutý) |
| ZAN_APP_TOKEN | Secret zákaznické onboarding stránky `/onboarding`; když je prázdný, použije se `ZAN_VOICE_TOKEN` (volitelné; bez tokenu je stránka vypnutá) |
| ZAN_VOICE_HTTP_HOST | Bind adresa voice kanálu (default `0.0.0.0` kvůli dosažitelnosti z HA Core; volitelné) |
| ZAN_VOICE_CHAT_ID | Telegram Chat ID, na které hlas mapuje (default = admin/Ondra; volitelné) |
| ZAN_HRA_CHAT_ID | Telegram Chat ID výchozího pomocníka ve hrách (`POST /hra`), když HA `input_text.hra_pomocnik_chat` je prázdné (default = `ZAN_VOICE_CHAT_ID` / Ondra; volitelné) |

### Hlasový kanál (voice)

Žán umí přijímat text z HA custom conversation componentu `zan_conversation`
(hlas → text → Žán → odpověď) přes lokální HTTP kanál na portu `8099`. Kanál je
**fail-closed**: dokud není vyplněný `ZAN_VOICE_TOKEN`, HTTP server se vůbec
nespustí. `ZAN_VOICE_TOKEN` je **sdílený secret** — stejnou hodnotu vyplň v
add-onu i v HA integraci `zan_conversation`. Add-on jede `host_network:true`,
takže se kanál bindne na `0.0.0.0` (aby ho HA Core dosáhl na
`172.30.32.1:8099`); ochranu drží bearer token, ne izolace sítě, proto kanál
**nikdy neprovozuj bez tokenu**.

### Zákaznická onboarding stránka

Add-on umí na stejném HTTP portu zobrazit `/onboarding?t=<token>`: dlaždice
služeb, které si zákazník připojí sám. Stránka je prototyp bez reálných OAuth
volání: nikde nemá pole na heslo, mock návrat jen uloží stav dlaždice do
`/config/zan_data/service_onboarding.json`. Slouží jako základ Žánovy zákaznické
apky v Home Assistantu, ne jako součást Baklažán cockpitu.

Pro cizí dům nepřenášej `/config/zan_data/` z jiné instalace. Prázdná
instalace si vytvoří vlastní `rodina.md` a `home_memory.json` podle hodnot
`ZAN_HOME_NAME`, `CHAT_NAME_ONDRA` a `CHAT_NAME_JANA`.

### Hry — most pro pomocníka (dětský režim)

Dětský režim Žána (HA balíček `zan_hry.yaml`, CHoS- `projects/baklazan/lab/ha/hry/`)
potřebuje **pomocníka, který nehraje** (rodič / starší brácha): potvrdí v Telegramu,
že děti úkol splnily, že je příprava hotová, nebo napíše, kam schoval předmět.
Kanál pomocníka = Telegram (rozhodnuto 23. 8. 2026). Most je v `hra-most.js`,
testy `npm run test:hra-most`.

**HA → pomocník: `POST /hra`** na stejném portu a se stejným bearer tokenem jako
`/voice` (`ZAN_VOICE_TOKEN`; bez tokenu route neexistuje). Volá ho HA
`rest_command.hra_zan_bot` (kostka `script.hra_telegram`). Tělo:

```json
{ "text": "Přepnuli obě páky?",
  "tlacitka": [{ "text": "✅ splnili", "data": "hra:ano" }, { "text": "❌ nesplnili", "data": "hra:ne" }],
  "komu": "pomocnik" }
```

Odpověď `{ "ok": true, "message_id": 123, "chat_id": … }`. Ke každé herní zprávě bot
**sám přidá tlačítko „⏹ Konec hry"** (`hra:konec`, bez duplikace, když ho HA už poslala).
Komu: `komu: "pomocnik"` (výchozí) = chat z HA `input_text.hra_pomocnik_chat`, když je
v allowlistu chatů; jinak `ZAN_HRA_CHAT_ID`, jinak admin. `komu: <chat id>` jen z allowlistu,
cizí chat → 400. Neznámé tlačítko (`data` mimo tabulku níže) → 400, nic se neposílá.

**Pomocník → HA: callback `hra:*`** (klik na tlačítko). Jediné HA volání podle allowlistu
v `hra-most.js` — nic jiného herní callback volat nesmí (entita se nikdy nebere
z `callback_data`):

| `callback_data` | HA |
|---|---|
| `hra:ano` | `input_boolean.turn_on` → `input_boolean.hra_pomocnik_ano` |
| `hra:ne` | `input_boolean.turn_on` → `input_boolean.hra_pomocnik_ne` |
| `hra:hotovo` | `input_boolean.turn_on` → `input_boolean.hra_priprava_hotovo` |
| `hra:ja` | `input_boolean.turn_on` → `input_boolean.hra_pomocnik_to_jsem_ja` |
| `hra:konec` | `script.turn_on` → `script.hra_konec` (také příkaz `/konec`) |
| `hra:pokoj:<slug>` | `input_text.set_value` → `input_text.hra_pomocnik_odpoved` = slug (`[a-z0-9_]`, P1 výběr pokoje) |
| `hra:text` | bot čeká 10 min na **další textovou zprávu** pomocníka → `input_text.hra_pomocnik_odpoved` („sklenička v koupelně") |

Po kliku se zpráva upraví (`→ ✅ splnili`), tlačítka zmizí, zůstane jen „Konec hry".
U `input_boolean` bot stav přečte zpět a potvrdí jen, když je fakt `on` (HA vrací 200
i když se nic nestalo). Volný text po `hra:text` se zapíše **jen když běží hra**
(`input_select.zan_rezim == hra`); jinak jde zpráva normální cestou k Žánovi.
Callbacky jdou mimo `pendingConfirm` (nejsou potvrzení AI akce) a jen z chatů
v allowlistu. `hra:konec` / `/konec` je brzda: funguje i při AI STOP.

## Aktualizace

Při nové verzi klikni **Update** v HA Add-on stránce.

## Příkazy

- `/start` — uvítání
- `/stav` — stav zařízení  
- `/balicky` — YAML balíčky
- `/dashboardy` — dashboardy
- `/pamet` — co Žán ví o domě
- `/zahrada` — zahradní brief
- `/navyky` — sledování návyků
- `/analyza` — ruční analýza návyků
- `/log` — log akcí (jen Ondra)
- `/konec` — konec hry (dětský režim; totéž co tlačítko „⏹ Konec hry")
- `/reset` — vymaž historii konverzace
