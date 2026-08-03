'use strict';

const fs = require('fs');
const path = require('path');

const VALID_STATUSES = new Set(['open', 'resolved', 'ignored']);
const VALID_SEVERITIES = new Set(['info', 'warning', 'critical']);

function emptyStore() {
  return { version: 1, updated_at: null, items: [] };
}

function safeSlug(value) {
  return String(value || 'repair')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48) || 'repair';
}

function loadRepairInbox(file) {
  try {
    if (!fs.existsSync(file)) return emptyStore();
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return {
      version: 1,
      updated_at: parsed.updated_at || null,
      items: Array.isArray(parsed.items) ? parsed.items : [],
    };
  } catch {
    return emptyStore();
  }
}

function saveRepairInbox(file, store) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const next = {
    version: 1,
    updated_at: new Date().toISOString(),
    items: Array.isArray(store.items) ? store.items : [],
  };
  fs.writeFileSync(file, JSON.stringify(next, null, 2), 'utf8');
  return next;
}

function normalizeRepair(input = {}, now = new Date()) {
  const source = safeSlug(input.source || 'zan');
  const capability = safeSlug(input.capability || 'unknown');
  const dedupeKey = safeSlug(input.dedupe_key || input.title || capability);
  const severity = VALID_SEVERITIES.has(input.severity) ? input.severity : 'warning';
  const status = VALID_STATUSES.has(input.status) ? input.status : 'open';
  const ts = now.toISOString();
  return {
    id: input.id || `${source}_${capability}_${dedupeKey}`,
    status,
    severity,
    source,
    capability,
    title: String(input.title || 'Žán našel problém').slice(0, 160),
    detail: String(input.detail || '').slice(0, 2000),
    next_step: String(input.next_step || 'Zkontrolovat ručně; Žán nic neopravuje sám.').slice(0, 1000),
    evidence: input.evidence && typeof input.evidence === 'object' ? input.evidence : {},
    count: Number.isFinite(input.count) ? input.count : 1,
    created_at: input.created_at || ts,
    updated_at: ts,
  };
}

function upsertRepairItem(file, input = {}, options = {}) {
  const now = options.now || new Date();
  const store = loadRepairInbox(file);
  const item = normalizeRepair(input, now);
  const existing = store.items.find(r => r.id === item.id && r.status === 'open');
  if (existing) {
    existing.severity = item.severity;
    existing.title = item.title;
    existing.detail = item.detail;
    existing.next_step = item.next_step;
    existing.evidence = item.evidence;
    existing.updated_at = item.updated_at;
    existing.count = (Number.isFinite(existing.count) ? existing.count : 1) + 1;
  } else {
    store.items.push(item);
  }
  const saved = saveRepairInbox(file, store);
  return { item: existing || item, store: saved };
}

function listRepairItems(file, options = {}) {
  const store = loadRepairInbox(file);
  const status = options.status || 'open';
  const items = store.items
    .filter(item => status === 'all' || item.status === status)
    .sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')));
  return { ...store, items };
}

function formatRepairInbox(file, options = {}) {
  const { items } = listRepairItems(file, options);
  if (items.length === 0) return '✅ Repair inbox je prázdný.';
  return items.slice(0, options.limit || 12).map(item => {
    const sev = item.severity === 'critical' ? '🚨' : item.severity === 'warning' ? '⚠️' : 'ℹ️';
    return `${sev} ${item.title}\nZdroj: ${item.source} / ${item.capability}\nDalší krok: ${item.next_step}`;
  }).join('\n\n');
}

module.exports = {
  loadRepairInbox,
  saveRepairInbox,
  upsertRepairItem,
  listRepairItems,
  formatRepairInbox,
};
