'use strict';
const assert = require('assert');
const { PROFILES, VOICE_CONTROL_TOOLS, resolveProfile, filterToolsByProfile } = require('../tool-profiles');

// Syntetické pole nástrojů (jména stačí — filtr pracuje nad .name).
const fullTools = [
  'get_states', 'get_state', 'get_areas', 'turn_on', 'turn_off', 'toggle',
  'call_service', 'schedule_action', 'announce_home', 'play_music',
  'read_cookbook',
  'garden_map', 'remember', 'recall', 'house_map', 'rodina_update',
  // admin-only:
  'write_package', 'delete_package', 'write_dashboard', 'restart_ha', 'onboard_device',
].map((name) => ({ name, description: `desc ${name}`, input_schema: {} }));

// ── 1) resolveProfile: explicit vyhrává, jinak podle admin gate ──
assert.strictEqual(resolveProfile('ovladani', false), 'ovladani', 'explicitní profil se respektuje');
assert.strictEqual(resolveProfile('ovladani', true), 'ovladani', 'explicitní profil i pro admina');
assert.strictEqual(resolveProfile(undefined, true), 'admin', 'bez profilu + admin → admin');
assert.strictEqual(resolveProfile(undefined, false), 'rodina', 'bez profilu + non-admin → rodina');
assert.strictEqual(resolveProfile('neznamy', true), 'admin', 'neznámý profil spadne na admin gate');
assert.strictEqual(resolveProfile('', false), 'rodina', 'prázdný profil spadne na admin gate');

// ── 2) rodina/admin = bez filtru (zpětná kompatibilita) ──
assert.strictEqual(filterToolsByProfile(fullTools, 'rodina'), fullTools, 'rodina vrací totéž pole (beze změny)');
assert.strictEqual(filterToolsByProfile(fullTools, 'admin'), fullTools, 'admin vrací totéž pole (beze změny)');

// ── 3) ovladani = jen whitelist, hlas NENÍ admin ──
const voice = filterToolsByProfile(fullTools, 'ovladani');
const voiceNames = voice.map((t) => t.name);
assert.deepStrictEqual(
  voiceNames,
  VOICE_CONTROL_TOOLS,
  'ovladani obsahuje přesně control tools (a v pořadí vstupu, které se s allowlistem shoduje)',
);
for (const forbidden of ['write_package', 'delete_package', 'write_dashboard', 'restart_ha', 'onboard_device', 'rodina_update', 'remember']) {
  assert.ok(!voiceNames.includes(forbidden), `hlasový profil NESMÍ obsahovat ${forbidden}`);
}
assert.ok(voiceNames.length <= 12, 'hlasový profil je malý (≤12 nástrojů)');

// ── 4) STABILITA per kanál (prompt cache): dvě volání = identické pole ──
const a = filterToolsByProfile(fullTools, 'ovladani').map((t) => t.name);
const b = filterToolsByProfile(fullTools, 'ovladani').map((t) => t.name);
assert.deepStrictEqual(a, b, 'ovladani je deterministický (stabilní cache prefix)');

// ── 5) filtr snese chybějící nástroj (allowlist ⊄ tools) bez pádu ──
const partial = filterToolsByProfile([{ name: 'get_states' }], 'ovladani');
assert.deepStrictEqual(partial.map((t) => t.name), ['get_states'], 'filtr ponechá jen reálně přítomné nástroje');

// ── 6) PROFILES kontrakt ──
assert.ok(Array.isArray(PROFILES.ovladani) && PROFILES.ovladani.length >= 8, 'ovladani má rozumnou sadu');
assert.strictEqual(PROFILES.rodina, null, 'rodina = bez filtru');
assert.strictEqual(PROFILES.admin, null, 'admin = bez filtru');

console.log('check-tool-profiles: OK (6 skupin kontrol)');
