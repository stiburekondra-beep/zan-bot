#!/usr/bin/env node
'use strict';
// Kontraktní test pro kartu 2026-08-21-programator-zana-08: "Žán zná svou
// verzi a jednou oznámí změnu".
//
// Ověřuje:
//  1) getZanVersion() čte z config.yaml (kanonický zdroj), ne z mrtvého
//     package.json.
//  2) getChangelogEntry() vrací skutečný obsah pro existující verzi a NULL
//     pro vymyšlenou (necituje neexistující změny).
//  3) decideVersionAnnouncement() rozliší restart stejné verze od upgradu
//     (akceptační kritérium karty).
//  4) announceVersionIfChanged() oznámí přesně JEDNOU na verzi — a stav
//     PŘEŽIJE restart procesu (require.cache vyčištěn + modul znovu
//     načten se stejným ZAN_DATA_DIR = simulace restartu add-onu).
//  5) get_version nástroj vrací totéž číslo jako getZanVersion().

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const yaml = require('js-yaml');

const root = path.resolve(__dirname, '..');
const botPath = path.join(root, 'bot.js');

function freshBot(dataDir) {
  delete require.cache[require.resolve(botPath)];
  process.env.ZAN_TEST_EXPORTS = '1';
  process.env.ZAN_DATA_DIR = dataDir;
  process.env.TELEGRAM_TOKEN = '000000:test-token';
  process.env.CHAT_ID_ONDRA = '1001';
  process.env.CHAT_ID_JANA = '1002';
  process.env.EXTRA_CHAT_IDS = '';
  process.env.ANTHROPIC_API_KEY = 'test';
  process.env.OPENAI_API_KEY = 'test';
  process.env.HA_URL = 'http://127.0.0.1:8123';
  process.env.HA_TOKEN = 'test';
  return require(botPath);
}

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zan-version-'));
  let bot = freshBot(tmp);

  // ── 1) kanonický zdroj = config.yaml, ne package.json ──
  const realConfig = yaml.load(fs.readFileSync(path.join(root, 'config.yaml'), 'utf8'));
  assert.strictEqual(bot.getZanVersion(), realConfig.version, 'getZanVersion() musí souhlasit s config.yaml');
  const pkgVersion = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  assert.notStrictEqual(bot.getZanVersion(), pkgVersion, 'verze nesmí náhodou souhlasit s mrtvým package.json (jinak test nic nedokazuje)');

  // ── 2) changelog: pravdivý obsah, nebo mlčení ──
  const entry = bot.getChangelogEntry(realConfig.version);
  assert.ok(entry && entry.length > 0, 'aktuální verze musí mít v CHANGELOG.md neprázdný záznam');
  assert.strictEqual(bot.getChangelogEntry('0.0.0-neexistuje-test'), null, 'vymyšlená verze nesmí vrátit žádný text (necitovat neexistující změny)');

  // ── 3) rozhodovací logika: restart stejné verze vs. upgrade ──
  assert.strictEqual(bot.decideVersionAnnouncement({}, '5.0.0').action, 'baseline', 'první běh bez uloženého stavu = baseline, ne announce');
  assert.strictEqual(
    bot.decideVersionAnnouncement({ last_announced_version: '5.0.0' }, '5.0.0').action,
    'none',
    'restart STEJNÉ verze nesmí spustit oznámení',
  );
  const upgradeDecision = bot.decideVersionAnnouncement({ last_announced_version: '5.0.0' }, '5.0.1');
  assert.strictEqual(upgradeDecision.action, 'announce', 'změna verze musí spustit oznámení');
  assert.strictEqual(upgradeDecision.previous, '5.0.0');

  // ── 4) end-to-end s injektovaným sendFn (bez reálného Telegramu) ──
  let sendCalls = [];
  const stubSend = async (chatId, text) => { sendCalls.push({ chatId, text }); };

  // 4a) první běh vůbec → baseline, NEOZNAMOVAT (jinak by zavedení funkce
  //     vypálilo "nová verze" na verzi, co už dávno běžela)
  await bot.announceVersionIfChanged(stubSend);
  assert.strictEqual(sendCalls.length, 0, 'první běh (bez historie) nesmí nic oznámit, jen si zapsat baseline');
  assert.ok(fs.existsSync(bot.VERSION_ANNOUNCE_FILE), 'baseline se musí perzistovat na disk');
  let state = JSON.parse(fs.readFileSync(bot.VERSION_ANNOUNCE_FILE, 'utf8'));
  assert.strictEqual(state.last_announced_version, realConfig.version);

  // 4b) "RESTART PROCESU" (nový require, STEJNÝ ZAN_DATA_DIR) → stejná verze
  //     → stav z disku ukazuje 'none' a NIC se znovu neoznámí. Tohle je jádro
  //     "jednou": perzistence musí přežít restart procesu, ne jen paměť.
  bot = freshBot(tmp);
  sendCalls = [];
  await bot.announceVersionIfChanged(stubSend);
  assert.strictEqual(sendCalls.length, 0, 'restart STEJNÉ verze (nový proces, stejný datový adresář) nesmí nic oznámit');

  // 4c) simulace upgradu: ručně přepsat perzistovaný stav na starší verzi
  fs.writeFileSync(bot.VERSION_ANNOUNCE_FILE, JSON.stringify({ last_announced_version: '0.0.1-test-predchozi' }), 'utf8');
  sendCalls = [];
  await bot.announceVersionIfChanged(stubSend);
  assert.strictEqual(sendCalls.length, 1, 'upgrade musí oznámit PRÁVĚ JEDNOU');
  assert.strictEqual(sendCalls[0].chatId, 1001, 'oznámení jde Ondrovi (CHAT_ID_ONDRA)');
  assert.ok(sendCalls[0].text.includes(realConfig.version), 'text oznámení obsahuje novou verzi');
  assert.ok(sendCalls[0].text.includes(entry), 'text oznámení obsahuje skutečný changelog, ne vymyšlený');
  state = JSON.parse(fs.readFileSync(bot.VERSION_ANNOUNCE_FILE, 'utf8'));
  assert.strictEqual(state.last_announced_version, realConfig.version, 'stav se po oznámení musí posunout na novou verzi');

  // 4d) hned další "restart" po oznámení → ticho (žádné opakování)
  bot = freshBot(tmp);
  sendCalls = [];
  await bot.announceVersionIfChanged(stubSend);
  assert.strictEqual(sendCalls.length, 0, 'po oznámení se stejná verze nesmí oznamovat znovu ani po dalším restartu');

  // ── 5) nástroj get_version vrací totéž, co getZanVersion() ──
  const toolResult = await bot.executeTool('get_version', {}, 1001);
  assert.strictEqual(toolResult.zan_verze, bot.getZanVersion(), 'nástroj get_version musí souhlasit s běžícím runtime');
  assert.ok(/Voice PE/.test(toolResult.poznamka) || /firmware/i.test(toolResult.poznamka), 'nástroj musí varovat před záměnou s Voice PE firmwarem');

  console.log('check-zan-version: OK (kanonický zdroj + changelog + jednou-a-dost přes restart procesu + tool)');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
