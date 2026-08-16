'use strict';

const fs = require('fs');
const path = require('path');

const CRITICAL_DOMAINS = new Set([
  'alarm_control_panel',
  'lock',
  'climate',
  'cover',
  'fan',
  'vacuum',
  'person',
  'device_tracker',
  'zone',
  'siren',
  'water_heater',
  'humidifier',
]);

// Bezpečnostní device_class z HA (kouř/CO/plyn/únik/přehřátí) — kritické i v ne-kritické
// doméně (typicky binary_sensor). HA je nastavuje spolehlivě, takže je to robustnější
// signál než klíčové slovo v názvu, které bezpečnostní entita generického jména mine.
const CRITICAL_DEVICE_CLASSES = new Set([
  'smoke',
  'gas',
  'carbon_monoxide',
  'safety',
  'moisture',
  'heat',
]);

const DEFAULT_SKIP_DOMAINS = new Set([
  'zone',
  'sun',
  'person',
  'device_tracker',
  'persistent_notification',
  'weather',
  'update',
]);

const CRITICAL_TEXT_RE = /alarm|z[aá]mek|zamek|lock|vrata|br[aá]na|kotel|bojler|topen[ií]|tepel|heat|pump|[cč]erpadlo|ventil|voda|plyn|gas|rekuper|klima|climate|cover|garage|gar[aá][zž]/i;

function nowIso() {
  return new Date().toISOString();
}

function readJson(file, fallback) {
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {}
  return fallback;
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8');
}

function emptyArchive() {
  return {
    version: 1,
    updated_at: nowIso(),
    note: 'Archiv entit: entity se nemažou, jen se skrývají v HA entity registry a tady zůstává audit pro obnovu.',
    archived: [],
  };
}

function loadArchive(file) {
  const archive = readJson(file, emptyArchive());
  if (!archive || !Array.isArray(archive.archived)) return emptyArchive();
  if (!archive.version) archive.version = 1;
  if (!archive.note) archive.note = emptyArchive().note;
  return archive;
}

function saveArchive(file, archive) {
  archive.updated_at = nowIso();
  writeJson(file, archive);
}

function domainOf(entityId) {
  return String(entityId || '').split('.')[0];
}

function textFor(entity = {}, state = {}) {
  return [
    entity.entity_id,
    entity.name,
    entity.original_name,
    entity.platform,
    state?.attributes?.friendly_name,
  ].filter(Boolean).join(' ');
}

function deviceClassOf(entity = {}, state = {}) {
  return String(
    state?.attributes?.device_class ||
    entity.device_class ||
    entity.original_device_class ||
    '',
  ).toLowerCase();
}

function isCriticalEntity(entity = {}, state = {}) {
  const entityId = entity.entity_id || state.entity_id || '';
  const domain = domainOf(entityId);
  if (CRITICAL_DOMAINS.has(domain)) return true;
  // Strukturální signál (device_class) má přednost před jménem: kouřový/CO/plynový
  // detektor generického jména (binary_sensor.hall_01) je pořád bezpečnostní entita.
  if (CRITICAL_DEVICE_CLASSES.has(deviceClassOf(entity, state))) return true;
  return CRITICAL_TEXT_RE.test(textFor(entity, state));
}

function stateAgeMs(state, now = Date.now()) {
  const t = Date.parse(state?.last_changed || state?.last_updated || '');
  return Number.isFinite(t) ? Math.max(0, now - t) : Infinity;
}

function formatAge(ms) {
  if (!Number.isFinite(ms)) return 'neznámě dlouho';
  const mins = Math.max(1, Math.round(ms / 60000));
  if (mins < 90) return `${mins} min`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours} h`;
  return `${Math.round(hours / 24)} d`;
}

function normalizeEntity(entity = {}, statesById = new Map(), now = Date.now()) {
  const state = statesById.get(entity.entity_id) || null;
  const name = entity.name || entity.original_name || state?.attributes?.friendly_name || entity.entity_id;
  const hiddenBy = entity.hidden_by || null;
  const disabledBy = entity.disabled_by || null;
  return {
    entity_id: entity.entity_id,
    domain: domainOf(entity.entity_id),
    name,
    platform: entity.platform || '',
    area_id: entity.area_id || '',
    device_id: entity.device_id || '',
    state: state?.state || 'missing',
    last_changed: state?.last_changed || state?.last_updated || '',
    age_ms: state ? stateAgeMs(state, now) : Infinity,
    hidden_by: hiddenBy,
    disabled_by: disabledBy,
    critical: isCriticalEntity(entity, state),
  };
}

function candidateReason(item, minAgeMs) {
  if (item.hidden_by || item.disabled_by) return 'už je skrytá nebo disabled v HA registry';
  if ((item.state === 'unavailable' || item.state === 'unknown') && item.age_ms >= minAgeMs) {
    return `je ${item.state} ${formatAge(item.age_ms)}`;
  }
  if (item.state === 'missing') return 'je v entity registry, ale chybí ve stavech HA';
  return '';
}

function findArchiveEntry(archive, entityId) {
  return archive.archived.find(e => e.entity_id === entityId && !e.restored_at) || null;
}

function buildEntityArchiveCandidates({ states = [], entityRegistry = [], archiveFile, minAgeMs = 7 * 24 * 60 * 60 * 1000, now = Date.now() }) {
  const archive = loadArchive(archiveFile);
  const statesById = new Map((Array.isArray(states) ? states : []).map(s => [s.entity_id, s]));
  const entities = Array.isArray(entityRegistry) && entityRegistry.length
    ? entityRegistry
    : (Array.isArray(states) ? states : []).map(s => ({
      entity_id: s.entity_id,
      name: s.attributes?.friendly_name || s.entity_id,
      original_name: s.attributes?.friendly_name || s.entity_id,
    }));

  const archivedIds = new Set(archive.archived.filter(e => !e.restored_at).map(e => e.entity_id));
  const candidates = [];
  const blocked = [];

  for (const entity of entities) {
    if (!entity.entity_id) continue;
    const domain = domainOf(entity.entity_id);
    if (DEFAULT_SKIP_DOMAINS.has(domain)) continue;
    if (archivedIds.has(entity.entity_id)) continue;
    const item = normalizeEntity(entity, statesById, now);
    const reason = candidateReason(item, minAgeMs);
    if (!reason) continue;
    const output = {
      entity_id: item.entity_id,
      name: item.name,
      domain: item.domain,
      state: item.state,
      age: formatAge(item.age_ms),
      reason,
      safe_to_archive: !item.critical,
    };
    if (item.critical) blocked.push({ ...output, reason: `${reason}; blokováno jako kritická entita` });
    else candidates.push(output);
  }

  return {
    generated_at: new Date(now).toISOString(),
    min_age_ms: minAgeMs,
    candidates,
    blocked,
    archived_count: archive.archived.filter(e => !e.restored_at).length,
    safety: 'Kandidáti jsou návrh. Archivace vyžaduje confirmed:true a kritické entity se nikdy neschovají tímhle nástrojem.',
  };
}

async function archiveEntity({ archiveFile, entityId, reason = '', states = [], entityRegistry = [], haWsCommand, confirmed = false, actor = 'Žán' }) {
  if (!confirmed) return { success: false, error: 'Archivace vyžaduje explicitní confirmed:true po lidském potvrzení konkrétní entity.' };
  if (!entityId) return { success: false, error: 'Chybí entity_id.' };
  const statesById = new Map((Array.isArray(states) ? states : []).map(s => [s.entity_id, s]));
  const entity = (Array.isArray(entityRegistry) ? entityRegistry : []).find(e => e.entity_id === entityId) || { entity_id: entityId };
  const normalized = normalizeEntity(entity, statesById);
  if (normalized.critical) return { success: false, error: 'Tato entita vypadá kriticky (alarm/zámek/topení/vrata/čerpadlo/ventil). Nejde archivovat automaticky.' };

  await haWsCommand('config/entity_registry/update', { entity_id: entityId, hidden_by: 'user' });

  const archive = loadArchive(archiveFile);
  const existing = findArchiveEntry(archive, entityId);
  const entry = {
    entity_id: entityId,
    name: normalized.name,
    domain: normalized.domain,
    archived_at: nowIso(),
    archived_by: actor,
    reason: reason || 'ručně potvrzená archivace',
    previous_hidden_by: normalized.hidden_by,
    previous_disabled_by: normalized.disabled_by,
    restore: 'Obnova nastaví hidden_by zpět na původní hodnotu.',
  };
  if (existing) Object.assign(existing, entry);
  else archive.archived.push(entry);
  saveArchive(archiveFile, archive);

  return { success: true, entity_id: entityId, hidden_by: 'user', archive_entry: entry };
}

async function restoreEntity({ archiveFile, entityId, haWsCommand, confirmed = false, actor = 'Žán' }) {
  if (!confirmed) return { success: false, error: 'Obnova vyžaduje explicitní confirmed:true po lidském potvrzení konkrétní entity.' };
  if (!entityId) return { success: false, error: 'Chybí entity_id.' };
  const archive = loadArchive(archiveFile);
  const entry = findArchiveEntry(archive, entityId);
  if (!entry) return { success: false, error: `Entita ${entityId} není v aktivním archivu.` };

  await haWsCommand('config/entity_registry/update', {
    entity_id: entityId,
    hidden_by: entry.previous_hidden_by || null,
  });

  entry.restored_at = nowIso();
  entry.restored_by = actor;
  saveArchive(archiveFile, archive);
  return { success: true, entity_id: entityId, hidden_by: entry.previous_hidden_by || null, archive_entry: entry };
}

function listArchive(archiveFile) {
  const archive = loadArchive(archiveFile);
  const active = archive.archived.filter(e => !e.restored_at);
  return {
    count: active.length,
    archived: active,
    restored_count: archive.archived.length - active.length,
    data_file: archiveFile,
    safety: archive.note,
  };
}

function formatEntityArchiveList(result) {
  if (!result.archived || result.archived.length === 0) return 'Archiv entit je prázdný.';
  return [
    `Archiv entit: ${result.count} skrytých položek.`,
    ...result.archived.slice(0, 30).map(e => `- ${e.name || e.entity_id} (${e.entity_id}) — ${e.reason || 'bez důvodu'}, archivováno ${e.archived_at}`),
  ].join('\n');
}

module.exports = {
  CRITICAL_DOMAINS,
  buildEntityArchiveCandidates,
  archiveEntity,
  restoreEntity,
  listArchive,
  formatEntityArchiveList,
  isCriticalEntity,
};
