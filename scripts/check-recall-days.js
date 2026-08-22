#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  appendDiaryEntry,
  cleanupOldDiaryFiles,
  diaryFile,
  ensureYesterdaySummary,
  recallDays,
  replaceSummary,
  yesterdaySummaryContext,
} = require('../conversation-diary');
const { VOICE_CONTROL_TOOLS } = require('../tool-profiles');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zan-recall-days-'));
const now = new Date('2026-08-20T10:00:00Z');

appendDiaryEntry(tmp, {
  role: 'USER',
  chatId: 1001,
  userName: 'Ondra',
  text: 'Co jsme resili s tim svetlem v kuchyni?',
  date: new Date('2026-08-19T08:00:00Z'),
}, { timeZone: 'Europe/Prague' });
appendDiaryEntry(tmp, {
  role: 'ZAN',
  chatId: 1001,
  userName: 'Ondra',
  text: 'Resili jsme svetlo v kuchyni a nedostupny vypinac.',
  date: new Date('2026-08-19T08:00:05Z'),
}, { timeZone: 'Europe/Prague' });
appendDiaryEntry(tmp, {
  role: 'USER',
  chatId: 1001,
  userName: 'Ondra',
  text: 'Dnes jen test.',
  date: now,
}, { timeZone: 'Europe/Prague' });

replaceSummary(diaryFile(tmp, '2026-08-19'), '2026-08-19', '- Resilo se svetlo v kuchyni.\n- Otevrene zustalo overit vypinac.');

const yesterday = recallDays(tmp, { daysBack: 1, now, timeZone: 'Europe/Prague' });
assert.strictEqual(yesterday.ok, true, 'vcerejsi denik existuje');
assert.strictEqual(yesterday.date, '2026-08-19', 'days_back=1 cte vcera');
assert.match(yesterday.summary, /svetlo v kuchyni/i, 'vraci vcerejsi shrnuti');

const query = recallDays(tmp, { daysBack: 1, query: 'světlem kuchyni', now, timeZone: 'Europe/Prague' });
assert.strictEqual(query.ok, true, 'query nad denikem probehne');
assert.ok(query.matches.some(line => line.includes('svetlem') || line.includes('svetlo')), 'query najde relevantni radek');

const missing = recallDays(tmp, { daysBack: 3, query: 'nic', now, timeZone: 'Europe/Prague' });
assert.strictEqual(missing.ok, false, 'chybejici den se prizna');
assert.match(missing.message, /nemam ulozeny denik/i, 'chybejici den nema fabulovat');

fs.writeFileSync(diaryFile(tmp, '2026-08-05'), '# Denik rozhovoru 2026-08-05\n', 'utf8');
cleanupOldDiaryFiles(tmp, { now, timeZone: 'Europe/Prague' });
assert.strictEqual(fs.existsSync(diaryFile(tmp, '2026-08-05')), false, 'den 15 je smazany');

replaceSummary(diaryFile(tmp, '2026-08-19'), '2026-08-19', '_zatim nevytvoreno_');
let summarized = false;
Promise.resolve()
  .then(() => ensureYesterdaySummary(tmp, async () => {
    summarized = true;
    return '- Resilo se svetlo.\n- Otevrene zustalo overeni.';
  }, { now, timeZone: 'Europe/Prague' }))
  .then((res) => {
    assert.strictEqual(res.updated, true, 'vcerejsi shrnuti se doplni pri prvnim kole dalsiho dne');
    assert.strictEqual(summarized, true, 'summarizer byl zavolan');
    assert.match(yesterdaySummaryContext(tmp, { now, timeZone: 'Europe/Prague' }), /Resilo se svetlo/, 'dynamicky kontext umi nacist shrnuti vcerejska');

    assert.ok(VOICE_CONTROL_TOOLS.includes('recall_days'), 'hlasovy profil obsahuje recall_days');

    process.env.ZAN_TEST_EXPORTS = '1';
    process.env.ZAN_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'zan-recall-days-bot-'));
    process.env.CHAT_ID_ONDRA = '1001';
    process.env.CHAT_ID_JANA = '1002';
    process.env.TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || 'test-token';
    process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'test-key';
    process.env.HA_URL = process.env.HA_URL || 'http://127.0.0.1:8123';
    process.env.HA_TOKEN = process.env.HA_TOKEN || 'test-ha-token';
    process.env.ZAN_HARNESS_ONLY = '1';
    const bot = require('../bot');
    assert.deepStrictEqual(bot.buildTools(9999).map(t => t.name), [], 'host profil nedostane recall_days ani jine domaci tooly');
    assert.ok(bot.buildTools(bot.CHAT_JANA, 'ovladani').some(t => t.name === 'recall_days'), 'rodina v hlasovem profilu recall_days dostane');
    console.log('check-recall-days: OK');
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
