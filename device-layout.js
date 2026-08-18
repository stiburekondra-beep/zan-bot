'use strict';

const ZIGBEE_RE = /zigbee|zha|z2m|zigbee2mqtt|aqara|lumi|ikea|tradfri|sonoff.*zb|zbbridge|conbee|skyconnect|silicon labs|silabs|ezsp|\bzb[-_\s]?\w*/i;
const WIFI_RE = /wifi|wi-fi|wlan|tapo|shelly|esphome|tuya|ewelink|sonoff|yeelight|wiz/i;
const MATTER_RE = /matter|thread/i;
const BRIDGE_RE = /bridge|coordinator|hub|gateway|zbbridge|zigbee2mqtt|zha/i;

// Zigbee LQI je 0–255 (Z2M `linkquality`, ZHA LQI diagnostika). Pod prahem = slabý spoj.
// Konzervativně 50: nižší číslo hlásíme jako slabý signál (kandidát na router), ať
// nefalšujeme poplach u zařízení, které jen o kousek klesne. Neznámé LQI = mlčet.
const WEAK_LQI_THRESHOLD = 50;
const LQI_ATTR_KEYS = ['linkquality', 'link_quality', 'lqi'];
const LQI_ENTITY_RE = /(_|\.)(lqi|linkquality|link_quality)$/i;

// Přečti LQI (sílu Zigbee spoje) z atributů entit zařízení, případně z diagnostické
// entity `*_lqi`/`*_linkquality`. Vrací celé číslo 0–255 nebo null (neznámé → nefabulovat).
function extractLqi(entities = [], statesById) {
  const values = [];
  for (const entity of entities) {
    const state = statesById?.get(entity.entity_id);
    if (!state) continue;
    const attrs = state.attributes || {};
    for (const key of LQI_ATTR_KEYS) {
      const n = Number(attrs[key]);
      if (Number.isFinite(n) && n >= 0 && n <= 255) values.push(n);
    }
    if (LQI_ENTITY_RE.test(entity.entity_id) && !isUnavailableState(state)) {
      const n = Number(state.state);
      if (Number.isFinite(n) && n >= 0 && n <= 255) values.push(n);
    }
  }
  if (!values.length) return null;
  // Zařízení může mít víc entit se stejným LQI; vezmi nejnižší (nejhorší spoj).
  return Math.min(...values);
}

function stateAgeMs(state, now = Date.now()) {
  const t = Date.parse(state?.last_changed || state?.last_updated || '');
  return Number.isFinite(t) ? Math.max(0, now - t) : Infinity;
}

function formatAge(ms) {
  if (!Number.isFinite(ms)) return 'neznámě dlouho';
  const mins = Math.max(1, Math.round(ms / 60000));
  if (mins < 90) return `${mins} min`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours} h`;
  return `${Math.round(hours / 24)} d`;
}

function isUnavailableState(state) {
  return state && (state.state === 'unavailable' || state.state === 'unknown');
}

function words(...parts) {
  return parts
    .flat()
    .filter(Boolean)
    .map(v => Array.isArray(v) ? v.join(' ') : String(v))
    .join(' ');
}

function integrationNames(device = {}) {
  return (device.identifiers || [])
    .map(i => Array.isArray(i) ? i[0] : i)
    .filter(Boolean)
    .map(String);
}

function inferTransport(device = {}, entities = []) {
  const hay = words(
    device.name,
    device.name_by_user,
    device.manufacturer,
    device.model,
    integrationNames(device),
    entities.map(e => e.entity_id),
    entities.map(e => e.name || e.original_name),
  );
  if (MATTER_RE.test(hay)) return 'matter';
  if (ZIGBEE_RE.test(hay)) return 'zigbee';
  if (WIFI_RE.test(hay)) return 'wifi';
  return 'unknown';
}

function makeAreaMaps(areaRegistry = [], houseMap = {}) {
  const areaNameById = new Map((Array.isArray(areaRegistry) ? areaRegistry : []).map(a => [a.area_id, a.name || a.area_id]));
  const roomByArea = new Map((houseMap.rooms || []).map(r => [r.area_id, { id: r.id, name: r.name, floor_id: r.floor_id || '' }]));
  return { areaNameById, roomByArea };
}

function summarizeDevice({ device, entities, statesById, areaNameById, roomByArea, now, minAgeMs, bridgeDeviceIds }) {
  const entityStates = entities
    .map(entity => {
      const state = statesById.get(entity.entity_id);
      return {
        entity_id: entity.entity_id,
        name: entity.name || entity.original_name || state?.attributes?.friendly_name || entity.entity_id,
        domain: entity.entity_id.split('.')[0],
        state: state?.state || 'missing',
        unavailable: isUnavailableState(state),
        age_ms: state ? stateAgeMs(state, now) : Infinity,
        disabled: !!entity.disabled_by,
      };
    })
    .filter(e => !e.disabled);

  const unavailableEntities = entityStates
    .filter(e => e.unavailable && e.age_ms >= minAgeMs)
    .sort((a, b) => b.age_ms - a.age_ms);

  const areaId = device.area_id || entities.find(e => e.area_id)?.area_id || null;
  const room = areaId ? roomByArea.get(areaId) : null;
  const transport = inferTransport(device, entities);
  const name = device.name_by_user || device.name || entities[0]?.name || entities[0]?.original_name || device.id || 'Neznámé zařízení';
  const bridgeLike = bridgeDeviceIds?.has(device.id) || BRIDGE_RE.test(words(name, device.manufacturer, device.model));
  // LQI čteme jen u Zigbee zařízení, která nejsou sama bridge/koordinátor.
  const lqi = transport === 'zigbee' && !bridgeLike ? extractLqi(entities, statesById) : null;

  return {
    device_id: device.id || null,
    name,
    manufacturer: device.manufacturer || '',
    model: device.model || '',
    integration: integrationNames(device).join(', '),
    via_device_id: device.via_device_id || '',
    area_id: areaId,
    area_name: areaId ? (areaNameById.get(areaId) || areaId) : 'Bez místnosti',
    room_id: room?.id || '',
    room_name: room?.name || '',
    transport,
    bridge_like: bridgeLike,
    lqi,
    lqi_weak: Number.isFinite(lqi) && lqi < WEAK_LQI_THRESHOLD,
    entity_count: entityStates.length,
    unavailable_count: unavailableEntities.length,
    unavailable_entities: unavailableEntities.map(e => ({
      entity_id: e.entity_id,
      name: e.name,
      state: e.state,
      age_ms: e.age_ms,
      age: formatAge(e.age_ms),
    })),
  };
}

function fallbackEntityDevices({ states = [], areaNameById, roomByArea, now, minAgeMs }) {
  return states
    .filter(s => !['zone', 'sun', 'device_tracker', 'update', 'person', 'persistent_notification', 'weather'].includes(s.entity_id.split('.')[0]))
    .map(s => {
      const areaId = s.attributes?.area_id || null;
      const room = areaId ? roomByArea.get(areaId) : null;
      const ageMs = stateAgeMs(s, now);
      const transport = inferTransport({}, [{ entity_id: s.entity_id, name: s.attributes?.friendly_name }]);
      const bridgeLike = BRIDGE_RE.test(s.attributes?.friendly_name || s.entity_id);
      const statesById = new Map([[s.entity_id, s]]);
      const lqi = transport === 'zigbee' && !bridgeLike
        ? extractLqi([{ entity_id: s.entity_id }], statesById)
        : null;
      return {
        device_id: null,
        name: s.attributes?.friendly_name || s.entity_id,
        manufacturer: '',
        model: '',
        integration: '',
        area_id: areaId,
        area_name: areaId ? (areaNameById.get(areaId) || areaId) : 'Bez místnosti',
        room_id: room?.id || '',
        room_name: room?.name || '',
        transport,
        bridge_like: bridgeLike,
        lqi,
        lqi_weak: Number.isFinite(lqi) && lqi < WEAK_LQI_THRESHOLD,
        entity_count: 1,
        unavailable_count: isUnavailableState(s) && ageMs >= minAgeMs ? 1 : 0,
        unavailable_entities: isUnavailableState(s) && ageMs >= minAgeMs ? [{
          entity_id: s.entity_id,
          name: s.attributes?.friendly_name || s.entity_id,
          state: s.state,
          age_ms: ageMs,
          age: formatAge(ageMs),
        }] : [],
      };
    });
}

function diagnose(devices) {
  const unavailable = devices.filter(d => d.unavailable_count > 0);
  const bridgeDown = unavailable.filter(d => d.bridge_like || (d.transport === 'zigbee' && /bridge|coordinator|hub|gateway/i.test(d.name)));
  const zigbeeUnavailable = unavailable.filter(d => d.transport === 'zigbee' && !bridgeDown.includes(d));
  const byArea = new Map();
  for (const d of zigbeeUnavailable) {
    const key = d.area_name || 'Bez místnosti';
    if (!byArea.has(key)) byArea.set(key, []);
    byArea.get(key).push(d);
  }

  const recommendations = [];
  if (bridgeDown.length > 0) {
    recommendations.push({
      type: 'bridge_down_first',
      severity: 'warning',
      title: 'Nejdřív ověř Zigbee bridge/koordinátor',
      detail: `Nedostupný je ${bridgeDown.map(d => d.name).slice(0, 3).join(', ')}. Dokud nekomunikuje bridge, návrh "kup Zigbee router" je špatná rada.`,
      next_step: 'Zkontrolovat napájení a síť bridge; případně ho fyzicky restartovat. Re-pair koncových zařízení až potom.',
    });
  }

  for (const [areaName, areaDevices] of byArea.entries()) {
    if (areaDevices.length < 2 || bridgeDown.length > 0) continue;
    recommendations.push({
      type: 'zigbee_mesh_candidate',
      severity: 'info',
      title: `Opakovaný Zigbee výpadek v zóně ${areaName}`,
      detail: `${areaDevices.length} Zigbee zařízení jsou nedostupná déle než práh a bridge není v datech označený jako nedostupný.`,
      next_step: 'Navrhnout Zigbee router/napájenou zásuvku mezi bridge a zónu, ale až po ověření, že bridge běží.',
      devices: areaDevices.map(d => d.name),
    });
  }

  // Slabý signál z MĚŘENÉHO LQI (ne z dead-device vzorce). Jen když bridge běží
  // — u mrtvého bridge má přednost bridge_down_first (nekupovat router naslepo).
  const weakSignal = devices.filter(d => d.transport === 'zigbee' && d.lqi_weak);
  if (bridgeDown.length === 0 && weakSignal.length > 0) {
    const weakByArea = new Map();
    for (const d of weakSignal) {
      const key = d.room_name || d.area_name || 'Bez místnosti';
      if (!weakByArea.has(key)) weakByArea.set(key, []);
      weakByArea.get(key).push(d);
    }
    for (const [areaName, areaDevices] of weakByArea.entries()) {
      const worst = Math.min(...areaDevices.map(d => d.lqi));
      recommendations.push({
        type: 'zigbee_weak_signal',
        severity: 'info',
        title: `Slabý Zigbee signál v zóně ${areaName}`,
        detail: `${areaDevices.length} Zigbee zařízení má slabý spoj (nejnižší LQI ${worst}/255, práh ${WEAK_LQI_THRESHOLD}). Zařízení odpovídá, ale spoj je na hraně.`,
        next_step: `Zvážit Zigbee router/napájenou zásuvku mezi bridge a zónu ${areaName} pro posílení meshe. Read-only doporučení, nekupovat bez potvrzení.`,
        devices: areaDevices.map(d => ({ name: d.name, lqi: d.lqi })),
      });
    }
  }

  if (unavailable.length > 0 && recommendations.length === 0) {
    recommendations.push({
      type: 'check_device_or_integration',
      severity: 'info',
      title: 'Zkontrolovat konkrétní zařízení nebo integraci',
      detail: 'Vidím nedostupná zařízení, ale data zatím neukazují jasný společný Zigbee mesh problém.',
      next_step: 'Ověřit napájení, integraci a poslední změny; fyzický reset nebo párování jen po potvrzení člověka.',
    });
  }

  return { unavailable, bridge_down: bridgeDown, zigbee_unavailable: zigbeeUnavailable, weak_signal: weakSignal, recommendations };
}

function buildDeviceLayoutSnapshot(input = {}) {
  const states = Array.isArray(input.states) ? input.states : [];
  const entityRegistry = Array.isArray(input.entityRegistry) ? input.entityRegistry : [];
  const deviceRegistry = Array.isArray(input.deviceRegistry) ? input.deviceRegistry : [];
  const areaRegistry = Array.isArray(input.areaRegistry) ? input.areaRegistry : [];
  const houseMap = input.houseMap || {};
  const now = input.now || Date.now();
  const minAgeMs = input.minAgeMs || 60 * 60 * 1000;
  const statesById = new Map(states.map(s => [s.entity_id, s]));
  const { areaNameById, roomByArea } = makeAreaMaps(areaRegistry, houseMap);

  let devices;
  if (deviceRegistry.length > 0) {
    const entityByDevice = new Map();
    for (const e of entityRegistry) {
      if (!e.device_id) continue;
      if (!entityByDevice.has(e.device_id)) entityByDevice.set(e.device_id, []);
      entityByDevice.get(e.device_id).push(e);
    }
    const bridgeDeviceIds = new Set();
    for (const device of deviceRegistry) {
      if (!device.via_device_id) continue;
      const entities = entityByDevice.get(device.id) || [];
      if (inferTransport(device, entities) === 'zigbee') bridgeDeviceIds.add(device.via_device_id);
    }
    devices = deviceRegistry
      .map(device => summarizeDevice({
        device,
        entities: entityByDevice.get(device.id) || [],
        statesById,
        areaNameById,
        roomByArea,
        now,
        minAgeMs,
        bridgeDeviceIds,
      }))
      .filter(d => d.entity_count > 0 || d.area_id || d.name !== 'Neznámé zařízení');
  } else {
    devices = fallbackEntityDevices({ states, areaNameById, roomByArea, now, minAgeMs });
  }

  const diagnosis = diagnose(devices);
  return {
    generated_at: new Date(now).toISOString(),
    min_age_ms: minAgeMs,
    counts: {
      devices: devices.length,
      unavailable_devices: diagnosis.unavailable.length,
      zigbee_unavailable: diagnosis.zigbee_unavailable.length,
      bridge_down: diagnosis.bridge_down.length,
      zigbee_weak_signal: diagnosis.weak_signal.length,
      rooms_from_house_map: Array.isArray(houseMap.rooms) ? houseMap.rooms.length : 0,
    },
    devices,
    diagnosis,
    safety: 'Read-only diagnostika: stav čtu z HA. Zigbee párování, fyzický reset ani ovládání rizikových zařízení se nespouští samo.',
  };
}

function formatDeviceLayout(snapshot, opts = {}) {
  const scope = opts.scope || 'summary';
  const lines = [
    `Layout zařízení: ${snapshot.counts.devices} zařízení; ${snapshot.counts.unavailable_devices} nedostupných déle než ${formatAge(snapshot.min_age_ms)}.`,
  ];

  if (snapshot.counts.rooms_from_house_map === 0) {
    lines.push('Mapa domu zatím nemá místnosti; používám HA oblasti, ne domýšlený půdorys.');
  }

  const list = scope === 'all' ? snapshot.devices : snapshot.diagnosis.unavailable;
  for (const d of list.slice(0, 20)) {
    const place = d.room_name || d.area_name || 'bez místnosti';
    const hw = [d.manufacturer, d.model].filter(Boolean).join(' ');
    const un = d.unavailable_entities.map(e => `${e.name} ${e.age}`).join(', ');
    const sig = Number.isFinite(d.lqi) ? `, signál LQI ${d.lqi}/255${d.lqi_weak ? ' (slabý)' : ''}` : '';
    lines.push(`- ${d.name} (${place}, ${d.transport}${hw ? `, ${hw}` : ''}${sig})${un ? `: nedostupné ${un}` : ''}`);
  }

  if (snapshot.diagnosis.recommendations.length > 0) {
    lines.push('Doporučení:');
    for (const r of snapshot.diagnosis.recommendations.slice(0, 5)) {
      lines.push(`- ${r.title}: ${r.next_step}`);
    }
  }

  lines.push(snapshot.safety);
  return lines.join('\n');
}

module.exports = {
  buildDeviceLayoutSnapshot,
  formatDeviceLayout,
  inferTransport,
};
