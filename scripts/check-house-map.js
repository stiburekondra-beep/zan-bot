'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { applyHouseMapAction, formatHouseMap, prepareHouseMapSeed, readMap } = require('../house-map');

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
res = applyHouseMapAction(file, { action: 'set_room', name: 'Ložnice', area_id: 'loznice', floor_id: '1_patro', notes: 'Alternativní názvy: dětský pokoj' });
assert.strictEqual(res.success, true);

const seed = {
  floors: [{ id: '1_patro', name: '1 Patro' }],
  rooms: [
    { id: 'living_room', name: 'Living Room', area_id: 'obyvak', floor_id: '1_patro', notes: 'Polycam label Living Room' },
    { id: 'other_1', name: 'Other 1', area_id: 'loznice', floor_id: '1_patro', notes: 'Polycam: pokoj s postelí' },
    { id: 'other_2', name: 'Other 2', floor_id: '1_patro', notes: 'Polycam nejasná místnost bez potvrzeného area_id' },
  ],
  adjacency: [
    { from: 'living_room', to: 'other_1', type: 'průchod' },
    { from: 'living_room', to: 'other_2', type: 'dveře' },
  ],
  items: [
    { room_id: 'living_room', name: 'pohovka' },
    { room_id: 'other_2', name: 'skříň' },
  ],
};
const customerRooms = [
  { area_id: 'obyvak', name: 'Obývák', aliases: ['obývací pokoj'], floor_id: '1_patro' },
  { area_id: 'loznice', name: 'Ložnice', aliases: ['pokoj s postelí'], floor_id: '1_patro' },
];

let proposal = prepareHouseMapSeed(seed, customerRooms);
assert.strictEqual(proposal.rooms.length, 2, 'only confirmed/customer rooms should be matched');
assert.strictEqual(proposal.rooms.find(r => r.area_id === 'obyvak').name, 'Obývák', 'customer name wins over Polycam label');
assert.strictEqual(proposal.items.length, 1, 'items in unresolved rooms are dropped');
assert.strictEqual(proposal.review.unresolved.length, 1, 'unclear Polycam room remains for review');
assert.strictEqual(proposal.review.ready_to_apply, false, 'unresolved room blocks apply');

res = applyHouseMapAction(file, { action: 'prepare_seed', seed, customer_rooms: customerRooms });
assert.strictEqual(res.success, true);
assert.strictEqual(res.proposal.rooms.length, 2);
res = applyHouseMapAction(file, { action: 'apply_seed', seed, customer_rooms: customerRooms });
assert.ok(res.error.includes('confirmed:true'), 'apply_seed requires explicit confirmation');
res = applyHouseMapAction(file, { action: 'apply_seed', seed, customer_rooms: customerRooms, confirmed: true });
assert.ok(res.error.includes('Seed nelze bezpečně zapsat'), 'apply_seed refuses unresolved rooms');

const safeSeed = {
  ...seed,
  rooms: seed.rooms.slice(0, 2),
  adjacency: seed.adjacency.slice(0, 1),
  items: seed.items.slice(0, 1),
};
res = applyHouseMapAction(file, { action: 'apply_seed', seed: safeSeed, customer_rooms: customerRooms, confirmed: true });
assert.strictEqual(res.success, true);
assert.strictEqual(res.map.rooms.length, 3, 'apply_seed merges into existing map instead of replacing it');
assert.strictEqual(res.map.rooms.find(r => r.area_id === 'obyvak').name, 'Obývák');
assert.strictEqual(res.map.adjacency.length, 2);
assert.strictEqual(res.map.items[0].room_id, 'obyvak');
assert.ok(res.map.rooms.find(r => r.area_id === 'loznice').notes.includes('Alternativní názvy'), 'seed must preserve existing room notes');

fs.rmSync(tmp, { recursive: true, force: true });
console.log('house map contract OK');
