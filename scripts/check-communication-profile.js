#!/usr/bin/env node
'use strict';
// Contract test komunikačního profilu (karty 2026-08-16-programator-zana-07 +
// 2026-08-17-programator-zana-03). Bez modelu, bez HA — čistá logika persona
// vrstvy. Hlídá:
//  - 3 úrovně odbornosti + 3 tóny dle Ondrovy definice existují,
//  - úroveň 1 = bez žargonu (rule instruuje zákaz technických slov),
//  - truth-guard drží na VŠECH úrovních I tónech (invariant v každém renderu),
//  - dětský tón / dite NEODEMYKÁ citlivou akci (bezpečnostní hrana v renderu),
//  - obě osy žijí v JEDNOM `memory.communication` objektu (setTon nezničí úroveň),
//  - default per domácnost, validace, fallbacky.

const assert = require('assert');
const {
  LEVELS,
  TONES,
  DEFAULT_EXPERTISE_LEVEL,
  DEFAULT_TON,
  TRUTH_INVARIANT,
  CHILD_SAFETY_INVARIANT,
  normalizeLevel,
  normalizeTon,
  getExpertiseLevel,
  getTon,
  isChild,
  setExpertiseLevel,
  setTon,
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

// ═══════════════════════════════════════════════════════════════════════
// TÓN (karta 2026-08-17-programator-zana-03) — druhá osa téže persona vrstvy
// ═══════════════════════════════════════════════════════════════════════

// ── 3 tóny existují (Ondrova definice: butler / kamarád / dětský) ────────
ok(TONES.butler && TONES.kamarad && TONES.detsky, '3 tóny definované');
ok(!TONES.formal && !TONES.robot, 'mimo definované tóny nic není');
ok(/vykej|uctiv/.test(TONES.butler.rule.toLowerCase()), 'butler = vykání/uctivost');
ok(/tykání|tykani|pohodov|uvolnen/.test(TONES.kamarad.rule.toLowerCase()), 'kamarád = tykání/pohoda');
ok(/hrav|laskav|trpěliv|trpeliv/.test(TONES.detsky.rule.toLowerCase()), 'dětský = laskavý/hravý');

// ── normalizace + default ───────────────────────────────────────────────
ok(normalizeTon('BUTLER') === 'butler', 'case-insensitive normalizace tónu');
ok(normalizeTon(' kamarad ') === 'kamarad', 'trim tónu');
ok(normalizeTon('robot') === null && normalizeTon(3) === null, 'neznámý/nevalidní tón odmítnut');
ok(DEFAULT_TON === 'butler', 'default tón = butler (uctivý sluha)');
ok(getTon({}) === 'butler', 'prázdná paměť → default butler (AK: neznámý profil = butler)');
ok(getTon(null) === 'butler', 'null paměť → butler (nevyhazuje)');
ok(getTon({ communication: { ton: 'kamarad' } }) === 'kamarad', 'čte nastavený tón');
ok(getTon({ communication: { ton: 'nonsense' } }) === 'butler', 'nevalidní uložený tón → butler');

// ── isChild: explicitní dite NEBO ton=detsky ────────────────────────────
ok(isChild({ communication: { dite: true } }) === true, 'dite:true → dítě');
ok(isChild({ communication: { ton: 'detsky' } }) === true, 'ton detsky → dítě (implikuje hranu)');
ok(isChild({ communication: { ton: 'butler' } }) === false, 'butler dospělý → není dítě');
ok(isChild({}) === false && isChild(null) === false, 'prázdná/null paměť → není dítě (nefabuluj identitu)');

// ── JEDNA persona vrstva: setTon nezničí úroveň odbornosti a naopak ──────
const persona = { communication: { expertise_level: 3 }, residents: {} };
const st = setTon(persona, 'kamarad');
ok(st.ok === true && st.ton === 'kamarad', 'setTon kamarad projde');
ok(persona.communication.expertise_level === 3, 'setTon NEPŘEPÍŠE expertise_level (jedna vrstva)');
ok(persona.communication.ton === 'kamarad', 'tón zapsán do stejného communication objektu');
ok(persona.residents && typeof persona.residents === 'object', 'ostatní paměť nedotčena');
// a zpět: setExpertiseLevel nezničí tón
setExpertiseLevel(persona, 1);
ok(persona.communication.ton === 'kamarad' && persona.communication.expertise_level === 1, 'obě osy koexistují');

// setTon detsky → dite=true automaticky (dětský rejstřík = dětská hrana)
const kidMem = {};
const kt = setTon(kidMem, 'detsky');
ok(kt.ok === true && kidMem.communication.dite === true, 'setTon detsky nastaví dite=true');
// explicitní dite override
const mem3 = {};
setTon(mem3, 'kamarad', true);
ok(mem3.communication.dite === true, 'explicitní dite=true respektován i u ne-dětského tónu (dítě mluví přes kamarádský profil)');
// nevalidní tón odmítnut
ok(setTon({}, 'robot').ok === false, 'setTon odmítne neznámý tón');
// host guard (jen data-vrstva ověřuje bot.js; tady čistá logika)

// ── render nese TÓN a truth invariant DRŽÍ na VŠECH tónech (AK 5a) ───────
for (const ton of ['butler', 'kamarad', 'detsky']) {
  const out = renderCommunicationInstruction({ communication: { expertise_level: 2, ton } });
  ok(out.includes(TONES[ton].label), `render tón ${ton} nese svůj label`);
  ok(out.includes(TRUTH_INVARIANT), `render tón ${ton} DRŽÍ truth invariant (tón nemění pravdu)`);
  ok(out.includes(LEVELS[2].label), `render tón ${ton} pořád nese úroveň odbornosti (ortogonální osy)`);
}

// ── dětský tón / dite NEODEMYKÁ citlivou akci (AK 5b) ────────────────────
const childRender = renderCommunicationInstruction({ communication: { expertise_level: 1, ton: 'detsky' } });
ok(childRender.includes(CHILD_SAFETY_INVARIANT), 'dětský tón render obsahuje bezpečnostní hranu');
ok(/dosp[ěe]l/.test(childRender.toLowerCase()) && /zámk|zamk|alarm/.test(childRender.toLowerCase()),
  'bezpečnostní hrana jmenuje dospělé potvrzení + citlivé akce (zámky/alarm)');
const diteAdultTone = renderCommunicationInstruction({ communication: { expertise_level: 2, ton: 'kamarad', dite: true } });
ok(diteAdultTone.includes(CHILD_SAFETY_INVARIANT), 'dite:true přidá hranu i u kamarádského tónu');
// dospělý (butler/kamarad bez dite) hranu NEMÁ — je to jen pro děti, ne šum všude
const adultRender = renderCommunicationInstruction({ communication: { expertise_level: 3, ton: 'butler' } });
ok(!adultRender.includes(CHILD_SAFETY_INVARIANT), 'dospělý profil nenese dětskou hranu (jen kde má)');
// KRITICKÉ: hrana REINFORCUJE, nikdy nezmírní — nikde neříká, že dítě smí víc
ok(!/dítě smí|dite smi|bez potvrzení|bez potvrzeni/.test(childRender.toLowerCase()),
  'dětská hrana NIKDY neodemyká — žádné "dítě smí" / "bez potvrzení"');

console.log(`communication-profile ok: ${n} kontrol`);
