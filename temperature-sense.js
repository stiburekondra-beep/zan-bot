'use strict';

// ═══════════════════════════════════════════════════════════════════════
// TEPLOTNÍ „DRUHÝ SMYSL" — read-only ověření teploty v místnosti z reálného
// čidla + naměřený trend z historie HA. Karta 2026-08-17-programator-zana-02
// ČÁST 1 (rozhodnutí 2026-08-16-sebekontrola-smysly, volba B): Žán si teplotu
// neověřuje slepou důvěrou v akci, ale přečte čidlo a poctivě řekne
// „teplota stoupá / zatím ne / nemám tam čidlo".
//
// TVRDÉ mantinely (Ondrův opakovaný závazný fakt: teploty v domě NEJSOU
// řízené, kanálové jednotky NEJSOU zapojené):
//   • READ-ONLY. Modul jen čte a počítá, NIKDY neřídí topení/klima ani
//     nesahá na packages/topeni_*. Žádný claim o řízení teploty.
//   • NEFABULUJE. Bez čidla → „nemám tam čidlo". Bez dost historie →
//     jen aktuální hodnota + „trend zatím nezměřím", NIKDY vymyšlený trend.
//
// Modul je čistě funkční (žádné HA volání) — bot.js dodá states + history,
// takže jde testovat bez HA (contract test injektuje data). Vzor:
// ventilation-report.js / device-layout.js.
// ═══════════════════════════════════════════════════════════════════════

const TEMP_UNITS = ['°c', 'c', '°f', 'f'];
// Práh, od kterého bereme změnu jako trend (pod ním = „beze změny"). HA
// čidla mají typicky rozlišení 0,1 °C a drift; 0,2 °C je konzervativní.
const DEFAULT_MIN_DELTA_C = 0.2;
// Minimální rozpětí měření, abychom o trendu vůbec mluvili. Kratší okno =
// šum, ne trend → „trend zatím nezměřím".
const DEFAULT_MIN_SPAN_MINUTES = 10;
// Věrohodné pásmo pokojové teploty. Reálné HW glitche (DS18B20 1-wire chyba
// −127 °C, power-on-reset 85 °C, Zigbee overflow sentinely 255…) jsou KONEČNÁ
// čísla — projdou asNumber jako „platná" hodnota a modul by je jinak ohlásil
// jako reálnou teplotu/trend (přesně fabulace, proti které tenhle „druhý
// smysl" stojí). Pásmo je schválně široké: −50 pokryje i garáž/nevytápěný
// prostor v silné zimě, 80 i čidlo u kamen — ale zachytí sentinely mimo něj.
// POZOR (poctivá hranice): 0 °C dropout (Zigbee) je UVNITŘ pásma a od reálné
// mrazivé místnosti se hodnotou nedá odlišit → tenhle clamp ho NEchytí.
const PLAUSIBLE_MIN_C = -50;
const PLAUSIBLE_MAX_C = 80;

// Je hodnota věrohodná pokojová teplota? Nečíselné/NaN i mimo pásmo → false.
function isPlausibleRoomTemp(value) {
  const n = asNumber(value);
  return n !== null && n >= PLAUSIBLE_MIN_C && n <= PLAUSIBLE_MAX_C;
}

function normalizeText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();
}

function asNumber(value) {
  if (value === null || value === undefined) return null;
  const n = Number(String(value).replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

// Poctivý formát čísla (1 desetinné místo, čárka jako oddělovač).
function fmt(n) {
  if (n === null || n === undefined || !Number.isFinite(Number(n))) return '?';
  return Number(n).toFixed(1).replace('.', ',');
}

// Teplotní čidlo poznáme STRUKTURÁLNĚ z HA (device_class/unit), ne z názvu —
// stejný princip jako area-alias/device-layout: strukturální data > keyword.
function isTemperatureSensor(entity = {}, registryDeviceClass) {
  const id = String(entity.entity_id || '');
  if (!id.startsWith('sensor.')) return false;
  const attrs = entity.attributes || {};
  const dc = normalizeText(attrs.device_class || registryDeviceClass || '');
  if (dc === 'temperature') return true;
  // Fallback: bez device_class ber jen když jednotka je jednoznačně teplotní.
  const unit = normalizeText(attrs.unit_of_measurement || '');
  return TEMP_UNITS.includes(unit);
}

// Kde entita „bydlí" — přímo na stavu, jinak z entity/device registru.
function entityAreaId(entity, entityRegistry = [], deviceRegistry = []) {
  const attrs = entity.attributes || {};
  if (attrs.area_id) return attrs.area_id;
  const reg = (Array.isArray(entityRegistry) ? entityRegistry : [])
    .find(e => e.entity_id === entity.entity_id);
  if (reg && reg.area_id) return reg.area_id;
  if (reg && reg.device_id) {
    const dev = (Array.isArray(deviceRegistry) ? deviceRegistry : [])
      .find(d => d.id === reg.device_id);
    if (dev && dev.area_id) return dev.area_id;
  }
  return null;
}

// Namapuj dotaz uživatele („obývák") na HA area_id. Autorita = HA area
// registr; house_map slouží jen jako alias/název místnosti navázaný na area.
function resolveAreaId(query, areaRegistry = [], houseMap = {}) {
  const q = normalizeText(query);
  if (!q) return null;
  const areas = Array.isArray(areaRegistry) ? areaRegistry : [];
  // 1) přesná/normalizovaná shoda názvu nebo id area
  let hit = areas.find(a => normalizeText(a.name) === q || normalizeText(a.area_id) === q);
  if (hit) return { area_id: hit.area_id, area_name: hit.name || hit.area_id };
  // 2) house_map: název/alias místnosti → area_id, pak dohledej v area registru
  const rooms = Array.isArray(houseMap.rooms) ? houseMap.rooms : [];
  const room = rooms.find(r => {
    const names = [r.name, ...(Array.isArray(r.aliases) ? r.aliases : [])].map(normalizeText);
    return names.includes(q);
  });
  if (room && room.area_id) {
    const a = areas.find(x => x.area_id === room.area_id);
    return { area_id: room.area_id, area_name: (a && a.name) || room.name || room.area_id };
  }
  return null;
}

// Všechna teplotní čidla v dané area.
function pickTemperatureSensors(areaId, states = [], entityRegistry = [], deviceRegistry = []) {
  const regClassById = new Map(
    (Array.isArray(entityRegistry) ? entityRegistry : [])
      .map(e => [e.entity_id, e.device_class || e.original_device_class]),
  );
  return (Array.isArray(states) ? states : [])
    .filter(s => isTemperatureSensor(s, regClassById.get(s.entity_id)))
    .filter(s => entityAreaId(s, entityRegistry, deviceRegistry) === areaId);
}

// Trend z bodů historie [{t: ms, v: number}]. Poctivě: <2 body nebo krátké
// rozpětí → 'unknown' (žádný vymyšlený trend).
function computeTrend(points, opts = {}) {
  const minDeltaC = Number.isFinite(opts.minDeltaC) ? opts.minDeltaC : DEFAULT_MIN_DELTA_C;
  const minSpanMinutes = Number.isFinite(opts.minSpanMinutes) ? opts.minSpanMinutes : DEFAULT_MIN_SPAN_MINUTES;
  // Glitch body (−127, 85, 255…) mimo věrohodné pásmo zahoď PŘED výpočtem
  // trendu — jinak by jeden chybový vzorek v historii vyrobil absurdní trend
  // („klesá −148 °C za 30 min"). Zahození = zacházíme s nimi jako s chybějícím
  // měřením, ne s reálnou teplotou.
  const clean = (Array.isArray(points) ? points : [])
    .map(p => ({ t: Number(p.t), v: asNumber(p.v) }))
    .filter(p => Number.isFinite(p.t) && p.v !== null && isPlausibleRoomTemp(p.v))
    .sort((a, b) => a.t - b.t);
  if (clean.length < 2) {
    return { trend: 'unknown', deltaC: null, spanMinutes: 0, samples: clean.length, reason: 'málo měření' };
  }
  const first = clean[0];
  const last = clean[clean.length - 1];
  const spanMinutes = Math.round((last.t - first.t) / 60000);
  if (spanMinutes < minSpanMinutes) {
    return { trend: 'unknown', deltaC: null, spanMinutes, samples: clean.length, reason: 'krátké okno' };
  }
  const deltaC = Math.round((last.v - first.v) * 10) / 10;
  let trend = 'steady';
  if (deltaC >= minDeltaC) trend = 'rising';
  else if (deltaC <= -minDeltaC) trend = 'falling';
  return { trend, deltaC, spanMinutes, samples: clean.length, reason: null };
}

const TREND_WORD = {
  rising: 'stoupá',
  falling: 'klesá',
  steady: 'drží se',
  unknown: 'zatím nezměřím',
};

// Poctivý strukturovaný + textový výrok. Nikdy netvrdí řízení teploty.
function buildTemperatureVerdict(input = {}) {
  const {
    roomQuery,
    areaName,
    areaResolved,
    sensors = [],
    currentC,
    trend,
  } = input;

  if (!areaResolved) {
    return {
      found: false,
      reason: 'unknown_room',
      text: `Místnost „${roomQuery}" neznám. Zkus přesný název (ověř přes get_areas) — teplotu nefabuluju.`,
    };
  }
  if (!sensors.length) {
    return {
      found: false,
      reason: 'no_sensor',
      area: areaName,
      text: `V místnosti ${areaName} nemám teplotní čidlo — teplotu neověřím. Nechceš tam nějaké přidat?`,
    };
  }
  if (currentC === null || currentC === undefined) {
    return {
      found: true,
      reason: 'sensor_unreadable',
      area: areaName,
      sensor: sensors[0],
      current_c: null,
      trend: 'unknown',
      text: `Teplotní čidlo v ${areaName} (${sensors[0]}) teď nehlásí čitelnou hodnotu — nemůžu potvrdit teplotu.`,
    };
  }
  // Glitch aktuální hodnota (−127 °C 1-wire chyba, 85 °C POR, sentinel) je
  // číslo, ale ne reálná teplota — NEHLÁSIT ji jako fakt. Zacházej stejně
  // jako s nečitelným čidlem: poctivé přiznání, ne fabulovaná teplota.
  if (!isPlausibleRoomTemp(currentC)) {
    return {
      found: true,
      reason: 'sensor_glitch',
      area: areaName,
      sensor: sensors[0],
      current_c: null,
      trend: 'unknown',
      text: `Teplotní čidlo v ${areaName} (${sensors[0]}) hlásí nesmyslnou hodnotu (${fmt(currentC)} °C) — nejspíš chyba čidla, teplotu nepotvrdím.`,
    };
  }

  const t = (trend && trend.trend) || 'unknown';
  let text = `V ${areaName} je teď ${fmt(currentC)} °C`;
  if (t === 'rising' || t === 'falling') {
    const sign = trend.deltaC > 0 ? '+' : '';
    text += ` a teplota ${TREND_WORD[t]} (${sign}${fmt(trend.deltaC)} °C za ${trend.spanMinutes} min).`;
  } else if (t === 'steady') {
    text += ` a za ${trend.spanMinutes} min se prakticky nemění.`;
  } else {
    text += `; trend ${TREND_WORD.unknown} (${(trend && trend.reason) || 'málo dat'}).`;
  }

  return {
    found: true,
    reason: 'ok',
    area: areaName,
    sensor: sensors[0],
    sensor_count: sensors.length,
    current_c: Math.round(currentC * 10) / 10,
    trend: t,
    delta_c: trend ? trend.deltaC : null,
    span_minutes: trend ? trend.spanMinutes : 0,
    text,
  };
}

// Převede HA history/period odpověď na body {t, v}. HA vrací pole polí:
// [[{state, last_changed|last_updated}, ...]]. Bere první sérii (jedna entita).
function historyToPoints(historyResponse) {
  const series = Array.isArray(historyResponse) && Array.isArray(historyResponse[0])
    ? historyResponse[0]
    : (Array.isArray(historyResponse) ? historyResponse : []);
  return series
    .map(row => ({
      t: new Date(row.last_changed || row.last_updated || 0).getTime(),
      v: asNumber(row.state),
    }))
    .filter(p => Number.isFinite(p.t) && p.t > 0 && p.v !== null);
}

module.exports = {
  DEFAULT_MIN_DELTA_C,
  DEFAULT_MIN_SPAN_MINUTES,
  PLAUSIBLE_MIN_C,
  PLAUSIBLE_MAX_C,
  normalizeText,
  asNumber,
  isPlausibleRoomTemp,
  isTemperatureSensor,
  entityAreaId,
  resolveAreaId,
  pickTemperatureSensors,
  computeTrend,
  buildTemperatureVerdict,
  historyToPoints,
};
