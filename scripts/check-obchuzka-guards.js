#!/usr/bin/env node
/**
 * Strážní kontrola obchůzky (19.8.2026, aktualizováno po "všechno to zapni").
 *
 * Obchůzka zasahuje do živého domu sama a od 19.8. smí i NEVRATNÉ věci
 * (instalace aktualizací, restart HA). Ondra to povolil vědomě. Pojistky se tím
 * ale nemění na nic — mění se jejich účel:
 *   dřív: co Žán NESMÍ
 *   teď:  aby z každého zásahu šlo COUVNOUT a aby se nezacyklil
 *
 * Statická kontrola, ne důkaz funkčnosti: že obchůzka opravdu vzkřísí rozbitou
 * integraci, ukáže až živý běh v 18:00.
 */
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'bot.js'), 'utf8');
const obchuzka = src.slice(src.indexOf('async function runObchuzka'), src.indexOf('async function selfReflect'));

const kontroly = [
  // ── cesty k Supervisoru ────────────────────────────────────────────────
  ['Supervisor jde přes WS supervisor/api, ne přes REST /api/hassio (401)',
    /haWsCommand\(\s*['"]supervisor\/api['"]/.test(src) &&
    !/(axios|fetch)[^\n]*api\/hassio\//.test(src) &&
    !/HA_URL\s*\}?\s*[`'"]?\/api\/hassio\//.test(src)],

  // ── allowlisty: model smí navrhnout cokoliv, projít smí jen ověřené ────
  ['reload jde jen na entitu ze seznamu nedostupných',
    /unavailableIds\.has\(z\.entity_id\)/.test(obchuzka)],
  ['restart add-onu má allowlist ze Supervisoru',
    /addonSlugs\.has\(z\.slug\)/.test(obchuzka)],
  ['install_update bere jen entity domény update.',
    /z\.entity_id\.startsWith\(['"]update\.['"]\)/.test(obchuzka)],

  // ── VRATNOST: nevratné zásahy musí mít zálohu předem ───────────────────
  ['před instalací aktualizace se dělá plná záloha',
    /const zal = await fullBackup\(`update \$\{z\.entity_id\}`\)/.test(obchuzka)],
  ['když záloha selže, aktualizace se NEinstaluje',
    /if \(!zal\.ok\) \{[\s\S]{0,220}?NEinstaluju/.test(obchuzka)],
  ['před restartem HA se dělá plná záloha',
    /const zal = await fullBackup\(['"]restart HA['"]\)/.test(obchuzka)],
  ['zpráva o restartu HA odejde dřív, než se HA restartuje',
    /sendSafe\([\s\S]{0,400}?services\/homeassistant\/restart/.test(obchuzka)],

  // ── ochrana před smyčkou ───────────────────────────────────────────────
  ['reload max 5×/den/entita', /count >= 5/.test(obchuzka)],
  ['restart add-onu max 3×/den', /count >= 3/.test(obchuzka)],
  ['Zigbee párování max 2×/den', /count >= 2/.test(obchuzka)],
  ['restart HA max 1×/den (jinak smyčka)', /restart HA jsem dnes už udělal/.test(obchuzka)],
  ['Core/OS aktualizace max 1×/den', /coreDnes >= 1/.test(obchuzka)],
  ['celkem max 3 aktualizace za den', /denniUpdaty >= 3/.test(obchuzka)],

  // ── chování hlášení ────────────────────────────────────────────────────
  ['když není co hlásit, nic se neposílá', /nic k řešení, nehlásím/.test(obchuzka)],
  ['když Žán vše sám opravil, taky mlčí', /nic nezbylo — nehlásím/.test(obchuzka)],
  ['obchůzka běží denně, ne jen St+So', /const isObchuzkaDen = true;/.test(src)],
  ['ranní ohlášení obchůzky se neposílá', !/^\s*announceObchuzka\(\);/m.test(src)],

  // ── příčiny, ne příznaky ───────────────────────────────────────────────
  ['diagnóza seskupuje podle společné příčiny',
    /SESKUP entity podle společné příčiny/.test(obchuzka)],
  ['pořadí zásahů je od nejmírnějšího',
    /POŘADÍ JE ZÁVAZNÉ/.test(obchuzka)],

  // ── síla signálu (Ondra 19.8.) ─────────────────────────────────────────
  ['síla Zigbee signálu se zjišťuje (ZHA i fallback přes entity)',
    /zha\/devices/.test(src) && /_lqi\$\|_linkquality\$/.test(src)],
  ['LQI se hodnotí v pásmech', /function hodnotSignal/.test(src)],
  ['signál jde do diagnózy modelu', /vč\. SÍLY SIGNÁLU/.test(obchuzka)],
  ['při párování Žán poradí podle signálu',
    /Než ho spáruješ zpátky na stejné místo/.test(obchuzka)],
  ['počítá se i počet routerů (systémová příčina)',
    /function spocitejRoutery/.test(src) && /zigbeeRouteru/.test(obchuzka)],

  // ── playbook na oživení signálu (Ondra 19.8.) ──────────────────────────
  ['seed playbook zigbee-signal existuje v repu',
    fs.existsSync(path.join(__dirname, '..', 'playbooks-seed', 'zigbee-signal.md'))],
  ['seed playbooky se při startu doplní do runtime složky',
    /function seedPlaybooks/.test(src) && /seedPlaybooks\(\);/.test(src)],
  ['seed NEPŘEPISUJE existující playbook',
    /if \(fs\.existsSync\(cil\)\) continue;/.test(src)],
  ['playbook se vkládá do diagnostiky obchůzky (jinak by ležel ladem)',
    /readPlaybook\('zigbee-signal'\)/.test(obchuzka) && /POSTUPY NA OŽIVENÍ ZIGBEE SIGNÁLU/.test(obchuzka)],
];

let chyb = 0;
for (const [popis, ok] of kontroly) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${popis}`);
  if (!ok) chyb++;
}
console.log(`\n${kontroly.length - chyb}/${kontroly.length} PASS`);
process.exit(chyb === 0 ? 0 : 1);
