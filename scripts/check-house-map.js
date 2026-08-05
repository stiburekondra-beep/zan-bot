'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { applyHouseMapAction, formatHouseMap, readMap } = require('../house-map');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zan-house-map-'));
const file = path.join(tmp, 'house_map.json');

let res = applyHouseMapAction(file, { action: 'get' });
assert.strictEqual(res.count.rooms, 0, 'empty map starts with no rooms');
assert.ok(fs.existsSync(file), 'map file must be created');

res = applyHouseMapAction(file, { action: 'set_room', name: 'Kuchyň', area_id: 'kuchyn', floor_id: 'prizemi', floor_name: 'Přízemí' });
assert.strictEqual(res.success, true);
res = applyHouseMapAction(file, { action: 'set_room', name: 'Obývák', area_id: 'obyvak', floor_id: 'prizemi' });
assert.strictEqual(res.success, true);

res = applyHouseMapAction(file, { action: 'set_adjacency', from: 'kuchyn', to: 'obyvak', type: 'průchod' });
assert.strictEqual(res.success, true);
assert.deepStrictEqual([res.adjacency.from, res.adjacency.to].sort(), ['kuchyn', 'obyvak']);

res = applyHouseMapAction(file, { action: 'add_item', room_id: 'obyvak', name: 'gauč', notes: 'u okna' });
assert.strictEqual(res.success, true);
assert.strictEqual(res.item.room_id, 'obyvak');

res = applyHouseMapAction(file, { action: 'get', room_id: 'obyvak' });
assert.strictEqual(res.room.name, 'Obývák');
assert.strictEqual(res.neighbors.length, 1);
assert.strictEqual(res.items[0].name, 'gauč');

const text = formatHouseMap(file, { room_id: 'obyvak' });
assert.ok(text.includes('Sousedí: Kuchyň'), 'detail should format neighbor name');
assert.ok(text.includes('gauč'), 'detail should list item');

res = applyHouseMapAction(file, { action: 'set_room', name: 'Pracovna' });
assert.ok(res.error.includes('area_id'), 'room requires HA area_id');
res = applyHouseMapAction(file, { action: 'set_adjacency', from: 'kuchyn', to: 'neznama', type: 'dveře' });
assert.ok(res.error.includes('house_map'), 'adjacency requires existing rooms');
res = applyHouseMapAction(file, { action: 'add_item', room_id: 'neznama', name: 'stůl' });
assert.ok(res.error.includes('existující'), 'item requires existing room');

res = applyHouseMapAction(file, { action: 'remove_item', name: 'gauč' });
assert.strictEqual(res.removed, 1);
assert.strictEqual(readMap(file).items.length, 0);
assert.deepStrictEqual(readMap(file).floors, [{ id: 'prizemi', name: 'Přízemí' }]);

fs.rmSync(tmp, { recursive: true, force: true });
console.log('house map contract OK');
