# Katalog automatizací — 100 věcí, co si lidé řeknou hned napoprvé

> Účel: než navrhneš YAML od nuly, mrkni sem (`read_cookbook`). Je tu 100
> nejčastějších přání roztříděných do 8 kategorií (stejných jako `packages/`).
> Ber to jako inspiraci a kostru, ne hotový zápis — entity_id jsou VŽDY
> placeholdery, nikdy je nezapisuj doslova.

## Jak s katalogem pracovat

**Placeholdery.** Každé `<domena.NÁZEV_VELKÝMI>` je zástupný symbol
(např. `<light.OBYVAK_STROP>`, `<binary_sensor.CHODBA_POHYB>`). Než recept
použiješ, zjisti přes `get_states` (s filtrem `domain`) skutečné ID v tomhle
konkrétním domě a placeholder jím nahraď. Nikdy nezapisuj `<...>` do
`write_package` — to by byla neplatná entita.

**Kam recept zapsat.** Každý recept má u sebe doporučenou kategorii
(shoduje se s `write_package` enum: `osvetleni`, `topeni`, `zasuvky`,
`zahrada`, `zabezpeceni`, `energie`, `system`, `ostatni`). Recept patří do
existujícího balíčku daného tématu, pokud existuje (`list_packages` →
`read_package`), jinak založ nový soubor `packages/<kategorie>/<tema>.yaml`
— název jen `[a-z0-9_]`, žádné pomlčky (viz pravidla v system promptu).
Víc receptů může žít v jednom souboru, pokud se týkají stejného tématu
(např. „chodba" — pohybové světlo i noční útlum ve stejném balíčku).

**Jak pojmenovávat.**
- `id:` automatizace = `<téma>_<co_dělá>` snake_case, unikátní v CELÉM configu
  (ne jen v souboru) — např. `chodba_svetlo_pohyb_noc`, ne `automation_1`.
- `alias:` česky, srozumitelně pro člověka, ne pro stroj — např.
  „Chodba: rozsvítit při pohybu v noci", ne „Chodba automation v2".
- Helpery (`input_boolean`, `input_number`…) pojmenovávej podle role, ne
  podle recepta: `rezim_dovolena`, ne `recept_15_dovolena`.

**Jak odstraňovat.** Jeden recept implementovaný jako celý balíček →
`delete_package` (po výslovném potvrzení, zálohuje se). Jeden recept jako
část většího balíčku → `read_package`, ručně vystřihni blok pod `automation:`/
`input_*:`, `write_package` se zbytkem — **vždy pošli kompletní zbylý obsah**,
ne jen diff (jinak to spadne na obsahovou pojistku, viz níž).

**Jak kopírovat/sdílet.** Hotový balíček (třeba poladěný recept) pošle
`export_package` jako soubor přímo do Telegramu — jde přeposlat na jinou
instalaci nebo jinému Žánovi. Cílová instalace ho pak jen `write_package`
uloží pod stejnou nebo jinou kategorií (entity_id uvnitř samozřejmě musí
sedět na JEJÍ dům — zkontrolovat/přepsat před zápisem).

**Bezpečnostní pojistka.** `write_package` odmítne zápis, který by oproti
starému obsahu souboru ztratil klíče nebo položky seznamu (typicky když
recept přidáváš do existujícího balíčku, ale zapomeneš poslat i to, co tam
už bylo). Řešení: vždy `read_package` → přidej recept do načteného obsahu →
teprve pak `write_package` s kompletním výsledkem.

---

## Osvětlení (osvetleni)

### 1. Rozsvítit chodbu při pohybu v noci
Kdy: schody/chodba v noci, aby nikdo netápal potmě.
```yaml
automation:
  - id: chodba_svetlo_pohyb_noc
    alias: "Chodba: rozsvítit při pohybu v noci"
    trigger:
      - platform: state
        entity_id: <binary_sensor.CHODBA_POHYB>
        to: "on"
    condition:
      - condition: sun
        after: sunset
        before: sunrise
    action:
      - service: light.turn_on
        target: { entity_id: <light.CHODBA_STROP> }
        data: { brightness_pct: 30 }
    mode: single
```

### 2. Zhasnout, když v místnosti nikdo není
Kdy: světlo zůstává svítit zbytečně po odchodu z místnosti.
```yaml
automation:
  - id: mistnost_zhasnout_bez_pohybu
    alias: "Místnost: zhasnout po X minutách bez pohybu"
    trigger:
      - platform: state
        entity_id: <binary_sensor.MISTNOST_POHYB>
        to: "off"
        for: { minutes: 15 }
    action:
      - service: light.turn_off
        target: { entity_id: <light.MISTNOST> }
    mode: single
```

### 3. Postupné rozsvícení venkovních světel při setmění
```yaml
automation:
  - id: venek_svetla_sunset
    alias: "Venkovní světla: rozsvítit při setmění"
    trigger:
      - platform: sun
        event: sunset
        offset: "-00:20:00"
    action:
      - service: light.turn_on
        target: { entity_id: <light.VENEK> }
    mode: single
```

### 4. Zhasnout venkovní světla za rozednění
```yaml
automation:
  - id: venek_svetla_sunrise_off
    alias: "Venkovní světla: zhasnout za rozbřesku"
    trigger:
      - platform: sun
        event: sunrise
    action:
      - service: light.turn_off
        target: { entity_id: <light.VENEK> }
    mode: single
```

### 5. Noční tlumené světlo v koupelně
Kdy: aby nikoho v noci neoslepilo plné světlo.
```yaml
automation:
  - id: koupelna_nocni_jas
    alias: "Koupelna: tlumené světlo v noci"
    trigger:
      - platform: state
        entity_id: <binary_sensor.KOUPELNA_POHYB>
        to: "on"
    condition:
      - condition: time
        after: "22:00:00"
        before: "06:00:00"
    action:
      - service: light.turn_on
        target: { entity_id: <light.KOUPELNA> }
        data: { brightness_pct: 10, color_name: "red" }
    mode: single
```

### 6. Vypnout všechna světla při odchodu z domu
```yaml
automation:
  - id: odchod_vsechna_svetla_off
    alias: "Odchod: zhasnout všude"
    trigger:
      - platform: state
        entity_id: <person.RODINA_VSICHNI_PRYC>
        to: "not_home"
    action:
      - service: light.turn_off
        target: { entity_id: all }
    mode: single
```

### 7. Rozsvítit při příjezdu domů po setmění
```yaml
automation:
  - id: prijezd_svetla_on
    alias: "Příjezd: rozsvítit, když je tma"
    trigger:
      - platform: state
        entity_id: <person.CLOVEK>
        to: "home"
    condition:
      - condition: sun
        after: sunset
        before: sunrise
    action:
      - service: light.turn_on
        target: { entity_id: <light.VSTUP> }
    mode: single
```

### 8. Scéna „kino" — ztlumit při zapnutí TV
```yaml
automation:
  - id: obyvak_kino_scena
    alias: "Obývák: kino scéna při zapnutí TV"
    trigger:
      - platform: state
        entity_id: <media_player.TV>
        to: "playing"
    action:
      - service: light.turn_on
        target: { entity_id: <light.OBYVAK> }
        data: { brightness_pct: 15 }
    mode: single
```

### 9. Blikání světla při zazvonění (oznámení)
```yaml
automation:
  - id: zvonek_blik_svetlo
    alias: "Zvonek: bliknout světlem v kuchyni"
    trigger:
      - platform: state
        entity_id: <binary_sensor.ZVONEK>
        to: "on"
    action:
      - service: light.turn_on
        target: { entity_id: <light.KUCHYN> }
        data: { flash: short }
    mode: single
```

### 10. Noční orientační světlo v dětském pokoji
```yaml
automation:
  - id: detsky_pokoj_orientacni_svetlo
    alias: "Dětský pokoj: slabé noční světlo"
    trigger:
      - platform: time
        at: "20:30:00"
    action:
      - service: light.turn_on
        target: { entity_id: <light.DETSKY_POKOJ_NOCNI> }
        data: { brightness_pct: 5 }
    mode: single
```

### 11. Rozsvítit chodbu, když dítě v noci vstane
Kdy: senzor postele/pohybu v dětském pokoji spustí slabé osvětlení cesty na WC.
```yaml
automation:
  - id: dite_v_noci_chodba_svetlo
    alias: "Dítě vstalo v noci: rozsvítit cestu na chodbu"
    trigger:
      - platform: state
        entity_id: <binary_sensor.DETSKY_POKOJ_POSTEL>
        to: "off"  # senzor přestal detekovat dítě v posteli
    condition:
      - condition: time
        after: "21:00:00"
        before: "06:30:00"
    action:
      - service: light.turn_on
        target: { entity_id: <light.CHODBA> }
        data: { brightness_pct: 15 }
    mode: single
```

### 12. Světlo ve spíži/skříni při otevření dveří
```yaml
automation:
  - id: spiz_svetlo_dvere
    alias: "Spíž: světlo při otevření dveří"
    trigger:
      - platform: state
        entity_id: <binary_sensor.SPIZ_DVERE>
        to: "on"
    action:
      - service: light.turn_on
        target: { entity_id: <light.SPIZ> }
    mode: single
```

### 13. Připomenutí „zhasni", když svítí a nikdo doma
```yaml
automation:
  - id: svetlo_bez_lidi_pripomenutí
    alias: "Upozornění: svítí a nikdo není doma"
    trigger:
      - platform: state
        entity_id: <person.RODINA_VSICHNI_PRYC>
        to: "not_home"
        for: { minutes: 20 }
    condition:
      - condition: state
        entity_id: <light.NAHODNA_KONTROLA>
        state: "on"
    action:
      - service: notify.telegram
        data: { message: "Svítí {{ '<light.NAHODNA_KONTROLA>' }} a nikdo není doma." }
    mode: single
```

### 14. Barevná scéna k narozeninám/svátku
Kdy: jednorázová/roční slavnostní scéna, spouští se ručně nebo na konkrétní datum.
```yaml
automation:
  - id: oslava_barevna_scena
    alias: "Oslava: barevná scéna"
    trigger:
      - platform: time
        at: "18:00:00"
    condition:
      - condition: template
        value_template: "{{ now().strftime('%m-%d') == '01-01' }}"  # nastav konkrétní datum
    action:
      - service: light.turn_on
        target: { entity_id: <light.OBYVAK> }
        data: { color_name: "purple", brightness_pct: 80 }
    mode: single
```

---

## Topení a klimatizace (topeni)

### 15. Noční útlum topení
```yaml
automation:
  - id: topeni_nocni_utlum
    alias: "Topení: noční útlum"
    trigger:
      - platform: time
        at: "22:00:00"
    action:
      - service: climate.set_temperature
        target: { entity_id: <climate.TOPENI> }
        data: { temperature: 18 }
    mode: single
```

### 16. Ranní nahřátí před probuzením
```yaml
automation:
  - id: topeni_ranni_nahřátí
    alias: "Topení: nahřát před budíkem"
    trigger:
      - platform: time
        at: "06:00:00"
    action:
      - service: climate.set_temperature
        target: { entity_id: <climate.TOPENI> }
        data: { temperature: 21 }
    mode: single
```

### 17. Vypnutí topení při otevřeném okně
```yaml
automation:
  - id: topeni_off_okno_otevrene
    alias: "Topení: vypnout, když je okno otevřené"
    trigger:
      - platform: state
        entity_id: <binary_sensor.OKNO_LOZNICE>
        to: "on"
        for: { minutes: 3 }
    action:
      - service: climate.set_hvac_mode
        target: { entity_id: <climate.TOPENI_LOZNICE> }
        data: { hvac_mode: "off" }
    mode: single
```

### 18. Znovu zapnout topení po zavření okna
```yaml
automation:
  - id: topeni_on_okno_zavrene
    alias: "Topení: zapnout po zavření okna"
    trigger:
      - platform: state
        entity_id: <binary_sensor.OKNO_LOZNICE>
        to: "off"
    action:
      - service: climate.set_hvac_mode
        target: { entity_id: <climate.TOPENI_LOZNICE> }
        data: { hvac_mode: "heat" }
    mode: single
```

### 19. Snížit teplotu, když nikdo není doma
```yaml
automation:
  - id: topeni_setback_prazdny_dum
    alias: "Topení: útlum, když je dům prázdný"
    trigger:
      - platform: state
        entity_id: <person.RODINA_VSICHNI_PRYC>
        to: "not_home"
        for: { minutes: 30 }
    action:
      - service: climate.set_temperature
        target: { entity_id: <climate.TOPENI> }
        data: { temperature: 17 }
    mode: single
```

### 20. Nahřát před příchodem domů
```yaml
automation:
  - id: topeni_pred_prijezdem
    alias: "Topení: nahřát před příjezdem domů"
    trigger:
      - platform: zone
        entity_id: <person.CLOVEK>
        zone: <zone.DOMOV_BLIZKO>
        event: enter
    action:
      - service: climate.set_temperature
        target: { entity_id: <climate.TOPENI> }
        data: { temperature: 21 }
    mode: single
```

### 21. Klimatizace jen když je venku výrazně tepleji
```yaml
automation:
  - id: klimatizace_jen_pri_horku
    alias: "Klimatizace: povolit jen při vyšší venkovní teplotě"
    trigger:
      - platform: numeric_state
        entity_id: <sensor.TEPLOTA_VENKU>
        above: 28
    condition:
      - condition: numeric_state
        entity_id: <sensor.TEPLOTA_OBYVAK>
        above: 25
    action:
      - service: climate.set_hvac_mode
        target: { entity_id: <climate.KLIMATIZACE_OBYVAK> }
        data: { hvac_mode: "cool" }
    mode: single
```

### 22. Upozornění na příliš nízkou/vysokou vlhkost
```yaml
automation:
  - id: vlhkost_mimo_rozsah
    alias: "Upozornění: vlhkost mimo doporučený rozsah"
    trigger:
      - platform: numeric_state
        entity_id: <sensor.VLHKOST_OBYVAK>
        below: 30
      - platform: numeric_state
        entity_id: <sensor.VLHKOST_OBYVAK>
        above: 65
    action:
      - service: notify.telegram
        data: { message: "Vlhkost v obýváku je {{ states('<sensor.VLHKOST_OBYVAK>') }} % — mimo doporučené 30–65 %." }
    mode: single
```

### 23. Ochrana proti zamrznutí
```yaml
automation:
  - id: topeni_ochrana_mraz
    alias: "Topení: ochrana proti zamrznutí"
    trigger:
      - platform: numeric_state
        entity_id: <sensor.TEPLOTA_DUM>
        below: 7
    action:
      - service: climate.set_hvac_mode
        target: { entity_id: <climate.TOPENI> }
        data: { hvac_mode: "heat" }
      - service: climate.set_temperature
        target: { entity_id: <climate.TOPENI> }
        data: { temperature: 10 }
    mode: single
```

### 24. Rozdílné teploty den/noc/víkend
```yaml
automation:
  - id: topeni_rozvrh_vikend
    alias: "Topení: víkendový rozvrh (jiná teplota než v týdnu)"
    trigger:
      - platform: time
        at: "08:00:00"
    condition:
      - condition: time
        weekday: [sat, sun]
    action:
      - service: climate.set_temperature
        target: { entity_id: <climate.TOPENI> }
        data: { temperature: 22 }
    mode: single
```

### 25. Upozornění, když topení běží neobvykle dlouho
```yaml
automation:
  - id: topeni_bezi_dlouho_upozorneni
    alias: "Upozornění: topení běží déle než obvykle"
    trigger:
      - platform: state
        entity_id: <climate.TOPENI>
        attribute: hvac_action
        to: "heating"
        for: { hours: 4 }
    action:
      - service: notify.telegram
        data: { message: "Topení běží nepřetržitě přes 4 hodiny — zkontroluj, jestli je vše v pořádku." }
    mode: single
```

### 26. Minimální teplota v dětském pokoji (bezpečnost)
```yaml
automation:
  - id: detsky_pokoj_min_teplota
    alias: "Dětský pokoj: hlídat minimální teplotu"
    trigger:
      - platform: numeric_state
        entity_id: <sensor.TEPLOTA_DETSKY_POKOJ>
        below: 18
    action:
      - service: climate.set_temperature
        target: { entity_id: <climate.TOPENI_DETSKY_POKOJ> }
        data: { temperature: 20 }
      - service: notify.telegram
        data: { message: "V dětském pokoji kleslo pod 18°C, přitápím." }
    mode: single
```

### 27. Notifikace při extrémní venkovní teplotě
```yaml
automation:
  - id: extremni_teplota_upozorneni
    alias: "Upozornění: extrémní venkovní teplota"
    trigger:
      - platform: numeric_state
        entity_id: <sensor.TEPLOTA_VENKU>
        below: -10
      - platform: numeric_state
        entity_id: <sensor.TEPLOTA_VENKU>
        above: 35
    action:
      - service: notify.telegram
        data: { message: "Venku je {{ states('<sensor.TEPLOTA_VENKU>') }}°C — zkontroluj děti/zahradu/zvířata." }
    mode: single
```

---

## Zásuvky a spotřebiče (zasuvky)

### 28. Vypnutí stand-by spotřebičů v noci
```yaml
automation:
  - id: standby_off_noc
    alias: "Zásuvky: vypnout stand-by v noci"
    trigger:
      - platform: time
        at: "23:30:00"
    action:
      - service: switch.turn_off
        target: { entity_id: [<switch.TV_ZASUVKA>, <switch.KONZOLE_ZASUVKA>] }
    mode: single
```

### 29. Vypnutí žehličky po nečinnosti
```yaml
automation:
  - id: zehlicka_off_necinnost
    alias: "Žehlička: vypnout po 15 minutách bez použití"
    trigger:
      - platform: numeric_state
        entity_id: <sensor.ZEHLICKA_VYKON>
        below: 5
        for: { minutes: 15 }
    condition:
      - condition: state
        entity_id: <switch.ZEHLICKA>
        state: "on"
    action:
      - service: switch.turn_off
        target: { entity_id: <switch.ZEHLICKA> }
    mode: single
```

### 30. Nabíječka telefonu se vypne při 100 %
```yaml
automation:
  - id: nabijecka_off_pri_100
    alias: "Nabíječka: vypnout při plné baterii"
    trigger:
      - platform: numeric_state
        entity_id: <sensor.TELEFON_BATERIE>
        above: 99
    action:
      - service: switch.turn_off
        target: { entity_id: <switch.NABIJECKA_ZASUVKA> }
    mode: single
```

### 31. Připomenutí vypnout pračku po dokončení
```yaml
automation:
  - id: pracka_dokoncena_pripomenutí
    alias: "Pračka: upozornit na dokončení cyklu"
    trigger:
      - platform: numeric_state
        entity_id: <sensor.PRACKA_VYKON>
        below: 3
        for: { minutes: 5 }
    condition:
      - condition: state
        entity_id: <switch.PRACKA_ZASUVKA>
        state: "on"
    action:
      - service: notify.telegram
        data: { message: "Pračka dokončila cyklus." }
    mode: single
```

### 32. Vánoční osvětlení — časovač
```yaml
automation:
  - id: vanocni_svetla_casovac
    alias: "Vánoční osvětlení: zapnout/vypnout podle času"
    trigger:
      - platform: time
        at: "16:00:00"
      - platform: time
        at: "22:00:00"
    action:
      - choose:
          - conditions: "{{ now().hour == 16 }}"
            sequence:
              - service: switch.turn_on
                target: { entity_id: <switch.VANOCNI_SVETLA> }
          - conditions: "{{ now().hour == 22 }}"
            sequence:
              - service: switch.turn_off
                target: { entity_id: <switch.VANOCNI_SVETLA> }
    mode: single
```

### 33. Vypnutí všech chytrých zásuvek při odchodu
```yaml
automation:
  - id: odchod_zasuvky_off
    alias: "Odchod: vypnout chytré zásuvky"
    trigger:
      - platform: state
        entity_id: <person.RODINA_VSICHNI_PRYC>
        to: "not_home"
    action:
      - service: switch.turn_off
        target: { entity_id: all }
    mode: single
```

### 34. Upozornění na vysoký odběr jedné zásuvky
```yaml
automation:
  - id: zasuvka_vysoky_odber
    alias: "Upozornění: vysoký odběr na zásuvce"
    trigger:
      - platform: numeric_state
        entity_id: <sensor.ZASUVKA_VYKON>
        above: 3000
    action:
      - service: notify.telegram
        data: { message: "Zásuvka {{ '<sensor.ZASUVKA_VYKON>' }} odebírá přes 3 kW — zkontroluj spotřebič." }
    mode: single
```

### 35. Automatické zapnutí zvlhčovače
```yaml
automation:
  - id: zvlhcovac_auto_on
    alias: "Zvlhčovač: zapnout při nízké vlhkosti"
    trigger:
      - platform: numeric_state
        entity_id: <sensor.VLHKOST_LOZNICE>
        below: 35
    action:
      - service: switch.turn_on
        target: { entity_id: <switch.ZVLHCOVAC> }
    mode: single
```

### 36. Akvárium/terárium — světlo podle harmonogramu
```yaml
automation:
  - id: akvarium_svetlo_rozvrh
    alias: "Akvárium: světlo podle rozvrhu"
    trigger:
      - platform: time
        at: "08:00:00"
      - platform: time
        at: "20:00:00"
    action:
      - service: switch.toggle
        target: { entity_id: <switch.AKVARIUM_SVETLO> }
    mode: single
```

### 37. Notifikace při abnormálně dlouhém běhu spotřebiče
```yaml
automation:
  - id: susicka_bezi_dlouho
    alias: "Sušička: upozornit, pokud běží déle než 3 hodiny"
    trigger:
      - platform: state
        entity_id: <switch.SUSICKA_ZASUVKA>
        to: "on"
        for: { hours: 3 }
    action:
      - service: notify.telegram
        data: { message: "Sušička běží už přes 3 hodiny — zkontroluj ji." }
    mode: single
```

### 38. Ranní káva podle budíku
```yaml
automation:
  - id: kavovar_ranni_start
    alias: "Kávovar: zapnout ráno"
    trigger:
      - platform: time
        at: "06:30:00"
    condition:
      - condition: time
        weekday: [mon, tue, wed, thu, fri]
    action:
      - service: switch.turn_on
        target: { entity_id: <switch.KAVOVAR_ZASUVKA> }
    mode: single
```

### 39. Vypnutí nabíječky elektrokola v noci
Kdy: bezpečnostní opatření proti riziku požáru přes noc bez dozoru.
```yaml
automation:
  - id: nabijecka_elektrokolo_off_noc
    alias: "Elektrokolo: vypnout nabíječku přes noc"
    trigger:
      - platform: time
        at: "23:00:00"
    action:
      - service: switch.turn_off
        target: { entity_id: <switch.NABIJECKA_ELEKTROKOLO> }
    mode: single
```

---

## Zahrada (zahrada)

### 40. Automatická zálivka podle vlhkosti půdy
```yaml
automation:
  - id: zahrada_zalivka_vlhkost
    alias: "Zahrada: zálivka podle vlhkosti půdy"
    trigger:
      - platform: numeric_state
        entity_id: <sensor.ZAHRADA_VLHKOST_PUDY>
        below: 30
    condition:
      - condition: time
        after: "06:00:00"
        before: "10:00:00"
    action:
      - service: switch.turn_on
        target: { entity_id: <switch.ZAHRADA_VENTIL> }
      - delay: { minutes: 15 }
      - service: switch.turn_off
        target: { entity_id: <switch.ZAHRADA_VENTIL> }
    mode: single
```

### 41. Zálivka se přeskočí, když má pršet
```yaml
automation:
  - id: zahrada_zalivka_skip_dest
    alias: "Zahrada: zálivku vynechat, pokud prší/bude pršet"
    trigger:
      - platform: time
        at: "06:00:00"
    condition:
      - condition: state
        entity_id: <weather.DOMOV>
        state: "rainy"
    action:
      - service: notify.telegram
        data: { message: "Zálivka dnes vynechána — čeká se déšť." }
    mode: single
```

### 42. Časovaná zálivka ráno/večer
```yaml
automation:
  - id: zahrada_zalivka_rozvrh
    alias: "Zahrada: zálivka ráno a večer"
    trigger:
      - platform: time
        at: "06:00:00"
      - platform: time
        at: "19:00:00"
    action:
      - service: switch.turn_on
        target: { entity_id: <switch.ZAHRADA_VENTIL> }
      - delay: { minutes: 10 }
      - service: switch.turn_off
        target: { entity_id: <switch.ZAHRADA_VENTIL> }
    mode: single
```

### 43. Osvětlení zahrady při setmění
```yaml
automation:
  - id: zahrada_svetlo_setmeni
    alias: "Zahrada: rozsvítit při setmění"
    trigger:
      - platform: sun
        event: sunset
    action:
      - service: light.turn_on
        target: { entity_id: <light.ZAHRADA> }
    mode: single
```

### 44. Detekce pohybu na zahradě v noci
```yaml
automation:
  - id: zahrada_pohyb_noc_upozorneni
    alias: "Zahrada: upozornit na pohyb v noci"
    trigger:
      - platform: state
        entity_id: <binary_sensor.ZAHRADA_POHYB>
        to: "on"
    condition:
      - condition: time
        after: "22:00:00"
        before: "06:00:00"
    action:
      - service: notify.telegram
        data: { message: "Pohyb na zahradě v {{ now().strftime('%H:%M') }}." }
    mode: single
```

### 45. Vypnutí zálivky při mrazu
```yaml
automation:
  - id: zahrada_zalivka_off_mraz
    alias: "Zahrada: vypnout zálivku při mrazu"
    trigger:
      - platform: numeric_state
        entity_id: <sensor.TEPLOTA_VENKU>
        below: 2
    action:
      - service: switch.turn_off
        target: { entity_id: <switch.ZAHRADA_VENTIL> }
    mode: single
```

### 46. Skleník — automatické větrání při horku
```yaml
automation:
  - id: sklenik_vetrani_horko
    alias: "Skleník: otevřít větrání při vysoké teplotě"
    trigger:
      - platform: numeric_state
        entity_id: <sensor.SKLENIK_TEPLOTA>
        above: 30
    action:
      - service: cover.open_cover
        target: { entity_id: <cover.SKLENIK_VETRANI> }
    mode: single
```

### 47. Připomenutí přihnojit/zkontrolovat rostliny
```yaml
automation:
  - id: rostliny_pripomenutí_hnojeni
    alias: "Rostliny: připomenout hnojení"
    trigger:
      - platform: time
        at: "10:00:00"
    condition:
      - condition: time
        weekday: [sun]
    action:
      - service: notify.telegram
        data: { message: "Neděle — čas zkontrolovat a případně přihnojit rostliny." }
    mode: single
```

### 48. Bazén/jezírko — hlídání teploty vody
```yaml
automation:
  - id: bazen_teplota_upozorneni
    alias: "Bazén: upozornit na teplotu vody"
    trigger:
      - platform: numeric_state
        entity_id: <sensor.BAZEN_TEPLOTA_VODY>
        above: 28
    action:
      - service: notify.telegram
        data: { message: "Voda v bazénu má {{ states('<sensor.BAZEN_TEPLOTA_VODY>') }}°C — ideální na koupání." }
    mode: single
```

### 49. Robotická sekačka jen za sucha a bez lidí
```yaml
automation:
  - id: sekacka_podminky_start
    alias: "Sekačka: spustit jen za sucha a bez lidí na zahradě"
    trigger:
      - platform: time
        at: "10:00:00"
    condition:
      - condition: state
        entity_id: <weather.DOMOV>
        state: "sunny"
      - condition: state
        entity_id: <binary_sensor.ZAHRADA_POHYB>
        state: "off"
    action:
      - service: vacuum.start
        target: { entity_id: <vacuum.SEKACKA> }
    mode: single
```

### 50. Detekce otevřeného venkovního kohoutku
```yaml
automation:
  - id: kohoutek_otevreny_dlouho
    alias: "Zahrada: upozornit na dlouho otevřený kohoutek"
    trigger:
      - platform: state
        entity_id: <binary_sensor.VENKOVNI_KOHOUTEK_PRUTOK>
        to: "on"
        for: { hours: 1 }
    action:
      - service: notify.telegram
        data: { message: "Venkovní kohoutek teče už přes hodinu — zkontroluj, jestli neteče zbytečně." }
    mode: single
```

### 51. Blokace zálivky při detekci pohybu v zóně
```yaml
automation:
  - id: zalivka_blok_pri_pohybu
    alias: "Zahrada: nespouštět zálivku, když je někdo v zóně"
    trigger:
      - platform: time
        at: "06:00:00"
    condition:
      - condition: state
        entity_id: <binary_sensor.ZAHRADA_POHYB>
        state: "off"
    action:
      - service: switch.turn_on
        target: { entity_id: <switch.ZAHRADA_VENTIL> }
    mode: single
```

---

## Zabezpečení (zabezpeceni)

### 52. Notifikace při otevření vstupních dveří mimo obvyklou dobu
```yaml
automation:
  - id: vstupni_dvere_neobvykla_doba
    alias: "Bezpečnost: dveře otevřeny mimo obvyklou dobu"
    trigger:
      - platform: state
        entity_id: <binary_sensor.VSTUPNI_DVERE>
        to: "on"
    condition:
      - condition: time
        after: "23:00:00"
        before: "05:00:00"
    action:
      - service: notify.telegram
        data: { message: "Vstupní dveře otevřeny ve {{ now().strftime('%H:%M') }}." }
    mode: single
```

### 53. Upozornění, že okno zůstalo otevřené a venku prší
```yaml
automation:
  - id: okno_otevrene_a_prsi
    alias: "Bezpečnost: okno otevřené a prší"
    trigger:
      - platform: state
        entity_id: <weather.DOMOV>
        to: "rainy"
    condition:
      - condition: state
        entity_id: <binary_sensor.OKNO_LOZNICE>
        state: "on"
    action:
      - service: notify.telegram
        data: { message: "Prší a okno v ložnici je otevřené!" }
    mode: single
```

### 54. Simulace přítomnosti při dovolené
```yaml
automation:
  - id: dovolena_simulace_pritomnosti
    alias: "Dovolená: nahodilé rozsvěcování"
    trigger:
      - platform: time_pattern
        minutes: "/30"
    condition:
      - condition: state
        entity_id: <input_boolean.REZIM_DOVOLENA>
        state: "on"
      - condition: sun
        after: sunset
        before: sunrise
    action:
      - service: light.toggle
        target: { entity_id: <light.OBYVAK> }
    mode: single
```

### 55. Detekce pohybu u vjezdu v režimu dovolená
```yaml
automation:
  - id: dovolena_pohyb_vjezd
    alias: "Dovolená: upozornit na pohyb u vjezdu"
    trigger:
      - platform: state
        entity_id: <binary_sensor.VJEZD_POHYB>
        to: "on"
    condition:
      - condition: state
        entity_id: <input_boolean.REZIM_DOVOLENA>
        state: "on"
    action:
      - service: notify.telegram
        data: { message: "Pohyb u vjezdu během dovolené — zkontroluj kameru." }
    mode: single
```

### 56. Dítě otevřelo dveře na zahradu bez dozoru
Kdy: bezpečnostní hook — dítě samo venku bez dospělého v blízkosti.
```yaml
automation:
  - id: dite_dvere_zahrada_bez_dozoru
    alias: "Bezpečnost: dítě otevřelo dveře na zahradu"
    trigger:
      - platform: state
        entity_id: <binary_sensor.ZAHRADNI_DVERE>
        to: "on"
    condition:
      - condition: state
        entity_id: <binary_sensor.DOSPELY_V_KUCHYNI_NEBO_ZAHRADE>
        state: "off"
    action:
      - service: notify.telegram
        data: { message: "Zahradní dveře se otevřely a nezdá se, že je poblíž dospělý." }
    mode: single
```

### 57. Připomenutí, že alarm vypnutý, ale dveře otevřené
```yaml
automation:
  - id: alarm_off_dvere_otevrene
    alias: "Bezpečnost: alarm vypnutý a dveře otevřené"
    trigger:
      - platform: state
        entity_id: <alarm_control_panel.DUM>
        to: "disarmed"
    condition:
      - condition: state
        entity_id: <binary_sensor.VSTUPNI_DVERE>
        state: "on"
    action:
      - service: notify.telegram
        data: { message: "Alarm je vypnutý a dveře jsou otevřené — jen pro info." }
    mode: single
```

### 58. Upozornění na výpadek kamery/senzoru
```yaml
automation:
  - id: kamera_offline_upozorneni
    alias: "Bezpečnost: kamera je offline"
    trigger:
      - platform: state
        entity_id: <camera.HLAVNI>
        to: "unavailable"
        for: { minutes: 5 }
    action:
      - service: notify.telegram
        data: { message: "Kamera je offline přes 5 minut." }
    mode: single
```

### 59. Noční kontrola zamčených dveří a oken
```yaml
automation:
  - id: nocni_kontrola_zamceno
    alias: "Bezpečnost: souhrn před spaním"
    trigger:
      - platform: time
        at: "22:30:00"
    action:
      - service: notify.telegram
        data:
          message: >
            Dveře: {{ states('<binary_sensor.VSTUPNI_DVERE>') }},
            Okno ložnice: {{ states('<binary_sensor.OKNO_LOZNICE>') }}
    mode: single
```

### 60. Neobvyklý pohyb, když má být dům prázdný
```yaml
automation:
  - id: pohyb_prazdny_dum
    alias: "Bezpečnost: pohyb, ačkoli má být dům prázdný"
    trigger:
      - platform: state
        entity_id: <binary_sensor.OBYVAK_POHYB>
        to: "on"
    condition:
      - condition: state
        entity_id: <person.RODINA_VSICHNI_PRYC>
        state: "not_home"
    action:
      - service: notify.telegram
        data: { message: "Pohyb v obýváku, i když má být dům prázdný!" }
    mode: single
```

### 61. Dítě u bazénu bez dozoru dospělého
```yaml
automation:
  - id: dite_bazen_bez_dozoru
    alias: "Bezpečnost: dítě u bazénu bez dozoru"
    trigger:
      - platform: state
        entity_id: <binary_sensor.BAZEN_ZONA_POHYB>
        to: "on"
    condition:
      - condition: state
        entity_id: <binary_sensor.DOSPELY_U_BAZENU>
        state: "off"
    action:
      - service: notify.telegram
        data: { message: "Pohyb u bazénu bez zjevného dozoru dospělého — zkontroluj hned." }
    mode: single
```

### 62. Kouřový/CO senzor — okamžitá reakce
```yaml
automation:
  - id: koureny_senzor_alarm
    alias: "Bezpečnost: kouř/CO detekován"
    trigger:
      - platform: state
        entity_id: <binary_sensor.KOUROVY_SENZOR>
        to: "on"
    action:
      - service: notify.telegram
        data: { message: "🚨 KOUŘ/CO DETEKOVÁN — zkontroluj dům okamžitě!" }
      - service: light.turn_on
        target: { entity_id: <light.CHODBA> }
        data: { brightness_pct: 100 }
    mode: single
```

### 63. Garážová vrata zůstala otevřená
```yaml
automation:
  - id: garaz_otevrena_dlouho
    alias: "Bezpečnost: garáž otevřená déle než 20 minut"
    trigger:
      - platform: state
        entity_id: <cover.GARAZ>
        to: "open"
        for: { minutes: 20 }
    action:
      - service: notify.telegram
        data: { message: "Garážová vrata jsou otevřená už přes 20 minut." }
    mode: single
```

### 64. Upozornění na opakované neúspěšné odemčení
```yaml
automation:
  - id: zamek_opakovane_selhani
    alias: "Bezpečnost: opakovaný neúspěšný pokus o odemčení"
    trigger:
      - platform: event
        event_type: lock_failed  # dle konkrétní integrace zámku
    action:
      - service: notify.telegram
        data: { message: "Opakovaný neúspěšný pokus o odemčení vstupních dveří." }
    mode: single
```

### 65. Noční hlídání dětského pokoje (citlivé, volitelné)
Kdy: jen na výslovné přání rodiny — pohyb mimo postel po uspání.
```yaml
automation:
  - id: dite_mimo_postel_v_noci
    alias: "Dětský pokoj: dítě opustilo postel v noci (volitelné)"
    trigger:
      - platform: state
        entity_id: <binary_sensor.DETSKY_POKOJ_POSTEL>
        to: "off"
    condition:
      - condition: time
        after: "21:30:00"
        before: "06:00:00"
    action:
      - service: notify.telegram
        data: { message: "Dítě opustilo postel v {{ now().strftime('%H:%M') }}." }
    mode: single
```

### 66. Návštěva u dveří, i když nikdo není doma
```yaml
automation:
  - id: zvonek_kdyz_nikdo_doma
    alias: "Bezpečnost: zvonek, i když nikdo není doma"
    trigger:
      - platform: state
        entity_id: <binary_sensor.ZVONEK>
        to: "on"
    condition:
      - condition: state
        entity_id: <person.RODINA_VSICHNI_PRYC>
        state: "not_home"
    action:
      - service: notify.telegram
        data:
          message: "Někdo zazvonil, nikdo není doma."
          data: { image: "{{ state_attr('<camera.VSTUP>', 'entity_picture') }}" }
    mode: single
```

---

## Energie (energie)

### 67. Denní souhrn spotřeby
```yaml
automation:
  - id: energie_denni_souhrn
    alias: "Energie: denní souhrn spotřeby"
    trigger:
      - platform: time
        at: "21:00:00"
    action:
      - service: notify.telegram
        data: { message: "Dnešní spotřeba: {{ states('<sensor.SPOTREBA_DEN>') }} kWh." }
    mode: single
```

### 68. Upozornění při překročení denního limitu
```yaml
automation:
  - id: energie_limit_prekrocen
    alias: "Energie: upozornit na překročení denního limitu"
    trigger:
      - platform: numeric_state
        entity_id: <sensor.SPOTREBA_DEN>
        above: 30
    action:
      - service: notify.telegram
        data: { message: "Dnešní spotřeba překročila 30 kWh." }
    mode: single
```

### 69. Přesun spotřeby do levné noční sazby
```yaml
automation:
  - id: pracka_start_levna_sazba
    alias: "Pračka: spustit v levné sazbě"
    trigger:
      - platform: state
        entity_id: <binary_sensor.LEVNA_SAZBA>
        to: "on"
    condition:
      - condition: state
        entity_id: <input_boolean.PRACKA_NACHYSTANA>
        state: "on"
    action:
      - service: switch.turn_on
        target: { entity_id: <switch.PRACKA_ZASUVKA> }
    mode: single
```

### 70. Spustit spotřebiče při přebytku z FVE
```yaml
automation:
  - id: fve_prebytek_spustit_ohrev
    alias: "FVE: spustit ohřev vody při přebytku výroby"
    trigger:
      - platform: numeric_state
        entity_id: <sensor.FVE_PREBYTEK>
        above: 1500
    action:
      - service: switch.turn_on
        target: { entity_id: <switch.OHREV_VODY> }
    mode: single
```

### 71. Upozornění na neobvykle vysokou spotřebu
```yaml
automation:
  - id: energie_neobvykla_spotreba
    alias: "Energie: neobvykle vysoká spotřeba"
    trigger:
      - platform: numeric_state
        entity_id: <sensor.CELKOVY_VYKON>
        above: 8000
        for: { minutes: 10 }
    action:
      - service: notify.telegram
        data: { message: "Celkový odběr domu je přes 8 kW už 10 minut — zkontroluj spotřebiče." }
    mode: single
```

### 72. Sledování stavu baterie FVE
```yaml
automation:
  - id: fve_baterie_nizky_stav
    alias: "FVE: upozornit na nízký stav baterie"
    trigger:
      - platform: numeric_state
        entity_id: <sensor.FVE_BATERIE_STAV>
        below: 20
    action:
      - service: notify.telegram
        data: { message: "Baterie FVE je na {{ states('<sensor.FVE_BATERIE_STAV>') }} %." }
    mode: single
```

### 73. Omezení topení při vysoké ceně elektřiny
```yaml
automation:
  - id: topeni_omezit_draha_elektrina
    alias: "Topení: omezit při vysoké ceně elektřiny"
    trigger:
      - platform: numeric_state
        entity_id: <sensor.CENA_ELEKTRINY>
        above: 6
    action:
      - service: climate.set_temperature
        target: { entity_id: <climate.TOPENI> }
        data: { temperature: 19 }
    mode: single
```

### 74. Upozornění na zbytečnou spotřebu (světlo + nikdo doma)
```yaml
automation:
  - id: energie_zbytecna_spotreba
    alias: "Energie: zbytečná spotřeba (svítí, nikdo doma)"
    trigger:
      - platform: state
        entity_id: <person.RODINA_VSICHNI_PRYC>
        to: "not_home"
        for: { minutes: 30 }
    condition:
      - condition: state
        entity_id: <light.NAHODNA_KONTROLA>
        state: "on"
    action:
      - service: notify.telegram
        data: { message: "Nikdo není doma přes 30 minut a pořád svítí." }
    mode: single
```

### 75. Měsíční report nákladů na energie
```yaml
automation:
  - id: energie_mesicni_report
    alias: "Energie: měsíční report nákladů"
    trigger:
      - platform: time
        at: "09:00:00"
    condition:
      - condition: template
        value_template: "{{ now().day == 1 }}"
    action:
      - service: notify.telegram
        data: { message: "Minulý měsíc spotřeba: {{ states('<sensor.SPOTREBA_MESIC>') }} kWh." }
    mode: single
```

### 76. Prioritizace spotřebičů při omezeném výkonu
```yaml
automation:
  - id: fve_ostrovni_priorita
    alias: "FVE ostrovní provoz: vypnout méně důležité spotřebiče"
    trigger:
      - platform: numeric_state
        entity_id: <sensor.FVE_DOSTUPNY_VYKON>
        below: 500
    action:
      - service: switch.turn_off
        target: { entity_id: <switch.MENE_DULEZITE_ZASUVKY> }
    mode: single
```

### 77. Upozornění na blížící se konec levného tarifu
```yaml
automation:
  - id: levna_sazba_konci_brzy
    alias: "Energie: levná sazba brzy skončí"
    trigger:
      - platform: state
        entity_id: <binary_sensor.LEVNA_SAZBA>
        to: "on"
    action:
      - delay: { hours: 2 }
      - service: notify.telegram
        data: { message: "Levná sazba za chvíli skončí — poslední šance spustit spotřebiče." }
    mode: single
```

### 78. Porovnání spotřeby tento měsíc vs. minulý
```yaml
automation:
  - id: energie_mesicni_srovnani
    alias: "Energie: srovnání spotřeby s minulým měsícem"
    trigger:
      - platform: time
        at: "09:00:00"
    condition:
      - condition: template
        value_template: "{{ now().day == 1 }}"
    action:
      - service: notify.telegram
        data:
          message: >
            Tento měsíc: {{ states('<sensor.SPOTREBA_MESIC>') }} kWh,
            minulý: {{ states('<sensor.SPOTREBA_MESIC_MINULY>') }} kWh.
    mode: single
```

---

## Systémové (system)

### 79. Denní kontrola baterií čidel
```yaml
automation:
  - id: system_baterie_kontrola
    alias: "Systém: denní kontrola baterií čidel"
    trigger:
      - platform: time
        at: "08:00:00"
    condition:
      - condition: numeric_state
        entity_id: <sensor.CIDLO_BATERIE>
        below: 20
    action:
      - service: notify.telegram
        data: { message: "Čidlu dochází baterie ({{ states('<sensor.CIDLO_BATERIE>') }} %)." }
    mode: single
```

### 80. Upozornění na zařízení offline
```yaml
automation:
  - id: system_zarizeni_offline
    alias: "Systém: zařízení je offline"
    trigger:
      - platform: state
        entity_id: <sensor.ZARIZENI_STAV>
        to: "unavailable"
        for: { minutes: 15 }
    action:
      - service: notify.telegram
        data: { message: "Zařízení je offline přes 15 minut." }
    mode: single
```

### 81. Ranní souhrn stavu domu
```yaml
automation:
  - id: system_ranni_souhrn
    alias: "Systém: ranní souhrn"
    trigger:
      - platform: time
        at: "07:00:00"
    action:
      - service: notify.telegram
        data:
          message: >
            Dobré ráno! Venku {{ states('<sensor.TEPLOTA_VENKU>') }}°C,
            {{ states('<weather.DOMOV>') }}.
    mode: single
```

### 82. Upozornění na dostupnou aktualizaci
```yaml
automation:
  - id: system_update_dostupny
    alias: "Systém: dostupná aktualizace HA/add-onu"
    trigger:
      - platform: state
        entity_id: <update.HA_CORE>
        to: "on"
    action:
      - service: notify.telegram
        data: { message: "Je dostupná nová aktualizace Home Assistantu." }
    mode: single
```

### 83. Kontrola volného místa na disku
```yaml
automation:
  - id: system_disk_plny
    alias: "Systém: málo volného místa na disku"
    trigger:
      - platform: numeric_state
        entity_id: <sensor.VOLNE_MISTO_DISK>
        below: 10
    action:
      - service: notify.telegram
        data: { message: "Na disku HA zbývá méně než 10 % místa." }
    mode: single
```

### 84. Týdenní souhrn neobvyklých událostí
```yaml
automation:
  - id: system_tydenni_souhrn_udalosti
    alias: "Systém: týdenní souhrn pro admina"
    trigger:
      - platform: time
        at: "20:00:00"
    condition:
      - condition: time
        weekday: [sun]
    action:
      - service: notify.telegram
        data: { message: "Týdenní přehled: zkontroluj log akcí (read_error_log)." }
    mode: single
```

### 85. Health-check spojení s Telegramem/MCP
```yaml
automation:
  - id: system_telegram_healthcheck
    alias: "Systém: kontrola spojení s Telegramem"
    trigger:
      - platform: time_pattern
        hours: "/6"
    action:
      - service: notify.telegram
        data: { message: "Health-check OK ({{ now().strftime('%H:%M') }})." }
    mode: single
```

### 86. Upozornění na neúspěšný pokus o zápis konfigurace
```yaml
automation:
  - id: system_config_check_selhal
    alias: "Systém: neplatná konfigurace při posledním zápisu"
    trigger:
      - platform: event
        event_type: system_log_event
        event_data: { level: "ERROR" }
    action:
      - service: notify.telegram
        data: { message: "Zaznamenána chyba v systémovém logu — zkontroluj read_error_log." }
    mode: single
```

### 87. Upozornění na výpadek internetu/HA offline
```yaml
automation:
  - id: system_internet_offline
    alias: "Systém: výpadek internetového připojení"
    trigger:
      - platform: state
        entity_id: <binary_sensor.INTERNET_PRIPOJENI>
        to: "off"
        for: { minutes: 5 }
    action:
      - service: persistent_notification.create
        data: { message: "Internet je nedostupný přes 5 minut (offline notifikace přes Telegram nepůjde)." }
    mode: single
```

### 88. Restart problémové integrace při opakovaném výpadku
```yaml
automation:
  - id: system_watchdog_restart_integrace
    alias: "Systém: restart integrace při opakovaném výpadku"
    trigger:
      - platform: state
        entity_id: <sensor.INTEGRACE_STAV>
        to: "unavailable"
        for: { minutes: 30 }
    action:
      - service: homeassistant.reload_config_entry
        target: { entity_id: <sensor.INTEGRACE_STAV> }
    mode: single
```

---

## Ostatní (ostatni)

### 89. Ranní rutina — budík spustí kávovar a rozsvítí
```yaml
automation:
  - id: ranni_rutina_start
    alias: "Ranní rutina: kávovar + světlo + počasí"
    trigger:
      - platform: time
        at: "06:30:00"
    condition:
      - condition: time
        weekday: [mon, tue, wed, thu, fri]
    action:
      - service: switch.turn_on
        target: { entity_id: <switch.KAVOVAR_ZASUVKA> }
      - service: light.turn_on
        target: { entity_id: <light.KUCHYN> }
        data: { brightness_pct: 60 }
      - service: notify.telegram
        data: { message: "Dobré ráno! Venku {{ states('<sensor.TEPLOTA_VENKU>') }}°C." }
    mode: single
```

### 90. Večerní rutina „good night"
```yaml
automation:
  - id: vecerni_rutina_good_night
    alias: "Večerní rutina: good night scéna"
    trigger:
      - platform: time
        at: "22:30:00"
    action:
      - service: light.turn_off
        target: { entity_id: all }
      - service: lock.lock
        target: { entity_id: <lock.VSTUPNI_DVERE> }
      - service: climate.set_temperature
        target: { entity_id: <climate.TOPENI> }
        data: { temperature: 18 }
    mode: single
```

### 91. Odchodová rutina „nikdo doma"
```yaml
automation:
  - id: odchodova_rutina
    alias: "Odchodová rutina: nikdo doma"
    trigger:
      - platform: state
        entity_id: <person.RODINA_VSICHNI_PRYC>
        to: "not_home"
    action:
      - service: light.turn_off
        target: { entity_id: all }
      - service: climate.set_temperature
        target: { entity_id: <climate.TOPENI> }
        data: { temperature: 17 }
      - service: lock.lock
        target: { entity_id: <lock.VSTUPNI_DVERE> }
    mode: single
```

### 92. Připomenutí na vynesení popelnic
```yaml
automation:
  - id: popelnice_pripomenutí
    alias: "Připomenutí: vynést popelnice"
    trigger:
      - platform: time
        at: "20:00:00"
    condition:
      - condition: time
        weekday: [tue]  # nastav podle skutečného svozového dne
    action:
      - service: notify.telegram
        data: { message: "Zítra je svoz — nezapomeň vynést popelnice." }
    mode: single
```

### 93. Narozeninová/výroční připomínka
```yaml
automation:
  - id: narozeniny_pripomenutí
    alias: "Připomínka: narozeniny"
    trigger:
      - platform: time
        at: "08:00:00"
    condition:
      - condition: template
        value_template: "{{ now().strftime('%m-%d') == '05-20' }}"  # nastav konkrétní datum
    action:
      - service: notify.telegram
        data: { message: "Dnes má někdo z rodiny narozeniny! 🎉" }
    mode: single
```

### 94. Hlídání spotřeby vody (možný únik)
```yaml
automation:
  - id: voda_neobvykly_prutok
    alias: "Voda: upozornit na neobvykle vysoký průtok"
    trigger:
      - platform: numeric_state
        entity_id: <sensor.PRUTOK_VODY>
        above: 20
        for: { minutes: 30 }
    action:
      - service: notify.telegram
        data: { message: "Neobvykle vysoký průtok vody přes 30 minut — možný únik!" }
    mode: single
```

### 95. Připomenutí krmení domácího mazlíčka
```yaml
automation:
  - id: mazlicek_krmeni_pripomenutí
    alias: "Mazlíček: připomenout krmení"
    trigger:
      - platform: time
        at: "07:30:00"
      - platform: time
        at: "18:00:00"
    action:
      - service: notify.telegram
        data: { message: "Čas nakrmit mazlíčka." }
    mode: single
```

### 96. Sledování kvality ovzduší a doporučení k větrání
```yaml
automation:
  - id: kvalita_ovzdusi_vetrani
    alias: "Ovzduší: doporučit větrání"
    trigger:
      - platform: numeric_state
        entity_id: <sensor.CO2_OBYVAK>
        above: 1200
    action:
      - service: notify.telegram
        data: { message: "CO2 v obýváku je vysoké ({{ states('<sensor.CO2_OBYVAK>') }} ppm) — vyvětrej." }
    mode: single
```

### 97. Oznámení dokončení pračky/myčky přes reproduktor
```yaml
automation:
  - id: pracka_hlasove_oznameni
    alias: "Pračka: hlasové oznámení dokončení"
    trigger:
      - platform: numeric_state
        entity_id: <sensor.PRACKA_VYKON>
        below: 3
        for: { minutes: 5 }
    condition:
      - condition: state
        entity_id: <switch.PRACKA_ZASUVKA>
        state: "on"
    action:
      - service: tts.speak
        target: { entity_id: <media_player.KUCHYN> }
        data: { message: "Pračka dokončila cyklus." }
    mode: single
```

### 98. „Kde je kdo" — rychlý přehled přítomnosti
```yaml
automation:
  # Tohle je spíš dashboard/dotaz než automatizace — ukázka šablony pro
  # markdown kartu nebo zprávu na vyžádání, ne trvalý trigger.
  - id: kde_je_kdo_dotaz
    alias: "Přehled: kde je kdo"
    trigger:
      - platform: event
        event_type: zan_dotaz_kde_je_kdo  # spouští se na dotaz, ne časem
    action:
      - service: notify.telegram
        data:
          message: >
            Ondra: {{ states('<person.ONDRA>') }},
            Jana: {{ states('<person.JANA>') }}
    mode: single
```

### 99. Hlasové oznámení počasí a dopravy před odchodem
```yaml
automation:
  - id: pred_odchodem_pocasi_doprava
    alias: "Před odchodem: počasí a doprava"
    trigger:
      - platform: time
        at: "07:15:00"
    action:
      - service: tts.speak
        target: { entity_id: <media_player.KUCHYN> }
        data: { message: "Venku {{ states('<sensor.TEPLOTA_VENKU>') }} stupňů, {{ states('<weather.DOMOV>') }}." }
    mode: single
```

### 100. Roční připomínka revizí (kotel, komín, hasicí přístroj)
```yaml
automation:
  - id: revize_rocni_pripomenutí
    alias: "Připomínka: roční revize"
    trigger:
      - platform: time
        at: "09:00:00"
    condition:
      - condition: template
        value_template: "{{ now().strftime('%m-%d') == '09-01' }}"  # nastav podle skutečného termínu
    action:
      - service: notify.telegram
        data: { message: "Čas na roční revizi kotle/komínu/hasicího přístroje." }
    mode: single
```
