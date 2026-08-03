#!/usr/bin/env node

const assert = require('assert');
const {
  buildCareProfile,
  buildConsentState,
  consentIsActive,
  evaluateCareEvent,
  validateCareRule,
} = require('../care-profile');

const enabled = buildConsentState({
  action: 'enable',
  subject: 'Děda',
  recipient: 'Vnuk Petr',
  explained_at: '2026-07-28T18:40:00+02:00',
  accepted_at: '2026-07-28T18:41:00+02:00',
});
assert.strictEqual(enabled.ok, true);
assert.strictEqual(consentIsActive(enabled.consent), true);
assert.deepStrictEqual(enabled.consent.allowed_signals, ['fall', 'long_inactivity', 'sos', 'activity']);

const disabled = buildConsentState({
  action: 'disable',
  current: enabled.consent,
  revoked_at: '2026-07-28T18:45:00+02:00',
});
assert.strictEqual(disabled.ok, true);
assert.strictEqual(consentIsActive(disabled.consent), false);

const missingRecipient = buildConsentState({ action: 'enable', subject: 'Děda' });
assert.strictEqual(missingRecipient.ok, false);
assert(missingRecipient.error.includes('konkrétního příjemce'));

const safeInactivity = validateCareRule({
  signal: 'dlouhá nečinnost',
  source: 'binary_sensor.mmwave_obyvak_presence',
  message: 'Žán vidí dlouhou nečinnost. Prosím koukni, jestli je všechno v pořádku.',
});
assert.strictEqual(safeInactivity.ok, true);
assert.strictEqual(safeInactivity.signal, 'long_inactivity');
assert.strictEqual(safeInactivity.safe_payload.shares_raw_data, false);

const fall = validateCareRule({
  signal: 'pád',
  source: 'binary_sensor.mmwave_fall',
  message: 'Žán zachytil možný pád. Je to doplňková notifikace rodině, není to náhrada tísňové linky ani lékaře.',
});
assert.strictEqual(fall.ok, true);
assert.strictEqual(fall.signal, 'fall');
assert.strictEqual(fall.warnings.length, 0);

const rawHealth = validateCareRule({
  signal: 'activity',
  source: 'sensor.band',
  raw_data: ['heart_rate', 'sleep'],
  message: 'Děda má aktivitu.',
});
assert.strictEqual(rawHealth.ok, false);
assert(rawHealth.errors.some(e => e.includes('Surová zdravotní data')));

const medicalClaim = validateCareRule({
  signal: 'activity',
  source: 'sensor.band',
  message: 'Tep 48 znamená problém se srdcem.',
});
assert.strictEqual(medicalClaim.ok, false);
assert(medicalClaim.errors.some(e => e.includes('zdravotní tvrzení')));

const unknownSignal = validateCareRule({
  signal: 'blood_pressure',
  source: 'sensor.band_pressure',
  message: 'Tlak mimo rozsah.',
});
assert.strictEqual(unknownSignal.ok, false);
assert(unknownSignal.errors.some(e => e.includes('odvozené signály')));

const blockedNoConsent = evaluateCareEvent({
  consent: {},
  rule: {
    signal: 'sos',
    source: 'button.sos',
    message: 'Žán dostal SOS požadavek o pomoc.',
  },
});
assert.strictEqual(blockedNoConsent.action, 'blocked');
assert.strictEqual(blockedNoConsent.reason, 'missing_consent');

const notify = evaluateCareEvent({
  consent: enabled.consent,
  rule: {
    signal: 'sos',
    source: 'button.sos',
    message: 'Žán dostal SOS požadavek o pomoc.',
  },
});
assert.strictEqual(notify.action, 'notify');
assert.strictEqual(notify.notification.recipient, 'Vnuk Petr');
assert.strictEqual(notify.notification.shares_raw_data, false);

const profile = buildCareProfile({
  current_consent: enabled.consent,
  rules: [
    { signal: 'fall', source: 'binary_sensor.mmwave_fall' },
    { signal: 'long_inactivity', source: 'binary_sensor.mmwave_presence' },
  ],
});
assert.strictEqual(profile.status, 'draft_ready');
assert.strictEqual(profile.safety.sends_messages, false);
assert.strictEqual(profile.safety.writes_home_assistant, false);

console.log('care-profile checks OK');
