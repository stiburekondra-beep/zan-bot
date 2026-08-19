'use strict';
// ═══════════════════════════════════════════════════════════════════════
// KOMUNIKAČNÍ PROFIL DOMÁCNOSTI — jak Žán mluví k tomuhle zákazníkovi.
// Karta 2026-08-16-programator-zana-07 (úrovně odbornosti) + 2026-08-17-programator-zana-03 (tón).
//
// JEDNA persona vrstva, DVĚ ORTOGONÁLNÍ osy — obě žijí ve stejném
// `memory.communication` objektu, jeden render, žádný druhý paralelní systém:
//   • ODBORNOST (expertise_level 1–3) = JAK SLOŽITĚ/technicky Žán mluví (žargon
//     vs. lidsky). Ondra 16.8.: 1 = laik/senior, 2 = běžný člověk, 3 = nadšenec.
//   • TÓN (ton = butler | kamarad | detsky) = JAKÝ REJSTŘÍK má — uctivý sluha /
//     pohodový kamarád / laskavý dětský. Ondra 17.8.: „nekdy britsky butler,
//     nekdy kamos, k detem jinak nez k dospelim." Ortogonální: lze „prostě +
//     kamarádsky" i „prostě + uctivě".
//   • `dite` (bool) = aktuálně mluví dítě → dětský rejstřík + BEZPEČNOSTNÍ HRANA.
//
// Úroveň ANI tón NEMĚNÍ PRAVDU: truth-guard a honesty guardy (actuation,
// action-claim, house-map, area-alias) platí na VŠECH nastaveních beze změny.
// Dětský tón NIKDY nezmírní oprávnění — citlivé akce (zámky, alarm, topení/HVAC,
// nákup, mazání konfigurace) pořád vyžadují dospělé potvrzení. Hravost je
// v JAZYCE, ne v OPRÁVNĚNÍCH.
//
// Profil se drží per DOMÁCNOST v /config/zan_data/home_memory.json
// (memory.communication.{expertise_level, ton, dite}), mimo git. Nastaví ho
// onboarding nebo ruční přepnutí (set_communication_level / set_communication_tone
// / věta „mluv jednodušeji" / „buď víc formální"). Per-osoba volba tónu po hlase
// je pozdější nadstavba nad speaker-ID (karta -07, zavřená koncept) — v1 jede
// explicitní nastavení + fallback butler, identitu Žán nefabuluje.
// ═══════════════════════════════════════════════════════════════════════

// Bezpečný default pro cizí/neznámou domácnost = 2 (běžný člověk, bez žargonu,
// ale snese detail). Ondrův dům si nastaví 3 explicitně. Nikdy 1 by mohlo znít
// blahosklonně na zdatného; nikdy 3 by na segment (rodiny, co se AI bojí)
// házelo žargon. Střed je nejmíň bolestivá chyba, když úroveň ještě neznáme.
const DEFAULT_EXPERTISE_LEVEL = 2;

const LEVELS = {
  1: {
    label: 'úroveň 1 — laik (např. senior)',
    rule:
      'Mluv maximálně jednoduše a krátce, trpělivě, jedna věc po druhé. ŽÁDNÝ ' +
      'technický žargon — nikdy neříkej „entita", „integrace", „restart HA", ' +
      '„unavailable", „YAML", „config", „log" ani ID zařízení typu light.kitchen. ' +
      'Důsledky vysvětli lidsky: řekni „světlo v kuchyni teď nesvítí", ne ' +
      '„light.kitchen je unavailable". Když něco nejde, řekni to prostě a nabídni ' +
      'jeden konkrétní další krok.',
  },
  2: {
    label: 'úroveň 2 — běžný člověk (zvládá mobil a internet)',
    rule:
      'Mluv přátelsky a normálně, bez technického balastu, ale snese víc detailu. ' +
      'Můžeš odkázat na tlačítko nebo appku. Vyhni se hlubokému žargonu (ID entit, ' +
      'YAML, čísla verzí), dokud se na to sám nezeptá.',
  },
  3: {
    label: 'úroveň 3 — technicky zdatný (AI / smart-home nadšenec)',
    rule:
      'Mluv technicky přesně: entity, verze, nástroje, ID — tak jak je zvyklý ' +
      'zkušený uživatel. Detail neškodí, ale pořád drž běžnou stručnost.',
  },
};

// Bezpečný default tónu pro nový/neznámý profil = uctivý sluha (butler). Nikdy
// nezačít „kamarádsky" (tykání neznámému může urazit) ani „dětsky" (fabulace
// identity). Butler je zdvořilá jistota; teplý okruh si kamaráda nastaví sám.
const DEFAULT_TON = 'butler';

const TONES = {
  butler: {
    label: 'sluha / butler — uctivý, zdvořilý',
    rule:
      'Mluv jako zdvořilý sluha: vykej, klidně a uctivě, bez familiárnosti. ' +
      'Oslovení zdvořilé, emoji střídmě nebo vůbec. Příklad rejstříku: „Rád ' +
      'zařídím. Světla v obývaku jsou zhasnutá."',
  },
  kamarad: {
    label: 'kamarád — pohodový, uvolněný',
    rule:
      'Mluv jako pohodový kamarád: uvolněně, tykání je v pořádku, klidně emoji, ' +
      'ale pořád služebně a k věci. Příklad rejstříku: „Jasně, zhasínám. Hotovo 👍"',
  },
  detsky: {
    label: 'dětský — laskavý, hravý, trpělivý',
    rule:
      'Mluv laskavě, jednoduše a hravě, trpělivě, povzbudivě. Žádná ironie, ' +
      'sarkasmus ani nic nevhodného pro dítě. Příklad rejstříku: „Ahoj! Rozsvítím ' +
      'ti v pokoji, ať vidíš. 🙂"',
  },
};

// Věta, která JE u KAŽDÉHO nastavení stejná — pojistka, že zjednodušení ani tón
// nikdy nezamlčí problém. Contract test na ni asertuje pro všechny úrovně i tóny.
const TRUTH_INVARIANT =
  'Úroveň ani tón mění TÓN a JAZYK, ne PRAVDU: železná pravidla, přiznání ' +
  'nejistoty a honesty guardy platí na všech nastaveních stejně — nikdy ' +
  'nezamlčuj problém kvůli jednoduchosti nebo hravosti a nefabuluj úspěch.';

// Bezpečnostní hrana pro dětský tón / když mluví dítě. Přidává se do renderu JEN
// při dite=true nebo ton=detsky — reinforcuje, NIKDY nezmírní, existující gate
// (citlivé akce vyžadují výslovné potvrzení). Contract test asertuje, že dětské
// nastavení oprávnění NEODEMYKÁ, jen jazyk.
const CHILD_SAFETY_INVARIANT =
  'DĚTSKÁ BEZPEČNOST: hravý/dětský tón nemění OPRÁVNĚNÍ. Citlivé akce — zámky, ' +
  'alarm, zabezpečení, topení/klimatizace, nákup, mazání nebo psaní konfigurace ' +
  '— pořád vyžadují potvrzení dospělého v této konverzaci. Dítěti je nikdy ' +
  'neprováděj sám a nikdy je neusnadňuj kvůli tónu.';

function normalizeLevel(value) {
  const n = Number(value);
  if (Number.isInteger(n) && n >= 1 && n <= 3) return n;
  return null;
}

function normalizeTon(value) {
  if (typeof value !== 'string') return null;
  const t = value.trim().toLowerCase();
  return TONES[t] ? t : null;
}

// Přečti úroveň z paměti domácnosti; když není nastavená nebo je nevalidní,
// spadni na bezpečný default. NIKDY nevyhazuj — čte se u každé zprávy.
function getExpertiseLevel(memory) {
  const raw = memory && memory.communication && memory.communication.expertise_level;
  return normalizeLevel(raw) || DEFAULT_EXPERTISE_LEVEL;
}

// Přečti tón z paměti; nenastavený/nevalidní → bezpečný default (butler).
// NIKDY nevyhazuj — čte se u každé zprávy.
function getTon(memory) {
  const raw = memory && memory.communication && memory.communication.ton;
  return normalizeTon(raw) || DEFAULT_TON;
}

// Aktuálně mluví dítě? Explicitní `dite:true` NEBO ton=detsky (dětský rejstřík
// implikuje dětskou bezpečnostní hranu). Fallback false — identitu nefabuluj.
function isChild(memory) {
  const c = memory && memory.communication;
  if (!c) return false;
  return c.dite === true || normalizeTon(c.ton) === 'detsky';
}

function ensureCommunication(memory) {
  if (!memory.communication || typeof memory.communication !== 'object') memory.communication = {};
  return memory.communication;
}

// Nastav úroveň per domácnost. Vytvoří memory.communication, když chybí, ale
// NEPŘEPÍŠE ostatní klíče (forward-compat pro `ton`/`dite` z karty -03).
function setExpertiseLevel(memory, level) {
  const n = normalizeLevel(level);
  if (!n) return { ok: false, error: 'Úroveň odbornosti musí být 1, 2 nebo 3.' };
  ensureCommunication(memory).expertise_level = n;
  return { ok: true, level: n, label: LEVELS[n].label };
}

// Nastav TÓN (a volitelně příznak dítě) per domácnost. Píše do STEJNÉHO
// `memory.communication` objektu vedle expertise_level — jedna persona vrstva,
// NEPŘEPÍŠE úroveň odbornosti (contract test to asertuje).
function setTon(memory, ton, dite) {
  const t = normalizeTon(ton);
  if (!t) return { ok: false, error: 'Tón musí být butler, kamarad nebo detsky.' };
  const c = ensureCommunication(memory);
  c.ton = t;
  if (typeof dite === 'boolean') c.dite = dite;
  else if (t === 'detsky') c.dite = true; // dětský rejstřík implikuje dětskou hranu
  return { ok: true, ton: t, dite: c.dite === true, label: TONES[t].label };
}

// Bezpečnostní rozhodnutí volané z bot.js: SMÍ tenhle požadavek vypnout dětskou
// hranu? `dite === false` je JEDINÁ cesta, jak setTon zruší dětský příznak (změna
// tónu bez explicitního boolean dite ho nechává být — viz setTon výše). Vypnutí
// dětské hrany je bezpečnostní krok → volající vrstva ho smí povolit jen adminovi;
// dítě (role user) si nesmí samo zrušit dětský příznak a odemknout reinforcement.
// (Tester reziduál sc.67, karta 2026-08-17-programator-zana-03.)
function tonRequestDisablesChildGuard(dite) {
  return dite === false;
}

// Blok do DYNAMICKÉHO (necachovaného) kontextu systémového promptu — profil se
// liší per domácnost, proto NESMÍ jít do SYSTEM_STATIC (rozbil by prompt cache).
function renderCommunicationInstruction(memory) {
  const level = getExpertiseLevel(memory);
  const ton = getTon(memory);
  const info = LEVELS[level];
  const tone = TONES[ton];
  const lines = [
    `ÚROVEŇ ODBORNOSTI ZÁKAZNÍKA: ${info.label}.`,
    info.rule,
    `TÓN / REJSTŘÍK: ${tone.label}.`,
    tone.rule,
    TRUTH_INVARIANT,
  ];
  if (isChild(memory)) lines.push(CHILD_SAFETY_INVARIANT);
  return lines.join('\n');
}

module.exports = {
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
  tonRequestDisablesChildGuard,
  renderCommunicationInstruction,
};
