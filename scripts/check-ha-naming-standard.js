#!/usr/bin/env node
/**
 * Standard pojmenování a místností v HA — kontrola, že pojistky drží.
 *
 * Vzniklo 19.8.2026: Žán přiřazoval místnosti přes entity override místo na
 * zařízení, a do pole "název" zapsal entity_id ("light.obyvak1"). V UI to vypadalo
 * skoro v pořádku, ale nástroje čtoucí device_registry Ondrovu konfiguraci vůbec
 * neviděly a vyhodnotily ji jako neexistující. Ondra: "entity jsme promazali,
 * ale nechci aby se to opakovalo."
 *
 * Standard je PŘEVZATÝ (datový model HA + HA best practices: entity renames,
 * device-sibling discovery), ne vymyšlený. Playbook: ha-pojmenovani-a-mistnosti.
 *
 * Testuje se skutečné chování pojistek, ne jen přítomnost textu v promptu.
 */
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'bot.js'), 'utf8');

// ── 1) chování: jméno ve tvaru entity_id se musí odmítnout ────────────────────
// Vytáhneme regex přímo ze zdrojáku a otestujeme ho na reálných případech,
// ať test nekontroluje jen to, že tam nějaký regex je.
const mJmeno = src.match(/if \(\/\^\(light\|switch\|sensor[^\n]*?\.test\(String\(input\.new_name/);
const regexRadek = mJmeno ? mJmeno[0] : '';
const mVzor = regexRadek.match(/\/(\^\(light[^/]+)\/i/);
let jmenoOK = false;
if (mVzor) {
  const re = new RegExp(mVzor[1], 'i');
  const spatne = ['light.obyvak1', 'switch.sonoff_acc8009232', 'sensor.teplota_kuchyn', 'input_boolean.ai_stop'];
  const dobre = ['Stropní světlo', 'Jídelní kout', 'Zásuvka terasa', 'Světlo koupelna', 'TV obývák (Cast)'];
  jmenoOK = spatne.every(s => re.test(s)) && dobre.every(s => !re.test(s));
}

const kontroly = [
  ['jméno ve tvaru entity_id se odmítne, lidský název projde (ověřeno na 4+5 případech)', jmenoOK],

  ['rename_entity vysvětlí rozdíl mezi názvem a entity_id',
    /To není jméno, ale entity_id/.test(src)],

  // ── 2) místnost patří na zařízení ──────────────────────────────────────────
  ['assign_area odmítne entitu, která má zařízení, a odkáže na ha_setup_assign_device',
    /Použij ha_setup_assign_device — místnost patří na zařízení/.test(src)],

  ['odmítnutí nese konkrétní další krok s device_id a area_id',
    /dalsi_krok: `ha_setup_assign_device\(device_id/.test(src)],

  ['override jde provést, ale jen s uvedeným důvodem (override_duvod)',
    /!input\.override_duvod/.test(src) && /override_duvod: \{ type: 'string'/.test(src)],

  ['u vícekanálového zařízení nástroj poradí, kdy je override správně',
    /kdy_je_override_spravne/.test(src)],

  ['důvod override se zapisuje do logu akcí (dohledatelné, proč výjimka vznikla)',
    /override: \$\{input\.override_duvod\}/.test(src)],

  // ── 3) standard je i v promptu (model ho vidí vždy, ne jen když sáhne po playbooku) ──
  ['systémový prompt nese standard pojmenování a místností',
    /STANDARD POJMENOVÁNÍ A MÍSTNOSTÍ/.test(src)],

  ['prompt říká, že místnost patří na zařízení',
    /Místnost patří na ZAŘÍZENÍ/.test(src)],

  ['prompt zakazuje entity_id v poli název',
    /Do pole NÁZEV nikdy nepiš entity_id/.test(src)],

  ['prompt varuje před opakováním místnosti v názvu',
    /Název neopakuj místnost/.test(src)],

  ['prompt připomíná dopadovou analýzu před změnou entity_id',
    /Před změnou entity_id projdi automatizace/.test(src)],

  // ── 4) playbook existuje a je nasazovaný ───────────────────────────────────
  ['playbook standardu existuje',
    fs.existsSync(path.join(__dirname, '..', 'playbooks-seed', 'ha-pojmenovani-a-mistnosti.md'))],

  ['playbook odkazuje na převzatý zdroj, ne na vlastní vymyšlenou konvenci',
    /best practices/i.test(fs.readFileSync(path.join(__dirname, '..', 'playbooks-seed', 'ha-pojmenovani-a-mistnosti.md'), 'utf8'))],
];

let chyb = 0;
for (const [popis, ok] of kontroly) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${popis}`);
  if (!ok) chyb++;
}
console.log(`\n${kontroly.length - chyb}/${kontroly.length} PASS`);
process.exit(chyb === 0 ? 0 : 1);
