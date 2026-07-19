const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const {
  addReminder,
  cancelReminder,
  dueReminders,
  listReminders,
  loadReminders,
  markReminderDelivered,
  markReminderPending,
} = require('../reminders');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zan-reminders-'));
const file = path.join(dir, 'zan_reminders.json');

try {
  const now = new Date('2026-07-19T15:00:00.000Z');

  const added = addReminder(file, {
    due_at: '2026-07-19T17:05:00+02:00',
    text: 'zkontrolovat rekuperaci',
    chat_id: 123,
    created_by: 'Radek',
  }, now);
  assert.strictEqual(added.success, true);
  assert.strictEqual(added.reminder.status, 'pending');
  assert.strictEqual(added.reminder.due_at, '2026-07-19T15:05:00.000Z');

  assert.strictEqual(listReminders(file, now).length, 1);
  assert.strictEqual(dueReminders(file, new Date('2026-07-19T15:04:59.000Z')).length, 0);

  const due = dueReminders(file, new Date('2026-07-19T15:05:00.000Z'));
  assert.strictEqual(due.length, 1);
  assert.strictEqual(loadReminders(file).reminders[0].status, 'sending');

  markReminderPending(file, added.reminder.id, 'network');
  assert.strictEqual(loadReminders(file).reminders[0].status, 'pending');
  assert.strictEqual(loadReminders(file).reminders[0].last_error, 'network');

  dueReminders(file, new Date('2026-07-19T15:05:01.000Z'));
  markReminderDelivered(file, added.reminder.id, new Date('2026-07-19T15:05:02.000Z'));
  assert.strictEqual(loadReminders(file).reminders[0].status, 'delivered');
  assert.strictEqual(listReminders(file, now).length, 0);

  const future = addReminder(file, {
    due_at: '2026-07-19T17:30:00+02:00',
    text: 'zavolat domu',
    chat_id: 123,
  }, now);
  assert.strictEqual(future.success, true);
  assert.strictEqual(cancelReminder(file, future.reminder.id).success, true);
  assert.strictEqual(loadReminders(file).reminders.find(r => r.id === future.reminder.id).status, 'cancelled');

  assert.ok(addReminder(file, { due_at: 'bad', text: 'x', chat_id: 1 }, now).error);
  assert.ok(addReminder(file, { due_at: '2026-07-19T14:59:00Z', text: 'x', chat_id: 1 }, now).error);

  console.log('reminders contract OK');
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
