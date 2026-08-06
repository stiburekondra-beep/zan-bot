const assert = require('assert');
const { guardHouseMap } = require('../house-map-guard');

// Bug 2026-08-05 (scénář 25, live v5.11.6): prázdná mapa (0 hran), Žán fabuluje
// sousednost a vydává ji za data z mapy domu.

// 1) Přesná repro věta z bugu (msg 276) + prázdná mapa → guard MUSÍ zasáhnout.
const bug = 'Podle mapy domu: vedle kuchyně — Obývák, Zádveří, což je typické pro otevřený prostor nebo průchod.';
const r1 = guardHouseMap(bug, 0);
assert.strictEqual(r1.changed, true, '1: guard měl zasáhnout na fabulaci z prázdné mapy');
assert.ok(/nemam naplnen|nemam naplnen|domysl|domýšl|potvrd/i.test(r1.text), '1: náhrada je poctivé přiznání');
assert.ok(!/Zádveří/.test(r1.text), '1: vymyšlené místnosti nesmí v odpovědi zůstat');
assert.strictEqual(r1.reason, 'empty-house-map-adjacency-claim', '1: reason nastaven');

// 2) Mapa MÁ sousednost (count > 0) → legitimní čtení, guard NESMÍ zasáhnout.
const legit = 'Podle mapy domu vedle kuchyně sousedí obývák.';
const r2 = guardHouseMap(legit, 3);
assert.strictEqual(r2.changed, false, '2: neprázdná mapa = guard mlčí');
assert.strictEqual(r2.text, legit, '2: text beze změny');

// 3) Prázdná mapa, ale odpověď se NEODVOLÁVÁ na mapu (holá věta) → guard mlčí
//    (úzký scope, aby neházel false-positive na polohu věci apod.).
const noAttr = 'Vedle kuchyně bývá často obývák, ale jistý si nejsem.';
const r3 = guardHouseMap(noAttr, 0);
assert.strictEqual(r3.changed, false, '3: bez odkazu na mapu guard nezasahuje');

// 4) Prázdná mapa, odvolání na mapu, ale BEZ tvrzení o sousednosti → guard mlčí.
const noAdj = 'Podle mapy domu tam zatím nic nemám, mapa je prázdná.';
const r4 = guardHouseMap(noAdj, 0);
assert.strictEqual(r4.changed, false, '4: bez adjacency claimu guard nezasahuje');

// 5) Poctivá odpověď (přiznání) na prázdné mapě se nesmí „opravovat" do nesmyslu,
//    a hlavně se nesmí donekonečna přepisovat — náhrada sama guard znovu nespustí.
const r5 = guardHouseMap(r1.text, 0);
assert.strictEqual(r5.changed, false, '5: poctivá náhrada guard znovu nespustí (žádná smyčka)');

// 6) adjacencyCount jako líná funkce — volá se jen když text nese signály.
let called = 0;
const r6a = guardHouseMap('Dobré ráno, jak se máš?', () => { called++; return 0; });
assert.strictEqual(r6a.changed, false, '6a: nesouvisející text');
assert.strictEqual(called, 0, '6a: file read se nesmí volat u nesouvisející zprávy');
const r6b = guardHouseMap(bug, () => { called++; return 0; });
assert.strictEqual(r6b.changed, true, '6b: na fabulaci se count zjistí');
assert.strictEqual(called, 1, '6b: líný count zavolán právě jednou');

// 7) Diakritika/velikost písmen nesmí guard obejít.
const caps = 'Podle Mapy Domu SOUSEDÍ s kuchyní obývák a ložnice.';
const r7 = guardHouseMap(caps, 0);
assert.strictEqual(r7.changed, true, '7: velká písmena/diakritika neobejdou guard');

console.log('check-house-map-guard: OK (7 kontrol)');
