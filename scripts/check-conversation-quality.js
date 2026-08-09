const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  analyzeConversationLog,
  classifyAssistant,
  classifyUserIntent,
  parseConversationLine,
} = require('../conversation-quality');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zan-conversation-quality-'));
const logFile = path.join(tmp, 'zan_conversation.log');
const qualityFile = path.join(tmp, 'conversation_quality.jsonl');

const sensitiveSentence = 'Kde je vedle kuchyně Zádveří a máš to fakt uložené?';
fs.writeFileSync(logFile, [
  `[2026-08-09T10:00:00.000Z] USER chat=123456(Ondra): ${sensitiveSentence}`,
  '[2026-08-09T10:00:01.000Z] ŽÁN chat=123456(Ondra): Mapa domu není naplněná, potřebuju půdorys nebo potvrzenou sousednost.',
  '[2026-08-09T10:01:00.000Z] USER chat=789012(Tester): pusť světlo',
  '[2026-08-09T10:01:02.000Z] ŽÁN chat=789012(Tester): Hotovo, světlo je zapnuté.',
  '[2026-08-09T10:02:00.000Z] USER chat=789012(Tester): to máš fakt uložené, nebo hádáš?',
  '[2026-08-09T10:02:01.000Z] ŽÁN chat=789012(Tester): Omlouvám se, to jsem si vymyslel.',
  '',
].join('\n'), 'utf8');

assert.deepStrictEqual(parseConversationLine('[2026-08-09T10:00:00.000Z] USER chat=1(A): ahoj'), {
  ts: '2026-08-09T10:00:00.000Z',
  role: 'USER',
  chat_id: '1',
  user: 'A',
  text: 'ahoj',
});
assert.strictEqual(classifyUserIntent('Vrať poslední změnu'), 'action_request');
assert.strictEqual(classifyAssistant('Potřebuju CO2 čidlo.', 'question'), 'missing_data');
assert.strictEqual(classifyAssistant('To jsem si vymyslel.', 'correction_or_probe'), 'possible_failure');

const result = analyzeConversationLog(logFile, qualityFile, { maxLines: 100 });
assert.strictEqual(result.records_written, 3);
assert.strictEqual(result.summary.total_assistant_turns, 3);
assert.strictEqual(result.summary.counts.missing_data, 1);
assert.strictEqual(result.summary.counts.answered, 1);
assert.strictEqual(result.summary.counts.possible_failure, 1);
assert.ok(result.summary.backlog.some(item => item.category === 'missing_data'));

const qualityText = fs.readFileSync(qualityFile, 'utf8');
assert.ok(qualityText.includes('"chat_hash"'));
assert.ok(!qualityText.includes('Zádveří'));
assert.ok(!qualityText.includes('půdorys'));
assert.ok(!qualityText.includes('světlo je zapnuté'));

console.log('conversation quality contract OK');
