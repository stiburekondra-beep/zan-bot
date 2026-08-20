'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_TIME_ZONE = 'Europe/Prague';
const RETENTION_DAYS = 14;
const MAX_MATCH_LINES = 40;

function dateParts(date = new Date(), timeZone = DEFAULT_TIME_ZONE) {
  const parts = new Intl.DateTimeFormat('cs-CZ', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date);
  return Object.fromEntries(parts.filter(p => p.type !== 'literal').map(p => [p.type, p.value]));
}

function dayKey(date = new Date(), timeZone = DEFAULT_TIME_ZONE) {
  const p = dateParts(date, timeZone);
  return `${p.year}-${p.month}-${p.day}`;
}

function timeKey(date = new Date(), timeZone = DEFAULT_TIME_ZONE) {
  const p = dateParts(date, timeZone);
  return `${p.hour}:${p.minute}:${p.second}`;
}

function addDays(day, offset) {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
}

function diaryFile(dir, day) {
  return path.join(dir, `${day}.md`);
}

function ensureDiaryFile(file, day) {
  if (fs.existsSync(file)) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `# Denik rozhovoru ${day}\n\n## Shrnuti\n_zatim nevytvoreno_\n\n## Zaznam\n`, 'utf8');
}

function oneLine(text) {
  return String(text || '').replace(/\r?\n/g, ' <NL> ').replace(/\s+/g, ' ').trim();
}

function safeName(name) {
  return oneLine(name).slice(0, 80) || 'neznamy';
}

function appendDiaryEntry(dir, entry, opts = {}) {
  const timeZone = opts.timeZone || DEFAULT_TIME_ZONE;
  const now = entry.date || new Date();
  const day = opts.day || dayKey(now, timeZone);
  const file = diaryFile(dir, day);
  ensureDiaryFile(file, day);
  const role = String(entry.role || 'INFO').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toUpperCase();
  const chat = Number.isFinite(Number(entry.chatId)) ? ` chat=${entry.chatId}` : '';
  const user = entry.userName ? ` (${safeName(entry.userName)})` : '';
  const line = `- [${timeKey(now, timeZone)}] ${role}${chat}${user}: ${oneLine(entry.text)}\n`;
  fs.appendFileSync(file, line, 'utf8');
  cleanupOldDiaryFiles(dir, { now, timeZone });
  return { day, file, line: line.trim() };
}

function readDiary(file) {
  if (!fs.existsSync(file)) return { exists: false, summary: '', entries: [] };
  const text = fs.readFileSync(file, 'utf8');
  const summaryMatch = text.match(/## Shrnuti\n([\s\S]*?)(?:\n## Zaznam|\n# |$)/);
  const rawSummary = summaryMatch ? summaryMatch[1].trim() : '';
  const summary = /^_?zatim nevytvoreno_?$/i.test(rawSummary) ? '' : rawSummary;
  const entriesBlock = text.includes('## Zaznam') ? text.split('## Zaznam').slice(1).join('## Zaznam') : '';
  const entries = entriesBlock.split(/\r?\n/).map(l => l.trim()).filter(l => l.startsWith('- ['));
  return { exists: true, summary, entries, text };
}

function replaceSummary(file, day, summaryLines) {
  ensureDiaryFile(file, day);
  const summary = String(summaryLines || '').trim() || '_zatim nevytvoreno_';
  const text = fs.readFileSync(file, 'utf8');
  if (text.includes('## Shrnuti') && text.includes('## Zaznam')) {
    const next = text.replace(/## Shrnuti\n[\s\S]*?\n## Zaznam/, `## Shrnuti\n${summary}\n\n## Zaznam`);
    fs.writeFileSync(file, next, 'utf8');
    return;
  }
  fs.writeFileSync(file, `# Denik rozhovoru ${day}\n\n## Shrnuti\n${summary}\n\n## Zaznam\n${text}`, 'utf8');
}

function stripDiacritics(text) {
  return String(text || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
}

function normalizedTerms(query) {
  return stripDiacritics(query)
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .map(t => t.trim())
    .filter(t => t.length >= 3);
}

function matchesQuery(line, terms) {
  if (!terms.length) return true;
  const n = stripDiacritics(line).toLowerCase();
  return terms.every(t => n.includes(t));
}

function recallDays(dir, input = {}) {
  const timeZone = input.timeZone || DEFAULT_TIME_ZONE;
  const now = input.now || new Date();
  const daysBack = Math.max(1, Math.min(RETENTION_DAYS, Number(input.daysBack || input.days_back || 1)));
  const day = addDays(dayKey(now, timeZone), -daysBack);
  const file = diaryFile(dir, day);
  const diary = readDiary(file);
  if (!diary.exists) {
    return {
      ok: false,
      days_back: daysBack,
      date: day,
      summary: '',
      matches: [],
      message: `Pro ${day} nemam ulozeny denik rozhovoru.`,
    };
  }
  const terms = normalizedTerms(input.query || '');
  const matches = diary.entries.filter(line => matchesQuery(line, terms)).slice(0, input.maxLines || MAX_MATCH_LINES);
  return {
    ok: true,
    days_back: daysBack,
    date: day,
    summary: diary.summary || '',
    entries_total: diary.entries.length,
    matches,
    matches_truncated: diary.entries.filter(line => matchesQuery(line, terms)).length > matches.length,
    message: formatRecallMessage(day, diary.summary, matches, input.query),
  };
}

function formatRecallMessage(day, summary, matches, query) {
  const parts = [`Denik ${day}:`];
  if (summary) parts.push(`Shrnuti:\n${summary}`);
  else parts.push('Shrnuti zatim neni vytvorene.');
  if (query) {
    parts.push(matches.length
      ? `Nalezeno k dotazu "${query}":\n${matches.join('\n')}`
      : `K dotazu "${query}" jsem v deniku nenasel shodu.`);
  } else if (matches.length) {
    parts.push(`Zaznamy:\n${matches.slice(0, 12).join('\n')}`);
  }
  return parts.join('\n\n');
}

function cleanupOldDiaryFiles(dir, opts = {}) {
  if (!fs.existsSync(dir)) return [];
  const timeZone = opts.timeZone || DEFAULT_TIME_ZONE;
  const today = dayKey(opts.now || new Date(), timeZone);
  const cutoff = addDays(today, -RETENTION_DAYS);
  const removed = [];
  for (const name of fs.readdirSync(dir)) {
    if (!/^\d{4}-\d{2}-\d{2}\.md$/.test(name)) continue;
    const day = name.slice(0, 10);
    if (day < cutoff) {
      const file = path.join(dir, name);
      fs.unlinkSync(file);
      removed.push(file);
    }
  }
  return removed;
}

function summaryNeedsUpdate(file) {
  const diary = readDiary(file);
  return diary.exists && diary.entries.length > 0 && !diary.summary;
}

async function ensureYesterdaySummary(dir, summarize, opts = {}) {
  const timeZone = opts.timeZone || DEFAULT_TIME_ZONE;
  const today = dayKey(opts.now || new Date(), timeZone);
  const yesterday = addDays(today, -1);
  const file = diaryFile(dir, yesterday);
  if (!summaryNeedsUpdate(file)) return { updated: false, day: yesterday };
  const diary = readDiary(file);
  const source = diary.entries.slice(-120).join('\n');
  const summary = await summarize(source, yesterday);
  replaceSummary(file, yesterday, normalizeSummary(summary));
  return { updated: true, day: yesterday };
}

function normalizeSummary(text) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(Boolean)
    .slice(0, 6)
    .map(l => l.startsWith('- ') ? l : `- ${l.replace(/^[-*]\s*/, '')}`);
  return lines.join('\n') || '_zatim nevytvoreno_';
}

function yesterdaySummaryContext(dir, opts = {}) {
  const timeZone = opts.timeZone || DEFAULT_TIME_ZONE;
  const today = dayKey(opts.now || new Date(), timeZone);
  const yesterday = addDays(today, -1);
  const diary = readDiary(diaryFile(dir, yesterday));
  if (!diary.exists || !diary.summary) return '';
  const maxChars = opts.maxChars || 400;
  return diary.summary.length > maxChars ? `${diary.summary.slice(0, maxChars - 1)}…` : diary.summary;
}

module.exports = {
  RETENTION_DAYS,
  appendDiaryEntry,
  cleanupOldDiaryFiles,
  dayKey,
  diaryFile,
  ensureYesterdaySummary,
  recallDays,
  replaceSummary,
  yesterdaySummaryContext,
};
