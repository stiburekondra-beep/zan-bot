#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { sanitizeVoiceResponse } = require('../voice-response');

function assertVoiceClean(input, expected, label) {
  const out = sanitizeVoiceResponse(input);
  assert.strictEqual(out, expected, label);
  assert(!/[#*_`]/.test(out), `${label}: bez markdown značek`);
  assert(!/\p{Extended_Pictographic}/u.test(out), `${label}: bez emoji`);
  assert(!/(^|\s)[-*+]\s+/m.test(out), `${label}: bez odrážek`);
  assert(out.length <= 260, `${label}: krátký text`);
  return out;
}

assertVoiceClean(
  '**Ahoj!** 😊\n- Zapnul jsem režim.\n- Když chceš, můžu pokračovat.',
  'Ahoj! Zapnul jsem režim.',
  'markdown + emoji + odrážky'
);

assertVoiceClean(
  '# Stav domu\nV obýváku je klid. V kuchyni svítí. Na zahradě nic nového. Další detail můžu říct potom.',
  'Stav domu V obýváku je klid. V kuchyni svítí.',
  'nadpis + více vět'
);

assertVoiceClean(
  'Mrknu na to přes `get_states` a pak ti řeknu výsledek. **Teď** ale nic nespouštím.',
  'Mrknu na to přes get states a pak ti řeknu výsledek. Teď ale nic nespouštím.',
  'inline code + bold'
);

const long = sanitizeVoiceResponse('Tohle je dlouhá odpověď bez tečky '.repeat(20), { maxChars: 120 });
assert(long.length <= 121, 'dlouhý text se zkrátí');
assert(/[.!?…]$/.test(long), 'zkrácený text končí větou');

assert.strictEqual(sanitizeVoiceResponse(''), 'Hotovo.', 'prázdná odpověď má fallback');

console.log('check-voice-response: OK');
