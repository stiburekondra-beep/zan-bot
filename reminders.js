const fs = require('fs');
const path = require('path');

function defaultState() {
  return { version: 1, reminders: [] };
}

function loadReminders(file) {
  try {
    if (!fs.existsSync(file)) return defaultState();
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!parsed || !Array.isArray(parsed.reminders)) return defaultState();
    return {
      version: parsed.version || 1,
      reminders: parsed.reminders.filter(r => r && r.id && r.status),
    };
  } catch {
    return defaultState();
  }
}

function saveReminders(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(state, null, 2), 'utf8');
}

function parseDueAt(value) {
  const due = new Date(value);
  if (!Number.isFinite(due.getTime())) return null;
  return due;
}

function addReminder(file, input, now = new Date()) {
  const due = parseDueAt(input.due_at);
  if (!due) return { error: 'Neplatný čas připomínky. Použij ISO datum s časovou zónou, např. 2026-07-20T07:30:00+02:00.' };
  if (due.getTime() <= now.getTime()) return { error: 'Čas připomínky je v minulosti.' };

  const text = String(input.text || '').trim();
  if (!text) return { error: 'Chybí text připomínky.' };

  const state = loadReminders(file);
  const reminder = {
    id: `r${now.getTime()}_${Math.random().toString(36).slice(2, 8)}`,
    text,
    due_at: due.toISOString(),
    due_at_input: String(input.due_at),
    chat_id: input.chat_id,
    created_by: input.created_by || null,
    created_at: now.toISOString(),
    status: 'pending',
    delivered_at: null,
  };
  state.reminders.push(reminder);
  saveReminders(file, state);
  return { success: true, reminder };
}

function listReminders(file, now = new Date()) {
  const state = loadReminders(file);
  return state.reminders
    .filter(r => r.status === 'pending' && parseDueAt(r.due_at)?.getTime() > now.getTime())
    .sort((a, b) => new Date(a.due_at) - new Date(b.due_at));
}

function cancelReminder(file, id) {
  const state = loadReminders(file);
  const reminder = state.reminders.find(r => r.id === id && r.status === 'pending');
  if (!reminder) return { error: 'Připomínka nenalezena nebo už není aktivní.' };
  reminder.status = 'cancelled';
  reminder.cancelled_at = new Date().toISOString();
  saveReminders(file, state);
  return { success: true, reminder };
}

function dueReminders(file, now = new Date()) {
  const state = loadReminders(file);
  const due = [];
  let changed = false;
  for (const reminder of state.reminders) {
    const dueAt = parseDueAt(reminder.due_at);
    if (reminder.status === 'pending' && dueAt && dueAt.getTime() <= now.getTime()) {
      reminder.status = 'sending';
      due.push(reminder);
      changed = true;
    }
  }
  if (changed) saveReminders(file, state);
  return due;
}

function markReminderDelivered(file, id, deliveredAt = new Date()) {
  const state = loadReminders(file);
  const reminder = state.reminders.find(r => r.id === id);
  if (!reminder) return { error: 'Připomínka nenalezena.' };
  reminder.status = 'delivered';
  reminder.delivered_at = deliveredAt.toISOString();
  saveReminders(file, state);
  return { success: true, reminder };
}

function markReminderPending(file, id, reason) {
  const state = loadReminders(file);
  const reminder = state.reminders.find(r => r.id === id);
  if (!reminder) return { error: 'Připomínka nenalezena.' };
  reminder.status = 'pending';
  reminder.last_error = reason || null;
  saveReminders(file, state);
  return { success: true, reminder };
}

module.exports = {
  addReminder,
  cancelReminder,
  dueReminders,
  listReminders,
  loadReminders,
  markReminderDelivered,
  markReminderPending,
};
