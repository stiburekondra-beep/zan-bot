const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const {
  addScheduledAction,
  cancelScheduledAction,
  dueScheduledActions,
  listScheduledActions,
  loadActions,
  markActionDone,
  markActionFailed,
} = require('../schedule-action');

const ALLOWED = ['light', 'switch', 'climate', 'media_player'];

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zan-schedule-'));
const file = path.join(dir, 'zan_scheduled_actions.json');

try {
  const now = new Date('2026-08-04T15:00:00.000Z');

  // service akce: přidání, splatnost, provedení
  const svc = addScheduledAction(file, {
    due_at: '2026-08-04T17:10:00+02:00',
    action_type: 'service',
    description: 'rozsvítit obývák',
    domain: 'light',
    service: 'turn_on',
    data: { entity_id: 'light.obyvak' },
    chat_id: 123,
    created_by: 'Ondra',
  }, ALLOWED, now);
  assert.strictEqual(svc.success, true);
  assert.strictEqual(svc.action.status, 'pending');
  assert.strictEqual(svc.action.due_at, '2026-08-04T15:10:00.000Z');

  assert.strictEqual(listScheduledActions(file, now).length, 1);
  assert.strictEqual(dueScheduledActions(file, new Date('2026-08-04T15:09:59.000Z')).length, 0);

  const due = dueScheduledActions(file, new Date('2026-08-04T15:10:00.000Z'));
  assert.strictEqual(due.length, 1);
  assert.strictEqual(loadActions(file).actions[0].status, 'sending');

  markActionDone(file, svc.action.id, new Date('2026-08-04T15:10:01.000Z'));
  assert.strictEqual(loadActions(file).actions[0].status, 'done');
  assert.strictEqual(listScheduledActions(file, now).length, 0);

  // selhání se zapíše a akce se NEopakuje (žádný návrat do pending)
  const fail = addScheduledAction(file, {
    due_at: '2026-08-04T17:20:00+02:00',
    action_type: 'message',
    message: 'zkontroluj garáž',
    chat_id: 123,
  }, ALLOWED, now);
  assert.strictEqual(fail.success, true);
  dueScheduledActions(file, new Date('2026-08-04T15:20:00.000Z'));
  markActionFailed(file, fail.action.id, 'HA offline');
  const failed = loadActions(file).actions.find(a => a.id === fail.action.id);
  assert.strictEqual(failed.status, 'failed');
  assert.strictEqual(failed.last_error, 'HA offline');
  assert.strictEqual(dueScheduledActions(file, new Date('2026-08-04T16:00:00.000Z')).length, 0);

  // cancel
  const cancelMe = addScheduledAction(file, {
    due_at: '2026-08-04T18:00:00+02:00',
    action_type: 'message',
    message: 'x',
    chat_id: 123,
  }, ALLOWED, now);
  assert.strictEqual(cancelScheduledAction(file, cancelMe.action.id).success, true);
  assert.strictEqual(loadActions(file).actions.find(a => a.id === cancelMe.action.id).status, 'cancelled');

  // validace vstupů
  assert.ok(addScheduledAction(file, { due_at: 'bad', action_type: 'message', message: 'x', chat_id: 1 }, ALLOWED, now).error);
  assert.ok(addScheduledAction(file, { due_at: '2026-08-04T14:00:00Z', action_type: 'message', message: 'x', chat_id: 1 }, ALLOWED, now).error, 'minulost');
  assert.ok(addScheduledAction(file, { due_at: '2026-08-20T15:00:00Z', action_type: 'message', message: 'x', chat_id: 1 }, ALLOWED, now).error, 'horizont 7 dní');
  assert.ok(addScheduledAction(file, { due_at: '2026-08-04T16:00:00Z', action_type: 'service', domain: 'lock', service: 'unlock', chat_id: 1 }, ALLOWED, now).error, 'doména mimo whitelist');
  assert.ok(addScheduledAction(file, { due_at: '2026-08-04T16:00:00Z', action_type: 'announce', message: 'x', chat_id: 1 }, ALLOWED, now).error, 'announce bez media_player');
  assert.ok(addScheduledAction(file, { due_at: '2026-08-04T16:00:00Z', action_type: 'sabotage', chat_id: 1 }, ALLOWED, now).error, 'neznámý druh');

  // limit 20 čekajících
  for (let i = 0; i < 20; i += 1) {
    const r = addScheduledAction(file, { due_at: '2026-08-04T19:00:00+02:00', action_type: 'message', message: `m${i}`, chat_id: 1 }, ALLOWED, now);
    assert.strictEqual(r.success, true, `add #${i}`);
  }
  assert.ok(addScheduledAction(file, { due_at: '2026-08-04T19:00:00+02:00', action_type: 'message', message: 'přes limit', chat_id: 1 }, ALLOWED, now).error, 'limit 20');

  console.log('schedule-action contract OK');
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
