// command-text.js
// Normalizace textu zprávy PRO ROUTING SLASH PŘÍKAZŮ ve skupinovém chatu.
//
// Proč: ve skupině Telegram (privacy mode) musí být bot oslovený, takže
// příkaz nedorazí jako holé "/budget", ale jako:
//   - "@Dum_Zan_bot /budget"   (vedoucí mention)
//   - "/budget@Dum_Zan_bot"    (Telegram doplní @bot za příkaz)
// Command handlery v bot.js jsou přesná shoda (text === '/budget'), takže
// bez normalizace ve skupině TICHÉ přestanou fungovat všechny slash příkazy.
//
// Tahle funkce vrací jen KOPII textu pro porovnání s příkazy. Původní
// msg.text zůstává beze změny pro NLP cestu (processMessage), aby oslovení
// bota v běžné větě nezměnilo význam zprávy.
//
// botUsername: vlastní username bota (bez @). Když je znám, strippuje se jen
// oslovení TOHOTO bota (mention jiného bota se nechá být — příkaz nebyl
// adresovaný nám). Když znám není (prázdný), použije se bezpečný fallback:
// vedoucí @mention se odstraní jen tehdy, když za ním následuje "/" (příkaz),
// takže se nikdy nerozbije běžná věta a routing příkazů dál funguje.

function normalizeCommandText(rawText, botUsername) {
  let t = String(rawText == null ? '' : rawText).trim();
  if (!t) return t;

  const uname = String(botUsername == null ? '' : botUsername).replace(/^@/, '').trim();
  const unameLc = uname.toLowerCase();

  // 1) Vedoucí "@mention " před příkazem/textem.
  const lead = t.match(/^@([A-Za-z0-9_]+)\s+([\s\S]*)$/);
  if (lead) {
    const mentioned = lead[1];
    const rest = lead[2].trim();
    const matchesUs = unameLc && mentioned.toLowerCase() === unameLc;
    const fallbackCmd = !unameLc && rest.startsWith('/');
    if (matchesUs || fallbackCmd) {
      t = rest;
    }
  }

  // 2) Sufix "/cmd@bot" na prvním tokenu (Telegram doplňuje @bot za příkaz).
  const cmd = t.match(/^(\/[A-Za-z0-9_]+)@([A-Za-z0-9_]+)([\s\S]*)$/);
  if (cmd) {
    const suffixUser = cmd[2];
    if (!unameLc || suffixUser.toLowerCase() === unameLc) {
      t = (cmd[1] + cmd[3]).trim();
    }
  }

  return t;
}

module.exports = { normalizeCommandText };
