'use strict';

const fs = require('fs');
const path = require('path');

const VALID_EDGE_TYPES = new Set(['dveře', 'průchod', 'schody', 'sousedí']);
const DEFAULT_SEED_MATCH_THRESHOLD = 0.72;

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

function normalizedText(value) {
  return String(value || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function textTokens(value) {
  const stop = new Set(['polycam', 'other', 'room', 'mistnost', 'patro', 'velka', 'mala']);
  return normalizedText(value).split(/\s+/).filter(t => t.length >= 3 && !stop.has(t));
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function normalizeCustomerRoom(room = {}) {
  const areaId = String(room.area_id || room.id || '').trim();
  const name = String(room.name || room.area_name || areaId).trim();
  const aliases = Array.isArray(room.aliases) ? room.aliases.map(a => String(a || '').trim()).filter(Boolean) : [];
  return {
    id: slugify(room.id || areaId || name, 'room'),
    name,
    area_id: areaId || slugify(name, 'room'),
    floor_id: room.floor_id ? String(room.floor_id) : '',
    floor_name: room.floor_name ? String(room.floor_name) : '',
    aliases,
  };
}

function customerRoomLabels(room) {
  return unique([room.id, room.area_id, room.name, ...(room.aliases || [])]);
}

function seedRoomLabels(room = {}) {
  return unique([
    room.id,
    room.area_id,
    room.name,
    room.polycam_label,
    ...(Array.isArray(room.aliases) ? room.aliases : []),
    room.notes,
  ].map(v => String(v || '')));
}

function tokenOverlapScore(seedLabels, customerLabels) {
  const seedTokens = new Set(seedLabels.flatMap(textTokens));
  const customerTokens = new Set(customerLabels.flatMap(textTokens));
  if (!seedTokens.size || !customerTokens.size) return 0;
  let overlap = 0;
  for (const token of seedTokens) if (customerTokens.has(token)) overlap += 1;
  return overlap / Math.max(seedTokens.size, customerTokens.size);
}

function scoreSeedRoomMatch(seedRoom, customerRoom) {
  const seedLabels = seedRoomLabels(seedRoom);
  const customerLabels = customerRoomLabels(customerRoom);
  const seedIds = seedLabels.map(v => slugify(v, ''));
  const customerIds = customerLabels.map(v => slugify(v, ''));

  if (seedRoom.area_id && customerRoom.area_id && String(seedRoom.area_id) === String(customerRoom.area_id)) {
    return { score: 1, reason: 'area_id exact' };
  }
  if (seedRoom.id && customerRoom.id && slugify(seedRoom.id, '') === slugify(customerRoom.id, '')) {
    return { score: 0.98, reason: 'room id exact' };
  }
  if (seedIds.some(id => id && customerIds.includes(id))) {
    return { score: 0.94, reason: 'name/alias exact' };
  }

  const overlap = tokenOverlapScore(seedLabels, customerLabels);
  if (overlap > 0) return { score: Math.min(0.88, overlap), reason: 'name/alias token overlap' };
  return { score: 0, reason: 'no match' };
}

function bestSeedRoomMatch(seedRoom, customerRooms) {
  let best = null;
  const scoredAll = [];
  for (const candidate of customerRooms) {
    const scored = scoreSeedRoomMatch(seedRoom, candidate);
    const entry = { ...candidate, ...scored };
    scoredAll.push(entry);
    if (!best || scored.score > best.score) best = entry;
  }
  if (!best) return { score: 0, reason: 'no customer rooms', tied_candidates: [] };
  // Remíza: kolik DALŠÍCH zákaznických místností (jiné area_id) dosahuje shodně
  // nejvyššího skóre. Když aspoň jedna → seed místnost nejde jednoznačně napasovat
  // a nesmí se tiše vybrat první (jinak druhá stejnojmenná místnost zmizí bez stopy).
  const tied = scoredAll.filter(e => String(e.area_id) !== String(best.area_id) && Math.abs(e.score - best.score) < 1e-9);
  return { ...best, tied_candidates: tied.map(e => ({ area_id: e.area_id, name: e.name, score: Number(e.score.toFixed(2)) })) };
}

function prepareHouseMapSeed(seed = {}, customerRooms = [], opts = {}) {
  const threshold = Number.isFinite(Number(opts.threshold)) ? Number(opts.threshold) : DEFAULT_SEED_MATCH_THRESHOLD;
  const sourceRooms = Array.isArray(seed.rooms) ? seed.rooms : [];
  const customers = customerRooms.map(normalizeCustomerRoom).filter(r => r.area_id && r.name);
  const floors = Array.isArray(seed.floors) ? seed.floors.map(f => ({ id: String(f.id || f.floor_id || ''), name: String(f.name || f.id || '') })).filter(f => f.id) : [];
  const matchBySeedId = new Map();
  const matchedAreaIds = new Set();
  const unresolved = [];
  const rooms = [];

  for (const room of sourceRooms) {
    const match = bestSeedRoomMatch(room, customers);
    const tiedCount = Array.isArray(match.tied_candidates) ? match.tied_candidates.length : 0;
    const ambiguous = match.score >= threshold && tiedCount >= 1;
    if (match.score >= threshold && !matchedAreaIds.has(match.area_id) && !ambiguous) {
      const roomId = slugify(match.area_id, 'room');
      matchedAreaIds.add(match.area_id);
      matchBySeedId.set(slugify(room.id || room.area_id || room.name, ''), roomId);
      rooms.push({
        id: roomId,
        name: match.name,
        area_id: match.area_id,
        floor_id: match.floor_id || room.floor_id || '',
        notes: unique([
          `Zdroj: zákazníkův/HA název místnosti. Polycam byl použit jen jako fallback (${match.reason}, jistota ${match.score.toFixed(2)}).`,
          room.notes ? `Polycam poznámka: ${room.notes}` : '',
        ]).join(' '),
      });
    } else {
      unresolved.push({
        polycam_id: room.id || '',
        polycam_name: room.name || '',
        polycam_area_id: room.area_id || '',
        best_customer_room: match.area_id ? { area_id: match.area_id, name: match.name, score: Number(match.score.toFixed(2)), reason: match.reason } : null,
        reason: ambiguous
          ? `ambiguous: ${tiedCount + 1} candidates tied at score ${match.score.toFixed(2)}`
          : (matchedAreaIds.has(match.area_id) ? 'customer room already used' : 'below confidence threshold'),
        tied_candidates: ambiguous
          ? [{ area_id: match.area_id, name: match.name, score: Number(match.score.toFixed(2)) }, ...match.tied_candidates]
          : undefined,
      });
    }
  }

  const adjacency = [];
  const droppedAdjacency = [];
  for (const edge of Array.isArray(seed.adjacency) ? seed.adjacency : []) {
    const normalized = normalizeEdge(edge);
    if (!normalized) continue;
    const from = matchBySeedId.get(normalized.from);
    const to = matchBySeedId.get(normalized.to);
    if (from && to && from !== to) {
      const sorted = [from, to].sort();
      const next = { from: sorted[0], to: sorted[1], type: normalized.type, notes: normalized.notes };
      if (!adjacency.some(e => e.from === next.from && e.to === next.to)) adjacency.push(next);
    } else {
      droppedAdjacency.push({ ...normalized, reason: 'unmatched room' });
    }
  }

  const items = [];
  const droppedItems = [];
  for (const item of Array.isArray(seed.items) ? seed.items : []) {
    const normalized = normalizeItem(item);
    const roomId = matchBySeedId.get(normalized.room_id);
    if (roomId) items.push({ ...normalized, id: slugify(`${roomId}_${normalized.name}`, 'item'), room_id: roomId });
    else droppedItems.push({ ...normalized, reason: 'unmatched room' });
  }

  return {
    version: 1,
    updated_at: new Date().toISOString(),
    note: 'Připraveno z Polycam seedu. Autoritou pro názvy a area_id jsou zákazníkovy/HA místnosti; Polycam názvy jsou jen fallback a poznámka.',
    floors,
    rooms,
    adjacency,
    items,
    review: {
      threshold,
      customer_rooms: customers.length,
      source_rooms: sourceRooms.length,
      matched_rooms: rooms.length,
      unresolved,
      dropped_adjacency: droppedAdjacency,
      dropped_items: droppedItems,
      ready_to_apply: unresolved.length === 0 && rooms.length > 0,
    },
  };
}

function mergeNotes(a, b) {
  return unique([a, b].map(v => String(v || '').trim())).join(' ');
}

function mergePreparedHouseMap(currentMap, prepared) {
  const next = {
    ...currentMap,
    floors: Array.isArray(currentMap.floors) ? [...currentMap.floors] : [],
    rooms: Array.isArray(currentMap.rooms) ? [...currentMap.rooms] : [],
    adjacency: Array.isArray(currentMap.adjacency) ? [...currentMap.adjacency] : [],
    items: Array.isArray(currentMap.items) ? [...currentMap.items] : [],
  };

  for (const floor of prepared.floors || []) {
    if (!next.floors.some(f => f.id === floor.id)) next.floors.push(floor);
  }

  for (const room of prepared.rooms || []) {
    const idx = next.rooms.findIndex(r => r.id === room.id || r.area_id === room.area_id);
    if (idx >= 0) {
      next.rooms[idx] = {
        ...next.rooms[idx],
        ...room,
        notes: mergeNotes(next.rooms[idx].notes, room.notes),
      };
    } else {
      next.rooms.push(room);
    }
  }

  for (const edge of prepared.adjacency || []) {
    if (!next.adjacency.some(e => e.from === edge.from && e.to === edge.to)) next.adjacency.push(edge);
  }

  for (const item of prepared.items || []) {
    const idx = next.items.findIndex(i => i.id === item.id);
    if (idx >= 0) {
      next.items[idx] = {
        ...next.items[idx],
        ...item,
        notes: mergeNotes(next.items[idx].notes, item.notes),
      };
    } else {
      next.items.push(item);
    }
  }

  return next;
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

  if (action === 'prepare_seed' || action === 'apply_seed') {
    const prepared = prepareHouseMapSeed(input.seed || {}, input.customer_rooms || [], { threshold: input.threshold });
    if (action === 'prepare_seed') return { success: true, proposal: prepared };
    if (!input.confirmed) {
      return { error: 'apply_seed vyžaduje confirmed:true po lidské kontrole návrhu.', proposal: prepared };
    }
    if (!prepared.review.ready_to_apply) {
      return { error: 'Seed nelze bezpečně zapsat: návrh má nevyřešené místnosti nebo žádný match.', proposal: prepared };
    }
    return { success: true, map: saveMap(file, mergePreparedHouseMap(map, prepared)), review: prepared.review };
  }

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
  mergePreparedHouseMap,
  prepareHouseMapSeed,
  readMap,
};
