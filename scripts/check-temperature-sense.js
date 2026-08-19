'use strict';

// Contract test pro temperature-sense.js — „druhý smysl" (teplota).
// Ověřuje strukturální rozpoznání čidla, mapování místnosti, NAMĚŘENÝ trend
// a hlavně HONESTY hranu: bez čidla/dat se trend NEFABULUJE.
// Běží bez HA (čistě funkce nad injektovanými daty).

const assert = require('assert');
const t = require('../temperature-sense');

let n = 0;
function ok(name, cond) {
  n += 1;
  assert(cond, `FAIL: ${name}`);
}

// ── isTemperatureSensor: strukturálně (device_class/jednotka), ne z názvu ──
ok('temp device_class → true',
  t.isTemperatureSensor({ entity_id: 'sensor.hall_01', attributes: { device_class: 'temperature' } }));
ok('°C jednotka bez device_class → true',
  t.isTemperatureSensor({ entity_id: 'sensor.x', attributes: { unit_of_measurement: '°C' } }));
ok('vlhkost (%) → false',
  !t.isTemperatureSensor({ entity_id: 'sensor.vlhkost', attributes: { device_class: 'humidity', unit_of_measurement: '%' } }));
ok('nesenzorová doména → false',
  !t.isTemperatureSensor({ entity_id: 'climate.obyvak', attributes: { device_class: 'temperature' } }));
ok('device_class z registru (fallback) → true',
  t.isTemperatureSensor({ entity_id: 'sensor.node7', attributes: {} }, 'temperature'));

// ── resolveAreaId: HA area název, house_map alias, neznámá ──
const areaReg = [{ area_id: 'obyvak', name: 'Obývák' }, { area_id: 'loznice', name: 'Ložnice' }];
const houseMap = { rooms: [{ area_id: 'obyvak', name: 'Obývák', aliases: ['velký pokoj'] }] };
ok('area podle názvu (diakritika/velikost)', t.resolveAreaId('obyvak', areaReg, houseMap)?.area_id === 'obyvak');
ok('area podle přesného názvu', t.resolveAreaId('Ložnice', areaReg, houseMap)?.area_id === 'loznice');
ok('area podle house_map aliasu', t.resolveAreaId('velký pokoj', areaReg, houseMap)?.area_id === 'obyvak');
ok('neznámá místnost → null', t.resolveAreaId('sklep', areaReg, houseMap) === null);

// ── pickTemperatureSensors: filtruje podle area + teplota ──
const states = [
  { entity_id: 'sensor.obyvak_teplota', state: '20.6', attributes: { device_class: 'temperature', unit_of_measurement: '°C', area_id: 'obyvak' } },
  { entity_id: 'sensor.obyvak_vlhkost', state: '45', attributes: { device_class: 'humidity', unit_of_measurement: '%', area_id: 'obyvak' } },
  { entity_id: 'sensor.loznice_teplota', state: '18.0', attributes: { device_class: 'temperature', unit_of_measurement: '°C', area_id: 'loznice' } },
];
const picked = t.pickTemperatureSensors('obyvak', states, [], []);
ok('vybere jen teplotní čidlo v area', picked.length === 1 && picked[0].entity_id === 'sensor.obyvak_teplota');
ok('area bez čidla → prázdné', t.pickTemperatureSensors('koupelna', states, [], []).length === 0);

// area z entity registru (stav bez area_id)
const stateNoArea = [{ entity_id: 'sensor.t2', state: '21', attributes: { device_class: 'temperature' } }];
const entReg = [{ entity_id: 'sensor.t2', area_id: 'obyvak' }];
ok('area z entity registru', t.pickTemperatureSensors('obyvak', stateNoArea, entReg, []).length === 1);

// ── computeTrend: naměřený trend + HONESTY (bez dat žádný trend) ──
const base = 1_700_000_000_000;
const rising = [{ t: base, v: 20.0 }, { t: base + 30 * 60000, v: 20.6 }];
ok('rising trend', t.computeTrend(rising).trend === 'rising');
const falling = [{ t: base, v: 21.0 }, { t: base + 30 * 60000, v: 20.3 }];
ok('falling trend', t.computeTrend(falling).trend === 'falling');
const steady = [{ t: base, v: 20.0 }, { t: base + 30 * 60000, v: 20.05 }];
ok('steady trend (pod prahem)', t.computeTrend(steady).trend === 'steady');
ok('1 měření → unknown (nefabuluje)', t.computeTrend([{ t: base, v: 20 }]).trend === 'unknown');
ok('krátké okno → unknown (nefabuluje)',
  t.computeTrend([{ t: base, v: 20 }, { t: base + 2 * 60000, v: 21 }]).trend === 'unknown');
ok('prázdná historie → unknown', t.computeTrend([]).trend === 'unknown');

// ── buildTemperatureVerdict: všechny honesty větve ──
const vUnknownRoom = t.buildTemperatureVerdict({ roomQuery: 'sklep', areaResolved: false });
ok('neznámá místnost → found:false + nefabuluje', vUnknownRoom.found === false && /neznám/i.test(vUnknownRoom.text));

const vNoSensor = t.buildTemperatureVerdict({ roomQuery: 'koupelna', areaResolved: true, areaName: 'Koupelna', sensors: [] });
ok('bez čidla → found:false + „nemám tam čidlo"', vNoSensor.found === false && /nemám teplotní čidlo/i.test(vNoSensor.text));
ok('bez čidla NEuvádí žádnou teplotu', !/\d,\d\s*°C/.test(vNoSensor.text));

const vUnreadable = t.buildTemperatureVerdict({ roomQuery: 'obývák', areaResolved: true, areaName: 'Obývák', sensors: ['sensor.obyvak_teplota'], currentC: null });
ok('nečitelné čidlo → nepotvrdí teplotu', /nemůžu potvrdit teplotu/i.test(vUnreadable.text));

const vOk = t.buildTemperatureVerdict({
  roomQuery: 'obývák', areaResolved: true, areaName: 'Obývák',
  sensors: ['sensor.obyvak_teplota'], currentC: 20.6, trend: t.computeTrend(rising),
});
ok('ok verdikt: found + trend rising', vOk.found === true && vOk.trend === 'rising');
ok('ok verdikt text nese hodnotu i trend', /20,6\s*°C/.test(vOk.text) && /stoupá/.test(vOk.text));

const vNoTrend = t.buildTemperatureVerdict({
  roomQuery: 'obývák', areaResolved: true, areaName: 'Obývák',
  sensors: ['sensor.obyvak_teplota'], currentC: 20.6, trend: t.computeTrend([{ t: base, v: 20.6 }]),
});
ok('málo dat: hodnota ano, trend „nezměřím" (nefabuluje)',
  /20,6\s*°C/.test(vNoTrend.text) && /nezměřím/.test(vNoTrend.text) && vNoTrend.trend === 'unknown');

// ── PLAUSIBILITA (sc.70): glitch hodnoty čidla se NEHLÁSÍ jako teplota ──
// isPlausibleRoomTemp: sentinely mimo pásmo, věrohodné hodnoty uvnitř.
ok('isPlausibleRoomTemp: DS18B20 −127 chyba → false', !t.isPlausibleRoomTemp(-127));
ok('isPlausibleRoomTemp: DS18B20 85 POR → false', !t.isPlausibleRoomTemp(85));
ok('isPlausibleRoomTemp: Zigbee 255 overflow → false', !t.isPlausibleRoomTemp(255));
ok('isPlausibleRoomTemp: reálná pokojová 20,6 → true', t.isPlausibleRoomTemp(20.6));
ok('isPlausibleRoomTemp: mrazivá garáž −18 → true (diskriminace)', t.isPlausibleRoomTemp(-18));
ok('isPlausibleRoomTemp: 0 °C (uvnitř pásma, nechytneme hodnotou) → true', t.isPlausibleRoomTemp(0));

// computeTrend: glitch bod v historii se zahodí PŘED trendem (žádný absurdní trend).
const glitchHist = [{ t: base, v: 21.0 }, { t: base + 15 * 60000, v: -127 }, { t: base + 30 * 60000, v: 21.4 }];
const glitchTrend = t.computeTrend(glitchHist);
ok('computeTrend: −127 glitch zahozen, žádný absurdní pokles',
  glitchTrend.samples === 2 && glitchTrend.deltaC !== null && Math.abs(glitchTrend.deltaC) < 5);
ok('computeTrend: DS18B20 85 POR zahozen',
  t.computeTrend([{ t: base, v: 20 }, { t: base + 30 * 60000, v: 85 }]).samples === 1);
// Diskriminace: zdravé body projdou beze změny.
ok('computeTrend: zdravé body dál rising (nepřeblokuje)', t.computeTrend(rising).trend === 'rising');

// buildTemperatureVerdict: glitch aktuální hodnota → sensor_glitch, ne fabulace.
const vGlitch = t.buildTemperatureVerdict({
  roomQuery: 'obývák', areaResolved: true, areaName: 'Obývák',
  sensors: ['sensor.obyvak_teplota'], currentC: -127, trend: t.computeTrend([]),
});
ok('glitch current → sensor_glitch, current_c null', vGlitch.reason === 'sensor_glitch' && vGlitch.current_c === null);
ok('glitch current: text NEHLÁSÍ −127 jako teplotu (nefabuluje)',
  /nesmyslnou|chyba čidla/i.test(vGlitch.text) && vGlitch.trend === 'unknown');
ok('glitch 85 POR → sensor_glitch',
  t.buildTemperatureVerdict({ roomQuery: 'obývák', areaResolved: true, areaName: 'Obývák', sensors: ['sensor.x'], currentC: 85 }).reason === 'sensor_glitch');
// Diskriminace: věrohodná hodnota dál projde jako ok.
ok('věrohodná hodnota 20,6 dál ok (nepřeblokuje)', vOk.reason === 'ok' && vOk.current_c === 20.6);

// ── historyToPoints: parsuje HA history/period tvar ──
const hist = [[
  { entity_id: 'sensor.obyvak_teplota', state: '20.0', last_changed: new Date(base).toISOString() },
  { entity_id: 'sensor.obyvak_teplota', state: 'unavailable', last_changed: new Date(base + 60000).toISOString() },
  { entity_id: 'sensor.obyvak_teplota', state: '20.6', last_updated: new Date(base + 30 * 60000).toISOString() },
]];
const pts = t.historyToPoints(hist);
ok('historyToPoints vyhodí nečíselné (unavailable)', pts.length === 2);
ok('historyToPoints → trend rising', t.computeTrend(pts).trend === 'rising');

console.log(`temperature-sense ok: ${n} kontrol`);
