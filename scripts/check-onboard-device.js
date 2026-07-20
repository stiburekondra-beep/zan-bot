const assert = require('assert');
const { inferCandidateCategory, inferPlugOnboarding, buildOnboardDeviceRequest } = require('../onboard-device');

const plug = inferCandidateCategory({
  hostname: 'tapo-p110-kuchyn',
  vendor: 'TP-Link',
  name: 'Chytra zasuvka kuchyn',
});
assert.strictEqual(plug.category_guess, 'plug');
assert(plug.candidates[0].reasons.some(r => r.startsWith('vendor:') || r.startsWith('keyword:')));
assert.strictEqual(plug.note.includes('Finální typ'), true);
assert.strictEqual(plug.plug_onboarding.recommended_handlers[0].handler, 'tplink');
assert.strictEqual(plug.plug_onboarding.automation_safety.risky_load, false);

const riskyPlug = inferPlugOnboarding({
  name: 'Zasuvka cerpadlo studna',
  vendor: 'Shelly',
  model: 'Shelly Plug S',
});
assert.strictEqual(riskyPlug.recommended_handlers[0].handler, 'shelly');
assert.strictEqual(riskyPlug.automation_safety.risky_load, true);
assert(riskyPlug.automation_safety.rule.includes('Nenabízet automatické'));

const tv = inferCandidateCategory({
  entity_id: 'media_player.lg_webos_tv',
  name: 'LG TV obyvaci pokoj',
  domain: 'media_player',
});
assert.strictEqual(tv.category_guess, 'tv');
assert.strictEqual(tv.confidence, 'medium');

const unknownPlug = buildOnboardDeviceRequest({ category: 'plug' });
assert.strictEqual(unknownPlug.needs_handler, true);
assert.strictEqual(unknownPlug.suggested_handlers[0].handler, null);
assert(unknownPlug.message.includes('nesmí tipovat'));

const tapoPlug = buildOnboardDeviceRequest({
  category: 'plug',
  candidate: { hostname: 'tapo-p110-kuchyn', vendor: 'TP-Link' },
});
assert.strictEqual(tapoPlug.needs_handler, true);
assert.strictEqual(tapoPlug.suggested_handlers[0].handler, 'tplink');
assert(tapoPlug.after_pairing.some(step => step.includes('ha_setup_assign_device')));

const shellyPlug = buildOnboardDeviceRequest({
  category: 'plug',
  handler: 'shelly',
  candidate: { name: 'Shelly Plug pracka', vendor: 'Shelly' },
});
assert.strictEqual(shellyPlug.handler, 'shelly');
assert.strictEqual(shellyPlug.automation_safety.risky_load, false);

const camera = buildOnboardDeviceRequest({
  category: 'camera',
  host: '192.168.0.50',
  username: 'local',
  password: 'secret',
  stream_path: '/stream2',
});
assert.strictEqual(camera.handler, 'generic');
assert.strictEqual(camera.userInput.stream_source, 'rtsp://192.168.0.50:554/stream2');
assert.strictEqual(camera.userInput.username, 'local');
assert.strictEqual(camera.userInput.password, 'secret');

const climate = buildOnboardDeviceRequest({
  category: 'climate',
  handler: 'daikin',
  flow_input: { host: '192.168.0.80' },
});
assert.strictEqual(climate.handler, 'daikin');
assert.deepStrictEqual(climate.userInput, { host: '192.168.0.80' });

console.log('onboard-device checks OK');
