const assert = require('assert');
const {
  cleanDeviceMemory,
  formatMemoryMap,
  isAutoSeededDeviceRecord,
} = require('../memory-devices');

const auto = {
  'light.kuchyn': {
    name: 'Kuchyn',
    entity_id: 'light.kuchyn',
    domain: 'light',
    state: 'on',
  },
};

assert.strictEqual(isAutoSeededDeviceRecord('light.kuchyn', auto['light.kuchyn']), true);
assert.strictEqual(isAutoSeededDeviceRecord('light.kuchyn', 'hlavni svetlo nad linkou'), false);
assert.strictEqual(isAutoSeededDeviceRecord('light.kuchyn', {
  name: 'Kuchyn',
  entity_id: 'light.kuchyn',
  domain: 'light',
  state: 'on',
  note: 'manualni poznamka',
}), false);

const cleaned = cleanDeviceMemory({
  ...auto,
  'klimatizace_loznice': 'v lete nemirit na postel',
  'sensor.teplota': { name: 'Teplota', entity_id: 'sensor.teplota', domain: 'sensor', state: '21', note: 'manualni' },
});

assert.deepStrictEqual(cleaned.removed, ['light.kuchyn']);
assert.deepStrictEqual(Object.keys(cleaned.devices).sort(), ['klimatizace_loznice', 'sensor.teplota']);

const formatted = formatMemoryMap(cleaned.devices, 1);
assert(formatted.includes('klimatizace_loznice'));
assert(formatted.includes('... a dalsich 1'));

console.log('memory-devices checks OK');
