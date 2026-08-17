'use strict';
// ═══════════════════════════════════════════════════════════════════════
// KOMUNIKAČNÍ PROFIL DOMÁCNOSTI — jak Žán mluví k tomuhle zákazníkovi.
// Karta 2026-08-16-programator-zana-07 (úrovně odbornosti).
//
// Ondrova definice = závazná (Telegram 16.8. 21:35): min. 3 úrovně:
//   1 = laik (jeho 84letý děda), 2 = běžný člověk (kamarád, zvládá mobil),
//   3 = technicky zdatný (AI nadšenec = dnešní default chování Žána na Ondru).
//
// Toto je JEDNA persona vrstva — záměrně strukturovaná tak, aby do stejného
// `memory.communication` objektu později zapadl i TÓN (karta -03: butler /
// kamarád / dětský) a příznak `dite`, BEZ druhého paralelního systému.
//
// Úroveň mění TÓN a JAZYK, ne PRAVDU: truth-guard a honesty guardy (actuation,
// action-claim, house-map, area-alias) platí na VŠECH úrovních beze změny.
// Úroveň se drží per DOMÁCNOST v /config/zan_data/home_memory.json
// (memory.communication.expertise_level), mimo git. Nastaví ji onboarding
// nebo ruční přepnutí (tool set_communication_level / věta "mluv jednodušeji").
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

// Věta, která JE u KAŽDÉ úrovně stejná — pojistka, že zjednodušení nikdy
// nezamlčí problém. Contract test na ni asertuje pro všechny úrovně.
const TRUTH_INVARIANT =
  'Úroveň mění TÓN a JAZYK, ne PRAVDU: železná pravidla, přiznání nejistoty ' +
  'a honesty guardy platí na všech úrovních stejně — nikdy nezamlčuj problém ' +
  'kvůli jednoduchosti a nefabuluj úspěch.';

function normalizeLevel(value) {
  const n = Number(value);
  if (Number.isInteger(n) && n >= 1 && n <= 3) return n;
  return null;
}

// Přečti úroveň z paměti domácnosti; když není nastavená nebo je nevalidní,
// spadni na bezpečný default. NIKDY nevyhazuj — čte se u každé zprávy.
function getExpertiseLevel(memory) {
  const raw = memory && memory.communication && memory.communication.expertise_level;
  return normalizeLevel(raw) || DEFAULT_EXPERTISE_LEVEL;
}

// Nastav úroveň per domácnost. Vytvoří memory.communication, když chybí, ale
// NEPŘEPÍŠE ostatní klíče (forward-compat pro `ton`/`dite` z karty -03).
function setExpertiseLevel(memory, level) {
  const n = normalizeLevel(level);
  if (!n) return { ok: false, error: 'Úroveň odbornosti musí být 1, 2 nebo 3.' };
  if (!memory.communication || typeof memory.communication !== 'object') memory.communication = {};
  memory.communication.expertise_level = n;
  return { ok: true, level: n, label: LEVELS[n].label };
}

// Blok do DYNAMICKÉHO (necachovaného) kontextu systémového promptu — úroveň se
// liší per domácnost, proto NESMÍ jít do SYSTEM_STATIC (rozbil by prompt cache).
function renderCommunicationInstruction(memory) {
  const level = getExpertiseLevel(memory);
  const info = LEVELS[level];
  return [
    `ÚROVEŇ ODBORNOSTI ZÁKAZNÍKA: ${info.label}.`,
    info.rule,
    TRUTH_INVARIANT,
  ].join('\n');
}

module.exports = {
  LEVELS,
  DEFAULT_EXPERTISE_LEVEL,
  TRUTH_INVARIANT,
  normalizeLevel,
  getExpertiseLevel,
  setExpertiseLevel,
  renderCommunicationInstruction,
};
