#!/usr/bin/env node

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const yaml = require('js-yaml');

const root = path.resolve(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zan-pilot-preflight-'));

process.env.ZAN_TEST_EXPORTS = '1';
process.env.ZAN_DATA_DIR = tmp;
process.env.TELEGRAM_TOKEN = '000000:test-token';
process.env.CHAT_ID_ONDRA = '1001';
process.env.CHAT_ID_JANA = '';
process.env.EXTRA_CHAT_IDS = '';
process.env.ZAN_HOME_NAME = 'Radkův Žán';
process.env.CHAT_NAME_ONDRA = 'Radek';
process.env.CHAT_NAME_JANA = '';
process.env.ANTHROPIC_API_KEY = 'test';
process.env.OPENAI_API_KEY = 'test';
process.env.HA_URL = 'http://127.0.0.1:8123';
process.env.HA_TOKEN = 'test';
process.env.HA_CONFIG_PATH = path.join(tmp, 'ha-config');

const bot = require(path.join(root, 'bot.js'));

const forbidden = [
  'Ondra',
  'Jana',
  'Štěpán',
  'Stepan',
  'Matěj',
  'Matej',
  'Eliška',
  'Eliska',
  'Stiburk',
  'Stibur',
];

function assertNoStiburkovi(text, label) {
  for (const word of forbidden) {
    assert.ok(!String(text).includes(word), `${label} leaks "${word}"`);
  }
}

try {
  const config = yaml.load(fs.readFileSync(path.join(root, 'config.yaml'), 'utf8'));
  assert.strictEqual(config.options.ZAN_HOME_NAME, 'Dům Žán');
  assert.strictEqual(config.options.CHAT_NAME_ONDRA, 'Ondra');
  assert.strictEqual(config.options.CHAT_NAME_JANA, 'Jana');
  assert.strictEqual(config.schema.ZAN_HOME_NAME, 'str?');
  assert.strictEqual(config.schema.CHAT_NAME_ONDRA, 'str?');
  assert.strictEqual(config.schema.CHAT_NAME_JANA, 'str?');

  const runSh = fs.readFileSync(path.join(root, 'run.sh'), 'utf8');
  assert.match(runSh, /export ZAN_HOME_NAME=\$\(jq --raw-output '\.ZAN_HOME_NAME \/\/ "Dům Žán"'/);
  assert.match(runSh, /export CHAT_NAME_ONDRA=\$\(jq --raw-output '\.CHAT_NAME_ONDRA \/\/ "Ondra"'/);
  assert.match(runSh, /export CHAT_NAME_JANA=\$\(jq --raw-output '\.CHAT_NAME_JANA \/\/ "Jana"'/);

  assert.strictEqual(bot.DATA_DIR, tmp);
  assert.ok(!bot.DATA_DIR.startsWith('/config/zan_data'), 'preflight must not use production /config/zan_data');
  assert.strictEqual(bot.HOME_NAME, 'Radkův Žán');
  assert.strictEqual(bot.CHAT_NAME_ONDRA, 'Radek');
  assert.strictEqual(bot.CHAT_ONDRA, 1001);
  assert.ok(!Number.isFinite(bot.CHAT_JANA), 'clean Radek preflight starts with one admin chat only');

  const memory = bot.loadMemory();
  assert.strictEqual(memory.home_name, 'Radkův Žán');
  assert.deepStrictEqual(Object.keys(memory.residents), ['admin']);
  assert.strictEqual(memory.residents.admin.name, 'Radek');
  assert.strictEqual(memory.residents.admin.role, 'admin');
  assert.deepStrictEqual(memory.rooms, {});
  assert.deepStrictEqual(memory.devices, {});
  assert.strictEqual(memory.house.name, 'Radkův Žán');
  assertNoStiburkovi(JSON.stringify(memory), 'clean memory');

  const adminUser = bot.getUser(1001);
  assert.deepStrictEqual(adminUser, { name: 'Radek', role: 'admin' });

  const start = bot.renderStartMessage(memory, adminUser);
  assert.match(start.text, /Ahoj Radek/);
  assert.match(start.text, /Jsem \*Žán\*/);
  assert.match(start.text, /Jsem Radek, bydlíme v rodinném domě/);
  assertNoStiburkovi(start.text, '/start');

  const pamet = bot.renderPametMessage(memory);
  assert.match(pamet.text, /Obyvatelé/);
  assert.match(pamet.text, /Radek: admin/);
  assertNoStiburkovi(pamet.text, '/pamet');

  const target = bot.resolveOnboardingTarget('admin');
  assert.strictEqual(target.chatId, 1001);
  assert.strictEqual(target.user.name, 'Radek');

  const intro = bot.renderOnboardingIntro(adminUser, target.user);
  assert.match(intro, /Ahoj Radek/);
  assert.match(intro, /Radek mě požádal/);
  assert.match(intro, /vždycky jen jedna rychlá otázka/);
  assert.doesNotMatch(intro, /tu už spolu řešíme/);
  assertNoStiburkovi(intro, '/onboarding admin');

  const rodina = bot.ensureRodina();
  assert.match(rodina, /# Rodina — profil domácnosti/);
  assert.match(rodina, /## Domácnost/);
  assert.ok(fs.existsSync(path.join(tmp, 'rodina.md')), 'rodina.md must be created in isolated ZAN_DATA_DIR');
  assert.strictEqual(bot.RODINA_FILE, path.join(tmp, 'rodina.md'));
  assert.strictEqual(bot.MEMORY_FILE, path.join(tmp, 'home_memory.json'));

  console.log(`Pilot clean preflight OK (${tmp})`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
