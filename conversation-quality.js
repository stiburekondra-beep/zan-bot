const fs = require('fs');
const crypto = require('crypto');

const DEFAULT_MAX_LINES = 2000;

function shortHash(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex').slice(0, 12);
}

function parseConversationLine(line) {
  const match = String(line || '').match(/^\[([^\]]+)\]\s+(.+?)\s+chat=([^\(]+)\((.*?)\):\s*(.*)$/);
  if (!match) return null;
  return {
    ts: match[1],
    role: match[2],
    chat_id: match[3],
    user: match[4],
    text: match[5] || '',
  };
}

function normalize(text) {
  return String(text || '').toLowerCase();
}

function classifyUserIntent(text) {
  const t = normalize(text);
  if (/(zapni|zhasni|vypni|nastav|spusť|spust|vrať|vrat|smaž|smaz|zapiš|zapis|restart|nahraj|přidej|pridej)/u.test(t)) return 'action_request';
  if (/(co je|kde je|kolik|jaký|jaky|jak |proč|proc|stav|svítí|sviti|máš|mas)/u.test(t)) return 'question';
  if (/(ne|to není|to neni|hádáš|hadas|fakt|opravdu|nic nevidim|nesedí|nesedi|špatně|spatne)/u.test(t)) return 'correction_or_probe';
  return 'other';
}

function classifyAssistant(text, previousUserIntent = 'other') {
  const t = normalize(text);
  if (/(vymyslel|hádal|hadal|omlouvám|omlouvam|mýlil|mylil|chyba|neprovedl|nepovedlo|selhalo|neznám|neznam)/u.test(t)) return 'possible_failure';
  if (/(unavailable|nedostup|nepřipojen|nepripojen|nemůžu potvrdit|nemuzu potvrdit)/u.test(t)) return 'missing_data';
  if (/(potřebuju|potrebuju|chybí|chybi|nemám .*data|nemam .*data|není naplněn|neni naplnen|čeká na|ceka na)/u.test(t)) return 'missing_data';
  if (/(neumím|neumim|nedokážu|nedokazu|bez .*neumím|bez .*nejde|není možné|neni mozne)/u.test(t)) return 'missing_skill';
  if (previousUserIntent === 'correction_or_probe') return 'partial_or_uncertain';
  if (/(hotovo|udělal|udelal|zapnuto|vypnuto|uloženo|ulozeno|našel|nasel|můžeš|muzes)/u.test(t)) return 'answered';
  return 'unclear';
}

function backlogForCategory(category) {
  switch (category) {
    case 'missing_data':
      return 'Doplnit chybějící fakt do domácích dat, house_map nebo technology_inventory.';
    case 'missing_skill':
      return 'Založit/napojit konkrétní skill kartu; nepopisovat to jako obecné učení modelu.';
    case 'possible_failure':
      return 'Prověřit jako bug/regresní scénář: Žán se opravil, přiznal chybu nebo reportoval selhání.';
    case 'partial_or_uncertain':
      return 'Dát testerovi navazující ověření; uživatel musel tlačit na přesnost.';
    case 'unclear':
      return 'Ručně vzorkovat v provozních datech mimo git; agregace nepoznala kvalitu.';
    default:
      return 'Bez backlog kroku.';
  }
}

function summarizeRecords(records) {
  const counts = {};
  const byIntent = {};
  let firstSeen = null;
  let lastSeen = null;

  for (const record of records) {
    counts[record.category] = (counts[record.category] || 0) + 1;
    byIntent[record.previous_user_intent] = (byIntent[record.previous_user_intent] || 0) + 1;
    if (!firstSeen || record.ts < firstSeen) firstSeen = record.ts;
    if (!lastSeen || record.ts > lastSeen) lastSeen = record.ts;
  }

  const backlog = Object.entries(counts)
    .filter(([category]) => category !== 'answered')
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([category, count]) => ({
      category,
      count,
      next_step: backlogForCategory(category),
    }));

  return {
    generated_at: new Date().toISOString(),
    privacy: 'Bez textu zpráv: jen kategorie, časy, hashe chatů a agregované počty.',
    total_assistant_turns: records.length,
    first_seen: firstSeen,
    last_seen: lastSeen,
    counts,
    user_intents: byIntent,
    backlog,
  };
}

function analyzeConversationLog(logFile, qualityFile, opts = {}) {
  const maxLines = Math.max(1, Math.min(opts.maxLines || DEFAULT_MAX_LINES, DEFAULT_MAX_LINES));
  const raw = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
  const lines = raw.split('\n').filter(Boolean).slice(-maxLines);
  const parsed = lines.map(parseConversationLine).filter(Boolean);
  const records = [];
  let lastUserIntent = 'other';

  for (const entry of parsed) {
    if (entry.role === 'USER') {
      lastUserIntent = classifyUserIntent(entry.text);
      continue;
    }
    if (entry.role !== 'ŽÁN' && entry.role !== 'ZAN') continue;
    const category = classifyAssistant(entry.text, lastUserIntent);
    records.push({
      ts: entry.ts,
      chat_hash: shortHash(entry.chat_id),
      user_hash: shortHash(entry.user),
      previous_user_intent: lastUserIntent,
      category,
    });
  }

  if (qualityFile) {
    fs.writeFileSync(qualityFile, records.map(r => JSON.stringify(r)).join('\n') + (records.length ? '\n' : ''), 'utf8');
  }

  return {
    summary: summarizeRecords(records),
    records_written: records.length,
    quality_file: qualityFile || null,
  };
}

module.exports = {
  analyzeConversationLog,
  parseConversationLine,
  classifyUserIntent,
  classifyAssistant,
  summarizeRecords,
};
