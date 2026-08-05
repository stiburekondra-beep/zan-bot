'use strict';

// house-map-guard.js
// Deterministická pojistka proti fabulaci sousednosti z PRÁZDNÉ mapy domu.
//
// Bug 2026-08-05 (live smoke v5.11.6, scénář 25): na dotaz „co je vedle
// kuchyně?" Žán odpověděl „Podle mapy domu: vedle kuchyně — Obývák, Zádveří…",
// přitom house_map byla úplně prázdná (0 vazeb) — sousednost si vymyslel a
// vydal ji za data z mapy. Přiznal se až po přímé výzvě. System-prompt pravidlo
// „Sousednost ani místnost nikdy nefabuluj" (bot.js tool-spec a MAPA DOMU sekce)
// to živě NEzastavilo — LLM tvrzení protlačil, stejně jako u bugu
// „pracovna = Dílna" (viz area-alias-guard.js). Tahle vrstva běží AŽ na hotovém
// textu odpovědi, takže nezávisí na tom, jestli model poslechl.
//
// Princip (úzký, near-zero false-positive): guard zasáhne JEN když odpověď
// PŘIPISUJE sousednost/uspořádání MAPĚ DOMU („podle mapy domu…", „z mapy domu…")
// A reálná house_map nemá ŽÁDNOU uloženou sousednost (0 hran). Takový výrok je
// z definice fabulace — mapa nemá co ukazovat. Nahradíme ho poctivým přiznáním.
// Když mapa sousednost MÁ (počet hran > 0), guard mlčí a nechá legitimní čtení
// projít beze změny (nehází falešné selhání).
//
// Hranice (vědomá, dokumentovaná — jako u actuation-guard multi-target):
//  - Guard cílí na tvrzení ODVOLÁVAJÍCÍ SE NA MAPU. Holou domněnku o sousednosti
//    bez odkazu na mapu („vedle kuchyně je obývák") tenhle guard neřeší —
//    rozlišit ji od legitimní věty (poloha věci, uživatel právě řekl půdorys)
//    bez odkazu na zdroj by mělo vysoké riziko false-positive. Tam drží první
//    obranu honest tool-output (mapa vrací „0 vazeb") + system prompt.
//  - Fabulace VĚCÍ v prázdné mapě (ne sousednost) je samostatná třída, mimo
//    scope téhle karty (scénář 25 = sousednost).

function stripDiacritics(s) {
  return String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '');
}

function norm(s) {
  return stripDiacritics(String(s == null ? '' : s).toLowerCase()).replace(/\s+/g, ' ').trim();
}

// Odpověď se výslovně odvolává na mapu domu jako zdroj.
const ATTRIBUTES_TO_MAP = /podle mapy domu|z mapy domu|v mape domu (?:mam|je|jsou|ukazuje|stoji)|mapa domu (?:ukazuje|rika|obsahuje|ma )|podle house ?map|dle mapy domu/;
// Odpověď tvrdí konkrétní sousednost / prostorové uspořádání.
const CLAIMS_ADJACENCY = /soused|vedle|naproti|prilehl|hranic|next to|adjacent/;

const HONEST =
  'Mapu domu ještě nemám naplněnou — uloženou sousednost místností v ní zatím nemám, ' +
  'takže ti teď spolehlivě neřeknu, co s čím sousedí (nechci si to domýšlet). ' +
  'Řekni mi, které místnosti spolu sousedí (nebo mi potvrď půdorys), a doplním to do mapy — ' +
  'příště odpovím rovnou z ní.';

// text: hotová odpověď Žána.
// adjacencyCount: počet hran v house_map. Smí být číslo NEBO funkce (volá se
//   líně, až když text nese signály — ať se soubor mapy nečte u každé zprávy).
// Vrací { text, changed, reason }.
function guardHouseMap(text, adjacencyCount) {
  if (!text || typeof text !== 'string') return { text, changed: false };
  const n = norm(text);

  // Levné signály nejdřív — teprve pak sáhni po počtu hran (líný file read).
  if (!ATTRIBUTES_TO_MAP.test(n)) return { text, changed: false };
  if (!CLAIMS_ADJACENCY.test(n)) return { text, changed: false };

  const count = typeof adjacencyCount === 'function'
    ? (Number(adjacencyCount()) || 0)
    : (Number(adjacencyCount) || 0);
  if (count > 0) return { text, changed: false }; // mapa má reálnou sousednost → nezasahuj

  return { text: HONEST, changed: true, reason: 'empty-house-map-adjacency-claim' };
}

module.exports = { guardHouseMap, _norm: norm };
