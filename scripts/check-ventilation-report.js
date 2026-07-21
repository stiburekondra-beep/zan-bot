#!/usr/bin/env node

const assert = require('assert');
const {
  buildModbusReadOnlyPlan,
  buildVentilationReport,
  summarizeCo2,
} = require('../ventilation-report');

const missing = buildModbusReadOnlyPlan({
  manufacturer: 'Atrea',
  model: '',
  connection: 'unknown',
});
assert.strictEqual(missing.ready_for_yaml, false);
assert(missing.missing.includes('model'));
assert(missing.missing.includes('register_map'));
assert(missing.yaml_guidance.some(step => step.includes('bez mapy registrů')));

const ready = buildModbusReadOnlyPlan({
  manufacturer: 'Atrea',
  model: 'Duplex 370 EC5',
  connection: 'Modbus TCP',
  register_map: 'manual-v1.pdf table 4',
});
assert.strictEqual(ready.ready_for_yaml, true);
assert(ready.connection_note.includes('IP adresu'));
assert(ready.package_scope.includes('read-only'));
assert(ready.package_scope.includes('Žádné'));
assert(ready.package_scope.includes('zápisy'));

const none = summarizeCo2([]);
assert.strictEqual(none.status, 'missing_sensor');
assert(none.message.includes('potřebuju') || none.message.includes('Nemám ověřené CO2 čidlo'));

const single = summarizeCo2([
  { entity_id: 'sensor.obyvak_co2', state: '1210', attributes: { friendly_name: 'CO2 obývák', unit_of_measurement: 'ppm' } },
]);
assert.strictEqual(single.status, 'single_sensor_trend');
assert(single.message.includes('trend'));
assert(single.message.includes('ne účinnost rekuperace'));

const delta = summarizeCo2([
  { entity_id: 'sensor.privod_co2', state: '430', attributes: { friendly_name: 'CO2 přívod', unit_of_measurement: 'ppm' } },
  { entity_id: 'sensor.obyvak_co2', state: '1045', attributes: { friendly_name: 'CO2 obývák', unit_of_measurement: 'ppm' } },
]);
assert.strictEqual(delta.status, 'measured_delta');
assert.strictEqual(delta.delta_ppm, 615);
assert(delta.message.includes('měřený rozdíl'));
assert(delta.message.includes('ne plná účinnost'));

const report = buildVentilationReport({
  manufacturer: 'Atrea',
  model: 'Duplex 370 EC5',
  connection: 'RTU RS-485',
  register_map: 'manual',
  entities: [
    { entity_id: 'sensor.rekuperace_filtr', state: 'ok', attributes: { friendly_name: 'Rekuperace filtr' } },
    { entity_id: 'sensor.obyvak_co2', state: '980', attributes: { friendly_name: 'CO2 obývák', unit_of_measurement: 'ppm' } },
  ],
});
assert.strictEqual(report.mode, 'read_only');
assert.strictEqual(report.safety.writes_allowed, false);
assert.strictEqual(report.modbus.ready_for_yaml, true);
assert.strictEqual(report.co2.status, 'single_sensor_trend');
assert.strictEqual(report.ventilation_entities[0].entity_id, 'sensor.rekuperace_filtr');
assert(report.message.includes('read-only Modbus senzory'));

console.log('ventilation-report checks OK');
