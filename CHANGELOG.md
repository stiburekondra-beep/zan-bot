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

## 5.12.17 — 2026-08-22

Sloučená release dávka šesti desk-ověřených oprav, které přeskočil release
vlak (5.12.14 → 5.12.16 je nezahrnul). Popis každé položky je z reálného
diffu větve, ne z názvu PR.

- **LQI gate na nedostupná zařízení (PR #86):** `extractLqi` v `device-layout.js`
  teď přeskočí entitu ve stavu `unavailable`/`unknown` i v atributové cestě,
  ne jen u stavové hodnoty. Mrtvé zařízení (typicky vybitá baterie) neslo
  zastaralý LQI atribut z posledního spojení a dostávalo falešnou radu
  „kup Zigbee router". Slabý signál se teď hodnotí jen u živých zařízení.
- **Zmražený baseline při párování (PR #87):** při plánování párovacího
  follow-upu se teď zmrazí snapshot známých entit z doby naplánování
  (`known_snapshot`) a `runPairingCheck` porovnává nové zařízení proti němu,
  ne proti živému `memory.known_entities`. Živý baseline mezitím přepisovala
  periodická `pollStates` smyčka a absorbovala právě spárované zařízení →
  kontrola ho po ~75 s okně už neviděla (race sc.65). Nová funkce
  `resolvePairingBaseline` s fallbackem na živý baseline pro staré akce.
- **Rozdělení kbelíku párování a aktuace (PR #90):** action-claim-guard měl
  párování i aktuaci zařízení v jednom `deviceSatisfied` — úspěšný `permit_join`
  pak legitimizoval i fabrikované „rozsvítil jsem světlo" v témž kole. Teď má
  párování vlastní kbelík (`pairingSatisfied` + detekce `fabricatedPairing`);
  `permit_join` kryje jen párovací tvrzení, ne aktuaci.
- **Media guard-disarm (PR #88):** `play_music` u mrtvého přehrávače vracel
  `success:true` + `confirmed:false` (strukturálně ok, ale efekt se neověřil),
  takže claim „Pouštím X" prošel guardem. Nový příznak `unavailable`/`effectUnverified`
  protéká z `play-music.js` přes `bot.js` do action-claim-guardu, který teď
  media povel bez ověřeného efektu nepovažuje za splněný. Idle/latence startu
  na živém přehrávači se dál bere jako legitimní „odesláno".
- **Vypnutí dětského režimu jen pro admina (PR #89):** `set_communication_tone`
  s `dite=false` (zrušení dětské hrany) je bezpečnostní krok — smí ho teď jen
  admin. Dítě (role user) si nesmí samo zrušit dětský příznak a odemknout
  reinforcement. Zapnutí dítěte (`dite=true`) i pouhá změna tónu zůstávají pro
  celou rodinu. Nový predikát `tonRequestDisablesChildGuard`.
- **Paměť konverzací přes dny (PR #92):** nový modul `conversation-diary.js`
  vede denní deník konverzací (append per zpráva, úklid starých souborů,
  automatické shrnutí včerejška) a nový nástroj `recall_days` umí odpovědět
  na „co jsme řešili včera / minule / před týdnem" z perzistentního deníku,
  místo aby si Žán domýšlel z krátké historie v paměti.

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
