# Changelog Žán bota

Kanonický zdroj čísla verze je `config.yaml` (pole `version`) — ne
`package.json` (ten je mrtvý, drží se historicky na "1.0.0" a nikdo ho
při release nezvyšuje).

Každý záznam popisuje SKUTEČNOU změnu z release commitu. Když se
vydává nová verze (bump `config.yaml`), sem patří krátký, pravdivý
popis toho, co se reálně změnilo — ne odhad ani barva LED prstence
(ta je jen Ondrův vizuální signál, bez obsahu). Žán si tenhle soubor
čte sám (karta 2026-08-21-programator-zana-08) a jednou po startu nové
verze ho stručně shrne Ondrovi.

## 5.12.16 — 2026-08-22

- Brzdy platí i na hlas: AI STOP vypínač v HA, brzda „HA je offline"
  a rate limit teď zastaví i hlasový povel, ne jen Telegram (dřív je hlas
  obcházel). Vypravěč při aktivním STOP mlčí. Nový kontraktní test
  `scripts/check-voice-guards.js`.
- Žán zná svou verzi: čte ji z `config.yaml`, nástroj `get_version`,
  a jednou po startu nové verze řekne, co je nové (z tohoto changelogu).

## 5.12.15 — 2026-08-21

- Hlasový kanál teď posílá Realtime hlasovému mostu signál lokálního
  potvrzení akce (`local_confirmation`) — hlas ví, že příkaz proběhl,
  i bez čekání na plnou textovou odpověď modelu.

## 5.12.14 — 2026-08-21

- Hlasový fast-path: rutinní potvrzení akce hlasem už nejede přes druhé
  volání modelu — odpověď je rychlejší.
