#!/usr/bin/env node
/**
 * Strážní kontrola obchůzky (19.8.2026).
 *
 * Obchůzka od téhle verze zasahuje do živého domu sama (reload integrace,
 * restart add-onu). Mantinely MUSÍ vynucovat kód, ne prompt — model může
 * navrhnout cokoliv. Tenhle test hlídá, že pojistky ze zdrojáku nezmizí.
 *
 * Je to statická kontrola, ne důkaz funkčnosti: že obchůzka opravdu opraví
 * rozbitou integraci, ukáže až živý běh v 18:00.
 */
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'bot.js'), 'utf8');
const kontroly = [
  // Pozor: /api/hassio se ve zdrojáku vyskytuje i v komentářích (vysvětlení pasti),
  // proto se hlídá jen skutečné HTTP volání, ne zmínka v textu.
  ['Supervisor jde přes WS supervisor/api, ne přes REST /api/hassio (401)',
    /haWsCommand\(\s*['"]supervisor\/api['"]/.test(src) &&
    !/(axios|fetch)[^\n]*api\/hassio\//.test(src) &&
    !/HA_URL\s*\}?\s*[`'"]?\/api\/hassio\//.test(src)],

  ['restart add-onu má allowlist ze Supervisoru (addonSlugs.has)',
    /addonSlugs\.has\(z\.slug\)/.test(src)],

  ['reload jde jen na entitu ze seznamu unavailable',
    /unavailableIds\.has\(z\.entity_id\)/.test(src)],

  ['reload max 2× denně na entitu',
    /count\s*>=\s*2/.test(src)],

  ['restart add-onu max 1× denně',
    /count\s*>=\s*1/.test(src)],

  ['obchůzka needěla nevratné věci — neinstaluje aktualizace',
    !/services\/update\/install/.test(src)],

  ['obchůzka nerestartuje celé HA sama',
    !/runObchuzka[\s\S]*?services\/homeassistant\/restart/.test(src.slice(src.indexOf('async function runObchuzka'), src.indexOf('async function selfReflect')))],

  ['když není co hlásit, nic se neposílá (Ondra: jen problémy)',
    /nic k řešení, nehlásím/.test(src)],

  ['když Žán vše sám opravil, taky mlčí',
    /nic nezbylo — nehlásím/.test(src)],

  ['obchůzka běží denně, ne jen St+So',
    /const isObchuzkaDen = true;/.test(src)],

  ['ranní ohlášení obchůzky se neposílá',
    !/^\s*announceObchuzka\(\);/m.test(src)],

  ['diagnóza hledá příčinu, ne výčet (seskupení podle integrace)',
    /SESKUP entity podle společné příčiny/.test(src)],
];

let chyb = 0;
for (const [popis, ok] of kontroly) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${popis}`);
  if (!ok) chyb++;
}
console.log(`\n${kontroly.length - chyb}/${kontroly.length} PASS`);
process.exit(chyb === 0 ? 0 : 1);
