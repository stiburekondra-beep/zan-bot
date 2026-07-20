const assert = require('assert');
const { inferCandidateCategory, buildOnboardDeviceRequest } = require('../onboard-device');

const plug = inferCandidateCategory({
  hostname: 'tapo-p110-kuchyn',
  vendor: 'TP-Link',
  name: 'Chytra zasuvka kuchyn',
});
assert.strictEqual(plug.category_guess, 'plug');
assert(plug.candidates[0].reasons.some(r => r.startsWith('vendor:') || r.startsWith('keyword:')));
assert.strictEqual(plug.note.includes('Finální typ'), true);

const tv = inferCandidateCategory({
  entity_id: 'media_player.lg_webos_tv',
  name: 'LG TV obyvaci pokoj',
  domain: 'media_player',
});
assert.strictEqual(tv.category_guess, 'tv');
assert.strictEqual(tv.confidence, 'medium');

const unknownPlug = buildOnboardDeviceRequest({ category: 'plug' });
assert.strictEqual(unknownPlug.needs_handler, true);
assert(unknownPlug.suggested_handlers.includes('shelly'));
assert(unknownPlug.message.includes('nesmí tipovat'));

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
