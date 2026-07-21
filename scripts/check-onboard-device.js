const assert = require('assert');
const {
  inferCandidateCategory,
  inferPlugOnboarding,
  inferTvOnboarding,
  inferClimateOnboarding,
  buildOnboardDeviceRequest,
} = require('../onboard-device');

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
assert.strictEqual(tv.tv_onboarding.recommended_handlers[0].handler, 'webostv');
assert.strictEqual(tv.tv_onboarding.pairing.requires_screen_confirmation, true);

const samsungTv = inferTvOnboarding({
  hostname: 'samsung-qled-living',
  vendor: 'Samsung',
  ssdp_st: 'urn:samsung.com:device:RemoteControlReceiver:1',
});
assert.strictEqual(samsungTv.recommended_handlers[0].handler, 'samsungtv');
assert(samsungTv.after_pairing.some(step => step.includes('media_player')));

const androidTv = buildOnboardDeviceRequest({
  category: 'tv',
  candidate: { name: 'Sony Google TV', manufacturer: 'Sony', model: 'Bravia Android TV' },
});
assert.strictEqual(androidTv.needs_handler, true);
assert.strictEqual(androidTv.suggested_handlers[0].handler, 'androidtv_remote');
assert.strictEqual(androidTv.tv_pairing.requires_screen_confirmation, true);
assert(androidTv.message.includes('media_player'));

const unknownTv = buildOnboardDeviceRequest({ category: 'tv' });
assert.strictEqual(unknownTv.needs_handler, true);
assert.strictEqual(unknownTv.suggested_handlers[0].handler, null);
assert(unknownTv.message.includes('nesmí tipovat'));

const webosTv = buildOnboardDeviceRequest({
  category: 'tv',
  handler: 'webostv',
  candidate: { name: 'LG webOS TV obyvak' },
  flow_input: { host: '192.168.0.44' },
});
assert.strictEqual(webosTv.handler, 'webostv');
assert.deepStrictEqual(webosTv.userInput, { host: '192.168.0.44' });
assert(webosTv.after_pairing.some(step => step.includes('ha_setup_assign_device')));

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
  candidate: { vendor: 'Daikin', model: 'Perfera WiFi' },
  flow_input: { host: '192.168.0.80' },
});
assert.strictEqual(climate.handler, 'daikin');
assert.deepStrictEqual(climate.userInput, { host: '192.168.0.80' });
assert.strictEqual(climate.climate_safety.read_only_default, true);
assert(climate.after_pairing.some(step => step.includes('climate entitu')));

const daikinClimate = buildOnboardDeviceRequest({
  category: 'climate',
  candidate: { hostname: 'daikin-ac-loznice', vendor: 'Daikin' },
});
assert.strictEqual(daikinClimate.needs_handler, true);
assert.strictEqual(daikinClimate.suggested_handlers[0].handler, 'daikin');
assert.strictEqual(daikinClimate.climate_safety.read_only_default, true);
assert(daikinClimate.message.includes('read-only'));

const mitsubishiClimate = inferClimateOnboarding({
  manufacturer: 'Mitsubishi Electric',
  integration: 'MELCloud',
});
assert.strictEqual(mitsubishiClimate.recommended_handlers[0].handler, 'melcloud');
assert(mitsubishiClimate.after_pairing.some(step => step.includes('packages/topeni_*')));

const greeClimate = inferCandidateCategory({
  entity_id: 'climate.gree_obyvak',
  domain: 'climate',
  vendor: 'Gree',
});
assert.strictEqual(greeClimate.category_guess, 'climate');
assert.strictEqual(greeClimate.confidence, 'medium');
assert.strictEqual(greeClimate.climate_onboarding.recommended_handlers[0].handler, 'gree');

const mideaCcm15 = inferClimateOnboarding({ name: 'Midea CCM15 controller' });
assert.strictEqual(mideaCcm15.recommended_handlers[0].handler, 'ccm15');

const irOnlyClimate = inferClimateOnboarding({ name: 'IR-only klimatizace pres Broadlink' });
assert.strictEqual(irOnlyClimate.control_safety.ir_only_requires_hardware, true);
assert(irOnlyClimate.control_safety.rule.includes('potřebuju_dokoupit'));

const unknownClimate = buildOnboardDeviceRequest({ category: 'climate' });
assert.strictEqual(unknownClimate.needs_handler, true);
assert.strictEqual(unknownClimate.suggested_handlers[0].handler, null);
assert(unknownClimate.message.includes('nesmí tipovat'));

console.log('onboard-device checks OK');
