const assert = require('assert');
const { evaluateActuation, isUnavailableStateValue } = require('../actuation-guard');

// Bug 2026-08-05-programator-zana-03: Žán hlásil úspěch aktuace na entitě, kterou
// sám označil za `unavailable` (zbminir2 offline → „Hurá, zapnul jsem 💡" do tmy).
// Guard běží na stavu cílové entity PO aktuaci a poctivý report vynutí deterministicky.

// 1) Přesná repro: unavailable světlo po turn_on NESMÍ hlásit úspěch.
const r1 = evaluateActuation({
  action: 'turn_on',
  entityId: 'light.zbminir2',
  postState: { entity_id: 'light.zbminir2', state: 'unavailable' },
});
assert.strictEqual(r1.success, false, '1: unavailable turn_on nesmí být success');
assert.strictEqual(r1.confirmed, false, '1: nesmí být confirmed');
assert.strictEqual(r1.unavailable, true, '1: příznak unavailable');
assert.ok(/nedostupn/i.test(r1.message), '1: report přiznává nedostupnost');
assert.ok(!/^✅/.test(r1.message), '1: žádná ✅ hláška úspěchu');
assert.ok(!/zapnuto\b(?!.*nedostupn)/i.test(r1.message) || /nemůžu potvrdit/i.test(r1.message), '1: nehlásí bezvýhradné zapnuto');

// 2) turn_off na unavailable — stejná poctivost (druhý pattern z bugu, msg 267/268).
const r2 = evaluateActuation({
  action: 'turn_off',
  entityId: 'light.zbminir2_2',
  postState: { state: 'unknown' },
});
assert.strictEqual(r2.success, false, '2: unknown turn_off nesmí být success');
assert.ok(/nedostupn/i.test(r2.message), '2: report přiznává nedostupnost');

// 3) Zdravé zařízení (state=on) po turn_on → potvrzený úspěch jako dřív.
const r3 = evaluateActuation({
  action: 'turn_on',
  entityId: 'light.kuchyn',
  postState: { state: 'on' },
});
assert.strictEqual(r3.success, true, '3: dostupné zařízení = success');
assert.strictEqual(r3.confirmed, true, '3: confirmed true');
assert.ok(/^✅/.test(r3.message), '3: potvrzená hláška s ✅');
assert.ok(/zapnuto/.test(r3.message), '3: obsahuje zapnuto');

// 4) toggle zdravého zařízení (state=off) → success (toggle nekontroluje směr, jen dostupnost).
const r4 = evaluateActuation({ action: 'toggle', entityId: 'switch.ventilator', postState: { state: 'off' } });
assert.strictEqual(r4.success, true, '4: dostupný toggle = success');
assert.ok(/přepnuto/.test(r4.message), '4: obsahuje přepnuto');

// 5) Stav se nepodařilo přečíst (null) → NEházet falešné selhání, jen neověřeno.
const r5 = evaluateActuation({ action: 'turn_on', entityId: 'light.x', postState: null });
assert.strictEqual(r5.success, true, '5: nečitelný stav nesmí být falešné selhání');
assert.strictEqual(r5.confirmed, false, '5: ale není potvrzeno');
assert.strictEqual(r5.unverified, true, '5: příznak unverified');
assert.ok(/nemůžu ověřit/i.test(r5.message), '5: report přiznává neověření');

// 6) Holý string stavu (ne objekt) funguje taky.
const r6 = evaluateActuation({ action: 'turn_off', entityId: 'light.y', postState: 'unavailable' });
assert.strictEqual(r6.success, false, '6: holý string unavailable = ne-success');

// 7) isUnavailableStateValue: přesná množina.
assert.strictEqual(isUnavailableStateValue('unavailable'), true, '7a');
assert.strictEqual(isUnavailableStateValue('unknown'), true, '7b');
assert.strictEqual(isUnavailableStateValue('on'), false, '7c');
assert.strictEqual(isUnavailableStateValue('off'), false, '7d');
assert.strictEqual(isUnavailableStateValue(''), false, '7e');

console.log('actuation-guard: OK (7 kontrol)');
