'use strict';

const assert = require('assert');
const {
  buildDeviceLayoutSnapshot,
  formatDeviceLayout,
  inferTransport,
} = require('../device-layout');

const now = Date.parse('2026-08-12T20:00:00.000Z');
const old = '2026-08-12T17:00:00.000Z';

const areaRegistry = [
  { area_id: 'garaz', name: 'Garáž' },
  { area_id: 'terasa', name: 'Terasa' },
];
const houseMap = {
  rooms: [
    { id: 'garaz', area_id: 'garaz', name: 'Garáž' },
    { id: 'terasa', area_id: 'terasa', name: 'Terasa' },
  ],
};

const bridgeDevice = {
  id: 'dev_bridge',
  name: 'ZBBridge-U',
  manufacturer: 'Sonoff',
  model: 'ZBBridge',
  area_id: 'garaz',
  identifiers: [['ewelink', '10028202d8']],
};
const garageDoor = {
  id: 'dev_door',
  name: 'Dveře garáže',
  manufacturer: 'Sonoff',
  model: 'SNZB-04',
  area_id: 'garaz',
  identifiers: [['zigbee2mqtt', 'door']],
};
const waterValve = {
  id: 'dev_valve',
  name: 'Ventil voda garáž',
  manufacturer: 'Aqara',
  model: 'Water valve',
  area_id: 'garaz',
  identifiers: [['zigbee2mqtt', 'valve']],
};

const entityRegistry = [
  { entity_id: 'sensor.sonoff_10028202d8', device_id: 'dev_bridge', name: 'ZBBridge-U', area_id: 'garaz' },
  { entity_id: 'binary_sensor.garaz_dvere', device_id: 'dev_door', name: 'Dveře garáže', area_id: 'garaz' },
  { entity_id: 'switch.ventil_garaz', device_id: 'dev_valve', name: 'Ventil voda garáž', area_id: 'garaz' },
];

let states = [
  { entity_id: 'sensor.sonoff_10028202d8', state: 'unavailable', last_changed: old, attributes: { friendly_name: 'ZBBridge-U' } },
  { entity_id: 'binary_sensor.garaz_dvere', state: 'unavailable', last_changed: old, attributes: { friendly_name: 'Dveře garáže' } },
  { entity_id: 'switch.ventil_garaz', state: 'unavailable', last_changed: old, attributes: { friendly_name: 'Ventil voda garáž' } },
];

let snapshot = buildDeviceLayoutSnapshot({
  states,
  entityRegistry,
  deviceRegistry: [bridgeDevice, garageDoor, waterValve],
  areaRegistry,
  houseMap,
  now,
  minAgeMs: 60 * 60 * 1000,
});

assert.strictEqual(snapshot.counts.unavailable_devices, 3, 'three devices are unavailable');
assert.strictEqual(snapshot.counts.bridge_down, 1, 'bridge down must be detected');
assert.strictEqual(snapshot.diagnosis.recommendations[0].type, 'bridge_down_first', 'bridge down must be first recommendation');
assert.ok(snapshot.diagnosis.recommendations[0].next_step.includes('bridge'), 'recommendation must check bridge first');
assert.ok(!snapshot.diagnosis.recommendations.some(r => r.type === 'zigbee_mesh_candidate'), 'must not suggest mesh while bridge is down');
assert.strictEqual(snapshot.devices.find(d => d.name === 'Dveře garáže').room_id, 'garaz', 'device links to house_map room via area_id');

states = [
  { entity_id: 'sensor.sonoff_10028202d8', state: 'online', last_changed: old, attributes: { friendly_name: 'ZBBridge-U' } },
  { entity_id: 'binary_sensor.garaz_dvere', state: 'unavailable', last_changed: old, attributes: { friendly_name: 'Dveře garáže' } },
  { entity_id: 'switch.ventil_garaz', state: 'unavailable', last_changed: old, attributes: { friendly_name: 'Ventil voda garáž' } },
];

snapshot = buildDeviceLayoutSnapshot({
  states,
  entityRegistry,
  deviceRegistry: [bridgeDevice, garageDoor, waterValve],
  areaRegistry,
  houseMap,
  now,
  minAgeMs: 60 * 60 * 1000,
});

assert.strictEqual(snapshot.counts.bridge_down, 0, 'bridge is online');
assert.ok(snapshot.diagnosis.recommendations.some(r => r.type === 'zigbee_mesh_candidate'), 'mesh candidate appears only after bridge is online');
assert.ok(formatDeviceLayout(snapshot).includes('Layout zařízení'), 'formatted output is human-readable');
assert.strictEqual(inferTransport({ manufacturer: 'Aqara', model: 'Lumi sensor' }, []), 'zigbee');
assert.strictEqual(inferTransport({ manufacturer: 'Shelly', model: 'Plug S' }, []), 'wifi');
assert.strictEqual(inferTransport({ manufacturer: 'Eve', model: 'Matter plug' }, []), 'matter');

console.log('device layout contract OK');
