const assert = require('assert');
const { normalizeCommandText } = require('../command-text');

const UNAME = 'Dum_Zan_bot';

// ── 1) Se známým username: skupinové varianty se sjednotí na holý příkaz ──
assert.strictEqual(normalizeCommandText('/budget', UNAME), '/budget', 'holý příkaz beze změny');
assert.strictEqual(normalizeCommandText('@Dum_Zan_bot /budget', UNAME), '/budget', 'vedoucí @mention se strippne');
assert.strictEqual(normalizeCommandText('/budget@Dum_Zan_bot', UNAME), '/budget', 'sufix /cmd@bot se strippne');
assert.strictEqual(normalizeCommandText('  /budget  ', UNAME), '/budget', 'okolní whitespace se trimuje');
assert.strictEqual(
  normalizeCommandText('@Dum_Zan_bot /budget@Dum_Zan_bot', UNAME),
  '/budget',
  'mention i sufix naráz',
);

// Case-insensitive na username
assert.strictEqual(normalizeCommandText('@dum_zan_bot /stav', UNAME), '/stav', 'mention case-insensitive');
assert.strictEqual(normalizeCommandText('/stav@DUM_ZAN_BOT', UNAME), '/stav', 'sufix case-insensitive');

// Argument příkazu zůstává
assert.strictEqual(
  normalizeCommandText('@Dum_Zan_bot /onboarding user', UNAME),
  '/onboarding user',
  'argument /onboarding se zachová po strip mention',
);
assert.strictEqual(
  normalizeCommandText('/onboarding@Dum_Zan_bot user', UNAME),
  '/onboarding user',
  'argument /onboarding se zachová po strip sufixu',
);

// ── 2) Mention JINÉHO bota se známým username se NEstrippuje ──
// (příkaz nebyl adresovaný nám → nemá spustit náš handler)
assert.strictEqual(
  normalizeCommandText('@JinyBot /budget', UNAME),
  '@JinyBot /budget',
  'mention jiného bota zůstává (neběží náš příkaz)',
);
assert.strictEqual(
  normalizeCommandText('/budget@JinyBot', UNAME),
  '/budget@JinyBot',
  'sufix jiného bota zůstává',
);

// ── 3) Bezpečný fallback bez známého username ──
// vedoucí @mention se strippne JEN když následuje příkaz "/"
assert.strictEqual(normalizeCommandText('@Cokoli /budget', ''), '/budget', 'fallback: mention před příkazem se strippne');
assert.strictEqual(normalizeCommandText('/budget@Cokoli', ''), '/budget', 'fallback: sufix se strippne');
assert.strictEqual(
  normalizeCommandText('@Dum_Zan_bot jak je venku?', ''),
  '@Dum_Zan_bot jak je venku?',
  'fallback: běžná věta s oslovením se NEmění (není příkaz)',
);

// ── 4) Běžná NLP věta se známým username: cmdText nesmí matchnout žádný příkaz ──
// (mention se sice odstraní, ale zbytek není příkaz → spadne do NLP s původním textem)
const nlp = normalizeCommandText('@Dum_Zan_bot rozsviť v kuchyni', UNAME);
assert.ok(!nlp.startsWith('/'), 'NLP věta po strip mention není příkaz');

// ── 5) Robustnost vůči prázdným/neřetězcovým vstupům ──
assert.strictEqual(normalizeCommandText('', UNAME), '', 'prázdný text');
assert.strictEqual(normalizeCommandText(null, UNAME), '', 'null text');
assert.strictEqual(normalizeCommandText(undefined, UNAME), '', 'undefined text');
assert.strictEqual(normalizeCommandText('/budget', ''), '/budget', 'prázdný username');
assert.strictEqual(normalizeCommandText('/budget', null), '/budget', 'null username');

console.log('check-command-text: OK');
