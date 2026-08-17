'use strict';

// Jednorázové odložené akce — „za 10 minut rozsviť", „ve 21:00 zkontroluj
// garáž a dej vědět". Zobecnění reminders.js z „pošli zprávu" na „proveď
// akci": stejný vzor úložiště (JSON v zan_data, přežije restart add-onu),
// stejný stavový automat pending → sending → done/failed, stejný tick
// z časovače v bot.js. Vzniklo 2026-08-04 (rozhodnutí „Žán = sluha-dům",
// vlna 2 — viz CHoS- research/2026-08-04_zan-sluha-dum-navrh-postupu.md).
//
// Druhy akcí (nic jiného modul nepustí):
//   service  — HA služba {domain, service, data}; domény omezuje whitelist
//              předaný z bot.js (stejný ALLOWED_DOMAINS jako živé call_service)
//   message  — text do Telegram chatu, kde akce vznikla
//   announce — TTS oznámení přes announce_home (media_player + message)

const fs = require('fs');
const path = require('path');

const ACTION_TYPES = new Set(['service', 'message', 'announce']);

function defaultState() {
  return { version: 1, actions: [] };
}

function loadActions(file) {
  try {
    if (!fs.existsSync(file)) return defaultState();
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!parsed || !Array.isArray(parsed.actions)) return defaultState();
    return {
      version: parsed.version || 1,
      actions: parsed.actions.filter(a => a && a.id && a.status),
    };
  } catch {
    return defaultState();
  }
}

function saveActions(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(state, null, 2), 'utf8');
}

function parseDueAt(value) {
  const due = new Date(value);
  if (!Number.isFinite(due.getTime())) return null;
  return due;
}

function validateActionInput(input, allowedDomains) {
  const type = String(input.action_type || '');
  if (!ACTION_TYPES.has(type)) {
    return `Neznámý druh akce "${type}". Povolené: ${[...ACTION_TYPES].join(', ')}.`;
  }
  if (type === 'service') {
    const domain = String(input.domain || '');
    if (!domain || !input.service) return 'Akce service potřebuje domain a service.';
    if (!allowedDomains.includes(domain)) return `Doména ${domain} není povolena.`;
  }
  if (type === 'message' && !String(input.message || '').trim()) {
    return 'Akce message potřebuje text zprávy.';
  }
  if (type === 'announce') {
    if (!String(input.message || '').trim()) return 'Akce announce potřebuje text oznámení.';
    if (!String(input.media_player_entity_id || '').trim()) {
      return 'Akce announce potřebuje media_player_entity_id (ověř přes get_states).';
    }
  }
  return null;
}

function addScheduledAction(file, input, allowedDomains, now = new Date()) {
  const due = parseDueAt(input.due_at);
  if (!due) return { error: 'Neplatný čas. Použij ISO datum s časovou zónou, např. 2026-08-04T21:30:00+02:00.' };
  if (due.getTime() <= now.getTime()) return { error: 'Čas akce je v minulosti.' };
  // Horizont 7 dní: jednorázový záměr, ne náhrada automatizace. Co se má
  // dít opakovaně nebo za týdny, patří do balíčku (write_package), kde je
  // vidět a přežije to i výpadek bota.
  if (due.getTime() - now.getTime() > 7 * 24 * 3600 * 1000) {
    return { error: 'Akce je dál než 7 dní — na to je automatizace v balíčku (write_package), ne jednorázový plán.' };
  }

  const validationError = validateActionInput(input, allowedDomains);
  if (validationError) return { error: validationError };

  const state = loadActions(file);
  const pendingCount = state.actions.filter(a => a.status === 'pending').length;
  if (pendingCount >= 20) {
    return { error: 'Už čeká 20 naplánovaných akcí — zruš nějakou (cancel), než přidáš další.' };
  }

  const action = {
    id: `a${now.getTime()}_${Math.random().toString(36).slice(2, 8)}`,
    action_type: input.action_type,
    description: String(input.description || '').trim() || null,
    due_at: due.toISOString(),
    due_at_input: String(input.due_at),
    domain: input.domain || null,
    service: input.service || null,
    data: input.data || null,
    message: input.message || null,
    media_player_entity_id: input.media_player_entity_id || null,
    // Interní příznak pro pairing follow-up: exekutor u message-akce místo
    // pouhého odeslání textu spustí reálnou kontrolu nových entit (viz
    // schedulePairingFollowup / executeDueScheduledActions v bot.js).
    pairing_check: input.pairing_check === true || null,
    backend: input.backend || null,
    chat_id: input.chat_id,
    created_by: input.created_by || null,
    created_at: now.toISOString(),
    status: 'pending',
    executed_at: null,
    last_error: null,
  };
  state.actions.push(action);
  saveActions(file, state);
  return { success: true, action };
}

function listScheduledActions(file, now = new Date()) {
  const state = loadActions(file);
  return state.actions
    .filter(a => a.status === 'pending' && parseDueAt(a.due_at)?.getTime() > now.getTime())
    .sort((a, b) => new Date(a.due_at) - new Date(b.due_at));
}

function cancelScheduledAction(file, id) {
  const state = loadActions(file);
  const action = state.actions.find(a => a.id === id && a.status === 'pending');
  if (!action) return { error: 'Naplánovaná akce nenalezena nebo už není aktivní.' };
  action.status = 'cancelled';
  action.cancelled_at = new Date().toISOString();
  saveActions(file, state);
  return { success: true, action };
}

function dueScheduledActions(file, now = new Date()) {
  const state = loadActions(file);
  const due = [];
  let changed = false;
  for (const action of state.actions) {
    const dueAt = parseDueAt(action.due_at);
    if (action.status === 'pending' && dueAt && dueAt.getTime() <= now.getTime()) {
      action.status = 'sending';
      due.push(action);
      changed = true;
    }
  }
  if (changed) saveActions(file, state);
  return due;
}

function markActionDone(file, id, executedAt = new Date()) {
  const state = loadActions(file);
  const action = state.actions.find(a => a.id === id);
  if (!action) return { error: 'Akce nenalezena.' };
  action.status = 'done';
  action.executed_at = executedAt.toISOString();
  saveActions(file, state);
  return { success: true, action };
}

function markActionFailed(file, id, reason) {
  // Jeden pokus, žádné tiché opakování: selhaná odložená akce se hlásí
  // člověku (bot.js pošle zprávu do chatu) — opakovat zapnutí kotle
  // o půlnoci bez dozoru je horší než to nezkusit.
  const state = loadActions(file);
  const action = state.actions.find(a => a.id === id);
  if (!action) return { error: 'Akce nenalezena.' };
  action.status = 'failed';
  action.last_error = reason || null;
  saveActions(file, state);
  return { success: true, action };
}

module.exports = {
  addScheduledAction,
  cancelScheduledAction,
  dueScheduledActions,
  listScheduledActions,
  loadActions,
  markActionDone,
  markActionFailed,
};
