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
- `/reset` — vymaž historii konverzace
