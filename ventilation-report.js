const REQUIRED_MODBUS_FIELDS = ['manufacturer', 'model', 'connection', 'register_map'];
const CO2_KEYWORDS = ['co2', 'co_2', 'carbon dioxide', 'oxid uhlicity', 'oxid uhličitý'];
const VENTILATION_KEYWORDS = ['rekuperace', 'ventilation', 'vzduchotechnika', 'vetrani', 'větrání', 'airflow', 'filter', 'filtr'];

function normalizeText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function asNumber(value) {
  if (value === null || value === undefined) return null;
  const n = Number(String(value).replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

function entityText(entity = {}) {
  const attrs = entity.attributes || {};
  return [
    entity.entity_id,
    entity.name,
    entity.friendly_name,
    attrs.friendly_name,
    attrs.device_class,
    attrs.unit_of_measurement,
    attrs.icon,
  ].join(' ');
}

function isCo2Entity(entity = {}) {
  const text = normalizeText(entityText(entity));
  const unit = normalizeText(entity.attributes && entity.attributes.unit_of_measurement);
  return unit.includes('ppm') && CO2_KEYWORDS.some(k => text.includes(normalizeText(k)));
}

function isVentilationEntity(entity = {}) {
  const text = normalizeText(entityText(entity));
  return VENTILATION_KEYWORDS.some(k => text.includes(normalizeText(k)));
}

function classifyCo2Location(entity = {}) {
  const text = normalizeText(entityText(entity));
  if (['outside', 'venku', 'exterier', 'exteriér', 'outdoor', 'fresh', 'privod', 'přívod', 'supply'].some(k => text.includes(normalizeText(k)))) {
    return 'outside_or_supply';
  }
  if (['inside', 'interier', 'interiér', 'indoor', 'mistnost', 'místnost', 'obyvak', 'obývák', 'odvod', 'return', 'extract'].some(k => text.includes(normalizeText(k)))) {
    return 'inside_or_extract';
  }
  return 'unknown';
}

function summarizeCo2(entities = []) {
  const co2 = entities
    .filter(isCo2Entity)
    .map(entity => ({
      entity_id: entity.entity_id,
      name: (entity.attributes && entity.attributes.friendly_name) || entity.name || entity.entity_id,
      ppm: asNumber(entity.state),
      location: classifyCo2Location(entity),
    }))
    .filter(item => item.ppm !== null);

  if (co2.length === 0) {
    return {
      status: 'missing_sensor',
      message: 'Nemám ověřené CO2 čidlo. Bez něj nesmím počítat účinnost ani tvrdit, že rekuperace větrá dobře.',
      needs: ['CO2 čidlo v obytné části', 'ideálně druhé CO2 měření pro venkovní/přívodní nebo odtahový vzduch'],
      entities: [],
    };
  }

  const outside = co2.find(item => item.location === 'outside_or_supply');
  const inside = co2.find(item => item.location === 'inside_or_extract');
  if (outside && inside) {
    const delta = Math.round(inside.ppm - outside.ppm);
    return {
      status: 'measured_delta',
      message: `CO2 rozdíl je ${delta} ppm (${inside.name}: ${inside.ppm} ppm, ${outside.name}: ${outside.ppm} ppm). To je měřený rozdíl, ne plná účinnost rekuperace.`,
      delta_ppm: delta,
      inside,
      outside,
      entities: co2,
    };
  }

  const highest = [...co2].sort((a, b) => b.ppm - a.ppm)[0];
  const trend = highest.ppm >= 1500 ? 'varovat a větrat' : highest.ppm >= 1000 ? 'upozornit na větrání' : 'stav vypadá běžně';
  return {
    status: 'single_sensor_trend',
    message: `Vidím jen jedno použitelné CO2 měření (${highest.name}: ${highest.ppm} ppm). Můžu z něj říct trend: ${trend}, ale ne účinnost rekuperace.`,
    trend,
    entities: co2,
  };
}

function buildModbusReadOnlyPlan(input = {}) {
  const missing = REQUIRED_MODBUS_FIELDS.filter(key => !String(input[key] || '').trim());
  const connection = normalizeText(input.connection);
  const connectionHints = {
    tcp: 'Modbus TCP: potřebuji IP adresu jednotky a port, typicky 502.',
    rtu: 'Modbus RTU/RS-485: potřebuji převodník, sériové parametry a fyzický přístup ke svorkám.',
    serial: 'Modbus RTU/RS-485: potřebuji převodník, sériové parametry a fyzický přístup ke svorkám.',
    unknown: 'Neznámá komunikační cesta: nejdřív zjistit, jestli je jednotka Modbus TCP v LAN, nebo RTU/RS-485 na svorkách.',
  };
  const connectionNote = connection.includes('tcp')
    ? connectionHints.tcp
    : (connection.includes('rtu') || connection.includes('rs-485') || connection.includes('serial'))
      ? connectionHints.rtu
      : connectionHints.unknown;

  return {
    ready_for_yaml: missing.length === 0,
    missing,
    connection_note: connectionNote,
    package_scope: 'Jen read-only senzory: stav jednotky, průtok/výkon, teploty, filtr, porucha a CO2. Žádné select/number/switch zápisy.',
    yaml_guidance: missing.length === 0
      ? [
          'připravit HA package s modbus sensors podle dodané mapy registrů',
          'každý registr opsat z manuálu; nic nedopočítávat ani netipovat podle jiné značky',
          'po reloadu ověřit entity přes get_states a až potom hlásit hotovo',
        ]
      : [
          'nejdřív doplnit chybějící údaje',
          'bez mapy registrů připravit jen checklist, ne YAML s adresami',
        ],
  };
}

function buildVentilationReport(input = {}) {
  const entities = Array.isArray(input.entities) ? input.entities : [];
  const modbus = buildModbusReadOnlyPlan(input.modbus || input);
  const co2 = summarizeCo2(entities);
  const ventilationEntities = entities
    .filter(isVentilationEntity)
    .map(entity => ({
      entity_id: entity.entity_id,
      name: (entity.attributes && entity.attributes.friendly_name) || entity.name || entity.entity_id,
      state: entity.state,
    }));

  return {
    success: true,
    mode: 'read_only',
    safety: {
      writes_allowed: false,
      rule: 'První verze rekuperace nesmí měnit výkon, režim ani zapisovat Modbus registry. Ovládání až po samostatném Ondrově potvrzení.',
    },
    modbus,
    co2,
    ventilation_entities: ventilationEntities,
    message: [
      modbus.ready_for_yaml
        ? 'Podklady pro read-only Modbus senzory vypadají kompletně; YAML pořád musí opsat konkrétní registry z manuálu.'
        : `Chybí podklady pro Modbus: ${modbus.missing.join(', ') || 'neznámé'}. Bez nich připrav jen checklist, ne registry.`,
      co2.message,
    ].join(' '),
  };
}

module.exports = {
  buildModbusReadOnlyPlan,
  buildVentilationReport,
  summarizeCo2,
};
