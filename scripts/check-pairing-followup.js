#!/usr/bin/env node
'use strict';

const assert = require('assert');
const {
  buildPairingNotification,
  buildPairingReminderMessage,
  pairingFollowupSuffix,
  runPairingCheck,
  buildPairingCheckMessage,
} = require('../pairing-followup');
const { buildOnboardDeviceRequest } = require('../onboard-device');

const notification = buildPairingNotification({
  phase: 'config_flow',
  category: 'tv',
  handler: 'webostv',
  checkAfterSeconds: 90,
  instruction: 'Potvrď kód na obrazovce TV.',
});

assert.strictEqual(notification.proactive, true);
assert.strictEqual(notification.phase, 'config_flow');
assert.strictEqual(notification.category, 'tv');
assert.strictEqual(notification.handler, 'webostv');
assert.strictEqual(notification.verify_tool, 'get_new_entities');
assert.strictEqual(notification.check_after_seconds, 90);
assert(notification.rule.includes('Nesmí říct hotovo'));

// FALLBACK reminder (použije se jen když reálná kontrola selže) NESMÍ slibovat
// autonomní akci, kterou message-akce neprovede. Dřív tvrdil „Teď zkontroluju…"
// = fabulace follow-through (sc.65). Teď poctivá pobídka.
const reminder = buildPairingReminderMessage({ backend: 'zha', duration: 60 });
assert(reminder.includes('doběhlo'));
assert(!/teď zkontroluju|ted zkontroluju/i.test(reminder), 'fallback nesmí slibovat present-tense kontrolu');
assert(!/ozvu/i.test(reminder), 'fallback nesmí slibovat autonomní ozvání');
assert(/zkontroluj/i.test(reminder), 'fallback má dát konkrétní další krok (pobídku)');

// pairingFollowupSuffix: slib „sám se ozvu" jen když je kontrola REÁLNĚ naplánovaná.
const suffixScheduled = pairingFollowupSuffix(true);
assert(/ozvu/i.test(suffixScheduled), 'naplánováno → smí slíbit ozvání');
const suffixFailed = pairingFollowupSuffix(false);
assert(!/ozvu/i.test(suffixFailed), 'nenaplánováno → nesmí slibovat autonomní ozvání');
assert(/zkontroluj/i.test(suffixFailed), 'nenaplánováno → dát konkrétní další krok');

// runPairingCheck: REÁLNÁ detekce nových entit (states − known baseline),
// testovatelná bez HA přes injektované závislosti.
(async () => {
  const fakeStates = [
    { entity_id: 'light.kuchyne', attributes: { friendly_name: 'Světlo kuchyň' } },
    { entity_id: 'switch.zasuvka_dvur', attributes: { friendly_name: 'Zásuvka dvůr' } },
    { entity_id: 'person.ondra', attributes: {} }, // ignorovaná doména
  ];
  let savedKnown = null;
  const res = await runPairingCheck({
    haGet: async (path) => {
      if (path === 'states') return fakeStates;
      const id = path.replace('states/', '');
      return fakeStates.find(s => s.entity_id === id) || { attributes: {} };
    },
    getKnown: () => ['light.kuchyne'], // kuchyň už známe → nová je jen zásuvka
    setKnown: (v) => { savedKnown = v; },
  });
  assert.strictEqual(res.count, 1, 'jen zásuvka je nová (person ignorován, kuchyň známá)');
  assert.strictEqual(res.entities[0].entity_id, 'switch.zasuvka_dvur');
  assert.strictEqual(res.entities[0].name, 'Zásuvka dvůr');
  assert(Array.isArray(savedKnown) && savedKnown.includes('switch.zasuvka_dvur'), 'baseline se aktualizuje');
  assert(!savedKnown.includes('person.ondra'), 'ignorované domény nejsou v baseline');

  // Kontrola odolnosti: prázdné/nevalidní states nespadnou.
  const empty = await runPairingCheck({ haGet: async () => null, getKnown: () => [], setKnown: () => {} });
  assert.strictEqual(empty.count, 0);

  // buildPairingCheckMessage: zpráva z VÝSLEDKU, ne slib. Nikdy netvrdí „hotovo".
  const found = buildPairingCheckMessage({ backend: 'zha', count: 1, entities: [{ entity_id: 'switch.x', name: 'Zásuvka dvůr' }] });
  assert(found.includes('Zásuvka dvůr'), 'nález obsahuje název entity');
  assert(!/teď zkontroluju|ted zkontroluju/i.test(found), 'nesmí slibovat budoucí kontrolu — už proběhla');
  assert(!/přidal jsem|pridal jsem|hotovo/i.test(found), 'nefabuluje „přidal jsem/hotovo"');

  const none = buildPairingCheckMessage({ backend: 'zha', count: 0, entities: [] });
  assert(/zkontroluj/i.test(none), 'nulový nález → konkrétní další krok');
  assert(!/teď zkontroluju|ted zkontroluju/i.test(none), 'nulový nález nesmí slibovat budoucí kontrolu');

  console.log('pairing-check (reálná kontrola) OK');
})().catch((e) => { console.error(e); process.exit(1); });

const tvNeedsHandler = buildOnboardDeviceRequest({
  category: 'tv',
  candidate: { name: 'LG webOS TV' },
});
assert.strictEqual(tvNeedsHandler.needs_handler, true);
assert.strictEqual(tvNeedsHandler.proactive_notification.proactive, true);
assert.strictEqual(tvNeedsHandler.proactive_notification.phase, 'handler_selection');
assert(tvNeedsHandler.proactive_notification.instruction.includes('neukončuj flow pasivním'));

const plugFlow = buildOnboardDeviceRequest({
  category: 'plug',
  handler: 'shelly',
  candidate: { name: 'Shelly Plug kuchyn' },
  flow_input: { host: '192.168.0.66' },
});
assert.strictEqual(plugFlow.handler, 'shelly');
assert.strictEqual(plugFlow.proactive_notification.phase, 'config_flow');
assert(plugFlow.proactive_notification.instruction.includes('hotovo až po'));

console.log('pairing-followup checks OK');
