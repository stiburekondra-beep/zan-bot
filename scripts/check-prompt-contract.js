#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'bot.js'), 'utf8');

function normalize(text) {
  return String(text)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[–—]/g, '-')
    .toLowerCase();
}

const text = normalize(source);

function assertIncludes(needle, label) {
  const normalizedNeedle = normalize(needle);
  if (!text.includes(normalizedNeedle)) {
    throw new Error(`Missing prompt contract: ${label}`);
  }
}

function assertRegex(regex, label) {
  if (!regex.test(text)) {
    throw new Error(`Missing prompt contract: ${label}`);
  }
}

assertIncludes('STYL ODPOVEDI', 'style section exists');
assertIncludes('Bezna odpoved ma max 3-4 kratke vety', 'default answer length');
assertIncludes('Pis jednoduse jako cloveku v kuchyni', 'human tone stays');
assertIncludes('Nepouzivej seznamy, nadpisy ani tabulky', 'lists are not default');
assertIncludes('report, inventuru zarizeni, rozpocet, potvrzeni citlive akce ci YAML/admin vystup', 'structured-output exceptions');
assertIncludes('Emoji nejvys jedno', 'emoji limit');
assertIncludes('Kdyz je tema velke, dej kratke jadro odpovedi a nabidni pokracovani', 'offer continuation instead of flooding');

assertRegex(/const\s+fast_max_tokens\s*=\s*900\s*;/, 'FAST max token limit');
assertRegex(/function\s+modelsupportstemperature\s*\(\s*model\s*\)[\s\S]*claude-haiku-/, 'temperature is guarded by model allowlist');
assertRegex(/function\s+clauderequestoptionsformodel\s*\(\s*model\s*\)[\s\S]*modelsupportstemperature\s*\(\s*model\s*\)[\s\S]*options\.temperature\s*=\s*0\.35/, 'temperature option only for supported models');
// Per-model request options se MUSÍ v agentní smyčce použít (invariant temperature
// allowlistu 2026-08-01). Snese inline spread i lokální proměnnou (voice max_tokens
// override, 2026-08-05): povinné je volání clauderequestoptionsformodel(model) i jeho
// spread do requestu.
assertRegex(/clauderequestoptionsformodel\s*\(\s*model\s*\)/, 'agent loop computes model request options');
assertRegex(/\.\.\.(clauderequestoptionsformodel\s*\(\s*model\s*\)|reqoptions)/, 'agent loop spreads model request options into request');
assertRegex(/model\s*===\s*model_servis[\s\S]*servis/, 'service/admin route still exists');

assertIncludes('PROAKTIVITA PRI PAROVANI', 'pairing proactivity section exists');
assertIncludes('nikdy nekonci pasivne', 'pairing must not end passively');
assertIncludes('dej mi vedet / napis mi', 'pairing names passive wait phrases');
assertIncludes('kdy se sam ozvu / co sam zkontroluju', 'pairing must announce own follow-up');
assertIncludes('Hotovo, pridal jsem" smis rict az po overeni nove entity nebo uspesneho create_entry', 'pairing success requires verification');
assertIncludes('MISTNOST U NOVEHO ZARIZENI', 'new device area rule exists');
assertIncludes('pouzivej presny nazev, ktery rekl', 'use user supplied area name');
assertIncludes('Nesmis si ho potichu prelozit na jinou existujici mistnost', 'forbid silent area aliasing');
assertIncludes('pracovna = Dilna', 'regression example for area aliasing');
assertIncludes('zeptej se, jestli ji mas vytvorit', 'ask before creating or selecting a different area');
assertIncludes('TECHNOLOGIE A DOKUMENTACE', 'technology documentation section exists');
assertIncludes('pouzij technology_inventory', 'technology inventory tool usage');
assertIncludes('planovano-nezapojeno', 'planned disconnected status is explicit');
assertIncludes('neni dukaz ovladani', 'planned technology is not active control');
assertIncludes('Zan dnes neridi teploty ani vetrani', 'no false HVAC control claim');
assertIncludes('MAPA DOMU', 'house map section exists');
assertIncludes('pouzij house_map', 'house map tool usage');
assertIncludes('overene HA area_id', 'house map links to HA areas');
assertIncludes('nevytvarej druhy ciselnik mistnosti', 'house map must not fork room truth');
assertIncludes('Sousednost, dvere, schody a veci ukladej jen z potvrzeneho pudorysu', 'house map does not invent topology');
assertIncludes('REKUPERACE + CO2', 'ventilation section exists');
assertIncludes('prvni verze je vzdy read-only', 'ventilation read-only default');
assertIncludes('registry nikdy nevymyslej podle podobne jednotky', 'forbid invented Modbus registers');
assertIncludes('Pouzij get_states/scan_all_devices', 'ventilation requires verified entities');
assertIncludes('ventilation_report', 'ventilation report tool usage');
assertIncludes('pokud mas jedno CO2 cidlo, rikej jen trend/odhad', 'single CO2 sensor is only trend');
assertIncludes('Nesmis menit vykon/rezim vetrani', 'forbid ventilation control');
assertIncludes('Pred novou automatizaci nebo zmenou chovani automatizace NIKDY nevolej write_package rovnou', 'automation write must not be immediate');
assertIncludes('KDYZ: co automatizaci spusti', 'automation proposal trigger section');
assertIncludes('A KDYZ: podminky, kdy smi bezet', 'automation proposal condition section');
assertIncludes('TAK: co dum udela', 'automation proposal action section');
assertIncludes('BEZPECNOST: co brani nechtenemu nebo fyzicky rizikovemu dopadu', 'automation proposal safety section');
assertIncludes('VRACENI ZPET: jak se zmena vypne nebo vrati', 'automation proposal rollback section');
assertIncludes('Pak cekej na jasne OK. Teprve po potvrzeni zapis YAML pres write_package', 'automation waits for explicit OK');
assertRegex(/write_package'[\s\S]*kdyz\s*\/\s*a kdyz\s*\/\s*tak\s*\/\s*bezpecnost\s*\/\s*vraceni zpet[\s\S]*bez tohoto ok write_package nevolej/, 'write_package tool description carries automation OK gate');
assertIncludes('HUDBA DOMA', 'music section exists');
assertIncludes('pouzij play_music pres Music Assistant', 'music commands use narrow play_music tool');
assertIncludes('Kdyz uz neco hraje a uzivatel chce jineho interpreta, zanr, radio, playlist nebo skladbu, znamena to PREPNOUT hudbu pres play_music', 'music switch intent calls play_music even while already playing');
assertRegex(/nikdy neodpovidej[\s\S]*uz hraju[\s\S]*jen proto[\s\S]*prehravac uz je ve stavu playing/, 'music command must not be short-circuited by playing state');
assertIncludes('Nezkousej otevrit music_assistant pres call_service', 'music_assistant is not opened through generic call_service');
assertIncludes('bez overeni nastrojem', 'music refusal must first try the tool');
assertIncludes('dej dalsi krok', 'music failure includes next step');
assertIncludes('LIMITY A MEZERY SCHOPNOSTI', 'capability gap section exists');
assertIncludes('nikdy nekonci holym "neumim", "nemuzu", "nesmim" nebo "nemam pristup"', 'no bare refusal rule');
assertIncludes('zapis anonymni mezeru do repair inboxu', 'capability gap writes repair inbox');
assertIncludes('raw vety rodiny ani citace do repair zaznamu neukladej', 'capability gap does not leak raw conversation');
assertIncludes('Poctivost zustava: limit priznej', 'honesty guards are not weakened by next-step rule');
assertIncludes('Host/neznamy chat nesmi cist ani zapisovat rodinnou pamet', 'guest cannot read/write family memory');
assertIncludes('neprozrazuj rodinnou pamet, jmena deti, rutiny, preference, mistnosti, zarizeni, kamery/mikrofony ani souhrn stavu domu', 'guest privacy covers memory and HA status summaries');
assertIncludes('rodinna data muzes ukazat az po potvrzeni adminem', 'guest must be routed to admin approval');

console.log('Prompt contract OK');
