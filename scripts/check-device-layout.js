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
assert.strictEqual(inferTransport({ manufacturer: 'dresden elektronik', model: 'ConBee II' }, []), 'zigbee');
assert.strictEqual(inferTransport({ manufacturer: 'Nabu Casa', model: 'HA SkyConnect' }, []), 'zigbee');

function assertCoordinatorViaDevice(name, manufacturer, model) {
  const coordinator = {
    id: 'dev_usb_coord',
    name,
    manufacturer,
    model,
    area_id: 'garaz',
    identifiers: [['zha', 'coord']],
  };
  const door = {
    ...garageDoor,
    via_device_id: 'dev_usb_coord',
  };
  const valve = {
    ...waterValve,
    via_device_id: 'dev_usb_coord',
  };
  const usbEntityRegistry = [
    { entity_id: 'sensor.usb_coord_state', device_id: 'dev_usb_coord', name, area_id: 'garaz' },
    { entity_id: 'binary_sensor.usb_garaz_dvere', device_id: 'dev_door', name: 'Dveře garáže', area_id: 'garaz' },
    { entity_id: 'switch.usb_ventil_garaz', device_id: 'dev_valve', name: 'Ventil voda garáž', area_id: 'garaz' },
  ];
  const usbStates = [
    { entity_id: 'sensor.usb_coord_state', state: 'unavailable', last_changed: old, attributes: { friendly_name: name } },
    { entity_id: 'binary_sensor.usb_garaz_dvere', state: 'unavailable', last_changed: old, attributes: { friendly_name: 'Dveře garáže' } },
    { entity_id: 'switch.usb_ventil_garaz', state: 'unavailable', last_changed: old, attributes: { friendly_name: 'Ventil voda garáž' } },
  ];
  const usbSnapshot = buildDeviceLayoutSnapshot({
    states: usbStates,
    entityRegistry: usbEntityRegistry,
    deviceRegistry: [coordinator, door, valve],
    areaRegistry,
    houseMap,
    now,
    minAgeMs: 60 * 60 * 1000,
  });

  assert.strictEqual(usbSnapshot.counts.bridge_down, 1, `${name} must be detected as bridge via via_device_id`);
  assert.strictEqual(
    usbSnapshot.diagnosis.recommendations[0].type,
    'bridge_down_first',
    `${name} outage must check coordinator before mesh`,
  );
  assert.ok(
    !usbSnapshot.diagnosis.recommendations.some(r => r.type === 'zigbee_mesh_candidate'),
    `${name} outage must not suggest buying router before coordinator is checked`,
  );
}

assertCoordinatorViaDevice('Sonoff Zigbee 3.0 USB Dongle Plus', 'Sonoff', 'ZBDongle-P');
assertCoordinatorViaDevice('ConBee II', 'dresden elektronik', 'ConBee II');
assertCoordinatorViaDevice('HA SkyConnect', 'Nabu Casa', 'SkyConnect');

// --- LQI / slabý Zigbee signál (karta 2026-08-17-programator-zana-02, část 2) ---
const lqiEntityRegistry = [
  { entity_id: 'sensor.sonoff_10028202d8', device_id: 'dev_bridge', name: 'ZBBridge-U', area_id: 'garaz' },
  { entity_id: 'binary_sensor.garaz_dvere', device_id: 'dev_door', name: 'Dveře garáže', area_id: 'garaz' },
  { entity_id: 'switch.ventil_garaz', device_id: 'dev_valve', name: 'Ventil voda garáž', area_id: 'garaz' },
];

// Slabý LQI z atributu `linkquality` (Z2M), bridge ONLINE → zigbee_weak_signal s hodnotou.
let weakSnapshot = buildDeviceLayoutSnapshot({
  states: [
    { entity_id: 'sensor.sonoff_10028202d8', state: 'online', last_changed: old, attributes: { friendly_name: 'ZBBridge-U' } },
    { entity_id: 'binary_sensor.garaz_dvere', state: 'on', last_changed: old, attributes: { friendly_name: 'Dveře garáže', linkquality: 42 } },
    { entity_id: 'switch.ventil_garaz', state: 'off', last_changed: old, attributes: { friendly_name: 'Ventil voda garáž', linkquality: 30 } },
  ],
  entityRegistry: lqiEntityRegistry,
  deviceRegistry: [bridgeDevice, garageDoor, waterValve],
  areaRegistry,
  houseMap,
  now,
  minAgeMs: 60 * 60 * 1000,
});
assert.strictEqual(weakSnapshot.counts.zigbee_weak_signal, 2, 'two zigbee devices report weak LQI');
const weakRec = weakSnapshot.diagnosis.recommendations.find(r => r.type === 'zigbee_weak_signal');
assert.ok(weakRec, 'weak signal recommendation appears when LQI is below threshold and bridge is up');
assert.ok(weakRec.detail.includes('30'), 'weak signal detail names the worst measured LQI value');
assert.ok(weakRec.next_step.toLowerCase().includes('router'), 'weak signal suggests router placement');
assert.strictEqual(weakSnapshot.devices.find(d => d.name === 'Dveře garáže').lqi, 42, 'device carries measured LQI');
assert.ok(formatDeviceLayout(weakSnapshot, { scope: 'all' }).includes('LQI 42'), 'formatted output shows LQI');

// Dobrý LQI → žádný poplach (fix nesmí jen „všechno hlásit slabé").
let goodSnapshot = buildDeviceLayoutSnapshot({
  states: [
    { entity_id: 'sensor.sonoff_10028202d8', state: 'online', last_changed: old, attributes: { friendly_name: 'ZBBridge-U' } },
    { entity_id: 'binary_sensor.garaz_dvere', state: 'on', last_changed: old, attributes: { friendly_name: 'Dveře garáže', linkquality: 210 } },
    { entity_id: 'switch.ventil_garaz', state: 'off', last_changed: old, attributes: { friendly_name: 'Ventil voda garáž', linkquality: 180 } },
  ],
  entityRegistry: lqiEntityRegistry,
  deviceRegistry: [bridgeDevice, garageDoor, waterValve],
  areaRegistry,
  houseMap,
  now,
  minAgeMs: 60 * 60 * 1000,
});
assert.strictEqual(goodSnapshot.counts.zigbee_weak_signal, 0, 'strong LQI must not trigger weak signal');
assert.ok(!goodSnapshot.diagnosis.recommendations.some(r => r.type === 'zigbee_weak_signal'), 'no weak signal recommendation with good LQI');

// Neznámé LQI (žádný atribut) → lqi null, žádná fabulace slabého signálu.
let unknownSnapshot = buildDeviceLayoutSnapshot({
  states: [
    { entity_id: 'sensor.sonoff_10028202d8', state: 'online', last_changed: old, attributes: { friendly_name: 'ZBBridge-U' } },
    { entity_id: 'binary_sensor.garaz_dvere', state: 'on', last_changed: old, attributes: { friendly_name: 'Dveře garáže' } },
    { entity_id: 'switch.ventil_garaz', state: 'off', last_changed: old, attributes: { friendly_name: 'Ventil voda garáž' } },
  ],
  entityRegistry: lqiEntityRegistry,
  deviceRegistry: [bridgeDevice, garageDoor, waterValve],
  areaRegistry,
  houseMap,
  now,
  minAgeMs: 60 * 60 * 1000,
});
assert.strictEqual(unknownSnapshot.counts.zigbee_weak_signal, 0, 'unknown LQI must not fabricate weak signal');
assert.strictEqual(unknownSnapshot.devices.find(d => d.name === 'Dveře garáže').lqi, null, 'unknown LQI stays null, not guessed');

// Slabý LQI ALE bridge DOWN → přednost bridge_down_first, žádný router poradce.
let weakButBridgeDown = buildDeviceLayoutSnapshot({
  states: [
    { entity_id: 'sensor.sonoff_10028202d8', state: 'unavailable', last_changed: old, attributes: { friendly_name: 'ZBBridge-U' } },
    { entity_id: 'binary_sensor.garaz_dvere', state: 'on', last_changed: old, attributes: { friendly_name: 'Dveře garáže', linkquality: 20 } },
    { entity_id: 'switch.ventil_garaz', state: 'off', last_changed: old, attributes: { friendly_name: 'Ventil voda garáž', linkquality: 25 } },
  ],
  entityRegistry: lqiEntityRegistry,
  deviceRegistry: [bridgeDevice, garageDoor, waterValve],
  areaRegistry,
  houseMap,
  now,
  minAgeMs: 60 * 60 * 1000,
});
assert.strictEqual(weakButBridgeDown.counts.bridge_down, 1, 'bridge is down in this scenario');
assert.strictEqual(weakButBridgeDown.diagnosis.recommendations[0].type, 'bridge_down_first', 'dead bridge takes precedence over weak signal');
assert.ok(!weakButBridgeDown.diagnosis.recommendations.some(r => r.type === 'zigbee_weak_signal'), 'no router advice while bridge is down');

// Diagnostická entita `sensor.*_lqi` (ZHA cesta) → LQI se přečte ze stavu entity.
let zhaLqiSnapshot = buildDeviceLayoutSnapshot({
  states: [
    { entity_id: 'sensor.sonoff_10028202d8', state: 'online', last_changed: old, attributes: { friendly_name: 'ZBBridge-U' } },
    { entity_id: 'binary_sensor.garaz_dvere', state: 'on', last_changed: old, attributes: { friendly_name: 'Dveře garáže' } },
    { entity_id: 'sensor.garaz_dvere_lqi', state: '35', last_changed: old, attributes: { friendly_name: 'Dveře garáže LQI' } },
  ],
  entityRegistry: [
    { entity_id: 'sensor.sonoff_10028202d8', device_id: 'dev_bridge', name: 'ZBBridge-U', area_id: 'garaz' },
    { entity_id: 'binary_sensor.garaz_dvere', device_id: 'dev_door', name: 'Dveře garáže', area_id: 'garaz' },
    { entity_id: 'sensor.garaz_dvere_lqi', device_id: 'dev_door', name: 'Dveře garáže LQI', area_id: 'garaz' },
  ],
  deviceRegistry: [bridgeDevice, garageDoor],
  areaRegistry,
  houseMap,
  now,
  minAgeMs: 60 * 60 * 1000,
});
assert.strictEqual(zhaLqiSnapshot.devices.find(d => d.name === 'Dveře garáže').lqi, 35, 'LQI read from dedicated *_lqi diagnostic entity');
assert.ok(zhaLqiSnapshot.diagnosis.recommendations.some(r => r.type === 'zigbee_weak_signal'), 'weak signal from ZHA LQI entity');

// sc.66 (tester reziduál k.2026-08-17-programator-zana-02): MRTVÉ zařízení (unavailable)
// se ZASTARALÝM atributem `linkquality` NESMÍ dostat radu "kup router". Bridge ONLINE,
// jen jedno Zigbee zařízení unavailable (<2 v zóně → ani mesh_candidate) — čistě izoluje
// LQI asymetrii: dřív atributová cesta četla stale hodnotu a fabulovala slabý signál.
let deadStaleLqi = buildDeviceLayoutSnapshot({
  states: [
    { entity_id: 'sensor.sonoff_10028202d8', state: 'online', last_changed: old, attributes: { friendly_name: 'ZBBridge-U' } },
    { entity_id: 'binary_sensor.garaz_dvere', state: 'unavailable', last_changed: old, attributes: { friendly_name: 'Dveře garáže', linkquality: 40 } },
  ],
  entityRegistry: [
    { entity_id: 'sensor.sonoff_10028202d8', device_id: 'dev_bridge', name: 'ZBBridge-U', area_id: 'garaz' },
    { entity_id: 'binary_sensor.garaz_dvere', device_id: 'dev_door', name: 'Dveře garáže', area_id: 'garaz' },
  ],
  deviceRegistry: [bridgeDevice, garageDoor],
  areaRegistry,
  houseMap,
  now,
  minAgeMs: 60 * 60 * 1000,
});
assert.strictEqual(deadStaleLqi.devices.find(d => d.name === 'Dveře garáže').lqi, null, 'unavailable device: stale linkquality attribute must NOT be read as LQI');
assert.strictEqual(deadStaleLqi.counts.zigbee_weak_signal, 0, 'dead device with stale LQI must not count as weak signal');
assert.ok(!deadStaleLqi.diagnosis.recommendations.some(r => r.type === 'zigbee_weak_signal'), 'no "buy router" advice for a dead (likely dead-battery) device');

console.log('device layout contract OK');
