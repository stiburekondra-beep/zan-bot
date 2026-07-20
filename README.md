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
