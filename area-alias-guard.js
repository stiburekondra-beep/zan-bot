'use strict';

// area-alias-guard.js
// Deterministická pojistka proti tichému domýšlení místnosti při onboardingu
// zařízení. Řeší bug 2026-07-21-01: Žán u „přidej zásuvku do pracovny" napsal
// „předpokládám, že pracovna = Dílna" a mapoval uživatelovu místnost na jinou
// existující HA area bez potvrzení. System-prompt pravidlo (v5.11.0) to živě
// nezastavilo — LLM alias protlačil i s explicitním zákazem. Tahle vrstva běží
// AŽ na hotovém textu odpovědi, takže nezávisí na tom, jestli model poslechl.
//
// Princip: alias-rovnice „<slovo uživatele> = <existující místnost>" je tvrdě
// zakázaná. Když ji v odpovědi najdeme, nahradíme ji bezpečným dotazem —
// Žán místnost sám nepřekládá, nechá uživatele potvrdit.

function stripDiacritics(s) {
  return String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '');
}

function norm(s) {
  return stripDiacritics(String(s == null ? '' : s).toLowerCase()).replace(/\s+/g, ' ').trim();
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Odstraní vodicí spojky ("že", "ze") ze zachyceného uživatelského slova.
function cleanUserWord(w) {
  return String(w == null ? '' : w).replace(/^\s*(?:že|ze)\s+/i, '').replace(/[„"“”»«']/g, '').trim();
}

// knownAreas: pole názvů místností existujících v HA (memory.rooms hodnoty —
//   buď string, nebo objekt { name }).
// Vrací { text, changed, guesses: [{ userWord, area }] }.
function guardAreaAlias(text, knownAreas) {
  if (!text || typeof text !== 'string') return { text, changed: false, guesses: [] };

  const areas = (Array.isArray(knownAreas) ? knownAreas : [])
    .map(a => (a && typeof a === 'object' && a.name) ? a.name : a)
    .filter(a => typeof a === 'string' && a.trim().length > 0);
  if (areas.length === 0) return { text, changed: false, guesses: [] };

  const knownNorm = new Set(areas.map(norm));
  // RHS rovnice musí být PŘESNĚ některá existující místnost (i víceslovná).
  // Delší názvy dřív, ať „Dětský pokoj" vyhraje nad případným „pokoj".
  const areaAlt = areas
    .slice()
    .sort((a, b) => b.length - a.length)
    .map(escapeRe)
    .join('|');

  // LHS = uživatelovo slovo/fráze (písmena + mezery), RHS = existující místnost.
  // Volitelné uvozovky kolem obou stran; volitelné „= " s mezerami.
  const eqCore = `["„“”»«']?\\s*([\\p{L}][\\p{L} ]{1,30}?)\\s*["„“”»«']?\\s*=\\s*["„“”»«']?\\s*(${areaAlt})\\s*["„“”»«']?`;

  const guesses = [];

  function isAlias(userWordRaw, area) {
    const u = norm(cleanUserWord(userWordRaw));
    const a = norm(area);
    if (!u || !a || u === a) return false;   // stejná místnost → není to alias
    if (knownNorm.has(u)) return false;      // uživatel řekl existující místnost → legit
    return true;
  }

  let out = text;

  // P0: závorka obsahující alias-rovnici → zahoď celou závorku
  //     (typicky „(předpokládám, že „pracovna" = Dílna; pokud ne, řekni …)")
  out = out.replace(/\(([^()]*=[^()]*)\)/gu, (m, inner) => {
    const eq = new RegExp(eqCore, 'iu').exec(inner);
    if (eq && isAlias(eq[1], eq[2])) {
      guesses.push({ userWord: cleanUserWord(eq[1]), area: eq[2] });
      return '';
    }
    return m;
  });

  // P1: holé alias-rovnice mimo závorky → nahraď bezpečným dotazem
  out = out.replace(new RegExp(eqCore, 'giu'), (m, uwRaw, area) => {
    if (isAlias(uwRaw, area)) {
      const uw = cleanUserWord(uwRaw);
      guesses.push({ userWord: uw, area });
      return `„${uw}" (tuhle místnost si sám nepřekládám na jinou — potvrď prosím, kam přesně zařízení patří)`;
    }
    return m;
  });

  // P2: neutralizuj i tvrzení „do místnosti <hádaná area>" — samotný název
  //     místnosti byl zaveden jen tou domněnkou, nechceme ho nechat jako fakt.
  const seenArea = new Set();
  for (const g of guesses) {
    if (seenArea.has(norm(g.area))) continue;
    seenArea.add(norm(g.area));
    const roomRe = new RegExp(
      `(?:do\\s+)?místnost(?:i|ě)?\\s+${escapeRe(g.area)}(?=[\\s.,;:)!?]|$)`,
      'giu'
    );
    out = out.replace(roomRe, `do místnosti, kterou potvrdíš (řekl(a) jsi „${g.userWord}")`);
  }

  // Úklid po zahození závorek: mezera před interpunkcí, dvojité mezery.
  out = out
    .replace(/\s+([.,;:!?])/g, '$1')
    .replace(/\(\s+/g, '(')
    .replace(/\s{2,}/g, ' ')
    .trim();

  return { text: out, changed: guesses.length > 0, guesses };
}

module.exports = { guardAreaAlias, _norm: norm };
