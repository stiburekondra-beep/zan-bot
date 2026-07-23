const assert = require('assert');
const { guardAreaAlias } = require('../area-alias-guard');

// Existující místnosti v HA (tvar jako memory.rooms hodnoty — mix string/objekt).
const areas = ['Dílna', 'Obývák', 'Kuchyň', { name: 'Dětský pokoj' }];

// 1) Přesná repro věta z bugu 2026-07-21-01 (re-test v5.11.0 FAIL).
const bug = 'Po přidání se zeptám: jak ji chceš pojmenovat? (např. „Zásuvka pracovna" ' +
  'nebo „Pracovna — zásuvka") a potvrdím, že jde do místnosti Dílna ' +
  '(předpokládám, že „pracovna" = Dílna; pokud ne, řekni správný název).';
const r1 = guardAreaAlias(bug, areas);
assert.strictEqual(r1.changed, true, '1: guard měl zasáhnout');
assert.ok(!/pracovna["„“”»«'\s]*=\s*Dílna/iu.test(r1.text), '1: alias „pracovna = Dílna" nesmí zůstat');
assert.ok(!/do\s+místnosti\s+Dílna\b/iu.test(r1.text), '1: nesmí zůstat tvrzení „do místnosti Dílna"');
assert.ok(/potvrd/iu.test(r1.text), '1: má vzniknout dotaz na potvrzení místnosti');
assert.ok(r1.guesses.some(g => g.userWord === 'pracovna' && g.area === 'Dílna'), '1: guess zaznamenán');

// 2) Holá rovnice mimo závorky.
const bare = 'Zásuvku dám do místnosti pracovna = Dílna, ok?';
const r2 = guardAreaAlias(bare, areas);
assert.strictEqual(r2.changed, true, '2: holá rovnice má být zachycena');
assert.ok(!/=\s*Dílna/iu.test(r2.text), '2: rovnice odstraněna');
assert.ok(/nepřekládám/iu.test(r2.text), '2: bezpečná náhrada přítomna');

// 3) Víceslovná místnost jako RHS („Dětský pokoj").
const multi = 'Předpokládám, že „ložnice kluků" = Dětský pokoj.';
const r3 = guardAreaAlias(multi, areas);
assert.strictEqual(r3.changed, true, '3: víceslovná area má být zachycena');
assert.ok(!/=\s*Dětský pokoj/iu.test(r3.text), '3: víceslovná rovnice odstraněna');

// 4) Uživatel řekl EXISTUJÍCÍ místnost — žádný alias, guard nesmí zasáhnout.
const legit = 'Potvrdím, že zásuvka jde do místnosti Obývák.';
const r4 = guardAreaAlias(legit, areas);
assert.strictEqual(r4.changed, false, '4: legit místnost se nesmí měnit');
assert.strictEqual(r4.text, legit, '4: text beze změny');

// 5) Ekvivalence sebe sama (Obývák = Obývák) není alias.
const same = 'Beru to jako „obývák" = Obývák.';
const r5 = guardAreaAlias(same, areas);
assert.strictEqual(r5.changed, false, '5: shodná místnost není alias');

// 6) Rovnice, kde RHS není žádná existující místnost (číslo/teplota) — neplést.
const temp = 'Nastavím teplota = 21 °C v ložnici.';
const r6 = guardAreaAlias(temp, areas);
assert.strictEqual(r6.changed, false, '6: RHS není area → žádný zásah');
assert.strictEqual(r6.text, temp, '6: text beze změny');

// 7) Prázdný seznam místností → no-op (nový/čistý dům).
const r7 = guardAreaAlias(bug, []);
assert.strictEqual(r7.changed, false, '7: bez známých místností guard neběží');
assert.strictEqual(r7.text, bug, '7: text beze změny');

// 8) Velikost písmen odolná (dílna vs Dílna — RHS diakritika sedí, liší se case).
const ci = 'Zřejmě „kůlna" = dílna, potvrdím.';
const r8 = guardAreaAlias(ci, areas);
assert.strictEqual(r8.changed, true, '8: case-insensitive match RHS');

console.log('check-area-alias-guard: OK (8 scénářů)');
