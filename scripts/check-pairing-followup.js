#!/usr/bin/env node
'use strict';

const assert = require('assert');
const {
  buildPairingNotification,
  buildPairingReminderMessage,
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

const reminder = buildPairingReminderMessage({
  backend: 'zha',
  duration: 60,
});
assert(reminder.includes('doběhlo'));
assert(reminder.includes('zkontroluju nová zařízení'));
assert(!/dej mi vedet|dej mi vědět|napis mi|napiš mi/i.test(reminder));

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
