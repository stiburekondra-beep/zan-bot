#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { upsertRepairItem, loadRepairInbox } = require('../repair-inbox');
const {
  classifyCapability,
  hasRefusalOrLimit,
  hasConcreteNextStep,
  handleCapabilityGap,
} = require('../capability-gap-repair');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zan-capability-gap-'));
const file = path.join(tmp, 'zan_repairs.json');
const now = new Date('2026-08-09T20:30:00.000Z');

const rawUserText = 'Pusť prosím Coldplay dětem v ložnici, ať usnou.';
const bareRefusal = 'To neumím.';
const r1 = handleCapabilityGap(bareRefusal, rawUserText, {
  repairFile: file,
  upsertRepair: upsertRepairItem,
  now,
});
assert.strictEqual(r1.changed, true, 'holé neumím musí dostat další krok');
assert.strictEqual(r1.recorded, true, 'capability gap se zapíše do repair inboxu');
assert.strictEqual(r1.capability, 'music', 'hudební požadavek se klasifikuje jako music');
assert.ok(/Poznamenal jsem si to/.test(r1.text), 'odpověď obsahuje lidské poznamenání bez firemního žargonu');
assert.ok(!/mezera pro firmu|firma rozhodne|ověřit to testem/i.test(r1.text), 'uživatelský text nesmí nést interní firemní žargon');

const saved1 = fs.readFileSync(file, 'utf8');
assert.ok(!saved1.includes(rawUserText), 'raw věta uživatele se nesmí uložit do repair inboxu');
assert.ok(!saved1.includes('Coldplay dětem v ložnici'), 'citlivý detail z požadavku nesmí protéct do repair inboxu');
assert.ok(saved1.includes('"privacy": "raw_conversation_not_stored"'), 'evidence výslovně říká, že raw text není uložen');

const r2 = handleCapabilityGap('Teď to neumím pustit, potřebuju zapojený přehrávač.', rawUserText, {
  repairFile: file,
  upsertRepair: upsertRepairItem,
  now: new Date('2026-08-09T20:31:00.000Z'),
});
assert.strictEqual(r2.changed, false, 'odpověď s konkrétním dalším krokem se textově nepřepisuje');
assert.strictEqual(r2.recorded, true, 'i poctivý limit se zapíše jako mezera');

const store = loadRepairInbox(file);
assert.strictEqual(store.items.length, 1, 'stejná capability mezera se deduplikuje');
assert.strictEqual(store.items[0].count, 2, 'opakovaný gap zvýší count místo spamu');
assert.strictEqual(store.items[0].source, 'konverzace', 'zdroj je konverzace');
assert.strictEqual(store.items[0].capability, 'music', 'capability zůstává music');
assert.strictEqual(store.items[0].evidence.privacy, 'raw_conversation_not_stored', 'privacy evidence zůstává');
assert.ok(/CEO\/programátor zkontroluje repair inbox/.test(store.items[0].next_step), 'interní repair next_step zůstává pro firmu');

assert.strictEqual(hasRefusalOrLimit('Jasně, zkusím to.'), false, 'běžná odpověď není limit');
assert.strictEqual(hasRefusalOrLimit('Nemám k tomu přístup.'), true, 'nemám přístup je limit');
assert.strictEqual(hasConcreteNextStep('Nemám k tomu přístup, ale zkus prosím nastavit token.'), true, 'konkrétní další krok se pozná');
assert.strictEqual(classifyCapability('Co je vedle kuchyně?', 'Mapu domu nemám.'), 'house_map', 'mapa domu se klasifikuje');

const r3 = handleCapabilityGap('Nemůžu potvrdit výsledek.', 'zapni světlo', {});
assert.strictEqual(r3.recorded, false, 'bez repairFile/upsert helperu se nic nezapisuje');
assert.strictEqual(r3.changed, true, 'i bez zápisu odpověď dostane další krok');
assert.ok(!/mezera pro firmu|firma rozhodne|ověřit to testem/i.test(r3.text), 'fallback text bez zápisu je pořád lidský');

console.log('capability gap repair contract OK');
