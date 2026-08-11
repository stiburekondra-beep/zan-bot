#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zan-guest-privacy-'));
process.env.ZAN_TEST_EXPORTS = '1';
process.env.ZAN_DATA_DIR = tmp;
process.env.CHAT_ID_ONDRA = '1001';
process.env.CHAT_ID_JANA = '1002';
process.env.CHAT_NAME_ONDRA = 'Ondra';
process.env.CHAT_NAME_JANA = 'Jana';
process.env.TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || 'test-token';
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'test-key';
process.env.HA_URL = process.env.HA_URL || 'http://127.0.0.1:8123';
process.env.HA_TOKEN = process.env.HA_TOKEN || 'test-ha-token';
process.env.ZAN_HARNESS_ONLY = '1';

const bot = require('../bot');

const memory = {
  home_name: 'Dům Žán',
  residents: {
    stepan: { name: 'Štěpán', born: '2020', role: 'dítě', info: 'má rád vláčky' },
    matej: { name: 'Matěj', born: '2023', role: 'dítě', info: 'dvojče' },
    eliska: { name: 'Eliška', born: '2023', role: 'dítě', info: 'dvojče' },
  },
  house: { address: 'Tajná 123', floors: 2, camera_note: 'Tapo má mikrofon' },
  rooms: {
    obyvak: { name: 'Obývák', area_id: 'obyvak' },
    loznice: { name: 'Ložnice', area_id: 'loznice' },
  },
  devices: {
    kamera_loznice: { name: 'Kamera v ložnici', entity_id: 'camera.tapo_loznice' },
  },
  preferences: { teplota: '22 stupňů', klid: 'po 20:00' },
  notes: [{ text: 'Jana nebývá doma v úterý večer' }],
};

const rodina = [
  '# Rodina — profil domácnosti',
  'Štěpán, Matěj a Eliška jsou děti.',
  'Večer po 20:00 je doma klid.',
  'Kamera Tapo má mikrofon.',
].join('\n');
fs.writeFileSync(bot.RODINA_FILE, rodina, 'utf8');

function assertNoLeak(text, label) {
  const s = String(text);
  for (const forbidden of [
    'Štěpán', 'Matěj', 'Eliška', 'Jana nebývá', 'Tajná 123', 'Obývák',
    'Ložnice', 'kamera_loznice', 'camera.tapo', 'Tapo má mikrofon', '22 stupňů',
    '20:00', 'dvojče', 'vláčky', 'Dům Žán',
  ]) {
    assert.ok(!s.includes(forbidden), `${label} nesmí obsahovat citlivý údaj: ${forbidden}`);
  }
}

const host = bot.getUser(9999);
assert.strictEqual(host.role, 'guest', 'neznámý chat je Host');
assert.strictEqual(bot.canAccessHouseholdPrivateData(9999, host), false, 'Host nemá přístup k rodinným datům');
assert.strictEqual(bot.canAccessHouseholdPrivateData(bot.CHAT_JANA, bot.getUser(bot.CHAT_JANA)), true, 'Jana zůstává známý uživatel');
assert.strictEqual(bot.canAccessHouseholdPrivateData(bot.CHAT_ONDRA, bot.getUser(bot.CHAT_ONDRA)), true, 'Ondra zůstává admin');

const guestContext = bot.renderHouseholdContext(memory, host, 9999);
assert.match(guestContext, /skryt/i, 'host context nese privacy informaci');
assertNoLeak(guestContext, 'host dynamic context');

const familyContext = bot.renderHouseholdContext(memory, bot.getUser(bot.CHAT_JANA), bot.CHAT_JANA);
assert.match(familyContext, /Štěpán/, 'rodina dál dostane rodinný kontext');
assert.match(familyContext, /PROFIL DOMÁCNOSTI/, 'rodina dál dostane rodina.md');

const guestStart = bot.renderStartMessage(memory, host).text;
assert.match(guestStart, /hosta/i, '/start hostovi vysvětlí omezení');
assertNoLeak(guestStart, '/start host');

const guestPamet = bot.renderPametMessage(memory, host).text;
assert.match(guestPamet, /soukrom/i, '/pamet hostovi neukáže paměť');
assertNoLeak(guestPamet, '/pamet host');

const janaPamet = bot.renderPametMessage(memory, bot.getUser(bot.CHAT_JANA)).text;
assert.match(janaPamet, /Štěpán/, '/pamet pro rodinu zůstává funkční');

assert.deepStrictEqual(bot.buildTools(9999).map(t => t.name), [], 'Host nedostane žádné nástroje domu');
assert.ok(bot.buildTools(bot.CHAT_JANA).some(t => t.name === 'recall'), 'rodina dál dostane recall');
assert.ok(bot.buildTools(bot.CHAT_JANA).some(t => t.name === 'get_states'), 'rodina dál dostane get_states');

Promise.resolve()
  .then(() => bot.executeTool('remember', { category: 'preference', key: 'teplota', value: '22' }, 9999))
  .then((result) => {
    assert.ok(result && result.error, 'Host nesmí zapisovat přes remember');
    assert.match(result.error, /rodinnou paměť/i, 'guest tool gate vrací lidský privacy důvod');
    console.log('check-guest-privacy: OK');
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
