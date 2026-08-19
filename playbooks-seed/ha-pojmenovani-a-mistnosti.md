# Standard: pojmenování a místnosti v Home Assistantu

> **Tenhle standard je převzatý, ne vymyšlený.** Vychází z datového modelu Home
> Assistantu a z oficiálních HA best practices (`safe-refactoring.md` — entity renames,
> device-sibling discovery). Nevymýšlej si vlastní konvenci, drž se téhle.
>
> Vzniklo 19. 8. 2026 poté, co se ukázalo, že Žán přiřazoval místnosti na úrovni entit.
> Fungovalo to v UI, ale nástroje čtoucí zařízení (signálový dashboard) Ondrovu
> konfiguraci vůbec neviděly a vyhodnotily ji jako neexistující.

## Model: zařízení vs. entita

- **Zařízení** = fyzická krabička (Zigbee zásuvka, relé, čidlo). Má výrobce, model,
  IEEE adresu. V HA `device_registry`.
- **Entita** = jedna funkce toho zařízení. Jedna zásuvka jich vyrobí i pět:
  `switch.*` (spínání), `sensor.*_vykon`, `sensor.*_napeti`, `sensor.*_lqi`,
  `sensor.*_rssi`. V HA `entity_registry`.
- **Místnost (area)** se dá nastavit na obojí. **Entita dědí místnost od svého
  zařízení**, dokud nemá vlastní. Vlastní místnost entity je *override*.

## Pravidlo 1 — místnost patří na ZAŘÍZENÍ

Používej `ha_setup_assign_device` (device → area). **Ne** `assign_area` (entity override).

Proč: entity ji zdědí, je to jedno místo pravdy, a čtou to všechny nástroje —
dashboardy, `area_id:` cíle v automatizacích, hlasové povely typu „zhasni v obýváku".

**Jediná výjimka, kdy je override správně:** jedno fyzické zařízení opravdu sahá do
dvou místností. Typicky dvoukanálové relé (TS0012, ZBMINIR2 ve dvojici), kde první
kanál spíná světlo v koupelně a druhý na chodbě. Tehdy:
- zařízení dostane místnost, kde fyzicky **visí krabička**,
- a jen ten kanál, který patří jinam, dostane override.

Když oba kanály míří do stejného pokoje, override nedělej — patří to na zařízení.

## Pravidlo 2 — jméno je lidský popis, nikdy technický identifikátor

**NIKDY** nezapisuj do pole „název" entity_id. Tohle je špatně a stalo se to:

```
switch.sonoff_acc8009232 = "light.obyvak1"      ← ŠPATNĚ, to je entity_id
light.zbminir2           = "light.obyvak 2"     ← ŠPATNĚ
```

Správně je lidský název, jak by to řekl člověk:

```
switch.sonoff_acc8009232 = "Stropní světlo"
light.zbminir2           = "Jídelní kout"
```

Když chceš změnit `entity_id`, měň `entity_id` — do jména se nepíše.

## Pravidlo 3 — název neopakuj místnost, když je v místnosti

HA skládá zobrazený název jako „Místnost + název entity". Když entitu pojmenuješ
„Obývák – hlavní světlo" a dáš ji do místnosti Obývák, uživatel uvidí
„Obývák Obývák – hlavní světlo".

- zařízení je v místnosti → entita se jmenuje **„Hlavní světlo"**, ne „Obývák – hlavní světlo"
- zařízení nikde není → pojmenuj popisně včetně místa, ale radši mu tu místnost přiřaď

## Pravidlo 4 — přejmenováváš zařízení? Přejmenuj všechny jeho entity

Z HA best practices (device-sibling discovery): zařízení nese víc entit a musí ladit
dohromady. Když z `shellyplug_s_a1b2c3` děláš „Topení v kanceláři", přejmenuj i
`sensor.*_energy` a `update.*`, ne jen spínač.

Diagnostické entity (`_lqi`, `_rssi`, `_baterie`) přejmenovávat nemusíš — dědí popis
ze zařízení a v UI se zobrazují pod ním.

## Pravidlo 5 — před změnou entity_id udělej dopadovou analýzu

Přejmenování `entity_id` **tiše rozbije** všechno, co ho používá jménem. Než ho změníš,
projdi a oprav:
- automatizace, skripty, scény (`read_package`, konfigurace přes API)
- dashboardy — nejen `entity:` v kartách, ale i `tap_action`, podmínky u conditional
  karet, Jinja v markdown kartách, **badges** (jsou vedle karet, ne uvnitř) a hlavička
  sekce (`views[n].header.card`)
- skupiny a helpery založené přes config flow (min/max, threshold, generic thermostat) —
  ty si entity_id drží ve své vlastní konfiguraci a registr je nepřepíše

Když si nejsi jistý, že jsi našel všechna místa, **entity_id neměň** — přejmenuj jen
zobrazovaný název. Ten nic nerozbije.

## Rychlá kontrola, než řekneš „hotovo"

1. Má **zařízení** místnost? (ne jen jeho entity)
2. Je jméno lidské, bez `switch.` / `light.` / `sensor.` na začátku?
3. Neopakuje název místnost, ve které zařízení je?
4. Když jsi přejmenoval zařízení, mají jeho entity odpovídající názvy?
5. Když jsi měnil `entity_id`, prošel jsi automatizace i dashboardy?
