'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  loadRepairInbox,
  upsertRepairItem,
  listRepairItems,
  formatRepairInbox,
} = require('../repair-inbox');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zan-repairs-'));
const file = path.join(tmp, 'zan_repairs.json');

assert.deepStrictEqual(loadRepairInbox(file).items, []);

const first = upsertRepairItem(file, {
  source: 'onboard_device',
  capability: 'onboard_device',
  dedupe_key: 'plug_no_handler',
  severity: 'warning',
  title: 'Přidání zásuvky selhalo',
  detail: 'HA config flow vrátil chybu.',
  next_step: 'Doplnit výrobce/model, netipovat handler.',
  evidence: { category: 'plug' },
}, { now: new Date('2026-08-03T04:00:00.000Z') }).item;

assert.strictEqual(first.status, 'open');
assert.strictEqual(first.id, 'onboard_device_onboard_device_plug_no_handler');

const second = upsertRepairItem(file, {
  source: 'onboard_device',
  capability: 'onboard_device',
  dedupe_key: 'plug_no_handler',
  title: 'Přidání zásuvky selhalo znovu',
  next_step: 'Pořád netipovat handler.',
}, { now: new Date('2026-08-03T04:05:00.000Z') }).item;

assert.strictEqual(second.id, first.id);
assert.strictEqual(listRepairItems(file).items.length, 1);
assert.strictEqual(listRepairItems(file).items[0].count, 2);
assert.ok(formatRepairInbox(file).includes('Přidání zásuvky selhalo znovu'));

upsertRepairItem(file, {
  source: 'watchdog',
  capability: 'read_error_log',
  dedupe_key: 'telegram_polling_dead',
  severity: 'critical',
  title: 'Telegram příjem se nepodařilo obnovit',
}, { now: new Date('2026-08-03T04:06:00.000Z') });

assert.strictEqual(listRepairItems(file).items.length, 2);
assert.ok(fs.readFileSync(file, 'utf8').includes('"version": 1'));

fs.rmSync(tmp, { recursive: true, force: true });
console.log('repair inbox contract OK');
