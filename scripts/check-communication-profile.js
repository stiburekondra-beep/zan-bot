#!/usr/bin/env node
'use strict';
// Contract test komunikačního profilu (karta 2026-08-16-programator-zana-07).
// Bez modelu, bez HA — čistá logika úrovní odbornosti. Hlídá:
//  - 3 úrovně dle Ondrovy definice existují,
//  - úroveň 1 = bez žargonu (rule instruuje zákaz technických slov),
//  - truth-guard drží na VŠECH úrovních (invariant v každém render výstupu),
//  - default per domácnost, validace 1..3, forward-compat pro `ton` (karta -03).

const assert = require('assert');
const {
  LEVELS,
  DEFAULT_EXPERTISE_LEVEL,
  TRUTH_INVARIANT,
  normalizeLevel,
  getExpertiseLevel,
  setExpertiseLevel,
  renderCommunicationInstruction,
} = require('../communication-profile');

let n = 0;
function ok(cond, label) {
  n += 1;
  assert(cond, `FAIL: ${label}`);
}

// ── 3 úrovně existují ───────────────────────────────────────────────────
ok(LEVELS[1] && LEVELS[2] && LEVELS[3], '3 úrovně definované');
ok(!LEVELS[0] && !LEVELS[4], 'mimo 1–3 nic není');

// ── úroveň 1 = bez žargonu (rule instruuje zákaz + dává lidský příklad) ──
const l1 = LEVELS[1].rule.toLowerCase();
ok(/žádný technický žargon|zadny technicky zargon/.test(l1), 'úroveň 1 zakazuje žargon');
for (const banned of ['entita', 'yaml', 'unavailable']) {
  ok(l1.includes(banned), `úroveň 1 jmenuje zakázané slovo příkladem: ${banned}`);
}
ok(l1.includes('light.kitchen'), 'úroveň 1 dává lidský příklad místo entity ID');

// úroveň 3 naopak žargon povoluje (jinak by nebyl rozdíl)
ok(/entity|entita|verze|id/.test(LEVELS[3].rule.toLowerCase()), 'úroveň 3 povoluje technický jazyk');

// ── truth-guard drží na VŠECH úrovních ──────────────────────────────────
for (const lvl of [1, 2, 3]) {
  const out = renderCommunicationInstruction({ communication: { expertise_level: lvl } });
  ok(out.includes(LEVELS[lvl].label), `render úroveň ${lvl} nese svůj label`);
  ok(out.includes(TRUTH_INVARIANT), `render úroveň ${lvl} nese truth invariant (nezamlčet problém)`);
  ok(/honesty guard|nefabuluj|nezamlčuj|nezamlcuj/.test(out.toLowerCase()), `render úroveň ${lvl} připomíná honesty`);
}

// ── default per domácnost ───────────────────────────────────────────────
ok(DEFAULT_EXPERTISE_LEVEL === 2, 'default úroveň = 2 (běžný člověk)');
ok(getExpertiseLevel({}) === 2, 'prázdná paměť → default 2');
ok(getExpertiseLevel(null) === 2, 'null paměť → default 2 (nevyhazuje)');
ok(getExpertiseLevel({ communication: { expertise_level: 1 } }) === 1, 'čte nastavenou úroveň 1');
ok(getExpertiseLevel({ communication: { expertise_level: 99 } }) === 2, 'nevalidní uložená hodnota → default');

// ── normalizace + validace ──────────────────────────────────────────────
ok(normalizeLevel('3') === 3, 'string "3" → 3');
ok(normalizeLevel(2.5) === null, 'necelé číslo odmítnuto');
ok(normalizeLevel(0) === null && normalizeLevel(4) === null, 'mimo rozsah odmítnuto');
ok(normalizeLevel('deda') === null, 'nesmysl odmítnut');

// ── setExpertiseLevel: validace + forward-compat (nezničí `ton`) ─────────
const badSet = setExpertiseLevel({}, 7);
ok(badSet.ok === false && /1, 2 nebo 3/.test(badSet.error), 'set odmítne úroveň mimo rozsah');

const mem = { communication: { ton: 'butler', dite: false }, notes: [] };
const good = setExpertiseLevel(mem, 1);
ok(good.ok === true && good.level === 1, 'set úroveň 1 projde');
ok(mem.communication.expertise_level === 1, 'úroveň zapsána do memory.communication');
ok(mem.communication.ton === 'butler' && mem.communication.dite === false, 'forward-compat: ton/dite zachovány (karta -03)');
ok(Array.isArray(mem.notes), 'ostatní paměť nedotčena');

// set na paměti bez communication objektu ho vytvoří
const mem2 = {};
setExpertiseLevel(mem2, 3);
ok(mem2.communication && mem2.communication.expertise_level === 3, 'communication objekt se vytvoří, když chybí');

console.log(`communication-profile ok: ${n} kontrol`);
