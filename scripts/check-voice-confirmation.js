#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { buildVoiceFastConfirmation } = require('../voice-confirmation');

const run = (name, entityId, result, variantIndex = 0, voice = true) =>
  buildVoiceFastConfirmation({
    voice,
    variantIndex,
    toolExecutions: [{ name, input: { entity_id: entityId }, result }],
  });

assert.strictEqual(run('turn_on', 'light.obyvak', { success: true, confirmed: true }), 'Rozsvíceno.');
assert.strictEqual(run('turn_on', 'light.obyvak', { success: true, confirmed: true }, 1), 'Světlo svítí.');
assert.strictEqual(run('turn_on', 'light.obyvak', { success: true, confirmed: true }, 2), 'Hotovo, svítí.');
assert.strictEqual(run('turn_off', 'light.obyvak', { success: true, confirmed: true }), 'Zhasnuto.');
assert.strictEqual(run('turn_on', 'switch.lampa', { success: true, confirmed: true }), 'Zapnuto.');

assert.strictEqual(run('turn_on', 'light.obyvak', { success: true, confirmed: false }), null, 'bez potvrzení žádná hotová fráze');
assert.strictEqual(run('turn_on', 'light.obyvak', { success: false, confirmed: false }), null, 'selhání jde přes model');
assert.strictEqual(run('turn_on', 'lock.dvere', { success: true, confirmed: true }), null, 'citlivá doména není ve fast-path');
assert.strictEqual(run('turn_on', 'light.obyvak', { success: true, confirmed: true }, 0, false), null, 'textový kanál se nemění');
assert.strictEqual(buildVoiceFastConfirmation({
  voice: true,
  toolExecutions: [
    { name: 'get_states', input: { domain: 'light' }, result: [] },
    { name: 'turn_on', input: { entity_id: 'light.obyvak' }, result: { success: true, confirmed: true } },
  ],
}), 'Rozsvíceno.', 'bezpečné čtení před akcí fast-path neblokuje');
assert.strictEqual(buildVoiceFastConfirmation({
  voice: true,
  toolExecutions: [
    { name: 'turn_on', input: { entity_id: 'light.obyvak' }, result: { success: true, confirmed: true } },
    { name: 'turn_on', input: { entity_id: 'light.kuchyn' }, result: { success: true, confirmed: true } },
  ],
}), null, 'více akcí pokračuje přes model');

console.log('check-voice-confirmation: OK (úzký fast-path + fail closed)');
