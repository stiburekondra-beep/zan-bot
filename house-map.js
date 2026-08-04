'use strict';

const fs = require('fs');
const path = require('path');

const VALID_EDGE_TYPES = new Set(['dveře', 'průchod', 'schody', 'sousedí']);

function emptyHouseMap() {
  return {
    version: 1,
    updated_at: new Date().toISOString(),
    note: 'Mapa domu je znalostní model. Místnosti mají odkazovat na HA area_id; sousednost bez potvrzení nevymýšlet.',
    floors: [],
    rooms: [],
    adjacency: [],
    items: [],
  };
}

function slugify(value, fallback = 'item') {
  return String(value || fallback)
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 72) || fallback;
}

function readMap(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let map;
  try {
    if (fs.existsSync(file)) map = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {}
  if (!map || !Array.isArray(map.rooms) || !Array.isArray(map.adjacency) || !Array.isArray(map.items)) {
    map = emptyHouseMap();
    fs.writeFileSync(file, JSON.stringify(map, null, 2), 'utf8');
  }
  if (!Array.isArray(map.floors)) map.floors = [];
  map.rooms = map.rooms.map(normalizeRoom);
  map.adjacency = map.adjacency.map(normalizeEdge).filter(Boolean);
  map.items = map.items.map(normalizeItem);
  return map;
}

function saveMap(file, map) {
  const next = {
    ...map,
    version: 1,
    updated_at: new Date().toISOString(),
  };
  fs.writeFileSync(file, JSON.stringify(next, null, 2), 'utf8');
  return next;
}

function normalizeRoom(room) {
  const id = slugify(room.id || room.area_id || room.name, 'room');
  return {
    id,
    name: String(room.name || room.area_name || id),
    area_id: String(room.area_id || id),
    floor_id: room.floor_id ? String(room.floor_id) : '',
    notes: room.notes ? String(room.notes) : '',
  };
}

function ensureFloor(map, floorId, floorName = '') {
  if (!floorId) return;
  if (!map.floors.some(f => f.id === floorId)) {
    map.floors.push({ id: floorId, name: floorName || floorId });
  }
}

function normalizeEdge(edge) {
  const from = slugify(edge.from || edge.room_a || edge.a, '');
  const to = slugify(edge.to || edge.room_b || edge.b, '');
  if (!from || !to || from === to) return null;
  const sorted = [from, to].sort();
  const type = VALID_EDGE_TYPES.has(edge.type) ? edge.type : 'sousedí';
  return {
    from: sorted[0],
    to: sorted[1],
    type,
    notes: edge.notes ? String(edge.notes) : '',
  };
}

function normalizeItem(item) {
  const roomId = slugify(item.room_id || item.room || '', '');
  const name = String(item.name || item.item || 'věc');
  return {
    id: slugify(item.id || `${roomId}_${name}`, 'item'),
    name,
    room_id: roomId,
    notes: item.notes ? String(item.notes) : '',
  };
}

function roomExists(map, roomId) {
  return map.rooms.some(r => r.id === roomId);
}

function applyHouseMapAction(file, input = {}) {
  const action = String(input.action || 'get');
  const map = readMap(file);

  if (action === 'get') {
    const roomId = input.room_id ? slugify(input.room_id, '') : '';
    if (roomId) {
      const room = map.rooms.find(r => r.id === roomId || slugify(r.name, '') === roomId || r.area_id === roomId);
      if (!room) return { error: `Místnost "${input.room_id}" v mapě domu není.`, map_file: file };
      const neighbors = map.adjacency
        .filter(e => e.from === room.id || e.to === room.id)
        .map(e => ({ room_id: e.from === room.id ? e.to : e.from, type: e.type, notes: e.notes }));
      return {
        map_file: file,
        room,
        neighbors,
        items: map.items.filter(i => i.room_id === room.id),
      };
    }
    return {
      map_file: file,
      count: { floors: map.floors.length, rooms: map.rooms.length, adjacency: map.adjacency.length, items: map.items.length },
      floors: map.floors,
      rooms: map.rooms,
      adjacency: map.adjacency,
      items: map.items,
    };
  }

  if (action === 'set_room') {
    if (!input.name || !input.area_id) {
      return { error: 'set_room potřebuje name a area_id z Home Assistant area registry.' };
    }
    const room = normalizeRoom(input);
    ensureFloor(map, room.floor_id, input.floor_name);
    const idx = map.rooms.findIndex(r => r.id === room.id || r.area_id === room.area_id);
    if (idx >= 0) map.rooms[idx] = { ...map.rooms[idx], ...room };
    else map.rooms.push(room);
    return { success: true, room, map: saveMap(file, map) };
  }

  if (action === 'set_adjacency') {
    const edge = normalizeEdge(input);
    if (!edge) return { error: 'set_adjacency potřebuje dvě různé místnosti: from a to.' };
    if (!roomExists(map, edge.from) || !roomExists(map, edge.to)) {
      return { error: 'Sousednost jde uložit jen mezi místnostmi, které už jsou v house_map.' };
    }
    const idx = map.adjacency.findIndex(e => e.from === edge.from && e.to === edge.to);
    if (idx >= 0) map.adjacency[idx] = { ...map.adjacency[idx], ...edge };
    else map.adjacency.push(edge);
    return { success: true, adjacency: edge, map: saveMap(file, map) };
  }

  if (action === 'add_item') {
    const item = normalizeItem(input);
    if (!item.room_id || !roomExists(map, item.room_id)) {
      return { error: 'add_item potřebuje room_id existující místnosti v house_map.' };
    }
    const idx = map.items.findIndex(i => i.id === item.id);
    if (idx >= 0) map.items[idx] = { ...map.items[idx], ...item };
    else map.items.push(item);
    return { success: true, item, map: saveMap(file, map) };
  }

  if (action === 'remove_item') {
    const id = slugify(input.item_id || input.id || input.name, '');
    if (!id) return { error: 'remove_item potřebuje item_id nebo name.' };
    const before = map.items.length;
    map.items = map.items.filter(i => i.id !== id && slugify(i.name, '') !== id);
    return { success: true, removed: before - map.items.length, map: saveMap(file, map) };
  }

  return { error: `Neznámá akce house_map: ${action}` };
}

function formatHouseMap(file, input = {}) {
  const data = applyHouseMapAction(file, { action: 'get', room_id: input.room_id });
  if (data.error) return data.error;
  if (data.room) {
    const namesById = new Map(readMap(file).rooms.map(r => [r.id, r.name]));
    const neighbors = data.neighbors.map(n => `${namesById.get(n.room_id) || n.room_id} (${n.type})`).join(', ') || 'nezadané';
    const items = data.items.map(i => i.name).join(', ') || 'nezadané';
    return [`${data.room.name}`, `HA area_id: ${data.room.area_id}`, `Sousedí: ${neighbors}`, `Věci: ${items}`].join('\n');
  }
  const rows = data.rooms.map(r => {
    const items = data.items.filter(i => i.room_id === r.id).map(i => i.name).join(', ') || 'bez věcí';
    return `- ${r.name} (${r.area_id}): ${items}`;
  });
  return [`Mapa domu: ${data.count.rooms} místností, ${data.count.adjacency} vazeb, ${data.count.items} věcí.`, ...rows].join('\n');
}

module.exports = {
  applyHouseMapAction,
  formatHouseMap,
  readMap,
};
