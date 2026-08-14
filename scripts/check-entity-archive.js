#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  buildEntityArchiveCandidates,
  archiveEntity,
  restoreEntity,
  listArchive,
  isCriticalEntity,
} = require('../entity-archive');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zan-entity-archive-'));
const archiveFile = path.join(tmp, 'entity_archive.json');
const old = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
const states = [
  { entity_id: 'sensor.stary_test', state: 'unavailable', last_changed: old, attributes: { friendly_name: 'Starý test' } },
  { entity_id: 'lock.vchod', state: 'unavailable', last_changed: old, attributes: { friendly_name: 'Zámek vchod' } },
  { entity_id: 'switch.ventil_voda', state: 'unavailable', last_changed: old, attributes: { friendly_name: 'Ventil voda' } },
  { entity_id: 'light.obyvak', state: 'on', last_changed: old, attributes: { friendly_name: 'Obývák' } },
];
const entityRegistry = [
  { entity_id: 'sensor.stary_test', name: 'Starý test', platform: 'test' },
  { entity_id: 'lock.vchod', name: 'Zámek vchod', platform: 'test' },
  { entity_id: 'switch.ventil_voda', name: 'Ventil voda', platform: 'test' },
  { entity_id: 'light.obyvak', name: 'Obývák', platform: 'test' },
  { entity_id: 'sensor.registry_missing', name: 'Registry missing', platform: 'test' },
];

const candidates = buildEntityArchiveCandidates({
  states,
  entityRegistry,
  archiveFile,
  minAgeMs: 7 * 24 * 60 * 60 * 1000,
});
assert(candidates.candidates.some(c => c.entity_id === 'sensor.stary_test'), 'dlouho unavailable sensor je kandidát');
assert(candidates.candidates.some(c => c.entity_id === 'sensor.registry_missing'), 'registry-only entita je kandidát');
assert(!candidates.candidates.some(c => c.entity_id === 'light.obyvak'), 'dostupná entita není kandidát');
assert(candidates.blocked.some(c => c.entity_id === 'lock.vchod'), 'lock je blokovaný');
assert(candidates.blocked.some(c => c.entity_id === 'switch.ventil_voda'), 'ventil podle názvu je blokovaný');
assert(isCriticalEntity({ entity_id: 'climate.loznice', name: 'Klima' }), 'climate je kritická doména');

(async () => {
  const calls = [];
  const haWsCommand = async (command, data) => {
    calls.push([command, data]);
    return { ok: true };
  };

  const notConfirmed = await archiveEntity({
    archiveFile,
    entityId: 'sensor.stary_test',
    states,
    entityRegistry,
    haWsCommand,
    confirmed: false,
  });
  assert.strictEqual(notConfirmed.success, false, 'archive bez confirmed odmítne');
  assert.strictEqual(calls.length, 0, 'bez confirmed nevolá HA');

  const critical = await archiveEntity({
    archiveFile,
    entityId: 'lock.vchod',
    states,
    entityRegistry,
    haWsCommand,
    confirmed: true,
  });
  assert.strictEqual(critical.success, false, 'kritická entita nejde archivovat');
  assert.strictEqual(calls.length, 0, 'kritická entita nevolá HA');

  const archived = await archiveEntity({
    archiveFile,
    entityId: 'sensor.stary_test',
    reason: 'už se nepoužívá',
    states,
    entityRegistry,
    haWsCommand,
    confirmed: true,
    actor: 'test',
  });
  assert.strictEqual(archived.success, true, 'potvrzený bezpečný sensor se archivuje');
  assert.deepStrictEqual(calls[0], ['config/entity_registry/update', { entity_id: 'sensor.stary_test', hidden_by: 'user' }], 'archive skrývá přes HA registry');
  const archive = listArchive(archiveFile);
  assert.strictEqual(archive.count, 1, 'archiv drží jednu aktivní položku');
  assert.strictEqual(archive.archived[0].reason, 'už se nepoužívá');

  const restoredNoConfirm = await restoreEntity({ archiveFile, entityId: 'sensor.stary_test', haWsCommand, confirmed: false });
  assert.strictEqual(restoredNoConfirm.success, false, 'restore bez confirmed odmítne');
  assert.strictEqual(calls.length, 1, 'restore bez confirmed nevolá HA');

  const restored = await restoreEntity({ archiveFile, entityId: 'sensor.stary_test', haWsCommand, confirmed: true, actor: 'test' });
  assert.strictEqual(restored.success, true, 'potvrzený restore projde');
  assert.deepStrictEqual(calls[1], ['config/entity_registry/update', { entity_id: 'sensor.stary_test', hidden_by: null }], 'restore vrací hidden_by');
  assert.strictEqual(listArchive(archiveFile).count, 0, 'po restore není aktivně archivovaná');

  console.log('entity-archive ok');
})().catch(err => {
  console.error(err);
  process.exit(1);
});
