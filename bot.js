require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const Anthropic = require('@anthropic-ai/sdk');
const axios = require('axios');
const yaml = require('js-yaml'); // validace YAML před zápisem (fáze 0 auditu 2026-07-05)
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');
const FormData = require('form-data');
// Explicitní 'ws' knihovna, ne spoléhání na globální WebSocket — základní
// image add-onu (Alpine, apk add nodejs) nemusí mít Node dost novej na to,
// aby ho měl v globálním scope. 'ws' má stejné .onopen/.onmessage/.onerror
// API, takže je to zaměnitelné 1:1.
const WebSocket = require('ws');

// ═══════════════════════════════════════════════
// KONFIGURACE
// ═══════════════════════════════════════════════
const TELEGRAM_TOKEN    = process.env.TELEGRAM_TOKEN;
const CHAT_ONDRA        = parseInt(process.env.CHAT_ID_ONDRA);
const CHAT_JANA         = parseInt(process.env.CHAT_ID_JANA);
const EXTRA_CHAT_IDS    = (process.env.EXTRA_CHAT_IDS || '').split(',').map(x => parseInt(x)).filter(Boolean);
const ALLOWED_CHATS     = [CHAT_ONDRA, CHAT_JANA, ...EXTRA_CHAT_IDS].filter(Boolean);
const ADMIN_CHATS       = [CHAT_ONDRA]; // jen Ondra může YAML, restart, kritické věci

const HA_URL            = process.env.HA_URL;
const HA_TOKEN          = process.env.HA_TOKEN;
const HA_CONFIG_PATH    = process.env.HA_CONFIG_PATH || '\\\\192.168.0.91\\config';
const HA_SAMBA_USER     = process.env.HA_SAMBA_USER;
const HA_SAMBA_PASS     = process.env.HA_SAMBA_PASS;
const ANTHROPIC_KEY     = process.env.ANTHROPIC_API_KEY;
const OPENAI_KEY        = process.env.OPENAI_API_KEY;
const HARNESS_ENABLED   = /^(1|true|yes|on)$/i.test(String(process.env.ZAN_HARNESS_ENABLED || ''));
const HARNESS_CHAT_ID   = parseInt(process.env.ZAN_HARNESS_CHAT_ID || '', 10);

// Perzistentní data PATŘÍ MIMO /app — kontejner se při každém updatu
// add-onu staví znovu a /app (=__dirname) se zahazuje. /config je mapované
// (config.yaml: map config:rw) → data přežijí updaty a jsou vidět přes Sambu.
const DATA_DIR = (() => {
  try { fs.mkdirSync('/config/zan_data', { recursive: true }); return '/config/zan_data'; }
  catch { return __dirname; } // fallback pro vývoj mimo add-on
})();
// Jednorázová migrace dat z /app (verze <= 5.4.16 ukládaly vedle bot.js)
if (DATA_DIR !== __dirname) {
  for (const f of ['home_memory.json', 'zan_actions.log', 'zan_conversation.log',
    'zan_usage.json', 'zan_garden.json', 'zan_events.json', 'zan_habits.json',
    'zan_udrzba.json', 'zan_tasks.json', 'zan_lessons.json']) {
    try {
      const src = path.join(__dirname, f), dst = path.join(DATA_DIR, f);
      if (fs.existsSync(src) && !fs.existsSync(dst)) fs.copyFileSync(src, dst);
    } catch {}
  }
}

const MEMORY_FILE       = path.join(DATA_DIR, 'home_memory.json');
const LOG_FILE          = path.join(DATA_DIR, 'zan_actions.log');
const CONVO_LOG_FILE    = path.join(DATA_DIR, 'zan_conversation.log');
const HARNESS_DIR       = path.join(DATA_DIR, 'harness');
const HARNESS_IN_DIR    = path.join(HARNESS_DIR, 'in');
const HARNESS_OUT_DIR   = path.join(HARNESS_DIR, 'out');

// Poučení z chyb — Žán si je ukládá sám (save_lesson) a dostává je
// v každém dynamickém kontextu, aby stejnou chybu neopakoval
const LESSONS_FILE      = path.join(DATA_DIR, 'zan_lessons.json');
function loadLessons() {
  try { if (fs.existsSync(LESSONS_FILE)) return JSON.parse(fs.readFileSync(LESSONS_FILE, 'utf8')); } catch {}
  return [];
}
function saveLessons(lessons) {
  try { fs.writeFileSync(LESSONS_FILE, JSON.stringify(lessons.slice(-50), null, 2), 'utf8'); } catch {}
}

// Lessons v2 (audit sekce 4.1): do kontextu jdou 3 nejnovější poučení
// + všechna starší, jejichž topic se trefí do slov aktuální zprávy.
// Dřívější "posledních 8" bylo slepé — poučení o kamerách se vytlačilo
// dřív, než se příště hodilo.
function relevantLessons(userMessage) {
  const lessons = loadLessons();
  if (lessons.length === 0) return [];
  const t = stripDiacritics(String(userMessage || '')).toLowerCase();
  const matchesTopic = (l) => {
    const topic = stripDiacritics(String(l.topic || '')).toLowerCase();
    if (!topic || topic === 'obecne') return false;
    // "yaml-balicky" → ["yaml","balicky"]; hrubý stem = prvních 5 znaků
    // (trefí "balicek" i "balicky", "dashboard" i "dashboardy")
    return topic.split(/[-_\s]+/).some(w => w.length >= 3 && t.includes(w.slice(0, 5)));
  };
  const newest = lessons.slice(-3);
  const matched = lessons.slice(0, -3).filter(matchesTopic).slice(-10);
  return [...matched, ...newest];
}

// ── PLAYBOOKY (audit sekce 4.2) — Žánovy "skilly" ──
// Ověřený postup se uloží jako pojmenovaný návod; do kontextu jdou jen
// NÁZVY (lazy-loading jako Claude Code skills), obsah si Žán vytáhne
// read_playbook, až ho potřebuje. Playbook ≠ lesson: lesson je "tohle
// nedělej", playbook je "takhle se dělá X, ověřeno". Ukládá se jen na
// pokyn/potvrzení Ondry — jinak by se zakonzervovaly i slepé uličky.
const PLAYBOOK_DIR = path.join(DATA_DIR, 'playbooks');
function playbookSlug(name) {
  return stripDiacritics(String(name)).toLowerCase().replace(/[\s-]+/g, '_').replace(/[^a-z0-9_]/g, '');
}
function listPlaybooks() {
  try { return fs.readdirSync(PLAYBOOK_DIR).filter(f => f.endsWith('.md')).map(f => f.slice(0, -3)); }
  catch { return []; }
}
function savePlaybook(name, content) {
  try {
    fs.mkdirSync(PLAYBOOK_DIR, { recursive: true });
    fs.writeFileSync(path.join(PLAYBOOK_DIR, playbookSlug(name) + '.md'), content, 'utf8');
    return playbookSlug(name);
  } catch (e) { console.error('savePlaybook:', e.message); return null; }
}
function readPlaybook(name) {
  try { return fs.readFileSync(path.join(PLAYBOOK_DIR, playbookSlug(name) + '.md'), 'utf8'); }
  catch { return null; }
}

// rodina.md — živý profil TÉHLE domácnosti (Žán #1: Stiburkovi).
// Per-dům data, žijí mimo git sdíleného kódu (rozhodnuti.md 2026-07-05/06).
// Plní se dotazníkem po jedné otázce (kickoff: /onboarding), čte se celý
// do dynamického kontextu — je to Žánův hlavní zdroj "jak tahle rodina žije".
// Ručně editovatelný přes Sambu: /config/zan_data/rodina.md
const RODINA_FILE = path.join(DATA_DIR, 'rodina.md');
const RODINA_SECTIONS = ['Domácnost', 'Denní rytmus', 'Práce a návraty', 'Vytápění a teploty', 'Pravidla pro Žána', 'Poznámky'];
function loadRodina() {
  try { if (fs.existsSync(RODINA_FILE)) return fs.readFileSync(RODINA_FILE, 'utf8'); } catch {}
  return null;
}
function saveRodina(content) {
  try { fs.writeFileSync(RODINA_FILE, content, 'utf8'); return true; }
  catch (e) { console.error('rodina.md save:', e.message); return false; }
}
function ensureRodina() {
  let c = loadRodina();
  if (c) return c;
  c = '# Rodina — profil domácnosti\n\n' +
    '> Plní Žán průběžně z rozhovorů (vždy jen jedna otázka, žádný formulář).\n' +
    '> Ručně editovatelné přes Sambu: /config/zan_data/rodina.md\n\n' +
    RODINA_SECTIONS.map(s => `## ${s}\n\n(zatím nevyplněno)\n`).join('\n');
  saveRodina(c);
  return c;
}
function updateRodinaSection(section, content) {
  let c = ensureRodina();
  // Nahraď blok sekce (od "## Sekce" po další "## " nebo konec souboru).
  // Sekce jsou pevný enum (RODINA_SECTIONS) bez regex znaků — netřeba escapovat.
  const re = new RegExp('## ' + section + '\\n[\\s\\S]*?(?=\\n## |$)');
  const block = `## ${section}\n\n${String(content).trim()}\n`;
  if (re.test(c)) c = c.replace(re, block);
  else c = c.trimEnd() + `\n\n${block}`;
  return saveRodina(c);
}

// Model: Haiku 4.5 pro běžný provoz (cca 3× levnější než Sonnet).
// Přepnutí bez zásahu do kódu: env ZAN_MODEL=claude-sonnet-5
const MODEL             = process.env.ZAN_MODEL || 'claude-haiku-4-5';

// ── MODEL ROUTING (audit 2026-07-05, sekce 5 — Ondrův návrh) ──
// Správný model na správný typ práce:
//   FAST   = dispečer a komorník: chat, ovládání, dotazy, zahrada, paměť
//   SMART  = YAML inženýr: balíčky, dashboardy, onboarding, noční fronta
//   SERVIS = údržbář a sebereflexe: běží ~12×/měsíc, rozhoduje o zásazích
//            do živého domu a evoluci ústavy → nejvyšší model se vyplatí
// MODEL (ZAN_MODEL) zůstává jako výchozí pro FAST kvůli zpětné kompatibilitě.
const MODEL_FAST   = process.env.ZAN_MODEL_FAST   || MODEL;
const MODEL_SMART  = process.env.ZAN_MODEL_SMART  || 'claude-sonnet-5';
const MODEL_SERVIS = process.env.ZAN_MODEL_SERVIS || 'claude-opus-4-8';

// Nástroje, jejichž pokus o použití FAST modelem eskaluje smyčku na SMART.
// Čtení a průzkum udělá levně Haiku; zápis/tvorbu vždy silnější model.
const SMART_ESCALATION_TOOLS = ['write_package', 'write_dashboard', 'ha_setup_create_floor', 'ha_setup_create_area', 'ha_setup_assign_device'];

function stripDiacritics(s) {
  return String(s).normalize('NFD').replace(/[̀-ͯ]/g, ''); // combining marks U+0300–U+036F
}

function pickModelForMessage(text) {
  // Vstupní heuristika (zdarma, stupeň 1 routingu): YAML/tvorba → rovnou
  // SMART, jinak FAST. Case-insensitive a bez diakritiky — z mobilu se
  // píše "balicek", "automatizace" i "Dashboard". Nemusí být dokonalá,
  // zápis jistí eskalace v běhu (stupeň 2).
  const t = stripDiacritics(String(text || '')).toLowerCase();
  return /dashboard|balicek|balick|automatizac|automatik|yaml|onboarding|nastav dum|vytvor|predelej|prestav|uprav\s+\S*\s*(kart|panel)/.test(t)
    ? MODEL_SMART : MODEL_FAST;
}

// Limity agentic smyčky — ochrana proti nekonečnému točení a obřím výsledkům
const MAX_AGENT_ITERATIONS = 8;
const MAX_TOOL_RESULT_CHARS = 12000;

// ═══════════════════════════════════════════════
// SECURITY — whitelist domén a zakázané entity
// ═══════════════════════════════════════════════
const ALLOWED_DOMAINS = ['light', 'switch', 'climate', 'input_boolean', 'script', 'scene', 'cover', 'fan', 'media_player', 'vacuum'];
const BLOCKED_ENTITIES = ['alarm_control_panel', 'lock', 'input_text', 'person', 'zone', 'device_tracker'];
const SENSITIVE_DOMAINS = ['climate', 'cover']; // vyžadují potvrzení
const CRITICAL_KEYWORDS = ['alarm', 'lock', 'zamek', 'zabezpeceni', 'kamera'];

// Rate limiting
const rateLimits = new Map(); // chatId -> [timestamps]
const RATE_LIMIT = 10; // max zpráv za minutu
const RATE_WINDOW = 60 * 1000;

// Pending confirmations — VYNUCENÉ potvrzení citlivých akcí (fáze 2,
// slabiny S3+S4): citlivou akci kód neprovede, dokud uživatel neťukne
// na inline tlačítko ✅. Do té doby žije tady. Není to prosba v promptu,
// je to závora v kódu.
const pendingConfirm = new Map(); // chatId -> { name, input, desc, token, when }

function isSensitiveAction(name, input) {
  // Vrací lidský popis akce, když vyžaduje potvrzení; jinak null.
  if (name === 'restart_ha') return 'restart Home Assistantu';
  if (['turn_on', 'turn_off', 'toggle'].includes(name)) {
    const domain = String(input.entity_id || '').split('.')[0];
    if (SENSITIVE_DOMAINS.includes(domain)) return `${name === 'turn_on' ? 'zapnutí' : name === 'turn_off' ? 'vypnutí' : 'přepnutí'} ${input.entity_id}`;
  }
  if (name === 'call_service' && SENSITIVE_DOMAINS.includes(input.domain)) {
    return `${input.domain}.${input.service} (${JSON.stringify(input.data || {}).slice(0, 120)})`;
  }
  return null;
}

// ═══════════════════════════════════════════════
// FRONTA ZPRÁV PER CHAT — bez tohohle se zprávy stejného chatu (např.
// když uživatel netrpělivě napíše druhou zprávu, než stihne dorazit
// odpověď na první) zpracovávaly SOUBĚŽNĚ — dva nezávislé běhy nad
// stejnou conversationHistory, dvě různé odpovědi za sebou (zjištěno
// 2026-07-05 — "pomoz mi přiřadit zařízení" + netrpělivé "heeej" =
// dvě mírně odlišné odpovědi na to samé). Teď se zprávy stejného chatu
// zpracují striktně jedna po druhé.
// ═══════════════════════════════════════════════
const chatQueues = new Map(); // chatId -> Promise (řetězec čekajících zpráv)
function enqueueForChat(chatId, fn) {
  const prev = chatQueues.get(chatId) || Promise.resolve();
  const next = prev.then(fn, fn);
  chatQueues.set(chatId, next.catch(() => {}));
  return next;
}

// ═══════════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════════
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
const anthropic = new Anthropic({ apiKey: ANTHROPIC_KEY });
// Konverzace per chat — perzistentní na disku (fáze 1 auditu, slabina S7):
// bez toho každý update/restart add-onu znamenal "o čem jsme to mluvili?".
// Ukládají se jen texty (fotky se do historie stejně nedávají).
const CONVO_STATE_FILE = path.join(DATA_DIR, 'zan_conversations.json');
let conversationHistory = {}; // per chatId
try {
  if (fs.existsSync(CONVO_STATE_FILE)) conversationHistory = JSON.parse(fs.readFileSync(CONVO_STATE_FILE, 'utf8')) || {};
} catch (e) { console.warn('Načtení konverzací selhalo (začínám s prázdnou):', e.message); }
function persistConversations() {
  try { fs.writeFileSync(CONVO_STATE_FILE, JSON.stringify(conversationHistory), 'utf8'); } catch (e) { console.warn('persistConversations:', e.message); }
}

// ═══════════════════════════════════════════════
// BEZPEČNÉ ODESÍLÁNÍ DO TELEGRAMU
// Telegram odmítne zprávu s nevalidním Markdownem (lichý počet * _ `)
// nebo delší než 4096 znaků — a uživateli pak nepřijde NIC, i když
// celý (drahý) AI průběh proběhl. Tenhle helper:
//  1. dělí dlouhé zprávy na kusy do 3900 znaků
//  2. zkusí Markdown, při chybě pošle plain text
//  3. nikdy nevyhodí výjimku ven (jen loguje)
// ═══════════════════════════════════════════════
async function sendSafe(chatId, text, extra = {}) {
  if (text === undefined || text === null || text === '') text = '…';
  text = String(text);
  const chunks = [];
  for (let i = 0; i < text.length; i += 3900) chunks.push(text.slice(i, i + 3900));
  for (const chunk of chunks) {
    try {
      await bot.sendMessage(chatId, chunk, { parse_mode: 'Markdown', ...extra });
    } catch (e) {
      try {
        // Markdown selhal (nespárované znaky apod.) → plain text
        const plain = { ...extra };
        delete plain.parse_mode;
        await bot.sendMessage(chatId, chunk, plain);
        console.warn(`sendSafe: Markdown fallback na plain text (${e.message})`);
      } catch (e2) {
        console.error(`sendSafe: odeslání selhalo úplně: ${e2.message}`);
      }
    }
  }
}

const PACKAGE_CATEGORIES = {
  osvetleni: 'Osvětlení', topeni: 'Topení a klimatizace', zasuvky: 'Zásuvky a spotřebiče',
  zahrada: 'Zahrada', zabezpeceni: 'Zabezpečení', energie: 'Energie', system: 'Systémové', ostatni: 'Ostatní',
};

// ═══════════════════════════════════════════════
// SLEDOVÁNÍ SPOTŘEBY TOKENŮ (/budget)
// Každé volání Claude API jde přes claudeCreate(), který sečte usage
// do zan_usage.json (denní kyblíky). Ceny za MTok podle modelu.
// ═══════════════════════════════════════════════
const USAGE_FILE = path.join(DATA_DIR, 'zan_usage.json');
const USD_CZK = 23; // hrubý kurz pro orientační přepočet

function modelPricing(model = MODEL) {
  // [input, output, cache_read, cache_write] USD za MTok — per model,
  // ne podle globálního MODEL (jinak /budget lže, jakmile běží víc modelů)
  const m = String(model);
  if (m.includes('haiku')) return [1, 5, 0.1, 1.25];
  if (m.includes('opus'))  return [15, 75, 1.5, 18.75];
  return [3, 15, 0.3, 3.75]; // sonnet a ostatní
}

function loadUsage() {
  try { if (fs.existsSync(USAGE_FILE)) return JSON.parse(fs.readFileSync(USAGE_FILE, 'utf8')); } catch {}
  return { days: {} };
}

function trackUsage(usage, model = MODEL) {
  if (!usage) return;
  try {
    const u = loadUsage();
    const day = new Date().toISOString().slice(0, 10);
    const d = u.days[day] || { calls: 0, input: 0, output: 0, cache_read: 0, cache_write: 0 };
    d.calls += 1;
    d.input += usage.input_tokens || 0;
    d.output += usage.output_tokens || 0;
    d.cache_read += usage.cache_read_input_tokens || 0;
    d.cache_write += usage.cache_creation_input_tokens || 0;
    // Rozpad po modelech — bez něj /budget počítá špatné ceny, jakmile
    // poběží víc modelů najednou (model routing). Starší dny d.models nemají.
    d.models = d.models || {};
    const md = d.models[model] || { calls: 0, input: 0, output: 0, cache_read: 0, cache_write: 0 };
    md.calls += 1;
    md.input += usage.input_tokens || 0;
    md.output += usage.output_tokens || 0;
    md.cache_read += usage.cache_read_input_tokens || 0;
    md.cache_write += usage.cache_creation_input_tokens || 0;
    d.models[model] = md;
    u.days[day] = d;
    // drž max 90 dní
    const keys = Object.keys(u.days).sort();
    while (keys.length > 90) delete u.days[keys.shift()];
    fs.writeFileSync(USAGE_FILE, JSON.stringify(u, null, 2), 'utf8');
    console.log(`💰 tokens: in=${usage.input_tokens} out=${usage.output_tokens} cache_read=${usage.cache_read_input_tokens || 0} cache_write=${usage.cache_creation_input_tokens || 0}`);
  } catch (e) { console.warn('trackUsage:', e.message); }
}

function usageCostUsd(d) {
  // Dny s rozpadem po modelech se počítají přesně; starší dny (bez d.models)
  // padají na cenu aktuálního globálního modelu jako dřív.
  if (d.models && Object.keys(d.models).length) {
    return Object.entries(d.models).reduce((sum, [m, v]) => {
      const [pi, po, pcr, pcw] = modelPricing(m);
      return sum + (v.input * pi + v.output * po + v.cache_read * pcr + v.cache_write * pcw) / 1e6;
    }, 0);
  }
  const [pi, po, pcr, pcw] = modelPricing();
  return (d.input * pi + d.output * po + d.cache_read * pcr + d.cache_write * pcw) / 1e6;
}

async function claudeCreate(params) {
  const response = await anthropic.messages.create(params);
  trackUsage(response.usage, params.model || MODEL);
  return response;
}

// ═══════════════════════════════════════════════
// LOGGING
// ═══════════════════════════════════════════════
function logAction(chatId, user, action, entity, result) {
  const entry = `[${new Date().toISOString()}] user=${user}(${chatId}) action=${action} entity=${entity || '-'} result=${result}\n`;
  try { fs.appendFileSync(LOG_FILE, entry); } catch {}
  console.log(entry.trim());
}

function logSecurity(chatId, event) {
  const entry = `[${new Date().toISOString()}] SECURITY chatId=${chatId} event=${event}\n`;
  try { fs.appendFileSync(LOG_FILE, entry); } catch {}
  console.warn(entry.trim());
}

// ═══════════════════════════════════════════════
// LOG KONVERZACE — ať Ondra s Claude Code nemusí kopírovat zprávy ručně,
// stačí přečíst tenhle soubor. Nejde o "odposlech" v reálném čase (Telegram
// dovoluje jen jednoho konzumenta long-pollingu na token), ale o čitelný
// záznam, co se s Žánem řešilo. Drží se posledních ~2000 řádků.
// ═══════════════════════════════════════════════
function logConvo(role, chatId, userName, text) {
  const line = `[${new Date().toISOString()}] ${role} chat=${chatId}(${userName}): ${String(text).replace(/\n/g, ' ⏎ ')}`;
  // Hlavní cesta ke čtení zvenku: stdout → add-on log (/api/hassio/addons/{slug}/logs),
  // stejná cesta, co se používá na kontrolu nasazení. Soubor v kontejneru
  // (CONVO_LOG_FILE) není zvenku přímo dostupný, drží se jen jako záloha.
  console.log(`💬 ${line}`);
  try {
    fs.appendFileSync(CONVO_LOG_FILE, line + '\n');
    const lines = fs.readFileSync(CONVO_LOG_FILE, 'utf8').split('\n');
    if (lines.length > 2000) fs.writeFileSync(CONVO_LOG_FILE, lines.slice(-2000).join('\n'));
  } catch {}
}

// ═══════════════════════════════════════════════
// RATE LIMITING
// ═══════════════════════════════════════════════
function checkRateLimit(chatId) {
  const now = Date.now();
  const times = (rateLimits.get(chatId) || []).filter(t => now - t < RATE_WINDOW);
  if (times.length >= RATE_LIMIT) return false;
  times.push(now);
  rateLimits.set(chatId, times);
  return true;
}

// ═══════════════════════════════════════════════
// UŽIVATELÉ
// ═══════════════════════════════════════════════
function getUser(chatId) {
  if (chatId === CHAT_ONDRA) return { name: 'Ondra', role: 'admin' };
  if (chatId === CHAT_JANA) return { name: 'Jana', role: 'user' };
  return { name: 'Host', role: 'guest' };
}

function isAdmin(chatId) { return ADMIN_CHATS.includes(chatId); }

// ═══════════════════════════════════════════════
// PAMĚŤ
// ═══════════════════════════════════════════════
function loadMemory() {
  try {
    if (fs.existsSync(MEMORY_FILE)) return JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf8'));
  } catch (e) { console.error('Memory load error:', e.message); }
  return {
    home_name: 'Dům Žán',
    residents: {
      ondra:  { name: 'Ondra',   born: '1991-11-30', emoji: '👨', info: '', role: 'admin' },
      jana:   { name: 'Jana',    born: '1991-09-22', emoji: '👩', info: '', role: 'user' },
      stepan: { name: 'Štěpán', born: '2019-07-20', emoji: '👦', info: '', role: 'kid' },
      matej:  { name: 'Matěj',  born: '2023-02-20', emoji: '👶', info: '', role: 'kid' },
      eliska: { name: 'Eliška', born: '2023-02-20', emoji: '👶', info: '', role: 'kid' },
    },
    house: {
      name: 'Dům Žán',
      address: '',
      type: '',
      year_built: '',
      photo_url: '',
      info: '',
      rooms_count: '',
      floors: '',
    },
    rooms: {}, devices: {},
    preferences: {}, notes: [],
    known_entities: [],
    checkin: { last_asked: null, pending_topics: [], declined_at: null },
    last_updated: null,
  };
}

function saveMemory(memory) {
  try {
    memory.last_updated = new Date().toISOString();
    fs.writeFileSync(MEMORY_FILE, JSON.stringify(memory, null, 2), 'utf8');
    return true;
  } catch (e) { console.error('Memory save error:', e.message); return false; }
}

// ═══════════════════════════════════════════════
// SÍŤ — sken LAN (scan_network), vyžaduje host_network+NET_RAW v config.yaml
// ═══════════════════════════════════════════════
function getLanSubnet() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal &&
          (iface.address.startsWith('192.168.') || iface.address.startsWith('10.') || iface.address.startsWith('172.'))) {
        const parts = iface.address.split('.');
        return `${parts[0]}.${parts[1]}.${parts[2]}.0/24`;
      }
    }
  }
  return null;
}

// ═══════════════════════════════════════════════
// SAMBA
// ═══════════════════════════════════════════════
function connectSamba() {
  if (!HA_SAMBA_USER || !HA_SAMBA_PASS) return true;
  try {
    try { execSync(`net use "${HA_CONFIG_PATH}" /delete /y`, { stdio: 'ignore' }); } catch {}
    execSync(`net use "${HA_CONFIG_PATH}" /user:${HA_SAMBA_USER} ${HA_SAMBA_PASS}`, { stdio: 'pipe' });
    console.log(`✅ Samba: ${HA_CONFIG_PATH}`);
    return true;
  } catch (e) { console.error('❌ Samba:', e.message); return false; }
}

// ═══════════════════════════════════════════════
// HA API s timeoutem a retry
// ═══════════════════════════════════════════════
// haHeaders jako funkce — vždy čte aktuální HA_TOKEN (token může přijít až po startu)
function haHeaders() {
  return { Authorization: `Bearer ${process.env.HA_TOKEN || HA_TOKEN}`, 'Content-Type': 'application/json' };
}

async function haGet(p, retries = 2) {
  for (let i = 0; i <= retries; i++) {
    try {
      const r = await axios.get(`${HA_URL}/api/${p}`, { headers: haHeaders(), timeout: 8000 });
      return r.data;
    } catch (e) {
      if (i === retries) throw e;
      await new Promise(r => setTimeout(r, 1000));
    }
  }
}

async function haPost(p, data = {}, retries = 2) {
  for (let i = 0; i <= retries; i++) {
    try {
      const r = await axios.post(`${HA_URL}/api/${p}`, data, { headers: haHeaders(), timeout: 8000 });
      return r.data;
    } catch (e) {
      if (i === retries) throw e;
      await new Promise(r => setTimeout(r, 1000));
    }
  }
}

async function isHaOnline() {
  try { await haGet(''); return true; } catch { return false; }
}

// HA config registry — zkusí GET, pak POST, pak template API fallback
async function haRegistry(name) {
  try { const r = await haGet(`config/${name}/list`); if (Array.isArray(r)) return r; } catch {}
  try { const r = await haPost(`config/${name}/list`, {}); if (Array.isArray(r)) return r; } catch {}

  // Fallback přes template API (funguje vždy)
  if (name === 'area_registry') {
    try {
      const tpl = `{% set ns = namespace(r=[]) %}{% for a in areas() %}{% set ns.r = ns.r + [{'area_id': a, 'name': area_name(a)}] %}{% endfor %}{{ ns.r | tojson }}`;
      const raw = await haPost('template', { template: tpl });
      const parsed = JSON.parse(typeof raw === 'string' ? raw : JSON.stringify(raw));
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    } catch (e) { console.warn(`haRegistry template fallback failed: ${e.message}`); }
  }

  console.warn(`haRegistry(${name}) failed — žádná metoda nefunguje`);
  return null;
}

async function isAiStopped() {
  try { const s = await haGet('states/input_boolean.ai_stop'); return s.state === 'on'; } catch { return false; }
}

// ═══════════════════════════════════════════════
// FRONTA VELKÝCH ÚKOLŮ (queue_task)
// Pro věci, co by "hodně stály" (velké dashboardy, hromadné přejmenování
// apod.) — Žán rovnou neřekne "nezvládnu", ale zařadí to do fronty a
// zpracuje v noci (processQueuedTasks), přes stejný agentic loop jako
// běžná konverzace (processMessage), jen s chatId=Ondra a syntetickou
// zprávou misto ruční zprávy z Telegramu.
// ═══════════════════════════════════════════════
const MAX_TASK_ATTEMPTS = 3; // po 3 nocích bez dokončení nahlásí a přestane zkoušet
function loadTasks() {
  try { if (fs.existsSync(TASKS_FILE)) return JSON.parse(fs.readFileSync(TASKS_FILE, 'utf8')); } catch {}
  return { tasks: [] };
}
function saveTasks(t) {
  try { fs.writeFileSync(TASKS_FILE, JSON.stringify(t, null, 2), 'utf8'); } catch {}
}

// ═══════════════════════════════════════════════
// HA WEBSOCKET — registry operace (patra/místnosti/zařízení)
// REST API config/{area,floor,device}_registry vrací 404 — HA tyhle
// registry historicky vystavuje jen přes WebSocket. Ověřeno ručně
// 2026-07-05 (config/area_registry/list, config/floor_registry/list,
// config/device_registry/list fungují). Create/update commandy zatím
// NEJSOU ověřené naostro — teprve budou, s Ondrovým souhlasem.
// Krátkodobé spojení na jeden příkaz — nastavování domu je vzácná
// operace (onboarding), netřeba držet perzistentní WS spojení.
// ═══════════════════════════════════════════════
let wsMsgId = 1;
function haWsCommand(type, payload = {}, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const wsUrl = HA_URL.replace(/^http/, 'ws') + '/api/websocket';
    let ws;
    try { ws = new WebSocket(wsUrl); } catch (e) { return reject(e); }
    const id = wsMsgId++;
    const timer = setTimeout(() => { try { ws.close(); } catch {} reject(new Error('HA WebSocket timeout')); }, timeoutMs);

    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.type === 'auth_required') {
        ws.send(JSON.stringify({ type: 'auth', access_token: process.env.HA_TOKEN || HA_TOKEN }));
      } else if (msg.type === 'auth_invalid') {
        clearTimeout(timer); try { ws.close(); } catch {}
        reject(new Error('HA WebSocket autentizace selhala'));
      } else if (msg.type === 'auth_ok') {
        ws.send(JSON.stringify({ id, type, ...payload }));
      } else if (msg.type === 'result' && msg.id === id) {
        clearTimeout(timer); try { ws.close(); } catch {}
        if (msg.success) resolve(msg.result);
        else reject(new Error(msg.error?.message || `HA WS příkaz ${type} selhal`));
      }
    };
    ws.onerror = (e) => { clearTimeout(timer); reject(new Error(e?.message || 'HA WebSocket chyba')); };
  });
}

// ═══════════════════════════════════════════════
// YAML HELPERS
// ═══════════════════════════════════════════════
function getPackagePath(cat, fn) {
  // Slug balíčku v HA smí obsahovat jen [a-z0-9_] — s pomlčkou/mezerou/
  // diakritikou/velkými písmeny HA balíček tiše nenačte (jen warning
  // v logu). Normalizujeme natvrdo, ať model nemůže vytvořit mrtvý
  // soubor (viz voda-casovace.yaml, 2026-07-05; diakritika doplněna 2026-07-06).
  fn = fn.normalize('NFD').replace(/[̀-ͯ]/g, '') // é→e, č→c…
    .toLowerCase().replace(/[\s-]+/g, '_').replace(/[^a-z0-9_.]/g, '_'); // rozsah výše = combining diacritics U+0300–U+036F
  return path.join(HA_CONFIG_PATH, 'packages', cat, fn.endsWith('.yaml') ? fn : fn + '.yaml');
}
function getDashboardPath(fn) {
  return path.join(HA_CONFIG_PATH, 'dashboards', fn.endsWith('.yaml') ? fn : fn + '.yaml');
}
function readYamlFile(fp) {
  try { if (fs.existsSync(fp)) return fs.readFileSync(fp, 'utf8'); } catch {}
  return null;
}
function writeYamlFile(fp, content) {
  try {
    const dir = path.dirname(fp);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(fp, content, 'utf8');
    return true;
  } catch (e) { console.error('Write error:', e.message); return false; }
}

// ═══════════════════════════════════════════════
// OCHRANA ZÁPISŮ (fáze 0 auditu 2026-07-05) — validace před zápisem,
// záloha před přepisem, undo, check_config po zápisu balíčku.
// Bez tohohle Žán zapisoval YAML naslepo (slabina S1).
// ═══════════════════════════════════════════════
const BACKUP_DIR = path.join(DATA_DIR, 'backups');

// Poslední zápis (pro undo_last_change) — vědomě jen v RAM: undo je
// záchrana "teď jsem to rozbil", ne archeologie. Historie je v backups/.
let lastChange = null; // { file, backup, wasNew, when }

function validateYamlSyntax(content) {
  // null = OK, jinak text chyby pro model. js-yaml navíc sám chytá
  // duplicitní klíče v jednom souboru (duplicated mapping key).
  try { yaml.load(content); return null; }
  catch (e) { return e.message; }
}

function backupFile(fp) {
  // Kopie do /config/zan_data/backups/<soubor>.<timestamp>, drží se
  // posledních 10 záloh na soubor. Vrací cestu k záloze, null když
  // originál neexistuje (= nový soubor, zálohovat není co).
  try {
    if (!fs.existsSync(fp)) return null;
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const bp = path.join(BACKUP_DIR, `${path.basename(fp)}.${ts}`);
    fs.copyFileSync(fp, bp);
    const siblings = fs.readdirSync(BACKUP_DIR)
      .filter(f => f.startsWith(path.basename(fp) + '.')).sort();
    while (siblings.length > 10) {
      try { fs.unlinkSync(path.join(BACKUP_DIR, siblings.shift())); } catch {}
    }
    return bp;
  } catch (e) { console.warn('backupFile:', e.message); return null; }
}

function recordChange(fp, backupPath, wasNew) {
  lastChange = { file: fp, backup: backupPath, wasNew, when: new Date().toISOString() };
}

function restoreLastChange() {
  // Vrátí poslední zápis: nový soubor smaže, přepsaný obnoví ze zálohy.
  if (!lastChange) return { error: 'Není co vracet — od startu add-onu žádný zaznamenaný zápis.' };
  try {
    const { file, backup, wasNew, when } = lastChange;
    if (wasNew) { if (fs.existsSync(file)) fs.unlinkSync(file); }
    else if (backup && fs.existsSync(backup)) fs.copyFileSync(backup, file);
    else return { error: 'Záloha se nenašla — obnov ručně z /config/zan_data/backups/.' };
    lastChange = null;
    return { success: true, restored: path.basename(file), was_new_file_deleted: wasNew, change_from: when };
  } catch (e) { return { error: e.message }; }
}

async function haCheckConfig() {
  // POST /api/config/core/check_config — validuje CELOU konfiguraci HA
  // (balíčky ano, lovelace dashboardy NE). Na N150 může trvat desítky
  // sekund, proto vlastní volání s dlouhým timeoutem místo haPost (8 s).
  const r = await axios.post(`${HA_URL}/api/config/core/check_config`, {},
    { headers: haHeaders(), timeout: 90000 });
  return r.data; // { result: 'valid'|'invalid', errors: string|null }
}
function listPackages() {
  const dir = path.join(HA_CONFIG_PATH, 'packages');
  const result = {};
  try {
    if (!fs.existsSync(dir)) return result;
    for (const cat of fs.readdirSync(dir)) {
      const cp = path.join(dir, cat);
      if (fs.statSync(cp).isDirectory()) result[cat] = fs.readdirSync(cp).filter(f => f.endsWith('.yaml'));
    }
  } catch {}
  return result;
}

// ═══════════════════════════════════════════════
// WHISPER — přepis hlasu
// ═══════════════════════════════════════════════
async function transcribeVoice(fileBuffer, mimeType) {
  const form = new FormData();
  form.append('file', fileBuffer, { filename: 'voice.ogg', contentType: mimeType || 'audio/ogg' });
  form.append('model', 'whisper-1');
  form.append('language', 'cs');
  const r = await axios.post('https://api.openai.com/v1/audio/transcriptions', form, {
    headers: { ...form.getHeaders(), Authorization: `Bearer ${OPENAI_KEY}` },
    timeout: 30000,
  });
  return r.data.text;
}

// ═══════════════════════════════════════════════
// NÁSTROJE
// ═══════════════════════════════════════════════
function buildTools(chatId) {
  const admin = isAdmin(chatId);
  const tools = [
    {
      name: 'get_areas',
      description: 'Získá seznam místností (oblastí/areas) z Home Assistant včetně zařízení v nich.',
      input_schema: { type: 'object', properties: {}, required: [] },
    },
    {
      name: 'garden_map',
      description: 'Správa mapy zahrady — přidej/uprav zónu nebo zobraz celou mapu.',
      input_schema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['get', 'set_zone', 'add_plant', 'remove_plant'] },
          zone_id: { type: 'string', description: 'ID zóny, např. zahon_u_plotu' },
          zone_name: { type: 'string', description: 'Čitelný název zóny, např. Záhon u plotu' },
          description: { type: 'string', description: 'Popis umístění nebo charakteru zóny' },
          plant: { type: 'string', description: 'Název rostliny' },
        },
        required: ['action'],
      },
    },
    {
      name: 'garden_plant_profile',
      description: 'Profil konkrétní rostliny — vytvoř, uprav nebo přidej poznámku/fotku.',
      input_schema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['get', 'create', 'add_note', 'add_photo_desc', 'get_all'] },
          plant_id: { type: 'string', description: 'ID rostliny, např. rajcata_zahon1' },
          name: { type: 'string' },
          location: { type: 'string', description: 'ID zóny kde roste' },
          species: { type: 'string', description: 'Druh/odrůda' },
          planted_date: { type: 'string', description: 'Datum výsadby' },
          note: { type: 'string', description: 'Poznámka nebo popis fotky' },
        },
        required: ['action'],
      },
    },
    {
      name: 'garden_planting_plan',
      description: 'Výsadbový plán — zaznamená co bylo kde vysazeno a zkontroluje střídání plodin.',
      input_schema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['get_history', 'add_record', 'check_rotation'] },
          zone_id: { type: 'string' },
          plant: { type: 'string' },
          year: { type: 'number' },
        },
        required: ['action'],
      },
    },
    {
      name: 'garden_note',
      description: 'Přidá obecnou zahradní poznámku nebo zobrazí historii.',
      input_schema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['add', 'get'] },
          text: { type: 'string' },
        },
        required: ['action'],
      },
    },
    {
      name: 'get_states',
      description: 'Získá seznam zařízení z HA.',
      input_schema: { type: 'object', properties: { domain: { type: 'string' } }, required: [] },
    },
    {
      name: 'get_state',
      description: 'Získá stav konkrétní entity.',
      input_schema: { type: 'object', properties: { entity_id: { type: 'string' } }, required: ['entity_id'] },
    },
    {
      name: 'camera_snapshot',
      description: 'Pořídí aktuální snímek z kamery (camera.xxx) a rovnou se na něj podívá. Použij, když se někdo zeptá "co se děje na [místo s kamerou]" nebo podobně. Entity_id kamery zjistíš přes get_states s domain=camera. Po zavolání popiš vlastními slovy, co na snímku vidíš.',
      input_schema: {
        type: 'object',
        properties: { entity_id: { type: 'string', description: 'entity_id kamery, např. camera.terasa' } },
        required: ['entity_id'],
      },
    },
    {
      name: 'turn_on',
      description: 'Zapne zařízení z whitelist domén.',
      input_schema: { type: 'object', properties: { entity_id: { type: 'string' } }, required: ['entity_id'] },
    },
    {
      name: 'turn_off',
      description: 'Vypne zařízení.',
      input_schema: { type: 'object', properties: { entity_id: { type: 'string' } }, required: ['entity_id'] },
    },
    {
      name: 'toggle',
      description: 'Přepne zařízení.',
      input_schema: { type: 'object', properties: { entity_id: { type: 'string' } }, required: ['entity_id'] },
    },
    {
      name: 'call_service',
      description: 'Zavolá HA službu pro povolené domény.',
      input_schema: {
        type: 'object',
        properties: { domain: { type: 'string' }, service: { type: 'string' }, data: { type: 'object' } },
        required: ['domain', 'service', 'data'],
      },
    },
    {
      name: 'remember',
      description: 'Uloží informaci do paměti.',
      input_schema: {
        type: 'object',
        properties: {
          category: { type: 'string', enum: ['room', 'device', 'preference', 'note', 'resident'] },
          key: { type: 'string' },
          value: { type: 'string' },
        },
        required: ['category', 'key', 'value'],
      },
    },
    {
      name: 'recall',
      description: 'Přečte paměť domu.',
      input_schema: {
        type: 'object',
        properties: { category: { type: 'string', enum: ['all', 'rooms', 'devices', 'preferences', 'notes', 'residents', 'checkin'] } },
        required: ['category'],
      },
    },
    {
      name: 'get_new_entities',
      description: 'Najde entity které Žán ještě nezná — nově přidaná zařízení.',
      input_schema: { type: 'object', properties: {}, required: [] },
    },
    {
      name: 'zigbee_permit_join',
      description: 'Zapne párování Zigbee sítě (permit join), aby šlo přidat nové zařízení. Sám detekuje integraci (Zigbee2MQTT, ZHA). Když párování nejde spustit dálkově (např. eWeLink most), vrátí instrukce pro uživatele — předej mu je.',
      input_schema: {
        type: 'object',
        properties: {
          duration: { type: 'number', description: 'Doba párování v sekundách (výchozí 60, max 254)' },
        },
        required: [],
      },
    },
    {
      name: 'scan_all_devices',
      description: 'Kompletní sken všech zařízení v HA — device registry, entity registry, oblasti. Vrátí zařízení podle místností, nezařazená zařízení, výrobce (Tuya, Sonoff, eWeLink, Zigbee apod.).',
      input_schema: { type: 'object', properties: {}, required: [] },
    },
    {
      name: 'rename_entity',
      description: 'Přejmenuje entitu v HA registru (friendly_name). DŮLEŽITÉ: entity_id NIKDY netipuj z názvu — vždy si ho napřed ověř přes get_states/scan_all_devices, jinak nástroj vrátí "Entity not found".',
      input_schema: {
        type: 'object',
        properties: {
          entity_id: { type: 'string', description: 'Přesné entity_id ověřené přes get_states, ne odhad z friendly_name' },
          new_name: { type: 'string', description: 'Nový friendly_name' },
        },
        required: ['entity_id', 'new_name'],
      },
    },
    {
      name: 'create_area',
      description: 'Vytvoří novou místnost (oblast) v HA.',
      input_schema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Název místnosti, např. Obývák' },
        },
        required: ['name'],
      },
    },
    {
      name: 'assign_area',
      description: 'Přiřadí entitu do místnosti v HA entity registry.',
      input_schema: {
        type: 'object',
        properties: {
          entity_id: { type: 'string' },
          area_name: { type: 'string', description: 'Název oblasti, např. Obývák' },
        },
        required: ['entity_id', 'area_name'],
      },
    },
    {
      name: 'assign_device_to_area',
      description: 'Přiřadí celé zařízení (device_id) do místnosti. Použij po scan_all_devices když znáš device_id.',
      input_schema: {
        type: 'object',
        properties: {
          device_id: { type: 'string', description: 'ID zařízení z device registry' },
          area_id: { type: 'string', description: 'area_id z area registry' },
        },
        required: ['device_id', 'area_id'],
      },
    },
    {
      name: 'scan_helpers',
      description: 'Zobrazí všechny existující helpery v HA (input_boolean, input_number, input_select, input_datetime, counter, timer). Použij před tvorbou testovacího dashboardu.',
      input_schema: { type: 'object', properties: {}, required: [] },
    },
    {
      name: 'read_playbook',
      description: 'Přečte uložený playbook (ověřený postup krok za krokem). Názvy dostupných playbooků máš v kontextu — před opakováním známého úkolu (přidání kamery, typ automatizace…) se podívej, jestli na to není návod.',
      input_schema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
    },
    {
      name: 'generate_report',
      description: 'Vygeneruje report o stavu domu — teploty, pohyb, počasí, energie, co se dělo. Použij, když uživatel napíše "report" nebo chce přehled — výsledek pak podej jako lidský přehled se zajímavostmi.',
      input_schema: { type: 'object', properties: {}, required: [] },
    },
    {
      name: 'update_family_member',
      description: 'Aktualizuje info o členu rodiny v paměti a přegeneruje rodinný dashboard. Použij kdykoli se dozvíš něco o členovi rodiny.',
      input_schema: {
        type: 'object',
        properties: {
          member_id: { type: 'string', description: 'ondra, jana, stepan, matej, eliska' },
          field: { type: 'string', description: 'Pole: info, preferences, photo_url, nebo libovolný klíč' },
          value: { type: 'string' },
        },
        required: ['member_id', 'field', 'value'],
      },
    },
    {
      name: 'update_house_info',
      description: 'Aktualizuje info o domě a přegeneruje rodinný dashboard.',
      input_schema: {
        type: 'object',
        properties: {
          field: { type: 'string', description: 'Pole: name, address, type, year_built, photo_url, info, floors, rooms_count' },
          value: { type: 'string' },
        },
        required: ['field', 'value'],
      },
    },
    {
      name: 'checkin_schedule',
      description: 'Správa týdenního check-inu.',
      input_schema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['mark_asked', 'mark_declined', 'add_topic', 'clear_topic', 'should_ask'] },
          topic: { type: 'string' },
        },
        required: ['action'],
      },
    },
    {
      name: 'rodina_update',
      description: `Zapíše/aktualizuje sekci v rodina.md — živém profilu domácnosti (dostáváš ho celý v kontextu). Sekce: ${RODINA_SECTIONS.join(', ')}. Obsah PŘEPISUJE celou sekci — piš vždy její kompletní nové znění (stávající text + doplněk). Ukládej sem odpovědi z dotazníku a trvalé poznatky o rodině hned, jak je zjistíš.`,
      input_schema: {
        type: 'object',
        properties: {
          section: { type: 'string', enum: RODINA_SECTIONS },
          content: { type: 'string', description: 'Kompletní nový obsah sekce (markdown, stručné odrážky)' },
        },
        required: ['section', 'content'],
      },
    },
  ];

  // Admin-only nástroje
  if (admin) {
    tools.push(
      {
        name: 'list_packages',
        description: 'Zobrazí existující YAML balíčky.',
        input_schema: { type: 'object', properties: {}, required: [] },
      },
      {
        name: 'read_package',
        description: 'Přečte obsah YAML balíčku.',
        input_schema: {
          type: 'object',
          properties: { category: { type: 'string' }, filename: { type: 'string' } },
          required: ['category', 'filename'],
        },
      },
      {
        name: 'write_package',
        description: `Zapíše YAML balíček. Kategorie: ${Object.keys(PACKAGE_CATEGORIES).join(', ')}.
NÁZEV SOUBORU = slug balíčku v HA: jen malá písmena a-z, číslice a podtržítka (snake_case). POMLČKA ZAKÁZÁNA — balíček s pomlčkou HA TIŠE nenačte (jen warning v logu, entity nevzniknou).
Pro testovací účely přidej příponu _test k názvu souboru (např. zahrada_test.yaml).
VŽDY nejdřív list_packages + read_package. Nikdy nezapisuj mimo packages/ nebo dashboards/.
Zápis je jištěný: syntaxe se validuje předem (nevalidní YAML se nezapíše), starý obsah se zálohuje a po zápisu běží kontrola konfigurace HA (může trvat i minutu) — při chybě se změna sama vrátí. Vrátit poslední zápis umíš nástrojem undo_last_change.
Po zápisu vždy popsat změny LIDSKY.`,
        input_schema: {
          type: 'object',
          properties: {
            category: { type: 'string', enum: Object.keys(PACKAGE_CATEGORIES) },
            filename: { type: 'string' },
            content: { type: 'string' },
            description: { type: 'string' },
          },
          required: ['category', 'filename', 'content', 'description'],
        },
      },
      {
        name: 'write_dashboard',
        description: 'Zapíše YAML dashboard. Pro testovací dashboardy použij název s příponou _test (např. zahrada_test.yaml).',
        input_schema: {
          type: 'object',
          properties: { filename: { type: 'string' }, content: { type: 'string' }, description: { type: 'string' } },
          required: ['filename', 'content', 'description'],
        },
      },
      {
        name: 'undo_last_change',
        description: 'Vrátí POSLEDNÍ zápis do configu (balíček, dashboard i smazání dashboardu): nový soubor smaže, přepsaný obnoví ze zálohy. Použij, když se změna nepovedla nebo si to uživatel rozmyslel. Po vrácení balíčku zavolej příslušný reload_ha. Starší zálohy: /config/zan_data/backups/.',
        input_schema: { type: 'object', properties: {}, required: [] },
      },
      {
        name: 'read_error_log',
        description: 'Přečte log s chybami — zdroj "ha" = error log Home Assistantu (filtrované ERROR/WARNING řádky), "zan_actions" = tvůj log akcí, "zan_conversation" = tvůj log konverzací. Použij VŽDY, když se něco nepovedlo (entita nevznikla, služba selhala) a hledáš příčinu.',
        input_schema: {
          type: 'object',
          properties: {
            source: { type: 'string', enum: ['ha', 'zan_actions', 'zan_conversation'] },
            lines: { type: 'number', description: 'kolik posledních řádků (default 60, max 200)' },
          },
          required: ['source'],
        },
      },
      {
        name: 'save_playbook',
        description: 'Uloží OVĚŘENÝ postup jako playbook (markdown, kroky za sebou, včetně čísel/nástrojů, které fungovaly). Ukládej JEN když postup prokazatelně funguje a Ondra řekl "ulož si to jako postup" (nebo to potvrdil na tvůj návrh). Playbook = "takhle se dělá X"; poučení (save_lesson) = "tohle nedělej".',
        input_schema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'krátký název, např. "pridani tapo kamery"' },
            content: { type: 'string', description: 'markdown: cíl, předpoklady, kroky, ověření' },
          },
          required: ['name', 'content'],
        },
      },
      {
        name: 'save_lesson',
        description: 'Uloží poučení z chyby. Piš krátce a obecně: co se stalo → jak to příště udělat jinak. Poučení dostáváš v každém kontextu — slouží k tomu, abys stejnou chybu neopakoval. Ukládej po každé opravené chybě nebo když tě uživatel opraví.',
        input_schema: {
          type: 'object',
          properties: {
            topic: { type: 'string', description: 'krátký štítek, např. "yaml-balicky", "dashboardy"' },
            text: { type: 'string' },
          },
          required: ['text'],
        },
      },
      {
        name: 'list_dashboards',
        description: 'Zobrazí dashboardy.',
        input_schema: { type: 'object', properties: {}, required: [] },
      },
      {
        name: 'read_dashboard',
        description: 'Přečte obsah dashboardu.',
        input_schema: {
          type: 'object',
          properties: { filename: { type: 'string' } },
          required: ['filename'],
        },
      },
      {
        name: 'validate_dashboard',
        description: 'Přečte dashboard, najde všechny entity v něm a zkontroluje které existují v HA a které ne. Základ pro úklid dashboardu.',
        input_schema: {
          type: 'object',
          properties: { filename: { type: 'string', description: 'Název souboru dashboardu' } },
          required: ['filename'],
        },
      },
      {
        name: 'delete_dashboard',
        description: 'Smaže soubor dashboardu.',
        input_schema: {
          type: 'object',
          properties: { filename: { type: 'string' } },
          required: ['filename'],
        },
      },
      {
        name: 'list_www_images',
        description: 'Zobrazí obrázky uložené v /config/www/zan/ které lze použít v dashboardech.',
        input_schema: { type: 'object', properties: {}, required: [] },
      },
      {
        name: 'reload_ha',
        description: 'Reloadne část HA po změně YAML. Dashboardy (Lovelace) reload NEPOTŘEBUJÍ — YAML dashboard se čte ze souboru vždy znovu, stačí obnovit stránku v prohlížeči/appce.',
        input_schema: {
          type: 'object',
          properties: { what: { type: 'string', enum: ['automations', 'scripts', 'scenes', 'helpers'] } },
          required: ['what'],
        },
      },
      {
        name: 'restart_ha',
        description: 'Restartuje HA. Jen když je skutečně nutné.',
        input_schema: {
          type: 'object',
          properties: { reason: { type: 'string' } },
          required: ['reason'],
        },
      },
      {
        name: 'ha_setup_list',
        description: 'Zobrazí aktuální patra, místnosti a zařízení bez přiřazené místnosti. Vždy zavolat jako první krok před vytvářením pater/místností nebo přiřazováním zařízení — ať se nevytváří duplicity.',
        input_schema: { type: 'object', properties: {}, required: [] },
      },
      {
        name: 'ha_setup_create_floor',
        description: 'Vytvoří nové patro domu (onboarding nové domácnosti). Level: 0 = přízemí, kladná čísla = patra nahoru, záporná = sklep/suterén.',
        input_schema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Např. "Přízemí", "1. patro", "Sklep"' },
            level: { type: 'integer' },
            icon: { type: 'string', description: 'Volitelně, mdi ikona, např. mdi:home' },
          },
          required: ['name', 'level'],
        },
      },
      {
        name: 'ha_setup_create_area',
        description: 'Vytvoří novou místnost a přiřadí ji k patru (floor_id z ha_setup_list).',
        input_schema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Např. "Obývací pokoj"' },
            floor_id: { type: 'string' },
            icon: { type: 'string' },
          },
          required: ['name', 'floor_id'],
        },
      },
      {
        name: 'ha_setup_assign_device',
        description: 'Přiřadí zařízení (device_id z ha_setup_list) do místnosti (area_id z ha_setup_list).',
        input_schema: {
          type: 'object',
          properties: {
            device_id: { type: 'string' },
            area_id: { type: 'string' },
          },
          required: ['device_id', 'area_id'],
        },
      },
      {
        name: 'scan_network',
        description: 'Prohledá domácí síť (LAN) a najde připojená zařízení — IP adresu, MAC a výrobce, pokud jde zjistit. Použij, když potřebuješ najít IP nové kamery/zařízení, které uživatel nezná (např. při přidávání kamery). Trvá cca 15–30 sekund. Zařízení od TP-Link (Tapo kamery) pozná podle výrobce v MAC adrese.',
        input_schema: { type: 'object', properties: {}, required: [] },
      },
      {
        name: 'setup_camera',
        description: `Přidá kameru do Home Assistant (Generic Camera / RTSP — funguje na Tapo a většinu IP kamer). NEČEKEJ, že budou všechny údaje hned k dispozici — doptej se na ně sám, po jedné otázce: 1) lokální IP kamery na síti, 2) u Tapo: má uživatel v appce Tapo vytvořený "Camera Account" (Advanced Settings → Camera Account — JINÝ účet než cloudové přihlášení, bez něj RTSP nejde)? Pokud ne, vysvětli mu krok za krokem jak ho vytvořit. 3) přihlašovací jméno/heslo z toho Camera Account. 4) jak se má kamera/místnost jmenovat. Teprve pak zavolej tenhle nástroj.`,
        input_schema: {
          type: 'object',
          properties: {
            host: { type: 'string', description: 'Lokální IP kamery, např. 192.168.0.50' },
            username: { type: 'string', description: 'Uživatel z Tapo Camera Account (ne cloudový účet)' },
            password: { type: 'string' },
            stream_path: { type: 'string', description: 'Výchozí /stream1 pro Tapo (vyšší kvalita) nebo /stream2 (nižší, úspornější)' },
            name: { type: 'string', description: 'Název kamery/místnosti pro HA, např. Terasa' },
          },
          required: ['host', 'username', 'password', 'name'],
        },
      },
      {
        name: 'queue_task',
        description: `Zařadí velký/drahý úkol (např. "hezké dashboardy pro celý dům", hromadné změny) do noční fronty místo okamžitého zpracování. Použij, když by úkol stál hodně tokenů vzhledem k dnešní útratě (viz AKTUÁLNÍ KONTEXT) NEBO by potřeboval víc iterací než zvládne jedna konverzace (mnoho místností/kroků najednou). Po zavolání VŽDY řekni uživateli lidsky, co a kdy uděláš (např. "je to hodně práce, zvládnu to přes noc, klidně na dvakrát").`,
        input_schema: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['add', 'list', 'mark_done'] },
            description: { type: 'string', description: 'Co přesně udělat — konkrétně, ať to noční zpracování ví, kde začít (add)' },
            task_id: { type: 'string', description: 'ID úkolu (mark_done)' },
          },
          required: ['action'],
        },
      }
    );
  }

  return tools;
}

// ═══════════════════════════════════════════════
// VYKONÁNÍ NÁSTROJŮ
// ═══════════════════════════════════════════════
async function executeTool(name, input, chatId) {
  const user = getUser(chatId);
  const memory = loadMemory();

  // Security check — admin-only nástroje
  const adminOnlyTools = ['write_package', 'write_dashboard', 'reload_ha', 'restart_ha', 'read_error_log', 'save_lesson', 'save_playbook', 'undo_last_change'];
  if (adminOnlyTools.includes(name) && !isAdmin(chatId)) {
    logSecurity(chatId, `blocked_admin_tool:${name}`);
    return { error: 'Tato akce je dostupná pouze pro administrátora.' };
  }

  // Vynucené potvrzení citlivých akcí (kotel/žaluzie/restart) — akce se
  // uloží a uživateli se zobrazí tlačítka ✅/❌. __confirmed smí nastavit
  // JEN callback handler (agentic loop ho z modelového vstupu maže).
  const sensitiveDesc = isSensitiveAction(name, input);
  if (sensitiveDesc && !input.__confirmed) {
    const token = String(Date.now());
    pendingConfirm.set(chatId, { name, input, desc: sensitiveDesc, token, when: Date.now() });
    await sendSafe(chatId, `⚠️ Citlivá akce: ${sensitiveDesc}\nMám to provést?`, {
      reply_markup: { inline_keyboard: [[
        { text: '✅ Ano', callback_data: `confirm:${token}` },
        { text: '❌ Ne', callback_data: `cancel:${token}` },
      ]] },
    });
    logAction(chatId, user.name, 'confirm_requested', sensitiveDesc, 'pending');
    return { pending_confirmation: true, note: 'Akce ČEKÁ na potvrzení tlačítkem — uživateli se právě zobrazila tlačítka ✅/❌. Neprováděj ji znovu a netvrď, že je hotová; řekni jen, že čekáš na potvrzení.' };
  }

  console.log(`🔧 [${user.name}] ${name} ${JSON.stringify(input).substring(0, 100)}`);

  try {
    switch (name) {

      case 'garden_map': {
        const garden = loadGarden();
        if (input.action === 'get') {
          return { map: garden.map, zones: Object.keys(garden.map).length };
        }
        if (input.action === 'set_zone') {
          if (!garden.map[input.zone_id]) garden.map[input.zone_id] = { plants: [] };
          garden.map[input.zone_id].name = input.zone_name || input.zone_id;
          garden.map[input.zone_id].description = input.description || '';
          saveGarden(garden);
          return { success: true, zone: garden.map[input.zone_id] };
        }
        if (input.action === 'add_plant') {
          if (!garden.map[input.zone_id]) return { error: `Zóna ${input.zone_id} neexistuje` };
          if (!garden.map[input.zone_id].plants.includes(input.plant)) {
            garden.map[input.zone_id].plants.push(input.plant);
          }
          saveGarden(garden);
          return { success: true };
        }
        if (input.action === 'remove_plant') {
          if (garden.map[input.zone_id]) {
            garden.map[input.zone_id].plants = garden.map[input.zone_id].plants.filter(p => p !== input.plant);
            saveGarden(garden);
          }
          return { success: true };
        }
        return { error: 'Neznámá akce' };
      }

      case 'garden_plant_profile': {
        const garden = loadGarden();
        if (!garden.plant_profiles) garden.plant_profiles = {};
        if (input.action === 'get_all') {
          return { profiles: garden.plant_profiles, count: Object.keys(garden.plant_profiles).length };
        }
        if (input.action === 'get') {
          return garden.plant_profiles[input.plant_id] || { error: 'Profil nenalezen' };
        }
        if (input.action === 'create') {
          garden.plant_profiles[input.plant_id] = {
            name: input.name,
            location: input.location || '',
            species: input.species || '',
            planted: input.planted_date || new Date().toLocaleDateString('cs-CZ'),
            photos: [],
            notes: [],
            created: new Date().toISOString(),
          };
          saveGarden(garden);
          return { success: true, profile: garden.plant_profiles[input.plant_id] };
        }
        if (input.action === 'add_note') {
          if (!garden.plant_profiles[input.plant_id]) return { error: 'Profil nenalezen' };
          garden.plant_profiles[input.plant_id].notes.push({
            text: input.note,
            date: new Date().toLocaleDateString('cs-CZ'),
          });
          saveGarden(garden);
          return { success: true };
        }
        if (input.action === 'add_photo_desc') {
          if (!garden.plant_profiles[input.plant_id]) return { error: 'Profil nenalezen' };
          garden.plant_profiles[input.plant_id].photos.push({
            description: input.note,
            date: new Date().toLocaleDateString('cs-CZ'),
            month: new Date().getMonth() + 1,
          });
          saveGarden(garden);
          return { success: true };
        }
        return { error: 'Neznámá akce' };
      }

      case 'garden_planting_plan': {
        const garden = loadGarden();
        if (!garden.planting_history) garden.planting_history = [];
        if (input.action === 'get_history') {
          const filtered = input.zone_id
            ? garden.planting_history.filter(h => h.zone === input.zone_id)
            : garden.planting_history;
          return { history: filtered.slice(-30) };
        }
        if (input.action === 'add_record') {
          garden.planting_history.push({
            zone: input.zone_id,
            plant: input.plant,
            year: input.year || new Date().getFullYear(),
            date: new Date().toLocaleDateString('cs-CZ'),
          });
          saveGarden(garden);
          return { success: true };
        }
        if (input.action === 'check_rotation') {
          const rotation = analyzeCropRotation(garden);
          return rotation;
        }
        return { error: 'Neznámá akce' };
      }

      case 'garden_note': {
        const garden = loadGarden();
        if (input.action === 'add') {
          garden.notes.push({ text: input.text, date: new Date().toLocaleDateString('cs-CZ') });
          if (garden.notes.length > 100) garden.notes = garden.notes.slice(-100);
          saveGarden(garden);
          return { success: true };
        }
        if (input.action === 'get') {
          return { notes: garden.notes.slice(-20) };
        }
        return { error: 'Neznámá akce' };
      }

      case 'get_areas': {
        // POZOR (oprava 2026-07-05): REST config/{area,entity,device}_registry
        // vrací 404 — HA tyhle registry vystavuje jen přes WebSocket. Dřívější
        // verze tohohle nástroje na to volala haGet(), chyby si tiše polykala
        // (.catch(() => [])) a vždycky vracela prázdno. Opraveno na haWsCommand.
        const [areaReg, entityReg, deviceReg] = await Promise.all([
          haWsCommand('config/area_registry/list').catch(() => []),
          haWsCommand('config/entity_registry/list').catch(() => []),
          haWsCommand('config/device_registry/list').catch(() => []),
        ]);
        const areas = Array.isArray(areaReg) ? areaReg : [];
        const entities = Array.isArray(entityReg) ? entityReg : [];
        const devices = Array.isArray(deviceReg) ? deviceReg : [];

        // Mapuj entity a zařízení na oblasti
        const entityByArea = {};
        for (const e of entities) {
          const aId = e.area_id;
          if (aId) {
            if (!entityByArea[aId]) entityByArea[aId] = [];
            entityByArea[aId].push({ entity_id: e.entity_id, name: e.name || e.original_name || e.entity_id });
          }
        }
        const deviceByArea = {};
        for (const d of devices) {
          const aId = d.area_id;
          if (aId) {
            if (!deviceByArea[aId]) deviceByArea[aId] = [];
            deviceByArea[aId].push({ device_id: d.id, name: d.name_by_user || d.name });
          }
        }

        const result = areas.map(a => ({
          area_id: a.area_id,
          name: a.name,
          entities: entityByArea[a.area_id] || [],
          devices: deviceByArea[a.area_id] || [],
        }));

        return {
          areas: result,
          count: result.length,
          empty_areas: result.filter(a => a.entities.length === 0 && a.devices.length === 0).map(a => a.name),
        };
      }

      case 'get_states': {
        const states = await haGet('states');
        let filtered = states.filter(s =>
          !['zone', 'sun', 'device_tracker', 'update', 'person'].some(d => s.entity_id.startsWith(d + '.'))
        );
        if (input.domain) filtered = filtered.filter(s => s.entity_id.startsWith(input.domain + '.'));
        return filtered.map(s => ({
          entity_id: s.entity_id,
          name: s.attributes.friendly_name || s.entity_id,
          state: s.state,
          unit: s.attributes.unit_of_measurement || '',
          area: s.attributes.area_id || '',
        })).slice(0, 120);
      }

      case 'get_state': {
        const s = await haGet(`states/${input.entity_id}`);
        return { entity_id: s.entity_id, name: s.attributes.friendly_name, state: s.state, attributes: s.attributes };
      }

      case 'camera_snapshot': {
        try {
          const r = await axios.get(`${HA_URL}/api/camera_proxy/${input.entity_id}`, {
            headers: haHeaders(), responseType: 'arraybuffer', timeout: 10000,
          });
          const base64 = Buffer.from(r.data).toString('base64');
          logAction(chatId, user.name, 'camera_snapshot', input.entity_id, 'ok');
          // Speciální tvar — processMessage tohle pozná a vrátí Claudovi
          // rovnou jako obrázek (multimodal tool_result), ne jako JSON text.
          return { __image_base64: base64, __media_type: 'image/jpeg', note: `Snímek z ${input.entity_id}, ${new Date().toLocaleTimeString('cs-CZ')}.` };
        } catch (e) {
          return { error: `Nepodařilo se získat snímek z ${input.entity_id}: ${e.message}` };
        }
      }

      case 'turn_on': {
        const domain = input.entity_id.split('.')[0];
        if (!ALLOWED_DOMAINS.includes(domain)) {
          logSecurity(chatId, `blocked_domain:${domain}`);
          return { error: `Doména ${domain} není povolena.` };
        }
        if (BLOCKED_ENTITIES.some(b => input.entity_id.includes(b))) {
          logSecurity(chatId, `blocked_entity:${input.entity_id}`);
          return { error: 'Tato entita je blokována z bezpečnostních důvodů.' };
        }
        const result = await haPost(`services/${domain}/turn_on`, { entity_id: input.entity_id });
        logAction(chatId, user.name, 'turn_on', input.entity_id, 'ok');
        return { success: true, message: `✅ ${input.entity_id} zapnuto`, confirmed: true };
      }

      case 'turn_off': {
        const domain = input.entity_id.split('.')[0];
        if (!ALLOWED_DOMAINS.includes(domain)) return { error: `Doména ${domain} není povolena.` };
        await haPost(`services/${domain}/turn_off`, { entity_id: input.entity_id });
        logAction(chatId, user.name, 'turn_off', input.entity_id, 'ok');
        return { success: true, message: `✅ ${input.entity_id} vypnuto`, confirmed: true };
      }

      case 'toggle': {
        const domain = input.entity_id.split('.')[0];
        if (!ALLOWED_DOMAINS.includes(domain)) return { error: `Doména ${domain} není povolena.` };
        await haPost(`services/${domain}/toggle`, { entity_id: input.entity_id });
        logAction(chatId, user.name, 'toggle', input.entity_id, 'ok');
        return { success: true, message: `✅ ${input.entity_id} přepnuto`, confirmed: true };
      }

      case 'call_service': {
        if (!ALLOWED_DOMAINS.includes(input.domain)) return { error: `Doména ${input.domain} není povolena.` };
        await haPost(`services/${input.domain}/${input.service}`, input.data);
        logAction(chatId, user.name, `${input.domain}.${input.service}`, JSON.stringify(input.data), 'ok');
        return { success: true, confirmed: true };
      }

      case 'remember': {
        if (input.category === 'room') memory.rooms[input.key] = input.value;
        else if (input.category === 'device') memory.devices[input.key] = input.value;
        else if (input.category === 'preference') memory.preferences[input.key] = input.value;
        else if (input.category === 'resident') {
          try { memory.residents[input.key] = JSON.parse(input.value); }
          catch { memory.residents[input.key] = { name: input.key, info: input.value }; }
        }
        else if (input.category === 'note') {
          memory.notes.push({ text: input.value, date: new Date().toLocaleDateString('cs-CZ') });
          if (memory.notes.length > 50) memory.notes = memory.notes.slice(-50);
        }
        saveMemory(memory);
        return { success: true };
      }

      case 'recall': {
        if (input.category === 'all') {
          // known_entities = seznam VŠECH entity_id v domě — do kontextu modelu neposílat (žere tokeny)
          const { known_entities, ...rest } = memory;
          return { ...rest, known_entities_count: (known_entities || []).length };
        }
        const map = { rooms: 'rooms', devices: 'devices', preferences: 'preferences', notes: 'notes', residents: 'residents', checkin: 'checkin' };
        return memory[map[input.category]] || {};
      }

      case 'get_new_entities': {
        const states = await haGet('states');
        const known = memory.known_entities || [];
        const all = states
          .filter(s => !['zone', 'sun', 'device_tracker', 'update', 'person', 'persistent_notification'].some(d => s.entity_id.startsWith(d + '.')))
          .map(s => s.entity_id);
        const newEntities = all.filter(e => !known.includes(e));
        // Aktualizuj known_entities
        memory.known_entities = all;
        saveMemory(memory);
        const details = await Promise.all(newEntities.slice(0, 20).map(async e => {
          try {
            const s = await haGet(`states/${e}`);
            return { entity_id: e, name: s.attributes.friendly_name || e, state: s.state, domain: e.split('.')[0] };
          } catch { return { entity_id: e }; }
        }));
        return { new_entities: details, count: newEntities.length };
      }

      case 'zigbee_permit_join': {
        const duration = Math.min(Math.max(input.duration || 60, 10), 254);
        // 1) Zigbee2MQTT — bridge vystavuje přepínač permit join
        try {
          const states = await haGet('states');
          const pj = states.find(s => s.entity_id.includes('permit_join') && ['switch', 'input_boolean'].includes(s.entity_id.split('.')[0]));
          if (pj) {
            await haPost(`services/${pj.entity_id.split('.')[0]}/turn_on`, { entity_id: pj.entity_id });
            logAction(chatId, user.name, 'permit_join', pj.entity_id, 'ok');
            return { success: true, backend: 'zigbee2mqtt', message: `✅ Párování zapnuto (Zigbee2MQTT). Aktivuj teď párování na zařízení a dej mi vědět — pak spustím sken.` };
          }
        } catch {}
        // 2) ZHA — služba zha.permit
        try {
          const services = await haGet('services');
          const domains = services.map(s => s.domain);
          if (domains.includes('zha')) {
            await haPost('services/zha/permit', { duration });
            logAction(chatId, user.name, 'permit_join', 'zha', 'ok');
            return { success: true, backend: 'zha', message: `✅ Párování zapnuto na ${duration} s (ZHA). Aktivuj teď párování na zařízení a dej mi vědět — pak spustím sken.` };
          }
          // 3) Z2M přes MQTT bez bridge entity
          if (domains.includes('mqtt')) {
            await haPost('services/mqtt/publish', { topic: 'zigbee2mqtt/bridge/request/permit_join', payload: JSON.stringify({ time: duration }) });
            logAction(chatId, user.name, 'permit_join', 'mqtt', 'ok');
            return { success: true, backend: 'zigbee2mqtt/mqtt', message: `✅ Poslal jsem žádost o párování na ${duration} s přes MQTT. Aktivuj párování na zařízení a dej mi vědět.` };
          }
        } catch (e) {
          return { error: `Spuštění párování selhalo: ${e.message}` };
        }
        // 4) Nic ovladatelného — typicky eWeLink/Sonoff most nebo Matter
        return {
          success: false,
          backend: 'none',
          user_instructions: 'Dálkové zapnutí párování tu není možné — Zigbee běží přes eWeLink most (nebo jde o Matter zařízení). Postup: Zigbee → otevři aplikaci eWeLink → vyber most ZBBridge-U → "Přidat podzařízení" a aktivuj párování na zásuvce. Matter → aplikace Home Assistant → Nastavení → Zařízení → Přidat zařízení → naskenuj QR kód. Až bude zařízení přidané, napiš mi a já ho pojmenuju, zařadím do místnosti a navrhnu automatizace.',
        };
      }

      case 'rename_entity': {
        if (!isAdmin(chatId)) return { error: 'Přejmenování vyžaduje admin přístup.' };
        try {
          // Oprava 2026-07-05: REST config/entity_registry/update vrací 404
          // (HA to vystavuje jen přes WebSocket) — přepnuto na haWsCommand.
          await haWsCommand('config/entity_registry/update', {
            entity_id: input.entity_id,
            name: input.new_name,
          });
          logAction(chatId, user.name, 'rename', input.entity_id, input.new_name);
          return { success: true, message: `Přejmenováno na: ${input.new_name}` };
        } catch (e) {
          return { error: `Přejmenování selhalo: ${e.message}. Přejmenuj ručně v HA Settings → Entities.` };
        }
      }

      case 'scan_all_devices': {
        const errors = {};
        const [deviceReg, entityReg, areaReg] = await Promise.all([
          haRegistry('device_registry').catch(e => { errors.device_registry = e.message; return null; }),
          haRegistry('entity_registry').catch(e => { errors.entity_registry = e.message; return null; }),
          haRegistry('area_registry').catch(e => { errors.area_registry = e.message; return null; }),
        ]);

        if (Object.keys(errors).length) console.warn('scan_all_devices errors:', errors);

        // Fallback — pokud registry selžou, použij /api/states
        const useStateFallback = !Array.isArray(deviceReg) || deviceReg.length === 0;
        if (useStateFallback) {
          const states = await haGet('states');
          const skipDomains = ['zone', 'sun', 'device_tracker', 'update', 'person', 'persistent_notification', 'weather'];
          const filtered = states.filter(s => !skipDomains.some(d => s.entity_id.startsWith(d + '.')));
          const byDomain = {};
          for (const s of filtered) {
            const domain = s.entity_id.split('.')[0];
            if (!byDomain[domain]) byDomain[domain] = [];
            byDomain[domain].push({ entity_id: s.entity_id, name: s.attributes.friendly_name || s.entity_id, state: s.state });
          }
          // Oblasti: z registry nebo z memory.rooms jako poslední záloha
          let areas = Array.isArray(areaReg) ? areaReg.map(a => ({ area_id: a.area_id, name: a.name })) : [];
          if (areas.length === 0) {
            areas = Object.values(memory.rooms || {}).filter(r => r.name).map(r => ({ area_id: r.area_id || r.name, name: r.name }));
          }
          return {
            total_entities: filtered.length,
            total_areas: areas.length,
            areas,
            by_domain: byDomain,
            registry_errors: errors,
            note: 'Registry API nedostupné — zobrazuji entity ze stavů. Oblasti: ' + (areas.length ? areas.map(a => a.name).join(', ') : 'prázdné'),
          };
        }

        const entityByDevice = {};
        for (const e of (Array.isArray(entityReg) ? entityReg : [])) {
          if (e.device_id) {
            if (!entityByDevice[e.device_id]) entityByDevice[e.device_id] = [];
            entityByDevice[e.device_id].push({
              entity_id: e.entity_id,
              name: e.name || e.original_name || e.entity_id,
              area_id: e.area_id,
              disabled: !!e.disabled_by,
            });
          }
        }
        const areas = Array.isArray(areaReg) ? areaReg : [];
        const areaMap = Object.fromEntries(areas.map(a => [a.area_id, a.name]));
        const devices = deviceReg.map(d => ({
          device_id: d.id,
          name: d.name_by_user || d.name || 'Neznámé',
          manufacturer: d.manufacturer || '',
          model: d.model || '',
          area_id: d.area_id || null,
          area_name: d.area_id ? (areaMap[d.area_id] || d.area_id) : null,
          integration: (d.identifiers || []).map(i => i[0]).filter(Boolean).join(', '),
          entities: entityByDevice[d.id] || [],
        }));
        const byArea = {};
        for (const d of devices) {
          const key = d.area_name || 'Bez místnosti';
          if (!byArea[key]) byArea[key] = [];
          byArea[key].push(d);
        }
        return {
          total_devices: devices.length,
          total_areas: areas.length,
          areas: areas.map(a => ({ area_id: a.area_id, name: a.name })),
          by_area: byArea,
          unassigned: devices.filter(d => !d.area_id),
        };
      }

      case 'create_area': {
        if (!isAdmin(chatId)) return { error: 'Vytvoření místnosti vyžaduje admin přístup.' };
        try {
          // Oprava 2026-07-05: REST config/area_registry/create vrací 404,
          // stejný problém jako u ha_setup_create_area — přepnuto na WS.
          // (Pozn.: ha_setup_create_area dělá totéž + rovnou i patro —
          // pro rychlé vytvoření místnosti bez patra zůstává i tenhle.)
          const result = await haWsCommand('config/area_registry/create', { name: input.name });
          logAction(chatId, user.name, 'create_area', input.name, 'ok');
          return { success: true, area_id: result.area_id, name: result.name, raw: result };
        } catch (e) {
          return {
            error: `Vytvoření oblasti selhalo: ${e.message}`,
            tip: 'Vytvoř místnost ručně v HA: Nastavení → Oblasti a zóny → Přidat oblast',
          };
        }
      }

      case 'assign_area': {
        if (!isAdmin(chatId)) return { error: 'Přiřazení oblasti vyžaduje admin přístup.' };
        try {
          const areas = await haWsCommand('config/area_registry/list').catch(() => []);
          const area = Array.isArray(areas) ? areas.find(a => a.name.toLowerCase() === input.area_name.toLowerCase()) : null;
          if (!area) {
            return { error: `Oblast "${input.area_name}" nenalezena.`, available: Array.isArray(areas) ? areas.map(a => a.name) : [] };
          }
          // Oprava 2026-07-05: REST config/entity_registry/update vrací 404 — WS.
          await haWsCommand('config/entity_registry/update', { entity_id: input.entity_id, area_id: area.area_id });
          logAction(chatId, user.name, 'assign_area', input.entity_id, area.area_id);
          return { success: true, message: `${input.entity_id} přiřazena do oblasti ${area.name}` };
        } catch (e) {
          return { error: e.message };
        }
      }

      case 'assign_device_to_area': {
        if (!isAdmin(chatId)) return { error: 'Přiřazení vyžaduje admin přístup.' };
        try {
          let area_id = input.area_id;
          // Pokud dostaneme název oblasti místo ID, vyhledáme area_id
          if (area_id && !area_id.match(/^[a-z0-9_]+$/)) {
            const areas = await haWsCommand('config/area_registry/list').catch(() => []);
            const found = Array.isArray(areas) ? areas.find(a => a.name.toLowerCase() === area_id.toLowerCase()) : null;
            if (!found) return { error: `Oblast "${area_id}" nenalezena.`, available: Array.isArray(areas) ? areas.map(a => a.name) : [] };
            area_id = found.area_id;
          }
          // Oprava 2026-07-05: REST config/device_registry/update vrací 404 — WS.
          // (ha_setup_assign_device dělá totéž — tenhle navíc umí i název místo ID.)
          await haWsCommand('config/device_registry/update', { device_id: input.device_id, area_id });
          logAction(chatId, user.name, 'assign_device_area', input.device_id, area_id);
          return { success: true, message: `Zařízení ${input.device_id} přiřazeno do oblasti ${area_id}` };
        } catch (e) {
          return { error: e.message };
        }
      }

      case 'scan_helpers': {
        const states = await haGet('states');
        const helperDomains = ['input_boolean', 'input_number', 'input_select', 'input_datetime', 'input_text', 'counter', 'timer'];
        const helpers = {};
        for (const domain of helperDomains) {
          const found = states
            .filter(s => s.entity_id.startsWith(domain + '.'))
            .map(s => ({
              entity_id: s.entity_id,
              name: s.attributes.friendly_name || s.entity_id,
              state: s.state,
              unit: s.attributes.unit_of_measurement || '',
              options: s.attributes.options || null,
              min: s.attributes.min !== undefined ? s.attributes.min : null,
              max: s.attributes.max !== undefined ? s.attributes.max : null,
            }));
          if (found.length > 0) helpers[domain] = found;
        }
        const total = Object.values(helpers).reduce((s, arr) => s + arr.length, 0);
        return { helpers, total, note: total === 0 ? 'Žádné helpery nenalezeny — můžu je vytvořit přes write_package' : `${total} helperů nalezeno` };
      }

      case 'generate_report': {
        const states = await haGet('states');

        // Teploty
        const temps = states.filter(s => s.entity_id.startsWith('sensor.') && s.attributes.unit_of_measurement === '°C')
          .map(s => `${s.attributes.friendly_name || s.entity_id}: ${s.state}°C`);

        // Pohyb
        const motion = states.filter(s => s.entity_id.includes('motion') || s.entity_id.includes('pohyb'))
          .map(s => `${s.attributes.friendly_name || s.entity_id}: ${s.state}`);

        // Světla zapnutá
        const lightsOn = states.filter(s => s.entity_id.startsWith('light.') && s.state === 'on')
          .map(s => s.attributes.friendly_name || s.entity_id);

        // Zásuvky zapnuté
        const switchesOn = states.filter(s => s.entity_id.startsWith('switch.') && s.state === 'on')
          .map(s => s.attributes.friendly_name || s.entity_id);

        // Počasí
        const weather = states.filter(s => s.entity_id.startsWith('weather.'))
          .map(s => ({ name: s.attributes.friendly_name, state: s.state, temp: s.attributes.temperature, humidity: s.attributes.humidity }));

        // Energie
        const energy = states.filter(s => s.attributes.unit_of_measurement === 'W' || s.attributes.unit_of_measurement === 'kWh')
          .map(s => `${s.attributes.friendly_name || s.entity_id}: ${s.state} ${s.attributes.unit_of_measurement}`);

        return { temps, motion, lightsOn, switchesOn, weather, energy, generated_at: new Date().toLocaleString('cs-CZ') };
      }

      case 'update_family_member': {
        if (!memory.residents[input.member_id]) return { error: `Člen "${input.member_id}" nenalezen. Dostupní: ondra, jana, stepan, matej, eliska` };
        memory.residents[input.member_id][input.field] = input.value;
        saveMemory(memory);
        await createFamilyDashboard();
        return { success: true, message: `${memory.residents[input.member_id].name}: ${input.field} aktualizováno. Dashboard přegenerován.` };
      }

      case 'update_house_info': {
        if (!memory.house) memory.house = {};
        memory.house[input.field] = input.value;
        saveMemory(memory);
        await createFamilyDashboard();
        return { success: true, message: `Domeček: ${input.field} = ${input.value}. Dashboard přegenerován.` };
      }

      case 'checkin_schedule': {
        if (!memory.checkin) memory.checkin = { last_asked: null, pending_topics: [], declined_at: null };
        const now = new Date().toISOString();
        if (input.action === 'mark_asked') { memory.checkin.last_asked = now; memory.checkin.declined_at = null; }
        else if (input.action === 'mark_declined') { memory.checkin.declined_at = now; }
        else if (input.action === 'add_topic' && input.topic) {
          if (!memory.checkin.pending_topics.includes(input.topic)) memory.checkin.pending_topics.push(input.topic);
        }
        else if (input.action === 'clear_topic') {
          memory.checkin.pending_topics = memory.checkin.pending_topics.filter(t => t !== input.topic);
        }
        else if (input.action === 'should_ask') {
          const lastAsked = memory.checkin.last_asked ? new Date(memory.checkin.last_asked) : null;
          const declined = memory.checkin.declined_at ? new Date(memory.checkin.declined_at) : null;
          const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
          const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
          saveMemory(memory);
          return {
            should_ask: (!lastAsked || lastAsked < weekAgo) && (!declined || declined < dayAgo),
            pending_topics: memory.checkin.pending_topics,
          };
        }
        saveMemory(memory);
        return { success: true };
      }

      case 'rodina_update': {
        // Jana (user) smí — profil plní hlavně ona; hosté ne
        if (user.role === 'guest') return { error: 'Profil domácnosti smí upravovat jen rodina.' };
        const ok = updateRodinaSection(input.section, input.content);
        if (!ok) return { error: 'Zápis rodina.md selhal (zkontroluj /config/zan_data).' };
        logAction(chatId, user.name, 'rodina_update', input.section, 'ok');
        return { success: true, note: `Sekce "${input.section}" uložena. Pokud zbývají nevyplněné sekce, můžeš se PŘÍŠTĚ zeptat na další — teď už se neptej.` };
      }

      case 'list_packages': return { packages: listPackages(), categories: PACKAGE_CATEGORIES };

      case 'read_package': {
        const fp = getPackagePath(input.category, input.filename);
        const content = readYamlFile(fp);
        if (!content) return { error: `Soubor neexistuje: ${input.category}/${input.filename}` };
        return { content };
      }

      case 'read_error_log': {
        const lines = Math.min(input.lines || 60, 200);
        if (input.source === 'zan_actions' || input.source === 'zan_conversation') {
          const f = input.source === 'zan_actions' ? LOG_FILE : CONVO_LOG_FILE;
          const txt = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
          return { log: txt.split('\n').slice(-lines).join('\n') || '(prázdný log)' };
        }
        const raw = await axios.get(`${HA_URL}/api/error_log`, { headers: haHeaders(), timeout: 10000 });
        const filtrovane = String(raw.data || '').split('\n')
          .filter(l => /ERROR|WARNING|Invalid|failed|Traceback/i.test(l));
        return { log: filtrovane.slice(-lines).join('\n') || '(žádné chyby ani warningy)' };
      }

      case 'save_playbook': {
        const slug = savePlaybook(input.name, input.content);
        if (!slug) return { error: 'Uložení playbooku selhalo (zkontroluj /config/zan_data).' };
        logAction(chatId, user.name, 'save_playbook', slug, 'ok');
        return { success: true, name: slug, note: 'Playbook uložen — jeho název od teď vidíš v kontextu.' };
      }

      case 'read_playbook': {
        const content = readPlaybook(input.name);
        if (!content) return { error: `Playbook "${input.name}" neexistuje. Dostupné: ${listPlaybooks().join(', ') || 'žádné'}` };
        return { name: playbookSlug(input.name), content };
      }

      case 'save_lesson': {
        const lessons = loadLessons();
        lessons.push({ date: new Date().toISOString().slice(0, 10), topic: input.topic || 'obecné', text: input.text });
        saveLessons(lessons);
        logAction(chatId, user.name, 'save_lesson', input.topic || '-', 'ok');
        return { success: true, celkem: lessons.length, note: 'Poučení uloženo — od teď ho dostáváš v každém kontextu.' };
      }

      case 'write_package': {
        // Fáze 0: 1) syntaxe se validuje PŘED zápisem, 2) starý obsah se
        // zálohuje, 3) po zápisu běží HA check_config — invalid = automatický
        // návrat zálohy. Nevalidní YAML se na disk nikdy nedostane.
        const syntaxError = validateYamlSyntax(input.content);
        if (syntaxError) {
          logAction(chatId, user.name, 'write_package', `${input.category}/${input.filename}`, 'yaml-invalid');
          return { error: `YAML není validní, nezapsáno. Oprav a zkus znovu:\n${syntaxError}` };
        }
        const fp = getPackagePath(input.category, input.filename);
        const oldContent = readYamlFile(fp);
        const backup = backupFile(fp);
        const ok = writeYamlFile(fp, input.content);
        if (!ok) return { error: `Zápis selhal. Zkontroluj Samba připojení.` };
        recordChange(fp, backup, !oldContent);

        // check_config může na N150 trvat desítky sekund — řekni to uživateli,
        // ať to nevypadá jako mlčení (poučení ze sendSafe éry).
        sendSafe(chatId, '🧪 Zapsáno, ověřuju konfiguraci HA (může trvat i minutu)…');
        let checkNote = '';
        try {
          const check = await haCheckConfig();
          if (check && check.result === 'invalid') {
            const restored = restoreLastChange();
            logAction(chatId, user.name, 'write_package', `${input.category}/${input.filename}`, 'check_config-invalid-rollback');
            return {
              error: `HA check_config hlásí chybu — zápis jsem automaticky vrátil (${restored.success ? (restored.was_new_file_deleted ? 'nový soubor smazán' : 'obnovena záloha') : 'POZOR: návrat selhal, obnov ručně z backups/'}).\nChyby: ${String(check.errors || '').slice(0, 1500)}\nPokud chyba očividně nesouvisí s tímhle souborem, config byl rozbitý už před zápisem — řekni to uživateli.`,
            };
          }
          checkNote = 'check_config: valid';
        } catch (e) {
          // check nedoběhl (timeout/síť) — zápis platí, ale bez ověření
          checkNote = `check_config nedoběhl (${e.message}) — zápis platí, ale neověřený; po reloadu ověř entity o to pečlivěji`;
        }

        memory.notes.push({ text: `Balíček ${input.category}/${input.filename}: ${input.description}`, date: new Date().toLocaleDateString('cs-CZ') });
        saveMemory(memory);
        logAction(chatId, user.name, 'write_package', `${input.category}/${input.filename}`, 'ok');
        const isTest = input.filename.search(/[-_]test/) >= 0;
        return {
          success: true,
          path: `packages/${input.category}/${input.filename}`,
          was_new: !oldContent,
          is_test: isTest,
          check_config: checkNote,
          undo_hint: 'Kdyby výsledek nebyl žádoucí, umíš ho vrátit nástrojem undo_last_change.',
          human_diff_hint: oldContent
            ? 'Soubor existoval — popiš uživateli CO KONKRÉTNĚ se změnilo, ne technické detaily'
            : `Nový soubor vytvořen${isTest ? ' (TESTOVACÍ — bez reálného HW)' : ''} — popiš co jsi vytvořil a proč to bude užitečné`,
        };
      }

      case 'write_dashboard': {
        // Fáze 0: syntaxe + záloha. check_config lovelace nevaliduje,
        // takže tady končíme u parsu — entity ověřuje validate_dashboard.
        const syntaxError = validateYamlSyntax(input.content);
        if (syntaxError) {
          logAction(chatId, user.name, 'write_dashboard', input.filename, 'yaml-invalid');
          return { error: `YAML není validní, nezapsáno. Oprav a zkus znovu:\n${syntaxError}` };
        }
        const fp = getDashboardPath(input.filename);
        const existed = fs.existsSync(fp);
        const backup = backupFile(fp);
        const ok = writeYamlFile(fp, input.content);
        if (!ok) return { error: 'Zápis dashboardu selhal.' };
        recordChange(fp, backup, !existed);
        logAction(chatId, user.name, 'write_dashboard', input.filename, 'ok');
        const isTest = input.filename.search(/[-_]test/) >= 0;
        return { success: true, path: `dashboards/${input.filename}`, is_test: isTest, undo_hint: 'Vrátit jde nástrojem undo_last_change.' };
      }

      case 'list_dashboards': {
        const dir = path.join(HA_CONFIG_PATH, 'dashboards');
        try {
          if (!fs.existsSync(dir)) return { dashboards: [] };
          return { dashboards: fs.readdirSync(dir).filter(f => f.endsWith('.yaml')) };
        } catch (e) { return { error: e.message }; }
      }

      case 'validate_dashboard': {
        const fp = getDashboardPath(input.filename);
        const content = readYamlFile(fp);
        if (!content) return { error: `Dashboard ${input.filename} neexistuje` };

        // Vytáhni všechny entity_id z YAML textu
        const entityMatches = content.match(/entity:\s*([^\s\n#]+)/g) || [];
        const entitiesMatches = content.match(/entities:\s*\n([\s\S]*?)(?=\n\s*\w+:|$)/g) || [];
        const foundEntities = new Set();

        for (const m of entityMatches) {
          const e = m.replace(/entity:\s*/, '').trim();
          if (e.includes('.')) foundEntities.add(e);
        }
        // Také hledej entity v seznamech (- entity_id nebo - light.xxx)
        const listMatches = content.match(/- ([\w]+\.[\w]+)/g) || [];
        for (const m of listMatches) {
          foundEntities.add(m.replace('- ', '').trim());
        }

        const allEntities = [...foundEntities];
        if (allEntities.length === 0) return { content, entities_found: 0, note: 'Žádné entity nenalezeny v YAML' };

        // Zkontroluj které existují v HA
        const states = await haGet('states');
        const existingIds = new Set(states.map(s => s.entity_id));

        const valid = allEntities.filter(e => existingIds.has(e));
        const missing = allEntities.filter(e => !existingIds.has(e));
        const stateInfo = valid.map(e => {
          const s = states.find(st => st.entity_id === e);
          return { entity_id: e, name: s?.attributes?.friendly_name || e, state: s?.state, domain: e.split('.')[0] };
        });

        return {
          filename: input.filename,
          total_entities: allEntities.length,
          valid: stateInfo,
          missing,
          missing_count: missing.length,
          content,
          summary: `${valid.length} entit existuje, ${missing.length} chybí v HA`,
        };
      }

      case 'delete_dashboard': {
        if (!isAdmin(chatId)) return { error: 'Smazání vyžaduje admin přístup.' };
        const fp = getDashboardPath(input.filename);
        try {
          if (!fs.existsSync(fp)) return { error: `Dashboard ${input.filename} neexistuje` };
          // Fáze 0: i smazání se zálohuje a jde vrátit přes undo_last_change
          const backup = backupFile(fp);
          fs.unlinkSync(fp);
          if (backup) lastChange = { file: fp, backup, wasNew: false, when: new Date().toISOString() };
          logAction(chatId, user.name, 'delete_dashboard', input.filename, 'ok');
          return { success: true, message: `Dashboard ${input.filename} smazán`, undo_hint: 'Vrátit jde nástrojem undo_last_change.' };
        } catch (e) { return { error: e.message }; }
      }

      case 'undo_last_change': {
        if (!isAdmin(chatId)) return { error: 'Undo vyžaduje admin přístup.' };
        const res = restoreLastChange();
        logAction(chatId, user.name, 'undo_last_change', res.restored || '-', res.error ? 'fail' : 'ok');
        if (res.success) res.note = 'Po vrácení balíčku nezapomeň na příslušný reload_ha, ať se HA vrátí ke starému stavu i za běhu.';
        return res;
      }

      case 'read_dashboard': {
        const fp = getDashboardPath(input.filename);
        const content = readYamlFile(fp);
        if (!content) return { error: `Dashboard ${input.filename} neexistuje` };
        return { content };
      }

      case 'list_www_images': {
        const wwwDir = path.join(HA_CONFIG_PATH, 'www', 'zan');
        try {
          if (!fs.existsSync(wwwDir)) return { images: [], note: 'Složka /config/www/zan/ zatím neexistuje — pošli fotku s textem "dashboard" nebo "domeček"' };
          const files = fs.readdirSync(wwwDir).filter(f => /\.(jpg|jpeg|png|gif|webp|svg)$/i.test(f));
          return {
            images: files.map(f => ({ filename: f, url: `/local/zan/${f}`, yaml: `image: "/local/zan/${f}"` })),
            count: files.length,
          };
        } catch (e) { return { error: e.message }; }
      }

      case 'reload_ha': {
        // Oprava 2026-07-05: config/{domain}/reload vrací 404 - správný tvar
        // je REST služba services/{domain}/reload (ověřeno curlem). "helpers"
        // navíc není jedna služba - každý typ helperu má svůj vlastní reload
        // (input_number, input_boolean, input_select, input_datetime,
        // input_text, timer - counter reload vůbec nemá).
        if (input.what === 'helpers') {
          const helperDomains = ['input_number', 'input_boolean', 'input_select', 'input_datetime', 'input_text', 'timer'];
          const results = {};
          for (const dom of helperDomains) {
            try { await haPost(`services/${dom}/reload`); results[dom] = 'ok'; }
            catch (e) { results[dom] = `chyba: ${e.message}`; }
          }
          logAction(chatId, user.name, 'reload_ha', 'helpers', JSON.stringify(results));
          return { success: true, detail: results };
        }
        const domainMap = { automations: 'automation', scripts: 'script', scenes: 'scene' };
        const domain = domainMap[input.what];
        if (!domain) return { error: `Neznámý typ reloadu: ${input.what}` };
        await haPost(`services/${domain}/reload`);
        logAction(chatId, user.name, 'reload_ha', input.what, 'ok');
        return { success: true };
      }

      case 'restart_ha': {
        // Oprava 2026-07-05: config/core/restart vrací 404 (stejná chyba jako
        // u reload_ha) - správná REST služba je services/homeassistant/restart.
        // NEOTESTOVÁNO naostro (test by opravdu restartoval živý HA) - založeno
        // na stejném, teď ověřeném vzoru services/{domain}/{service}.
        logAction(chatId, user.name, 'restart_ha', '-', input.reason);
        await haPost('services/homeassistant/restart');
        return { success: true, message: 'HA restartuje — bude dostupný za ~60 sekund.' };
      }

      case 'ha_setup_list': {
        try {
          const [areas, floors, devices] = await Promise.all([
            haWsCommand('config/area_registry/list'),
            haWsCommand('config/floor_registry/list'),
            haWsCommand('config/device_registry/list'),
          ]);
          const unassigned = devices
            .filter(d => !d.area_id && d.entry_type !== 'service')
            .map(d => ({ device_id: d.id, name: d.name_by_user || d.name, manufacturer: d.manufacturer }));
          return {
            floors: floors.map(f => ({ floor_id: f.floor_id, name: f.name, level: f.level })),
            areas: areas.map(a => ({ area_id: a.area_id, name: a.name, floor_id: a.floor_id })),
            unassigned_devices: unassigned.slice(0, 50),
            unassigned_count: unassigned.length,
          };
        } catch (e) { return { error: e.message }; }
      }

      case 'ha_setup_create_floor': {
        try {
          const result = await haWsCommand('config/floor_registry/create', {
            name: input.name, level: input.level, icon: input.icon,
          });
          logAction(chatId, user.name, 'ha_setup_create_floor', input.name, 'ok');
          return { success: true, floor: result };
        } catch (e) { return { error: e.message }; }
      }

      case 'ha_setup_create_area': {
        try {
          const result = await haWsCommand('config/area_registry/create', {
            name: input.name, floor_id: input.floor_id, icon: input.icon,
          });
          logAction(chatId, user.name, 'ha_setup_create_area', input.name, 'ok');
          return { success: true, area: result };
        } catch (e) { return { error: e.message }; }
      }

      case 'ha_setup_assign_device': {
        try {
          await haWsCommand('config/device_registry/update', {
            device_id: input.device_id, area_id: input.area_id,
          });
          logAction(chatId, user.name, 'ha_setup_assign_device', `${input.device_id} -> ${input.area_id}`, 'ok');
          return { success: true };
        } catch (e) { return { error: e.message }; }
      }

      case 'scan_network': {
        if (!isAdmin(chatId)) return { error: 'Sken sítě vyžaduje admin přístup.' };
        try {
          const subnet = getLanSubnet();
          if (!subnet) return { error: 'Nepodařilo se zjistit domácí síť (LAN rozhraní nenalezeno) — zkontroluj host_network v config.yaml add-onu.' };

          const output = execSync(`nmap -sn ${subnet}`, { timeout: 45000 }).toString();
          const lines = output.split('\n');
          const hosts = [];
          for (let i = 0; i < lines.length; i++) {
            const m = lines[i].match(/Nmap scan report for (?:(\S+) )?\(?([\d.]+)\)?/);
            if (m) {
              const host = { ip: m[2], hostname: m[1] && m[1] !== m[2] ? m[1] : null, mac: null, vendor: null };
              const macLine = lines[i + 1] ? lines[i + 1].match(/MAC Address: ([0-9A-Fa-f:]+) \(([^)]+)\)/) : null;
              if (macLine) { host.mac = macLine[1]; host.vendor = macLine[2]; }
              hosts.push(host);
            }
          }
          const withMac = hosts.filter(h => h.mac).length;
          console.log(`🔍 scan_network: subnet=${subnet} hosts=${hosts.length} s_MAC=${withMac} (0 = chybí NET_RAW/root, ARP fallback nefunguje)`);
          logAction(chatId, user.name, 'scan_network', subnet, `${hosts.length} zařízení, ${withMac} s MAC`);
          return { subnet, count: hosts.length, hosts };
        } catch (e) {
          return { error: `Sken sítě selhal: ${e.message}` };
        }
      }

      case 'setup_camera': {
        if (!isAdmin(chatId)) return { error: 'Přidání kamery vyžaduje admin přístup.' };
        try {
          const streamPath = input.stream_path || '/stream1';
          // Bez přihlašovacích údajů v URL — Generic Camera integrace má
          // username/password jako samostatná pole (ověřeno živě 2026-07-05).
          const streamUrl = `rtsp://${input.host}:554${streamPath}`;

          // Oprava 2026-07-05: config_entries/flow je REST, ne WebSocket
          // (opak area/floor/device registry, které jsou WS-only) — ověřeno
          // přímým testem, "Unknown command" byla chyba ve špatném kanálu.
          let flow = await haPost('config/config_entries/flow', {
            handler: 'generic', show_advanced_options: false,
          });
          console.log(`📷 setup_camera krok 0 (create): ${JSON.stringify(flow).slice(0, 400)}`);

          let step = 0;
          while (flow && flow.type === 'form' && step < 3) {
            const stepId = flow.step_id;
            let userInput;
            if (stepId === 'user') {
              userInput = {
                stream_source: streamUrl,
                username: input.username,
                password: input.password,
                advanced: { framerate: 2, verify_ssl: false, rtsp_transport: 'tcp', authentication: 'basic' },
              };
            } else {
              userInput = {}; // potvrzovací/confirm krok — prázdný submit
            }
            flow = await haPost(`config/config_entries/flow/${flow.flow_id}`, userInput);
            step++;
            console.log(`📷 setup_camera krok ${step} (step_id=${stepId}): ${JSON.stringify(flow).slice(0, 500)}`);
          }

          if (flow && flow.type === 'create_entry') {
            logAction(chatId, user.name, 'setup_camera', input.name, 'ok');
            return { success: true, message: `Kamera "${input.name}" přidána do HA.`, raw: flow };
          }
          console.error(`🔴 setup_camera neskončilo create_entry, finální stav: ${JSON.stringify(flow).slice(0, 600)}`);
          const stepErrors = flow && flow.errors ? flow.errors : null;
          return {
            error: stepErrors ? `HA odmítlo: ${JSON.stringify(stepErrors)}` : 'Přidání kamery neskončilo úspěchem (create_entry).',
            tip: stepErrors && stepErrors.stream_source === 'timeout'
              ? 'HA se nedokázalo připojit ke kameře (timeout) — zkontroluj, jestli kamera na téhle IP skutečně běží a jestli má RTSP/Camera Account opravdu povolený.'
              : undefined,
            raw: flow,
          };
        } catch (e) {
          console.error(`🔴 setup_camera vyjimka: ${e.message}`);
          return { error: `Nastavení kamery selhalo: ${e.message}`, tip: 'Zkus přidat ručně: Nastavení → Zařízení a služby → Přidat integraci → Generic Camera.' };
        }
      }

      case 'queue_task': {
        const t = loadTasks();
        if (input.action === 'add') {
          const task = {
            id: `t${Date.now()}`,
            description: input.description,
            requested_by: user.name,
            chat_id: chatId,
            created_at: new Date().toISOString(),
            status: 'queued',
            attempts: 0,
          };
          t.tasks.push(task);
          saveTasks(t);
          logAction(chatId, user.name, 'queue_task_add', task.id, task.description);
          return { success: true, task_id: task.id, message: 'Zařazeno do noční fronty.' };
        }
        if (input.action === 'list') {
          return { tasks: t.tasks.filter(x => x.status !== 'done') };
        }
        if (input.action === 'mark_done') {
          const task = t.tasks.find(x => x.id === input.task_id);
          if (!task) return { error: 'Úkol nenalezen' };
          task.status = 'done';
          saveTasks(t);
          return { success: true };
        }
        return { error: 'Neznámá action' };
      }

      default: return { error: 'Neznámý nástroj' };
    }
  } catch (err) {
    logAction(chatId, user.name, name, JSON.stringify(input).substring(0, 50), `ERROR:${err.message}`);
    return { error: err.message };
  }
}

// ═══════════════════════════════════════════════
// ZAHRADNÍ SYSTÉM — plná verze
// ═══════════════════════════════════════════════
const GARDEN_FILE = path.join(DATA_DIR, 'zan_garden.json');

function loadGarden() {
  try { if (fs.existsSync(GARDEN_FILE)) return JSON.parse(fs.readFileSync(GARDEN_FILE, 'utf8')); } catch {}
  return {
    // Mapa zahrady — pojmenované zóny s popisem
    map: {
      // Sekce 1 - Předzahrádka
      predzahradka: { name: 'Předzahrádka', section: '1', description: 'předzahrádka před domem', plants: [] },
      // Sekce 2 - Přední dvůr
      od_uhlehu: { name: '2.1 Od Úlehlů', section: '2', description: 'záhon u sousedů Úlehlů', plants: [] },
      nad_sklepem: { name: '2.2 Nad sklepem', section: '2', description: 'záhon nad sklepem', plants: [] },
      // Sekce 3 - Zahrada
      k_uhlehlom: { name: '3.1 K Úlehlom', section: '3', description: 'hlavní záhony zeleniny', plants: [] },
      k_tureckOM: { name: '3.2 K Turečkom', section: '3', description: 'spodní záhon u Turečků', plants: [] },
      travnik: { name: '3.3 Trávník', section: '3', description: 'volná travnatá plocha', plants: [] },
      vyvyseny_zahon_1: { name: '3.4 Vyvýšený záhon 1', section: '3', description: 'vyvýšený záhon č.1', plants: [] },
      vyvyseny_zahon_2: { name: '3.5 Vyvýšený záhon 2', section: '3', description: 'vyvýšený záhon č.2', plants: [] },
      u_studny: { name: '3.6 U studny', section: '3', description: 'okrasná zóna u studny', plants: [] },
      // Sekce 4 - Sad
      sad_stromy: { name: '4.1 Stromy', section: '4', description: 'ovocný sad', plants: [] },
      policko: { name: '4.2 Políčko', section: '4', description: 'zelenina na políčku', plants: [] },
    },
    // Profily rostlin — každá rostlina má svůj záznam
    plant_profiles: {
      // např. "rajcata_2024": { name: "Rajčata", location: "zahon_u_plotu", species: "...", planted: "2024-05-01", photos: [{date, description}], notes: [], history: [] }
    },
    // Výsadbový plán — co bylo kde a kdy
    planting_history: [],
    // Obecné zahradní poznámky
    notes: [],
    last_visit: null,
    // Základní skladba zahrady
    plants: {
      zelenina: ['rajčata', 'okurky', 'papriky', 'salát', 'mrkev'],
      ovocne_stromy: ['jabloň', 'hruška', 'třešeň', 'švestka'],
      kere: ['růže', 'rybíz', 'angrešt'],
      travnik: true,
    },
  };
}

function saveGarden(garden) {
  try { fs.writeFileSync(GARDEN_FILE, JSON.stringify(garden, null, 2), 'utf8'); } catch {}
}

// Sezónní kalendář pro ČR
function getSeasonalTasks(month) {
  const calendar = {
    1:  { season: 'Leden ❄️',    tasks: ['Kontrola zimního krytí keřů a stromů', 'Plánování jarní výsadby', 'Objednání semen', 'Ochrana před mrazem'] },
    2:  { season: 'Únor ❄️',     tasks: ['Přihnojení ovocných stromů (NPK)', 'Řez ovocných stromů před rašením', 'Příprava substrátu pro předpěstování', 'Předpěstování rajčat a paprik v interiéru'] },
    3:  { season: 'Březen 🌱',   tasks: ['Řez růží', 'Přihnojení trávníku', 'Výsev zeleniny v skleníku', 'Odklizení zimního krytí', 'Úprava záhonů'] },
    4:  { season: 'Duben 🌸',    tasks: ['Výsadba sazeniček zeleniny ven (po 15.4)', 'Přihnojení růží', 'Sázení cibulovin', 'Ošetření proti škůdcům', 'Mulčování záhonů'] },
    5:  { season: 'Květen 🌷',   tasks: ['Výsadba rajčat, okurek, paprik ven', 'Přihnojení trávníku', 'Zálivka dle počasí', 'Vazení a opory pro popínavé rostliny', 'Boj s plevelem'] },
    6:  { season: 'Červen ☀️',   tasks: ['Intenzivní zálivka', 'Sklizeň jahod a rybízu', 'Hnojení zeleniny', 'Kosení trávníku každých 7-10 dní', 'Řez po odkvětu'] },
    7:  { season: 'Červenec 🌞', tasks: ['Sklizeň zeleniny', 'Zálivka ráno nebo večer', 'Hnojení rajčat a okurek', 'Letní řez ovocných stromů', 'Sběr bylinek'] },
    8:  { season: 'Srpen 🌻',    tasks: ['Příprava záhonů na podzimní výsadbu', 'Sklizeň pozdní zeleniny', 'Přihnojení trávníku (draslík)', 'Výsev ozimé zeleniny'] },
    9:  { season: 'Září 🍂',     tasks: ['Výsadba cibulovin (tulipány, narcisy)', 'Přihnojení trávníku na zimu', 'Sklizeň jablek a hrušek', 'Příprava kompostu', 'Úklid záhonů'] },
    10: { season: 'Říjen 🍁',    tasks: ['Výsadba ovocných stromů a keřů', 'Přikrytí citlivých rostlin', 'Přihnojení růží (draslík)', 'Poslední seč trávníku', 'Uložení nářadí'] },
    11: { season: 'Listopad 🍃', tasks: ['Zimní ochrana keřů a stromů', 'Mulčování záhonů', 'Kompostování listí', 'Výsadba cibulovin do mrazu', 'Čištění zahradního nábytku'] },
    12: { season: 'Prosinec ❄️', tasks: ['Kontrola zimního krytí', 'Plánování příštího roku', 'Kontrola uloženého nářadí', 'Vánoční dekorace ze zahrady 🎄'] },
  };
  return calendar[month] || calendar[1];
}

// Doporučené střídání plodin (co po čem NEdávat)
const CROP_ROTATION = {
  'rajčata': ['rajčata', 'papriky', 'lilek', 'brambory'],
  'okurky':  ['okurky', 'cukety', 'dýně', 'melouny'],
  'mrkev':   ['mrkev', 'petržel', 'celer', 'pastiňák'],
  'salát':   [],  // salát jde po čemkoliv
  'zelí':    ['zelí', 'brokolice', 'květák', 'kedluben'],
};

// Analýza výsadbového plánu — co kde bylo a co tam dát
function analyzeCropRotation(garden) {
  const warnings = [];
  const suggestions = [];
  const currentYear = new Date().getFullYear();

  for (const [zoneId, zone] of Object.entries(garden.map || {})) {
    const recentHistory = (garden.planting_history || [])
      .filter(h => h.zone === zoneId && new Date(h.year) >= currentYear - 2)
      .map(h => h.plant);

    for (const plant of (zone.plants || [])) {
      const badPredecessors = CROP_ROTATION[plant.toLowerCase()] || [];
      const conflict = recentHistory.find(h => badPredecessors.includes(h.toLowerCase()));
      if (conflict) {
        warnings.push(`⚠️ ${zone.name}: ${plant} po ${conflict} — riziko chorob, zvažte přesun`);
      }
    }
  }

  return { warnings, suggestions };
}

// Identifikace rostliny nebo problému z fotky
async function analyzeGardenPhoto(base64Image, caption, garden, memory) {
  const month = new Date().getMonth() + 1;
  const seasonal = getSeasonalTasks(month);
  const mapSummary = Object.entries(garden.map || {}).map(([k, v]) => `${v.name}: ${(v.plants || []).join(', ')}`).join('\n') || 'mapa zatím prázdná';

  const prompt = `Jsi Žán, zahradní expert a správce domu "${memory.home_name}".
Jana ti poslala fotku ze zahrady.

ZAHRADA JANY:
Mapa zón: ${mapSummary}
Rostliny celkem: zelenina (${garden.plants.zelenina.join(', ')}), stromy (${garden.plants.ovocne_stromy.join(', ')}), keře (${garden.plants.kere.join(', ')})
Měsíc: ${seasonal.season}
Komentář Jany: "${caption || 'bez komentáře'}"

Tvůj úkol:
1. Identifikuj co je na fotce (rostlina, problém, škůdce, stav zahrady...)
2. Pokud je to rostlina → napiš název, základní péči a zda ji Jana už má v zahradě
3. Pokud je to problém/choroba → diagnostikuj a navrhni konkrétní řešení
4. Zeptej se: "Mám si tuto rostlinu zapamatovat? Kde na zahradě roste?" (pokud je to nová rostlina)
5. Navrhni jestli to ovlivňuje nějaký sezónní úkol

Piš česky, přátelsky, jako Žán. Oslovi "Jano".`;

  const response = await claudeCreate({
    model: MODEL,
    max_tokens: 800,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: base64Image } },
        { type: 'text', text: prompt },
      ],
    }],
  });

  return response.content.find(b => b.type === 'text')?.text || 'Nepodařilo se analyzovat fotku.';
}

async function generateGardenAdvice(chatId) {
  const garden = loadGarden();
  const memory = loadMemory();
  const month = new Date().getMonth() + 1;
  const seasonal = getSeasonalTasks(month);
  garden.last_visit = new Date().toISOString();
  saveGarden(garden);

  // Počasí z HA
  let weatherInfo = '';
  try {
    const states = await haGet('states');
    const weather = states.find(s => s.entity_id.startsWith('weather.'));
    if (weather) weatherInfo = `Počasí: ${weather.state}, ${weather.attributes.temperature}°C, vlhkost: ${weather.attributes.humidity}%`;
  } catch {}

  // Střídání plodin
  const rotation = analyzeCropRotation(garden);

  // Profily rostlin — co potřebuje pozornost
  const profileAlerts = [];
  for (const [id, profile] of Object.entries(garden.plant_profiles || {})) {
    if (profile.notes && profile.notes.length > 0) {
      const lastNote = profile.notes[profile.notes.length - 1];
      profileAlerts.push(`${profile.name} (${profile.location || '?'}): ${lastNote.text}`);
    }
  }

  const mapSummary = Object.entries(garden.map || {})
    .map(([k, v]) => `${v.name}: ${(v.plants || []).join(', ')}`)
    .join('\n') || 'mapa zatím není nastavena';

  const prompt = `Jsi Žán, zahradní rádce a správce domu "${memory.home_name}".
Jana jde na zahradu. Připrav jí konkrétní brief na dnes.

MAPA ZAHRADY:
${mapSummary}

ROSTLINY: zelenina (${garden.plants.zelenina.join(', ')}), stromy (${garden.plants.ovocne_stromy.join(', ')}), keře (${garden.plants.kere.join(', ')})
MĚSÍC: ${seasonal.season}
SEZÓNNÍ ÚKOLY: ${seasonal.tasks.join(' | ')}
${weatherInfo}
${rotation.warnings.length > 0 ? 'VAROVÁNÍ STŘÍDÁNÍ PLODIN: ' + rotation.warnings.join(' | ') : ''}
${profileAlerts.length > 0 ? 'POZNÁMKY K ROSTLINÁM: ' + profileAlerts.join(' | ') : ''}
ZAHRADNÍ POZNÁMKY: ${garden.notes.slice(-3).map(n => n.text).join(' | ') || 'žádné'}

Brief pro Janu (max 12 řádků):
1. Pozdrav a zmínka o počasí
2. Top 3 úkoly na dnes (konkrétní, s ohledem na mapu zahrady)
3. Jeden zahradní tip nebo zajímavost
4. Případné varování (mráz, sucho, střídání plodin)
5. Povzbudivé zakončení 🌱

Piš česky, přátelsky, oslovi "Jano".`;

  const response = await claudeCreate({
    model: MODEL,
    max_tokens: 700,
    messages: [{ role: 'user', content: prompt }],
  });

  return response.content.find(b => b.type === 'text')?.text || 'Hezké zahradničení Jano! 🌱';
}

// ═══════════════════════════════════════════════
// AGENTIC LOOP
// ═══════════════════════════════════════════════
// ═══════════════════════════════════════════════
// STATICKÝ SYSTEM PROMPT
// Musí být byte-identický mezi voláními — je na něm cache_control
// (prompt caching = prefix match; cachuje se spolu s definicemi tools).
// Nic proměnlivého sem nepatří (čas, paměť, jméno uživatele → dynamicContext).
// ═══════════════════════════════════════════════
const SYSTEM_STATIC = `Jsi Žán — veselý, oddaný a chytrý správce domu. Jako Alfred u Batmana, ale pro chytrý dům. Mluvíš česky, přirozeně, s lehkou dávkou humoru, oslovuješ jménem.

═══ 1. ŽELEZNÁ PRAVIDLA (nikdy neporušit) ═══
- Potvrzuj jen SKUTEČNĚ provedené akce. Bez zavolaného nástroje se nic nestalo — pak piš „chystám se / navrhuju", ne „hotovo".
- Kotel, alarm, zámky, restart HA, mazání čehokoli = teprve po výslovném souhlasu v TÉHLE konverzaci. Souhlas z minula neplatí.
- Zapisuješ výhradně do packages/ a dashboards/.
- HA offline → oznam to, nic nepředstírej.
- Nevíš/nejde to → řekni to rovnou a navrhni další krok. Mlžení je horší než přiznaná nejistota.

═══ 2. JAK PRACUJEŠ ═══
- Fakta o domě zjišťuj nástroji (get_states, scan_all_devices, list_packages, read_package), ne dotazem na uživatele a ne pamětí z tréninku. Uživatel zná dům, ty znáš YAML — nikdy se ho neptej, kde co je v souborech.
- Před akcí přemýšlej: CO chce člověk dosáhnout → JAK to v HA postavit → teprve pak nástroje. U větších návrhů řekni záměr jednou větou, než začneš.
- Po každé změně popiš výsledek LIDSKY (co to dělá pro dům), technikálie jen když se někdo zeptá.
- Víc otázek najednou = očísluj je tak, aby šlo odpovědět „3: kuchyň, 6: ano" z mobilu. Jedno zadání, jedna odpověď — netříšti je do víc zpráv s jiným číslováním.
- Nové info o domě/lidech ukládej hned (remember, update_family_member, update_house_info, rodina_update), nečekej na potvrzení.

═══ 3. STRUKTURA KONFIGURACE (závazná konvence domu) ═══
- Všechen YAML žije v packages/<kategorie>/<tema>.yaml — jeden balíček = jedno téma (zahrada/voda.yaml). Kategorie dává write_package.
- Název souboru = slug: jen [a-z0-9_]. Pomlčka/mezera/diakritika → HA balíček TIŠE nenačte (entity nevzniknou, jen warning v logu).
- Balíček nese víc klíčů najednou: input_number:, timer:, automation:, script:, sensor:… Automatizace patří do STEJNÉHO souboru jako helpery tématu. Samostatný automations.yaml neexistuje a nevytvářej ho.
- Jeden helper = právě jedna definice v právě jednom souboru. Duplicate key (i napříč balíčky) = balíček se nenačte. Před vytvořením ověř read_package, že už neexistuje.
- Automatizace: unikátní id: (snake_case) + český alias:. Klíč unique_id: do automation: nepatří (automatizace se nenačte). Jinde na něj nesahej.
- Úprava = read_package → uprav → write_package se STEJNÝM názvem a VŽDY KOMPLETNÍM obsahem (zápis přepisuje celý soubor).
- Po zápisu: automation:→reload_ha(automations), helpery→reload_ha(helpers), script:→scripts, scene:→scenes. Dashboardy reload nepotřebují (jen obnovit stránku).
- Po reloadu OVĚŘ get_state, že entita existuje. Neexistuje → nezapisuj dokola; read_error_log(ha), najdi příčinu, oprav, save_lesson.

═══ 4. HA TAHÁK (vzory — drž se jich, neimprovizuj) ═══
Vzory používají klasický zápis (platform:, service:) — drž ho a nemíchej s novějším (triggers:/actions:).
Automatizace:
  automation:
    - id: tema_co_kdy            # snake_case, unikátní
      alias: "Téma: co se děje"
      trigger:
        - platform: time                    # v čas
          at: "06:00:00"
        - platform: state                   # při změně stavu
          entity_id: binary_sensor.dvere
          to: "on"
          for: { minutes: 5 }               # trvá aspoň 5 min
        - platform: numeric_state           # při překročení
          entity_id: sensor.teplota
          below: 18
        - platform: sun                     # východ/západ
          event: sunset
          offset: "-00:30:00"
        - platform: event                   # timer doběhl
          event_type: timer.finished
          event_data: { entity_id: timer.zalevka }
      condition:
        - condition: time
          after: "06:00:00"
          before: "22:00:00"
        - condition: state
          entity_id: input_boolean.dovolena
          state: "off"
      action:
        - service: switch.turn_on
          target: { entity_id: switch.ventil }
        - delay: { minutes: 10 }
        - service: notify.telegram          # oznámení
          data: { message: "Zalito." }
      mode: single                          # default; mode: restart = nový trigger přeruší běžící

Helpery:
  input_number:
    zalevka_minuty: { name: "Délka zálivky", min: 1, max: 60, step: 1, unit_of_measurement: "min", icon: "mdi:timer" }
  input_boolean:
    dovolena: { name: "Režim dovolená", icon: "mdi:beach" }
  timer:
    zalevka: { name: "Odpočet zálivky" }
  # Odpočet na dashboardu = timer + timer.start (duration: sekundy)
  # + automatizace na event timer.finished. NIKDY delay přes input_number.

Šablony (Jinja v action/condition):
  "{{ states('input_number.zalevka_minuty') | int }}"
  "{{ states('sensor.teplota') | float(0) < 5 }}"

Dashboard karty (vestavěné; custom/Mushroom jen když je ověřeně nainstalované přes HACS — zeptej se):
  - type: tile          # univerzální; entity, name, volitelně features
  - type: sensor        # graf: graph: line
  - type: gauge         # severity: { green: 0, yellow: 60, red: 85 }
  - type: button        # tap_action: { action: toggle }
  - type: horizontal-stack / vertical-stack / grid   # skládání
  - type: markdown      # text; Jinja šablony fungují v content
Entity_id do karet VŽDY z get_states (mívají sériová čísla uvnitř, např. sensor.swv_studna_sonoff_acc800d837_water) — netipuj z friendly_name.
Po KAŽDÉM write_dashboard zavolej validate_dashboard a chybějící entity oprav hned — nikdy „hotovo" s nefunkční kartou.

═══ 5. WORKFLOWY ═══
NOVÉ ZAŘÍZENÍ: pokud ještě není spárované → zigbee_permit_join → předej uživateli instrukce (user_instructions vlastními slovy) a čekej na potvrzení → scan_all_devices → identifikuj nové → navrhni české názvy + místnost → ČEKEJ na OK → rename_entity → create_area (chybí-li) → assign_device_to_area → remember → navrhni 2–3 automatizace s YAML → ČEKEJ na OK → write_package → doporuč doplňkový HW.

ONBOARDING: vždy nejdřív zjisti stav — ha_setup_list + paměť (house.onboarding_done). Nikdy nezačínej naslepo.
  onboarding_done=true → nic z tohohle, běžný provoz.
  Prázdný dům (skoro žádná patra/místnosti) → plný setup: otázky po jedné (obyvatelé, patra, místnosti, vytápění a teploty den/noc, pravidla vždy/nikdy) → ha_setup_create_floor/area → přiřaď zařízení → ulož (update_house_info vč. heating_type, temp_day, temp_night, heating_control).
  Místnosti UŽ EXISTUJÍ (běžný případ!) + unassigned>0 → NEVYTVÁŘEJ nové, jen dopřiřaď (jednoznačné rovnou, nejasné krátkou otázkou s nabídkou míst) a doptej se JEN na preference, které v paměti chybí.
  Přání vs. realita: rodina chce řídit teploty po místnostech a chybí senzor → řekni to + navrhni konkrétní HW s cenou. Neslibuj funkci bez senzoru. Hotovo → update_house_info onboarding_done=true.

RODINA.MD (profil domácnosti — dostáváš ho celý v kontextu): trvalé poznatky o rodině (rytmus dne, návraty z práce, teplotní komfort, pravidla, kdo co má rád) ukládej HNED přes rodina_update — vždy celou sekci znovu (stávající obsah + doplněk), stručné odrážky. Nevyplněné sekce doplňuj MAX JEDNOU krátkou otázkou na konci jinak hotové odpovědi; nikdy výslech, nikdy seznam otázek, neopakuj otázku, na kterou uživatel nechtěl odpovědět. „Dost otázek" → přestaň úplně a zkus za pár dní (checkin_schedule). rodina.md = fakta o rodině a domácnosti; remember = zařízení/místnosti/technika — nemíchat.

ÚKLID DASHBOARDU („udělej pořádek", „bordel"): list_dashboards → validate_dashboard → navrhni CO smažeš a přidáš → ČEKEJ na souhlas → write_dashboard → validate_dashboard znovu → teprve pak „hotovo". Nikdy nemaž bez souhlasu.

TESTOVACÍ VĚCI: soubory s příponou _test, nadpis "🧪 TEST:", helpery (input_*, timer, counter) místo chybějícího HW, v kartách označ "(sim)". Reálné domény: sensor, binary_sensor, light, switch, climate, cover, media_player, fan. Po vytvoření vysvětli, co je reálné a co simulace a co přikoupit (s cenou).

KAMERA: camera_snapshot jen na výslovnou žádost („co se děje na terase"), nikdy sám od sebe — nejsi špión. Po snímku popiš věcně, co vidíš. Přidání kamery: doptej se po jedné otázce; IP nezná → scan_network (výrobce TP-Link = Tapo) a nabídni k výběru; Tapo potřebuje Camera Account (ne cloudový účet) — vysvětli založení; pak setup_camera; doporuč DHCP rezervaci. Když nástroj selže, řekni to na rovinu a dej návod na ruční přidání (Nastavení → Zařízení a služby → Generic Camera).

VELKÉ ÚKOLY: neodmítej a neříkej „to nezvládnu". Zhodnoť rozsah, řekni na rovinu („je toho hodně, zvládnu přes noc"), queue_task(add) s konkrétním popisem a potvrď kdy. Malé věci dělej hned. Rozhoduj podle rozsahu a dnešní útraty v kontextu, ne podle strachu.

═══ 6. UČENÍ Z CHYB A POSTUPŮ ═══
Něco selhalo nebo tě uživatel opravil → 1) read_error_log (zdroj ha / vlastní logy), 2) najdi skutečnou příčinu, ne dohad, 3) oprav, 4) save_lesson (krátce, obecně, s topic). Ponaučení dostáváš v kontextu — chybu s existujícím ponaučením NIKDY neopakuj. Když si protiřečí ponaučení a tahle ústava, řekni to Ondrovi.
Když se netriviální postup POVEDE a ověřil sis výsledek → navrhni „mám si to uložit jako postup?" a po OK save_playbook. Před opakováním známého úkolu zkontroluj playbooky v kontextu (read_playbook).

═══ 7. PROAKTIVITA ═══
- Navrhuj HW, když vidíš příležitost: "💡 Doplnit by šlo: [název] ([značka] [model]) ~[cena] Kč — [přínos]".
- Senzory→nápady: teplota+vlhkost→topení a extrémy; CO2→>1000 upozornit, >1500 varovat + větrat; pohyb→světla/bezpečnost; dveře/okna→otevřeno v noci/dešti; spotřeba→anomálie; kouř/plyn→okamžitě.
- Jednou týdně nenásilný check-in (checkin_schedule).
- Integrace poznáš: tuya→Tuya, ewelink→Sonoff/eWeLink, zha/zigbee→Zigbee (Aqara, IKEA, Hue…), mqtt→Tasmota/ESPHome, Xiaomi/Aqara→Zigbee nebo Mi Home.`;

async function processMessage(chatId, userMessage, imageBase64 = null, opts = {}) {
  const user = getUser(chatId);
  const memory = loadMemory();
  logConvo('USER', chatId, user.name, imageBase64 ? `[fotka] ${userMessage}` : userMessage);

  if (!conversationHistory[chatId]) conversationHistory[chatId] = [];
  
  const residents = memory.residents || {};
  const residentNames = Object.values(residents).map(r => r.name || r).join(', ') || 'zatím neznám';

  const garden = loadGarden();
  const month = new Date().getMonth() + 1;
  const seasonal = getSeasonalTasks(month);
  const isJana = chatId === CHAT_JANA;

  // Dynamický kontext — proměnlivé věci patří sem (za cache breakpoint),
  // ne do SYSTEM_STATIC, jinak by rozbíjely prompt cache
  const roomNames = Object.values(memory.rooms || {}).map(r => (r && r.name) ? r.name : r).filter(Boolean).join(', ');
  const todayUsage = loadUsage().days[new Date().toISOString().slice(0, 10)] || { calls: 0, input: 0, output: 0, cache_read: 0, cache_write: 0 };
  const todayCzk = (usageCostUsd(todayUsage) * USD_CZK).toFixed(1);
  const dynamicContext = `AKTUÁLNÍ KONTEXT:
Dům: "${memory.home_name}" | Čas: ${new Date().toLocaleString('cs-CZ')}
Dnešní útrata zatím: ~${todayCzk} Kč (${todayUsage.calls} volání) — použij při rozhodování, jestli je něco "hodně tokenů" (queue_task)
UŽIVATEL: ${user.name} (${user.role === 'admin' ? 'administrátor — plná práva' : 'uživatel — může ovládat zařízení, ne YAML'})
Obyvatelé: ${Object.values(residents).map(r => `${r.emoji || ''} ${r.name}${r.born ? ' (*' + r.born + '*)' : ''}${r.info ? ' — ' + r.info : ''}`).join(', ') || 'zatím neznám'}
Dům detaily: ${JSON.stringify(memory.house || {})}
Místnosti: ${roomNames || 'žádné'}
Zařízení v paměti: ${Object.keys(memory.devices || {}).length} (detaily si vyžádej nástroji, do kontextu se neposílají)
Preference: ${JSON.stringify(memory.preferences)}
Poznámky: ${memory.notes.slice(-6).map(n => n.text).join(' | ') || 'žádné'}
Ponaučení z minulých chyb (řiď se jimi, neopakuj je): ${relevantLessons(userMessage).map(l => `[${l.topic}] ${l.text}`).join(' | ') || 'zatím žádná'}
Playbooky (ověřené postupy, obsah přes read_playbook): ${listPlaybooks().join(', ') || 'zatím žádné'}
PROFIL DOMÁCNOSTI (rodina.md — tvůj hlavní zdroj, jak tahle rodina žije; sekce "(zatím nevyplněno)" = příležitost k JEDNÉ otázce):
${(() => { const r = ensureRodina(); return r.length < 4500 ? r : r.slice(0, 4500) + '\n…(zkráceno — celý profil je v /config/zan_data/rodina.md)'; })()}
${isJana ? `🌱 Zahrada — zóny: ${Object.entries(garden.map || {}).map(([k, v]) => `${v.name}${(v.plants || []).length ? ' (' + v.plants.join(', ') + ')' : ''}`).join(' | ') || 'nenastavena'} | profilů rostlin: ${Object.keys(garden.plant_profiles || {}).length} | ${seasonal.season}, sez. úkoly: ${seasonal.tasks.slice(0, 3).join(', ')}
Zahradní poznámky: ${garden.notes.slice(-2).map(n => n.text).join(' | ') || 'žádné'}
Zahradní nástroje používej aktivně: garden_map (zóny), garden_plant_profile (profily rostlin), garden_planting_plan (střídání plodin), garden_note (deník). Když Jana popisuje zahradu nebo rostlinu → automaticky ulož do příslušného nástroje. Když pošle fotku rostliny → nabídni vytvoření profilu a zařazení na mapu.` : ''}`;

  // Připrav zprávu — s obrázkem nebo bez
  let userContent;
  if (imageBase64) {
    userContent = [
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: imageBase64 } },
      { type: 'text', text: userMessage },
    ];
  } else {
    userContent = userMessage;
  }

  // Do trvalé historie jde jen text — base64 fotka by se jinak přeposílala
  // (a platila) s každou další zprávou dalších ~10 kol konverzace
  conversationHistory[chatId].push({ role: 'user', content: imageBase64 ? `[fotka] ${userMessage}` : userMessage });
  const messages = [...conversationHistory[chatId].slice(0, -1), { role: 'user', content: userContent }];
  const tools = buildTools(chatId);

  // Model routing: fronta/servis si model vynutí (opts.forceModel),
  // jinak rozhodne heuristika na zprávě. Eskalace v běhu viz níže.
  let model = opts.forceModel || pickModelForMessage(userMessage);
  let escalated = model !== MODEL_FAST;

  // Agentic loop — s limitem iterací (ochrana proti nekonečnému točení)
  for (let iter = 0; iter < MAX_AGENT_ITERATIONS; iter++) {
    const response = await claudeCreate({
      model,
      max_tokens: 4096,
      system: [
        // cache_control na statickém bloku → cachuje se prefix tools + SYSTEM_STATIC
        // (cache je per model — FAST a SMART si drží každý svou)
        { type: 'text', text: SYSTEM_STATIC, cache_control: { type: 'ephemeral' } },
        { type: 'text', text: dynamicContext + `\nBěžíš na modelu ${model} (${model === MODEL_FAST ? 'FAST — běžný provoz' : model === MODEL_SMART ? 'SMART — YAML a tvorba' : 'SERVIS — údržba'}) — kdyby se někdo ptal, proč něco trvá déle nebo stojí víc.` },
      ],
      tools,
      messages,
    });

    // Eskalace (stupeň 2 routingu): FAST model sáhl po zapisovacím/tvořícím
    // nástroji → JEDNOU restart smyčky na SMART. Rozpracovaný tool call se
    // NEPROVÁDÍ a nepushuje — SMART si zápis rozmyslí znovu nad stejnou
    // historií (dosavadní čtecí kroky v messages zůstávají a platí).
    if (!escalated && response.stop_reason === 'tool_use') {
      const wants = response.content.filter(b => b.type === 'tool_use' && SMART_ESCALATION_TOOLS.includes(b.name)).map(b => b.name);
      if (wants.length > 0) {
        escalated = true;
        model = MODEL_SMART;
        console.log(`⤴️ Eskalace na SMART (${model}) kvůli: ${wants.join(', ')}`);
        continue;
      }
    }

    messages.push({ role: 'assistant', content: response.content });

    if (response.stop_reason === 'tool_use') {
      const toolResults = [];
      for (const block of response.content) {
        if (block.type === 'tool_use') {
          // __confirmed smí nastavit jen callback handler tlačítek — model
          // si potvrzení nesmí "přibalit" sám (schema ho nezná, ale poslat by šlo)
          if (block.input && block.input.__confirmed) delete block.input.__confirmed;
          const result = await executeTool(block.name, block.input, chatId);
          if (result && result.error) {
            // Generický log chyb nástrojů — bez tohohle nešlo zjistit, PROČ
            // něco selhalo, jen že Žán o tom slušně informoval uživatele.
            const safeInput = { ...block.input };
            if (safeInput.password) safeInput.password = '[REDACTED]';
            console.error(`🔴 TOOL ERROR ${block.name} input=${JSON.stringify(safeInput)} → ${JSON.stringify(result).slice(0, 500)}`);
          }
          let content;
          if (result && result.__image_base64) {
            // Nástroj vrátil obrázek (např. camera_snapshot) — pošli ho
            // Claudovi jako skutečný obrázek, ne jako JSON text, ať ho
            // může reálně "vidět" a popsat.
            content = [
              { type: 'image', source: { type: 'base64', media_type: result.__media_type || 'image/jpeg', data: result.__image_base64 } },
              { type: 'text', text: result.note || 'Snímek z kamery.' },
            ];
          } else {
            let resultStr = JSON.stringify(result);
            if (resultStr.length > MAX_TOOL_RESULT_CHARS) {
              resultStr = resultStr.slice(0, MAX_TOOL_RESULT_CHARS) + ' …[VÝSLEDEK OŘEZÁN — byl příliš dlouhý, pracuj s tímto výřezem]';
            }
            content = resultStr;
          }
          toolResults.push({ type: 'tool_result', tool_use_id: block.id, content });
        }
      }
      messages.push({ role: 'user', content: toolResults });
      continue;
    }

    // end_turn, max_tokens i cokoliv jiného → vrať text, který máme
    const textBlock = response.content.find(b => b.type === 'text');
    const finalText = textBlock ? textBlock.text : 'Hotovo.';
    conversationHistory[chatId].push({ role: 'assistant', content: finalText });
    if (conversationHistory[chatId].length > 20) conversationHistory[chatId] = conversationHistory[chatId].slice(-20);
    persistConversations(); // přežije restart/update add-onu
    logConvo('ŽÁN', chatId, user.name, finalText);
    return finalText;
  }

  const tooLong = `⏳ Úloha byla moc dlouhá (přes ${MAX_AGENT_ITERATIONS} kol nástrojů) — zkus ji rozdělit na menší kroky.`;
  logConvo('ŽÁN', chatId, user.name, tooLong);
  return tooLong;
}

// ═══════════════════════════════════════════════
// TELEGRAM HANDLERS
// ═══════════════════════════════════════════════
bot.on('message', (msg) => {
  enqueueForChat(msg.chat.id, () => handleMessage(msg));
});

// Inline tlačítka ✅/❌ pro citlivé akce — jediné místo, které smí nastavit
// __confirmed a provést odloženou akci. Potvrzení platí 10 minut.
bot.on('callback_query', async (q) => {
  try {
    const chatId = q.message?.chat?.id;
    if (!chatId || !ALLOWED_CHATS.includes(chatId)) { await bot.answerCallbackQuery(q.id); return; }
    const [act, token] = String(q.data || '').split(':');
    const p = pendingConfirm.get(chatId);
    if (!p || p.token !== token || Date.now() - p.when > 10 * 60 * 1000) {
      pendingConfirm.delete(chatId);
      await bot.answerCallbackQuery(q.id, { text: 'Tahle žádost už neplatí — řekni mi to znovu.' });
      return;
    }
    pendingConfirm.delete(chatId);
    if (act !== 'confirm') {
      await bot.answerCallbackQuery(q.id, { text: 'Zrušeno' });
      await sendSafe(chatId, `❌ Dobře, neprovádím: ${p.desc}`);
      logAction(chatId, getUser(chatId).name, 'confirm_cancel', p.desc, 'user');
      return;
    }
    await bot.answerCallbackQuery(q.id, { text: 'Provádím…' });
    const result = await executeTool(p.name, { ...p.input, __confirmed: true }, chatId);
    if (result && result.error) await sendSafe(chatId, `⚠️ Akce selhala: ${result.error}`);
    else await sendSafe(chatId, `✅ Provedeno: ${p.desc}`);
    logAction(chatId, getUser(chatId).name, 'confirm_execute', p.desc, result && result.error ? 'fail' : 'ok');
  } catch (e) { console.error('callback_query:', e.message); }
});

async function handleMessage(msg, send = sendSafe, sendChatAction = (chatId, action) => bot.sendChatAction(chatId, action)) {
  const chatId = msg.chat.id;

  // Security — neznámý chat
  if (!ALLOWED_CHATS.includes(chatId)) {
    logSecurity(chatId, 'unauthorized_access');
    send(chatId, '⛔ Přístup odepřen.');
    return;
  }

  // Rate limiting
  if (!checkRateLimit(chatId)) {
    send(chatId, '⏳ Příliš mnoho zpráv. Počkej chvíli.');
    return;
  }

  // HA online check
  if (!(await isHaOnline()) && msg.text !== '/start' && msg.text !== '/pamet') {
    send(chatId, '🔴 Home Assistant není dostupný. Akce nelze provést.');
    return;
  }

  // AI stop check
  if (msg.text !== '/start' && msg.text !== '/pamet' && await isAiStopped()) {
    send(chatId, '🛑 *AI STOP je aktivní.* Deaktivuj ho v Home Assistant.', { parse_mode: 'Markdown' });
    return;
  }

  const user = getUser(chatId);

  // ── HLASOVÁ ZPRÁVA ──
  if (msg.voice) {
    sendChatAction(chatId, 'typing');
    try {
      const fileId = msg.voice.file_id;
      const fileInfo = await bot.getFile(fileId);
      const fileUrl = `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${fileInfo.file_path}`;
      const audioResp = await axios.get(fileUrl, { responseType: 'arraybuffer', timeout: 15000 });
      const buffer = Buffer.from(audioResp.data);
      send(chatId, '🎤 Přepisuji hlasovku...');
      const text = await transcribeVoice(buffer, 'audio/ogg');
      send(chatId, `📝 Rozuměl jsem: _"${text}"_`, { parse_mode: 'Markdown' });
      logAction(chatId, user.name, 'voice_transcribed', '-', text.substring(0, 50));
      const response = await processMessage(chatId, text);
      send(chatId, response, { parse_mode: 'Markdown' });
    } catch (e) {
      console.error('Voice error:', e.message);
      send(chatId, '❌ Nepodařilo se zpracovat hlasovku: ' + e.message);
    }
    return;
  }

  // ── FOTKA ──
  if (msg.photo) {
    sendChatAction(chatId, 'typing');
    try {
      const photo = msg.photo[msg.photo.length - 1];
      const fileInfo = await bot.getFile(photo.file_id);
      const fileUrl = `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${fileInfo.file_path}`;
      const imgResp = await axios.get(fileUrl, { responseType: 'arraybuffer', timeout: 15000 });
      const base64 = Buffer.from(imgResp.data).toString('base64');
      const caption = msg.caption || '';

      // Jana posílá fotku ze zahrady?
      const gardenKeywords = ['zahrada', 'rostlina', 'kytka', 'strom', 'keř', 'záhon', 'škůdce', 'choroba', 'list', 'květ', 'plod', 'semeno'];
      const isGardenPhoto = chatId === CHAT_JANA && (
        gardenKeywords.some(k => caption.toLowerCase().includes(k)) ||
        !caption // Jana bez komentáře → pravděpodobně zahrada
      );

      logAction(chatId, user.name, 'photo_received', isGardenPhoto ? 'garden' : 'general', caption.substring(0, 50));

      // Detekce: chce uložit fotku do dashboardu?
      const dashboardImageKeywords = ['dashboard', 'domeček', 'domecek', 'pozadí', 'pozadi', 'logo', 'ikona', 'obrázek', 'obrazek', 'fotka do', 'ulož', 'uloz'];
      const isDashboardImage = dashboardImageKeywords.some(k => caption.toLowerCase().includes(k));

      if (isDashboardImage) {
        // Ulož do /config/www/zan/
        const wwwDir = path.join(HA_CONFIG_PATH, 'www', 'zan');
        if (!fs.existsSync(wwwDir)) fs.mkdirSync(wwwDir, { recursive: true });
        const timestamp = Date.now();
        const filename = `foto_${timestamp}.jpg`;
        const filepath = path.join(wwwDir, filename);
        fs.writeFileSync(filepath, Buffer.from(imgResp.data));
        const localUrl = `/local/zan/${filename}`;
        logAction(chatId, user.name, 'image_saved', filename, 'ok');
        const saveMsg = `📸 Fotka uložena! Můžu ji použít v dashboardu jako:\n\`\`\`yaml\n- type: picture\n  image: "${localUrl}"\n\`\`\`\nURL: \`${localUrl}\``;
        send(chatId, saveMsg, { parse_mode: 'Markdown' });
        const userCaption = caption || 'Fotka uložena pro dashboard.';
        const response = await processMessage(chatId, `${userCaption} (fotka uložena jako ${localUrl})`, base64);
        send(chatId, response, { parse_mode: 'Markdown' });
      } else if (isGardenPhoto) {
        send(chatId, '🌱 Koukám na fotku...');
        const garden = loadGarden();
        const memory = loadMemory();
        const analysis = await analyzeGardenPhoto(base64, caption, garden, memory);
        send(chatId, analysis, { parse_mode: 'Markdown' });
      } else {
        const userCaption = caption || 'Co vidíš na této fotce? Jak to souvisí s domem?';
        const response = await processMessage(chatId, userCaption, base64);
        send(chatId, response, { parse_mode: 'Markdown' });
      }
    } catch (e) {
      console.error('Photo error:', e.message);
      send(chatId, '❌ Nepodařilo se zpracovat fotku: ' + e.message);
    }
    return;
  }

  const text = msg.text;
  if (!text) return;

  // ── PŘÍKAZY ──
  if (text === '/start') {
    const memory = loadMemory();
    const homeKnown = Object.keys(memory.rooms).length > 0;
    const residentsKnown = Object.keys(memory.residents || {}).length > 0;

    if (!homeKnown || !residentsKnown) {
      send(chatId,
        `👋 Ahoj ${user.name}! Jsem *Žán* — váš věrný správce domu! 🏠\n\n` +
        'Jsem tu aby se o vás postaral. Ale nejdřív se musím trochu seznámit!\n\n' +
        '*Kdo jste a jak vypadá váš dům?*\n\n' +
        '_Například: "Jsem Ondra, s přítelkyní Janou. Máme obývák, kuchyň, ložnici, koupelnu, záchod a technickou místnost."_',
        { parse_mode: 'Markdown' }
      );
    } else {
      const residents = memory.residents || {};
      const names = Object.values(residents).map(r => r.name).join(' a ');
      send(chatId,
        `👋 Ahoj ${user.name}! Jsem zpět — správce domu ${memory.home_name}.\n\n` +
        `Pamatuji si ${names ? names : 'vás'}, ${Object.keys(memory.rooms).length} místností a ${Object.keys(memory.devices).length} zařízení.\n\n` +
        '*Co potřebuješ?* 😊\n\n' +
        '/balicky · /dashboardy · /pamet · /stav · /log',
        { parse_mode: 'Markdown' }
      );
    }
    return;
  }

  // Kickoff dotazníku — Žán se sám představí a položí první otázku.
  // Jen admin (Ondra) rozhoduje, KDY se Žán ozve; Žán sám od sebe
  // konverzaci nikdy nezačíná. Použití: /onboarding (výchozí Jana).
  if (text.startsWith('/onboarding') && isAdmin(chatId)) {
    const target = (text.split(/\s+/)[1] || 'jana').toLowerCase();
    const targetChat = target === 'jana' ? CHAT_JANA : (target === 'ondra' ? CHAT_ONDRA : null);
    if (!targetChat) { send(chatId, '⚠️ Neznámý cíl. Použij: /onboarding jana'); return; }
    ensureRodina();
    const osloveni = target === 'jana' ? 'Jano' : 'Ondro';
    const intro =
      `👋 Ahoj ${osloveni}! Tady Žán, váš domácí sluha. 🏠\n\n` +
      `Ondra mě požádal, abych se s tebou líp seznámil — ať se o vás můžu starat chytřeji ` +
      `(topení podle toho, kdy jste doma, světla, zahrada… tu už spolu řešíme 🌱).\n\n` +
      `Budu se občas na něco zeptat — vždycky jen jedna rychlá otázka, žádné formuláře. ` +
      `A kdykoli řekneš „dost otázek", přestanu.\n\n` +
      `Tak první: *jak vypadá váš běžný všední den?* Kdy vstáváte, kdy kdo odchází a vrací se? Stačí pár slov. 🙂`;
    await send(targetChat, intro, { parse_mode: 'Markdown' });
    // Zasej intro do historie cílového chatu — až člověk odpoví, model ví,
    // na co navazuje (jinak by odpověď „vstáváme v 6" visela ve vzduchu)
    if (!conversationHistory[targetChat]) conversationHistory[targetChat] = [];
    conversationHistory[targetChat].push({ role: 'assistant', content: intro });
    logConvo('ŽÁN', targetChat, getUser(targetChat).name, intro);
    logAction(chatId, user.name, 'onboarding_kickoff', target, 'ok');
    if (targetChat !== chatId) send(chatId, `✅ Představil jsem se ${target === 'jana' ? 'Janě' : target} a položil první otázku dotazníku. Odpovědi se ukládají do rodina.md (/config/zan_data/).`);
    return;
  }

  if (text === '/pamet') {
    const memory = loadMemory();
    let out = '🧠 *Co Žán ví o domě:*\n\n';
    const residents = memory.residents || {};
    if (Object.keys(residents).length > 0) out += `*Obyvatelé:*\n${Object.entries(residents).map(([k, v]) => `• ${v.name || k}${v.role ? ': ' + v.role : ''}`).join('\n')}\n\n`;
    if (Object.keys(memory.rooms).length > 0) out += `*Místnosti:*\n${Object.entries(memory.rooms).map(([k, v]) => `• ${k}: ${v}`).join('\n')}\n\n`;
    if (Object.keys(memory.devices).length > 0) out += `*Zařízení:*\n${Object.entries(memory.devices).map(([k, v]) => `• ${k}: ${v}`).join('\n')}\n\n`;
    if (memory.notes.length > 0) out += `*Poslední poznámky:*\n${memory.notes.slice(-5).map(n => `• ${n.text}`).join('\n')}`;
    if (out === '🧠 *Co Žán ví o domě:*\n\n') out += 'Zatím nic — řekněte mi něco o vašem domě! 😊';
    send(chatId, out, { parse_mode: 'Markdown' });
    return;
  }

  if (text === '/reset') {
    conversationHistory[chatId] = [];
    persistConversations();
    send(chatId, '🔄 Konverzace vymazána. Paměť domu zůstala.');
    return;
  }

  if (text === '/budget') {
    const u = loadUsage();
    const today = new Date().toISOString().slice(0, 10);
    const month = today.slice(0, 7);
    const empty = { calls: 0, input: 0, output: 0, cache_read: 0, cache_write: 0 };
    const d = u.days[today] || empty;
    const monthDays = Object.entries(u.days).filter(([k]) => k.startsWith(month));
    const m = monthDays
      .reduce((a, [, v]) => ({ calls: a.calls + v.calls, input: a.input + v.input, output: a.output + v.output, cache_read: a.cache_read + v.cache_read, cache_write: a.cache_write + v.cache_write }), { ...empty });
    const dUsd = usageCostUsd(d);
    // Měsíc = součet dnů (den s rozpadem po modelech se počítá přesně,
    // starší den cenou globálního modelu) — nesčítat tokeny napříč modely!
    const mUsd = monthDays.reduce((s, [, v]) => s + usageCostUsd(v), 0);
    // Rozpad dneška po modelech (od zavedení model trackingu)
    const perModel = Object.entries(d.models || {})
      .map(([mod, v]) => {
        const [pi, po, pcr, pcw] = modelPricing(mod);
        const usd = (v.input * pi + v.output * po + v.cache_read * pcr + v.cache_write * pcw) / 1e6;
        return `• ${mod.replace('claude-', '')}: ${v.calls}× ≈ ${(usd * USD_CZK).toFixed(2)} Kč`;
      }).join('\n');
    send(chatId,
      `💰 *Spotřeba Žána* (výchozí model: ${MODEL})\n\n` +
      `*Dnes:* ${d.calls} volání\n` +
      `• input ${d.input.toLocaleString('cs-CZ')} | output ${d.output.toLocaleString('cs-CZ')}\n` +
      `• cache: čtení ${d.cache_read.toLocaleString('cs-CZ')} | zápis ${d.cache_write.toLocaleString('cs-CZ')}\n` +
      `• ≈ $${dUsd.toFixed(3)} (${(dUsd * USD_CZK).toFixed(2)} Kč)\n` +
      (perModel ? `${perModel}\n` : '') +
      `\n*Tento měsíc:* ${m.calls} volání ≈ $${mUsd.toFixed(2)} (${(mUsd * USD_CZK).toFixed(0)} Kč)\n\n` +
      `_Sleduje se od v5.3.3 — starší spotřeba v console.anthropic.com_`,
      { parse_mode: 'Markdown' });
    return;
  }

  if (text === '/stav') {
    try {
      const states = await haGet('states');
      const relevant = states
        .filter(s => ['light', 'switch', 'climate', 'sensor'].some(d => s.entity_id.startsWith(d + '.')))
        .map(s => `${s.attributes.friendly_name || s.entity_id}: ${s.state}${s.attributes.unit_of_measurement || ''}`)
        .join('\n');
      send(chatId, `📊 *Zařízení:*\n\n${relevant}`, { parse_mode: 'Markdown' });
    } catch (e) { send(chatId, '❌ ' + e.message); }
    return;
  }

  if (text === '/balicky') {
    const packages = listPackages();
    if (Object.keys(packages).length === 0) { send(chatId, '📦 Zatím žádné balíčky.'); return; }
    let out = '📦 *YAML balíčky:*\n\n';
    for (const [cat, files] of Object.entries(packages)) {
      const testFiles = files.filter(f => f.search(/[-_]test/) >= 0);
      const realFiles = files.filter(f => !f.search(/[-_]test/) >= 0);
      if (realFiles.length) out += `*${cat}/*\n${realFiles.map(f => `  • ${f}`).join('\n')}\n`;
      if (testFiles.length) out += `*${cat}/ (testovací)*\n${testFiles.map(f => `  🧪 ${f}`).join('\n')}\n`;
      out += '\n';
    }
    send(chatId, out, { parse_mode: 'Markdown' });
    return;
  }

  if (text === '/dashboardy') {
    const dashDir = path.join(HA_CONFIG_PATH, 'dashboards');
    try {
      if (!fs.existsSync(dashDir)) { send(chatId, '📊 Složka dashboards neexistuje.'); return; }
      const files = fs.readdirSync(dashDir).filter(f => f.endsWith('.yaml'));
      if (files.length === 0) { send(chatId, '📊 Zatím žádné dashboardy.'); return; }
      const real = files.filter(f => !f.search(/[-_]test/) >= 0);
      const test = files.filter(f => f.search(/[-_]test/) >= 0);
      let out = '📊 *Dashboardy:*\n\n';
      if (real.length) out += `*Produkční:*\n${real.map(f => `• ${f}`).join('\n')}\n\n`;
      if (test.length) out += `*Testovací:*\n${test.map(f => `🧪 ${f}`).join('\n')}`;
      send(chatId, out, { parse_mode: 'Markdown' });
    } catch (e) { send(chatId, '❌ ' + e.message); }
    return;
  }

  if (text === '/zahrada') {
    sendChatAction(chatId, 'typing');
    try {
      const advice = await generateGardenAdvice(chatId);
      send(chatId, `🌱 *Zahradní brief:*\n\n${advice}`, { parse_mode: 'Markdown' });
    } catch (e) { send(chatId, '❌ ' + e.message); }
    return;
  }

  if (text === '/navyky' && isAdmin(chatId)) {
    const events = loadEvents();
    const habits = loadHabits();
    let out = '🧠 *Sledování návyků:*\n\n';
    out += `Zaznamenaných událostí: *${events.length}*\n`;
    out += `Poslední analýza: ${habits.last_analysis ? new Date(habits.last_analysis).toLocaleDateString('cs-CZ') : 'zatím žádná'}\n`;
    out += `Příští analýza: každou *neděli v 20:00*\n\n`;
    if (events.length < 50) out += `⏳ Potřebuji aspoň 50 událostí pro analýzu (zatím ${events.length}). Sbírám data...\n`;
    else out += `✅ Mám dost dat pro analýzu!\n`;
    if (habits.suggestions_sent.length > 0) {
      out += `\n*Poslední návrhy:*\n`;
      habits.suggestions_sent.slice(-3).forEach(s => out += `• ${s.date}: ${s.suggestion.substring(0, 60)}...\n`);
    }
    send(chatId, out, { parse_mode: 'Markdown' });
    return;
  }

  if (text === '/analyza' && isAdmin(chatId)) {
    send(chatId, '🧠 Spouštím analýzu návyků...');
    analyzeHabits();
    return;
  }

  if (text === '/log' && isAdmin(chatId)) {
    try {
      if (!fs.existsSync(LOG_FILE)) { send(chatId, '📋 Log je prázdný.'); return; }
      const lines = fs.readFileSync(LOG_FILE, 'utf8').split('\n').filter(Boolean).slice(-20);
      send(chatId, `📋 *Posledních 20 akcí:*\n\n\`\`\`\n${lines.join('\n')}\n\`\`\``, { parse_mode: 'Markdown' });
    } catch (e) { send(chatId, '❌ ' + e.message); }
    return;
  }

  sendChatAction(chatId, 'typing');
  try {
    const response = await processMessage(chatId, text);
    send(chatId, response, { parse_mode: 'Markdown' });
  } catch (error) {
    console.error('Chyba:', error.message);
    send(chatId, '❌ Chyba: ' + error.message);
  }
}

// ═══════════════════════════════════════════════
// TEST HARNESS — souborový inbox/outbox přes /config/zan_data/harness
// Default OFF. Zapnutí vyžaduje ZAN_HARNESS_ENABLED=true a
// ZAN_HARNESS_CHAT_ID, které je zároveň v běžném whitelistu.
// Vstup:  /config/zan_data/harness/in/<id>.json  { "chat_id": 123, "text": "ahoj" }
// Výstup: /config/zan_data/harness/out/<id>.out.json
// ═══════════════════════════════════════════════
function writeJsonAtomic(file, data) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

async function processHarnessFile(inputFile) {
  const startedAt = new Date().toISOString();
  const base = path.basename(inputFile).replace(/\.json$/, '');
  const processingFile = path.join(HARNESS_IN_DIR, `${base}.processing`);
  const outFile = path.join(HARNESS_OUT_DIR, `${base}.out.json`);
  const output = {
    id: base,
    status: 'error',
    started_at: startedAt,
    finished_at: null,
    replies: [],
  };

  try {
    fs.renameSync(inputFile, processingFile);
  } catch {
    return; // soubor mezitím vzal jiný běh nebo ho zapisovač ještě drží
  }

  try {
    const request = JSON.parse(fs.readFileSync(processingFile, 'utf8'));
    const chatId = Number(request.chat_id);
    const text = typeof request.text === 'string' ? request.text : '';
    output.chat_id = chatId;

    if (chatId !== HARNESS_CHAT_ID) {
      output.status = 'rejected';
      output.error = `chat_id ${chatId || '(missing)'} není povolený harness chat`;
      logSecurity(chatId || 0, 'harness_wrong_chat_id');
      return;
    }
    if (!text.trim()) {
      output.status = 'rejected';
      output.error = 'Chybí text zprávy';
      return;
    }

    const harnessSend = async (replyChatId, replyText, extra = {}) => {
      output.replies.push({
        chat_id: replyChatId,
        text: String(replyText ?? ''),
        extra,
        ts: new Date().toISOString(),
      });
    };
    const harnessAction = async (replyChatId, action) => {
      output.replies.push({
        chat_id: replyChatId,
        action,
        ts: new Date().toISOString(),
      });
    };

    await enqueueForChat(chatId, () => handleMessage({
      chat: { id: chatId },
      from: { id: chatId, is_bot: false, first_name: 'Harness' },
      text,
      date: Math.floor(Date.now() / 1000),
    }, harnessSend, harnessAction));

    output.status = 'ok';
    output.text = output.replies
      .filter(r => r.text)
      .map(r => r.text)
      .join('\n\n');
  } catch (e) {
    output.status = 'error';
    output.error = e.message;
    console.error('Harness error:', e.message);
  } finally {
    output.finished_at = new Date().toISOString();
    try { writeJsonAtomic(outFile, output); } catch (e) { console.error('Harness output write:', e.message); }
    try { fs.unlinkSync(processingFile); } catch {}
  }
}

function startHarnessInbox() {
  if (!HARNESS_ENABLED) return;

  if (!Number.isInteger(HARNESS_CHAT_ID) || !ALLOWED_CHATS.includes(HARNESS_CHAT_ID)) {
    console.warn('Harness vypnut: ZAN_HARNESS_CHAT_ID musí být nastavený a být v ALLOWED_CHATS/EXTRA_CHAT_IDS.');
    return;
  }

  fs.mkdirSync(HARNESS_IN_DIR, { recursive: true });
  fs.mkdirSync(HARNESS_OUT_DIR, { recursive: true });
  console.log(`Harness zapnut: ${HARNESS_IN_DIR} -> ${HARNESS_OUT_DIR}, chat_id=${HARNESS_CHAT_ID}`);

  let running = false;
  setInterval(async () => {
    if (running) return;
    running = true;
    try {
      const files = fs.readdirSync(HARNESS_IN_DIR)
        .filter(f => f.endsWith('.json'))
        .sort()
        .map(f => path.join(HARNESS_IN_DIR, f));
      for (const file of files) await processHarnessFile(file);
    } catch (e) {
      console.error('Harness poll:', e.message);
    } finally {
      running = false;
    }
  }, 1000);
}

startHarnessInbox();

bot.on('polling_error', (e) => console.error('Polling error:', e.message));

// ═══════════════════════════════════════════════
// SLEDOVÁNÍ NÁVYKŮ — state poller každých 5 minut
// ═══════════════════════════════════════════════
const EVENTS_FILE = path.join(DATA_DIR, 'zan_events.json');
const HABITS_FILE = path.join(DATA_DIR, 'zan_habits.json');
const UDRZBA_FILE = path.join(DATA_DIR, 'zan_udrzba.json');
const TASKS_FILE = path.join(DATA_DIR, 'zan_tasks.json');

// Sledované domény pro návyky
const HABIT_DOMAINS = ['light', 'switch', 'climate', 'cover', 'input_boolean'];

let lastStates = {}; // entity_id -> state

function loadEvents() {
  try { if (fs.existsSync(EVENTS_FILE)) return JSON.parse(fs.readFileSync(EVENTS_FILE, 'utf8')); } catch {}
  return [];
}

function saveEvents(events) {
  try {
    // Drž max 10 000 událostí (~2 měsíce)
    if (events.length > 10000) events = events.slice(-10000);
    fs.writeFileSync(EVENTS_FILE, JSON.stringify(events, null, 2), 'utf8');
  } catch (e) { console.error('Events save error:', e.message); }
}

function loadHabits() {
  try { if (fs.existsSync(HABITS_FILE)) return JSON.parse(fs.readFileSync(HABITS_FILE, 'utf8')); } catch {}
  return { last_analysis: null, suggestions_sent: [], confirmed_habits: [] };
}

function saveHabits(habits) {
  try { fs.writeFileSync(HABITS_FILE, JSON.stringify(habits, null, 2), 'utf8'); } catch {}
}

// Polluj stavy každých 5 minut a zaznamenej změny
async function pollStates() {
  try {
    if (!(await isHaOnline())) return;
    const states = await haGet('states');
    const now = new Date();
    const events = loadEvents();
    let changed = false;

    for (const s of states) {
      const domain = s.entity_id.split('.')[0];
      if (!HABIT_DOMAINS.includes(domain)) continue;

      const prev = lastStates[s.entity_id];
      if (prev !== undefined && prev !== s.state) {
        // Stav se změnil — zaloguj
        events.push({
          ts: now.toISOString(),
          dow: now.getDay(),        // 0=ne, 1=po...
          hour: now.getHours(),
          minute: now.getMinutes(),
          entity_id: s.entity_id,
          name: s.attributes.friendly_name || s.entity_id,
          from: prev,
          to: s.state,
          domain,
        });
        changed = true;
      }
      lastStates[s.entity_id] = s.state;
    }

    if (changed) saveEvents(events);
  } catch (e) {
    // Tiché selhání — HA může být dočasně nedostupné
  }
}

// Každou neděli v 20:00 — analýza návyků a návrh automatizací
async function analyzeHabits() {
  const habits = loadHabits();
  // Guard: interval běží každou minutu a v okně 20:00–20:05 by analýzu spustil až 5×
  if (habits.last_analysis && Date.now() - new Date(habits.last_analysis).getTime() < 6 * 24 * 60 * 60 * 1000) {
    console.log('Analýza návyků: přeskočeno (poslední proběhla před méně než 6 dny)');
    return;
  }
  const events = loadEvents();
  if (events.length < 50) return; // Málo dat

  try {
    console.log('🧠 Analyzuji návyky...');

    // Připrav data pro Claude
    // Agreguj: pro každou entitu spočítej nejčastější hodiny zapnutí/vypnutí
    const summary = {};
    for (const e of events) {
      const key = `${e.entity_id}:${e.to}`;
      if (!summary[key]) summary[key] = {
        entity_id: e.entity_id, name: e.name, state: e.to, domain: e.domain,
        hours: {}, days: {}, count: 0
      };
      summary[key].hours[e.hour] = (summary[key].hours[e.hour] || 0) + 1;
      summary[key].days[e.dow] = (summary[key].days[e.dow] || 0) + 1;
      summary[key].count++;
    }

    // Filtruj — jen věci které se opakují aspoň 3x
    const patterns = Object.values(summary).filter(p => p.count >= 3);

    const memory = loadMemory();
    const prompt = `Jsi Žán, AI správce domu "${memory.home_name}".
Analyzuješ data o chování v chytrém domě za poslední týden a hledáš opakující se návyky.

Data o změnách stavů (entity, hodina, počet výskytů):
${JSON.stringify(patterns, null, 2)}

Obyvatelé: ${JSON.stringify(memory.residents)}
Místnosti: ${JSON.stringify(memory.rooms)}
Dříve navržené automatizace: ${JSON.stringify(habits.suggestions_sent.slice(-5))}

Tvůj úkol:
1. Najdi 2-3 nejzajímavější opakující se vzory (např. "světlo v koupelně se zapíná každý den ráno 7-8h")
2. Pro každý vzor navrhni konkrétní HA automatizaci
3. Zeptej se uživatele jestli ji má vytvořit
4. Buď konkrétní — uveď hodiny, entity, dny

Piš česky, přátelsky, jako Žán. Zpráva půjde do Telegramu.
Formát: krátký úvod, pak 2-3 návrhy s otázkou "Mám to udělat? (ano/ne)"`;

    const response = await claudeCreate({
      // Analýza návyků = SERVIS model (routing stupeň 3): běží 1×/týden
      // a navrhuje automatizace do živého domu — kvalita > cena.
      model: MODEL_SERVIS,
      max_tokens: 1000,
      messages: [{ role: 'user', content: prompt }],
    });

    const suggestion = response.content.find(b => b.type === 'text')?.text;
    if (!suggestion) return;

    // Pošli návrh Ondrovi
    await sendSafe(CHAT_ONDRA, `🧠 *Týdenní analýza návyků:*\n\n${suggestion}`, { parse_mode: 'Markdown' });

    // Follow-up (slabina S5): návrh patří i do konverzační historie —
    // jinak Žán neví, na co uživatel odpovídá "ano, udělej 2".
    if (!conversationHistory[CHAT_ONDRA]) conversationHistory[CHAT_ONDRA] = [];
    conversationHistory[CHAT_ONDRA].push({ role: 'assistant', content: `[Poslal jsem týdenní analýzu návyků s návrhy automatizací]\n${suggestion}` });
    persistConversations();

    // Ulož že jsme poslali návrh
    habits.last_analysis = new Date().toISOString();
    habits.suggestions_sent.push({
      date: new Date().toLocaleDateString('cs-CZ'),
      suggestion: suggestion.substring(0, 200),
    });
    if (habits.suggestions_sent.length > 20) habits.suggestions_sent = habits.suggestions_sent.slice(-20);
    saveHabits(habits);

    console.log('✅ Analýza návyků odeslána');
  } catch (e) {
    console.error('Analýza návyků selhala:', e.message);
  }
}

// ═══════════════════════════════════════════════
// ÚDRŽBÁŘ — servisní obchůzka (středa + sobota 18:00)
// Spec: projects/baklazan/research/2026-07-03_zan-udrzbar-obchuzka.md
// (repo CHoS-, upřesněno 2026-07-05: St/So 18:00 místo denně).
//
// v1 rozsah — VĚDOMĚ jen diagnostika, žádné automatické zásahy:
// restart add-onu / reload integrace jde přes Supervisor API, který má
// podle zkušeností z deploy pipeline (docs/memory/project_zan_bot.md)
// nespolehlivé endpointy (401 na některých cestách) — než se to pořádně
// otestuje, obchůzka jen hlásí a ptá se, nikdy sama nezasahuje.
// ═══════════════════════════════════════════════
function loadUdrzba() {
  try { if (fs.existsSync(UDRZBA_FILE)) return JSON.parse(fs.readFileSync(UDRZBA_FILE, 'utf8')); } catch {}
  return { last_run_date: null, last_announce_date: null };
}
function saveUdrzba(u) {
  try { fs.writeFileSync(UDRZBA_FILE, JSON.stringify(u, null, 2), 'utf8'); } catch {}
}

function todayStr() {
  // YYYY-MM-DD v lokálním čase (ne UTC) — konzistentní s "jednou za den" guardem
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Ranní ohlášení dopředu — ať Ondra ví, že dnes večer proběhne obchůzka
async function announceObchuzka() {
  const u = loadUdrzba();
  const today = todayStr();
  if (u.last_announce_date === today) return; // už ohlášeno dnes

  await sendSafe(CHAT_ONDRA, '🔧 Dnes večer v 18:00 se podívám na dům (servisní obchůzka) — dám ti vědět, jak to dopadlo.');
  u.last_announce_date = today;
  saveUdrzba(u);
}

async function runObchuzka() {
  const u = loadUdrzba();
  const today = todayStr();
  if (u.last_run_date === today) {
    console.log('Obchůzka: přeskočeno (dnes už proběhla)');
    return;
  }
  if (await isAiStopped()) {
    console.log('Obchůzka: přeskočeno (AI je vypnuté přes input_boolean.ai_stop)');
    return;
  }

  try {
    console.log('🔧 Spouštím servisní obchůzku...');
    if (!(await isHaOnline())) {
      await sendSafe(CHAT_ONDRA, '🔧 Servisní obchůzka: HA momentálně neodpovídá, zkusím to příště.');
      return;
    }

    const states = await haGet('states');

    // 1. Nedostupná/neznámá entita
    const unavailable = states.filter(s => s.state === 'unavailable' || s.state === 'unknown');

    // 2. Čekající aktualizace (core i add-ony jsou update.* entity)
    const updates = states
      .filter(s => s.entity_id.startsWith('update.') && s.state === 'on')
      .map(s => ({
        name: s.attributes.friendly_name || s.entity_id,
        installed: s.attributes.installed_version,
        latest: s.attributes.latest_version,
      }));

    // 3. Nízká baterie — podle device_class, ne podle názvu entity
    const lowBattery = states.filter(s =>
      s.attributes?.device_class === 'battery' &&
      !isNaN(parseFloat(s.state)) &&
      parseFloat(s.state) < 20
    );

    // 4. Kamera — dokud není v HA žádná entita domény camera.*, Žán ji nevidí
    const cameras = states.filter(s => s.entity_id.startsWith('camera.'));

    // Sestav zprávu
    const lines = [`🔧 *Servisní obchůzka* — ${new Date().toLocaleDateString('cs-CZ')} 18:00`, ''];

    if (unavailable.length === 0) {
      lines.push('✅ Všechna zařízení dostupná.');
    } else {
      lines.push(`⚠️ *${unavailable.length}× nedostupné/neznámé zařízení:*`);
      for (const s of unavailable.slice(0, 15)) {
        lines.push(`  • ${s.attributes.friendly_name || s.entity_id}`);
      }
      if (unavailable.length > 15) lines.push(`  • ...a ${unavailable.length - 15} dalších`);
    }

    lines.push('');
    if (updates.length === 0) {
      lines.push('✅ Žádné čekající aktualizace.');
    } else {
      lines.push(`🔄 *${updates.length}× čekající aktualizace* (žádnou jsem sám nenainstaloval):`);
      for (const up of updates) {
        lines.push(`  • ${up.name}: ${up.installed} → ${up.latest}`);
      }
    }

    lines.push('');
    if (lowBattery.length === 0) {
      lines.push('✅ Žádná baterie pod 20 %.');
    } else {
      lines.push(`🔋 *${lowBattery.length}× nízká baterie:*`);
      for (const s of lowBattery) lines.push(`  • ${s.attributes.friendly_name || s.entity_id}: ${s.state}%`);
    }

    if (cameras.length === 0) {
      lines.push('');
      lines.push('📷 Kamera v domě není napojená na Home Assistant — nevidím ji a nemůžu na ni dohlížet.');
    }

    // ── DIAGNÓZA NA SERVIS MODELU + REAKTIVNÍ ZÁSAHY (fáze 2 auditu,
    // slabina S12; reaktivní zásahy rovnou = rozhodnutí Ondry 2026-07-06,
    // dům = lab). Mantinely VYNUCUJE KÓD, ne model:
    //   - allowlist: JEN homeassistant.reload_config_entry, a JEN na
    //     entity ze seznamu unavailable (členství ověřuje kód)
    //   - max 2 stejné zásahy/den; po druhém už jen hlásí
    //   - nic nevratného (žádné updaty, mazání, restarty — ty se jen ptají)
    const hasFindings = unavailable.length > 0 || updates.length > 0 || lowBattery.length > 0;
    if (hasFindings) {
      try {
        let errorExcerpt = '';
        try {
          const raw = await axios.get(`${HA_URL}/api/error_log`, { headers: haHeaders(), timeout: 15000 });
          errorExcerpt = String(raw.data || '').split('\n').filter(l => /ERROR|WARNING/i.test(l)).slice(-40).join('\n');
        } catch {}

        const diagPrompt = `Jsi Žán, údržbář chytrého domu. Výsledky servisní obchůzky:
NEDOSTUPNÉ ENTITY: ${JSON.stringify(unavailable.slice(0, 30).map(s => ({ id: s.entity_id, name: s.attributes.friendly_name || s.entity_id })))}
ČEKAJÍCÍ UPDATY: ${JSON.stringify(updates)}
SLABÉ BATERIE: ${JSON.stringify(lowBattery.map(s => ({ id: s.entity_id, pct: s.state })))}
VÝŇATEK Z ERROR LOGU HA:
${errorExcerpt.slice(0, 4000) || '(prázdný)'}

Úkol: 1) urči pravděpodobné PŘÍČINY (skupiny entit stejné integrace = jedna příčina), 2) rozliš vážné od kosmetického, 3) navrhni zásahy.
Jediný povolený zásah je reload integrace přes entitu (homeassistant.reload_config_entry) — dává smysl u zamrzlé integrace nebo síťového zařízení, NE u vybité baterie nebo fyzicky odpojeného zařízení. Max 3 zásahy.
Vrať POUZE JSON bez komentářů: {"diagnoza":"stručně česky pro majitele — příčiny a co je vážné","zasahy":[{"entity_id":"...","duvod":"..."}]}`;

        const diagResp = await claudeCreate({
          model: MODEL_SERVIS, // ~12 volání/měsíc; rozhoduje o zásazích do živého domu
          max_tokens: 900,
          messages: [{ role: 'user', content: diagPrompt }],
        });
        const diagText = diagResp.content.find(b => b.type === 'text')?.text || '';
        let diag = null;
        try { diag = JSON.parse(diagText.replace(/^```(json)?|```$/gm, '').trim()); } catch {}

        if (diag && diag.diagnoza) {
          lines.push('');
          lines.push(`🧠 *Diagnóza:* ${diag.diagnoza}`);
        }

        // Reaktivní zásahy s mantinely (vynucuje kód)
        const unavailableIds = new Set(unavailable.map(s => s.entity_id));
        u.interventions = u.interventions || {};
        const dayKey = today;
        u.interventions[dayKey] = u.interventions[dayKey] || {};
        // drž jen posledních 14 dní
        for (const k of Object.keys(u.interventions)) if (k < new Date(Date.now() - 14 * 86400e3).toISOString().slice(0, 10)) delete u.interventions[k];

        const proposed = Array.isArray(diag?.zasahy) ? diag.zasahy.slice(0, 3) : [];
        for (const z of proposed) {
          if (!z || !unavailableIds.has(z.entity_id)) continue; // mimo allowlist/seznam → ignoruj
          const count = u.interventions[dayKey][z.entity_id] || 0;
          if (count >= 2) {
            lines.push(`🔧 ${z.entity_id}: dnes už jsem to zkoušel ${count}× — dál nezasahuju, chce to lidský pohled (${z.duvod})`);
            continue;
          }
          u.interventions[dayKey][z.entity_id] = count + 1;
          saveUdrzba(u);
          try {
            await haPost('services/homeassistant/reload_config_entry', { entity_id: z.entity_id });
            logAction(CHAT_ONDRA, 'Žán-údržbář', 'reload_config_entry', z.entity_id, 'ok');
            await new Promise(r => setTimeout(r, 10000)); // dej integraci čas naběhnout
            let after = null;
            try { after = await haGet(`states/${z.entity_id}`); } catch {}
            const revived = after && after.state !== 'unavailable' && after.state !== 'unknown';
            lines.push(`🔧 Obnovil jsem integraci ${z.entity_id} (${z.duvod}) → ${revived ? `✅ zase žije (${after.state})` : '⚠️ pořád nedostupná — nechávám na tobě'}`);
          } catch (e) {
            lines.push(`🔧 Pokus o obnovu ${z.entity_id} selhal: ${e.message}`);
            logAction(CHAT_ONDRA, 'Žán-údržbář', 'reload_config_entry', z.entity_id, 'fail');
          }
        }
      } catch (e) {
        console.error('Diagnóza obchůzky selhala (posílám aspoň výčet):', e.message);
      }
    }

    // Žádost o rozhodnutí, ne jen informace — jen když je vůbec co řešit
    const needsDecision = unavailable.length > 0 || updates.length > 0 || lowBattery.length > 0 || cameras.length === 0;
    if (needsDecision) {
      lines.push('');
      lines.push('*Co bych potřeboval rozhodnout:*');
      let n = 1;
      if (updates.some(u => u.name.toLowerCase().includes('core') || u.name.toLowerCase().includes('operating system'))) {
        lines.push(`${n++}. Mám nainstalovat aktualizaci HA Core/OS, nebo počkat na klidnější chvíli? (jen s tvým souhlasem — nikdy sám)`);
      }
      if (unavailable.length > 0) {
        lines.push(`${n++}. Něco z nedostupných zařízení stojí za fyzickou kontrolu — mrkneš na to, až budeš mít chvíli?`);
      }
      if (cameras.length === 0) {
        lines.push(`${n++}. Chceš, ať kameru zapojím do Home Assistantu? Pak na ni budu moct dohlížet a hlásit ti, co se děje.`);
      }
      lines.push('');
      lines.push('Odpověz mi, až budeš mít čas 🙂');
    } else {
      lines.push('');
      lines.push('Všechno vypadá v pořádku, nic ode mě teď nepotřebuješ.');
    }

    const reportText = lines.join('\n');
    await sendSafe(CHAT_ONDRA, reportText, { parse_mode: 'Markdown' });

    // Report patří i do konverzační historie — odpověď "1: ano" na
    // číslovaná rozhodnutí musí mít kontext (stejný vzor jako u návyků).
    if (!conversationHistory[CHAT_ONDRA]) conversationHistory[CHAT_ONDRA] = [];
    conversationHistory[CHAT_ONDRA].push({ role: 'assistant', content: `[Poslal jsem report servisní obchůzky]\n${reportText}` });
    persistConversations();

    u.last_run_date = today;
    saveUdrzba(u);
    console.log('✅ Servisní obchůzka odeslána');
  } catch (e) {
    console.error('Servisní obchůzka selhala:', e.message);
  }
}

// ═══════════════════════════════════════════════
// TÝDENNÍ SEBEREFLEXE (fáze 2 auditu, sekce 4.3) — neděle 20:30, SERVIS
// model projde poučení + logy týdne a NAVRHNE Ondrovi úpravy: které
// lessons zobecnit/sloučit/smazat a co změnit v ústavě. Bot sám NIC
// nemění — ústavu mění člověk commitem v zan-bot. Tím se učení uzavírá.
// ═══════════════════════════════════════════════
async function selfReflect() {
  const u = loadUdrzba();
  if (u.last_reflection && Date.now() - new Date(u.last_reflection).getTime() < 6 * 24 * 60 * 60 * 1000) return;
  if (await isAiStopped()) { console.log('Sebereflexe: přeskočeno (AI vypnuté)'); return; }

  try {
    console.log('🪞 Spouštím týdenní sebereflexi...');
    const lessons = loadLessons();
    const actions = fs.existsSync(LOG_FILE) ? fs.readFileSync(LOG_FILE, 'utf8').split('\n').slice(-150).join('\n') : '';
    let errors = '';
    try {
      const raw = await axios.get(`${HA_URL}/api/error_log`, { headers: haHeaders(), timeout: 15000 });
      errors = String(raw.data || '').split('\n').filter(l => /ERROR|WARNING/i.test(l)).slice(-40).join('\n');
    } catch {}

    const prompt = `Jsi zkušený mentor AI asistenta Žána (správce chytrého domu). Projdi jeho týden a navrhni zlepšení. NIC neměníš sám — výstup čte Ondra (vývojář) a rozhodne.

POUČENÍ Z CHYB (zan_lessons.json, ${lessons.length} ks):
${JSON.stringify(lessons, null, 1).slice(0, 5000)}

POSLEDNÍCH ~150 AKCÍ (úspěchy i faily):
${actions.slice(0, 5000)}

CHYBY Z HA LOGU:
${errors.slice(0, 3000) || '(žádné)'}

Vrať česky, stručně, ve 3 sekcích:
1. ÚDRŽBA POUČENÍ — která sloučit/zobecnit/smazat (jsou zastaralá či duplicitní) a proč
2. VZORY PROBLÉMŮ — co se týden opakovalo a stojí za systémové řešení
3. NÁVRHY DO ÚSTAVY — max 3 konkrétní změny system promptu (co přidat/přeformulovat), každá s důvodem
Když není co navrhnout, napiš to — nevymýšlej práci.`;

    const response = await claudeCreate({
      model: MODEL_SERVIS, // 1×/týden — evoluce ústavy má největší pákový efekt
      max_tokens: 1500,
      messages: [{ role: 'user', content: prompt }],
    });
    const text = response.content.find(b => b.type === 'text')?.text;
    if (!text) return;

    await sendSafe(CHAT_ONDRA, `🪞 *Týdenní sebereflexe Žána* (návrhy — nic jsem sám nezměnil):\n\n${text}`, { parse_mode: 'Markdown' });
    if (!conversationHistory[CHAT_ONDRA]) conversationHistory[CHAT_ONDRA] = [];
    conversationHistory[CHAT_ONDRA].push({ role: 'assistant', content: `[Poslal jsem týdenní sebereflexi s návrhy]\n${text}` });
    persistConversations();

    u.last_reflection = new Date().toISOString();
    saveUdrzba(u);
    console.log('✅ Sebereflexe odeslána');
  } catch (e) {
    console.error('Sebereflexe selhala:', e.message);
  }
}

// Zpracuje jeden čekající úkol z fronty (queue_task) — noční běh.
// Používá stejný agentic loop jako běžná zpráva (processMessage), jen
// se syntetickým promptem místo Telegram zprávy od člověka.
async function processQueuedTasks() {
  const t = loadTasks();
  const pending = t.tasks.filter(x => x.status === 'queued' || x.status === 'in_progress');
  if (pending.length === 0) return;
  if (await isAiStopped()) { console.log('Fronta úkolů: přeskočeno (AI vypnuté)'); return; }

  const task = pending[0]; // FIFO — jeden úkol za noc, ať se nekumuluje cena
  console.log(`🌙 Zpracovávám úkol z fronty: ${task.description}`);
  task.status = 'in_progress';
  task.attempts = (task.attempts || 0) + 1;
  saveTasks(t);

  const prompt = task.attempts > 1
    ? `Pokračuj v úkolu z fronty (pokus ${task.attempts}/${MAX_TASK_ATTEMPTS}), noční zpracování, nikdo teď nekouká: "${task.description}". Nejdřív zkontroluj, co už existuje (list_dashboards, read_package/read_dashboard...), ať neděláš práci znovu, a pokračuj tam, kde jsi minule skončil.`
    : `Zpracuj úkol z fronty, noční zpracování, nikdo teď nekouká: "${task.description}"`;

  try {
    // Noční fronta = velké/tvořící úkoly → vždy SMART model (routing stupeň 3)
    const result = await processMessage(task.chat_id || CHAT_ONDRA, prompt, null, { forceModel: MODEL_SMART });
    const hitLimit = typeof result === 'string' && result.includes('Úloha byla moc dlouhá');

    const tt = loadTasks();
    const tref = tt.tasks.find(x => x.id === task.id);
    if (!tref) return;

    if (hitLimit && tref.attempts < MAX_TASK_ATTEMPTS) {
      tref.status = 'queued'; // zůstává ve frontě, pokračuje příští noc
      saveTasks(tt);
      await sendSafe(task.chat_id || CHAT_ONDRA, `🌙 Pracoval jsem na úkolu "${task.description}" — je toho víc, pokračuju další noc (pokus ${tref.attempts}/${MAX_TASK_ATTEMPTS}).`);
    } else if (hitLimit) {
      tref.status = 'stuck';
      saveTasks(tt);
      await sendSafe(task.chat_id || CHAT_ONDRA, `⚠️ Úkol "${task.description}" se mi po ${MAX_TASK_ATTEMPTS} nocích nepodařilo dokončit sám — mrkneme na to spolu?`);
    } else {
      tref.status = 'done';
      saveTasks(tt);
      await sendSafe(task.chat_id || CHAT_ONDRA, `✅ Hotovo přes noc — "${task.description}":\n\n${result}`);
    }
  } catch (e) {
    console.error('Zpracování fronty selhalo:', e.message);
    const tt = loadTasks();
    const tref = tt.tasks.find(x => x.id === task.id);
    if (tref) { tref.status = 'queued'; saveTasks(tt); }
  }
}

// ═══════════════════════════════════════════════
// RODINNÝ DASHBOARD
// ═══════════════════════════════════════════════
function generateFamilyDashboardYaml(residents, house) {
  const r = residents || {};
  const h = house || {};

  function esc(s) { return (s || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"'); }

  function ageExpr(born) {
    return `{{ ((as_timestamp(now()) - as_timestamp(strptime('${born}', '%Y-%m-%d'))) / (365.25 * 86400)) | int }}`;
  }

  // Karta pro dítě — jen věk + info
  function kidCard(member) {
    const { name, born, emoji, info } = member;
    const bornDisplay = born.split('-').reverse().join('. ');
    const infoText = esc(info || 'Doplň mi info o sobě 🙂');
    return `          - type: markdown\n            content: "${emoji} **${name}** | 🎂 ${bornDisplay} · **${ageExpr(born)} let**\\n${infoText}"`;
  }

  // Karta pro dospělého — věk + poloha (person entity) + kalendář + info
  function adultCard(key, member) {
    const { name, born, emoji, info, work_schedule } = member;
    const bornDisplay = born.split('-').reverse().join('. ');
    const pEnt = member.person_entity || `person.${key}`;
    const calEnt = member.calendar_entity || `calendar.${key}`;

    // Poloha z person entity — 'home' → 🏠 Doma, zóna → 📍 název zóny, not_home → 📍 Mimo domov
    const locTpl = `{% set _l=states('${pEnt}') %}` +
      `{% if _l=='home' %}🏠 Doma` +
      `{% elif _l in ['unavailable','unknown','not_home',''] %}📵 Nesledován` +
      `{% else %}📍 {{ _l }}{% endif %}`;

    // Kalendář — aktuální nebo nejbližší událost + čas konce (= návrat)
    const calTpl = `{% set _e=state_attr('${calEnt}','message') %}` +
      `{% set _t=state_attr('${calEnt}','end_time') %}` +
      `{% if _e is not none %}` +
        `📅 {{ _e }}{% if _t is not none %} · ⏰ návrat {{ _t[11:16] }}{% endif %}` +
      `{% endif %}`;

    const schedLine = work_schedule ? `⏰ Plán: ${esc(work_schedule)}` : '';
    const infoText = esc(info || 'Doplň mi info o sobě 🙂');

    const contentParts = [
      `${emoji} **${name}** | 🎂 ${bornDisplay} · **${ageExpr(born)} let**`,
      locTpl,
      calTpl,
      schedLine,
      infoText,
    ].filter(Boolean).join('\\n');

    return [
      `          - type: vertical-stack`,
      `            cards:`,
      `              - type: tile`,
      `                entity: ${pEnt}`,
      `                name: "${esc(name)}"`,
      `              - type: markdown`,
      `                content: "${contentParts}"`,
    ].join('\n');
  }

  const parents = ['ondra', 'jana'].filter(k => r[k]).map(k => adultCard(k, r[k])).join('\n');
  const kids    = ['stepan', 'matej', 'eliska'].filter(k => r[k]).map(k => kidCard(r[k])).join('\n');

  const housePhoto = h.photo_url
    ? `      - type: picture\n        image: "${esc(h.photo_url)}"\n`
    : '';
  const houseInfo = [
    h.address     && `📍 ${h.address}`,
    h.type        && `🏠 ${h.type}`,
    h.year_built  && `📅 Rok stavby: ${h.year_built}`,
    h.floors      && `🏢 Podlaží: ${h.floors}`,
    h.rooms_count && `🚪 Místností: ${h.rooms_count}`,
    h.info        && `ℹ️ ${h.info}`,
  ].filter(Boolean).join('\\n') || 'Zatím žádné info — řekni mi o domě víc 🏡';

  return [
    'title: Rodina',
    'views:',
    '  - title: Rodina',
    '    path: rodina',
    '    icon: mdi:home-heart',
    '    cards:',
    `      - type: markdown`,
    `        content: "<center><h2>👨‍👩‍👧‍👦 Naše rodina</h2><i>{{ now().strftime('%-d. %-m. %Y') }}</i></center>"`,
    '      - type: horizontal-stack',
    '        cards:',
    parents,
    '      - type: horizontal-stack',
    '        cards:',
    kids,
    housePhoto,
    '      - type: markdown',
    '        title: "🏡 Náš dům"',
    `        content: "${houseInfo}"`,
  ].join('\n') + '\n';
}

async function createFamilyDashboard() {
  try {
    const memory = loadMemory();
    // Doplň chybějící členy rodiny pokud paměť existuje ale je stará
    const defaults = {
      ondra:  { name: 'Ondra',   born: '1991-11-30', emoji: '👨', info: '', role: 'admin' },
      jana:   { name: 'Jana',    born: '1991-09-22', emoji: '👩', info: '', role: 'user' },
      stepan: { name: 'Štěpán', born: '2019-07-20', emoji: '👦', info: '', role: 'kid' },
      matej:  { name: 'Matěj',  born: '2023-02-20', emoji: '👶', info: '', role: 'kid' },
      eliska: { name: 'Eliška', born: '2023-02-20', emoji: '👶', info: '', role: 'kid' },
    };
    let changed = false;
    for (const [key, val] of Object.entries(defaults)) {
      if (!memory.residents[key]) { memory.residents[key] = val; changed = true; }
      else if (!memory.residents[key].born) { memory.residents[key] = { ...val, ...memory.residents[key] }; changed = true; }
    }
    if (!memory.house) { memory.house = {}; changed = true; }
    if (changed) saveMemory(memory);

    const yaml = generateFamilyDashboardYaml(memory.residents, memory.house);
    const fp = path.join(HA_CONFIG_PATH, 'dashboards', 'Rodina.yaml');
    const ok = writeYamlFile(fp, yaml);
    if (ok) {
      console.log('👨‍👩‍👧‍👦 Rodinný dashboard vytvořen: dashboards/Rodina.yaml');
      // Reload zbytečný — YAML dashboard se čte ze souboru vždy znovu
      // (žádná služba "lovelace" v HA neexistuje, ověřeno 2026-07-05).
    } else {
      console.warn('⚠️ Rodinný dashboard — zápis selhal (config path nedostupný)');
    }
  } catch (e) {
    console.error('Family dashboard error:', e.message);
  }
}

// ═══════════════════════════════════════════════
// ČASOVAČE
// ═══════════════════════════════════════════════
// Polluj stavy každých 5 minut
setInterval(pollStates, 5 * 60 * 1000);

// Každou hodinu zkontroluj jestli je neděle 20:00 → analýza návyků
setInterval(() => {
  const now = new Date();
  if (now.getDay() === 0 && now.getHours() === 20 && now.getMinutes() < 5) {
    analyzeHabits();
  }
}, 60 * 1000);

// Neděle 20:30 → týdenní sebereflexe (po analýze návyků, SERVIS model)
setInterval(() => {
  const now = new Date();
  if (now.getDay() === 0 && now.getHours() === 20 && now.getMinutes() >= 30 && now.getMinutes() < 35) {
    selfReflect();
  }
}, 60 * 1000);

// Fronta velkých úkolů (queue_task) — jednou denně ve 2:30, jeden úkol
// za noc. Mimo kolizi s měsíčním restartem (~02:05) a obchůzkou (18:00).
setInterval(() => {
  const now = new Date();
  if (now.getHours() === 2 && now.getMinutes() >= 30 && now.getMinutes() < 35) {
    processQueuedTasks();
  }
}, 60 * 1000);

// Servisní obchůzka — středa (3) a sobota (6) v 18:00, s ranním ohlášením
// v 7:00 téhož dne. getDay(): 0=ne, 1=po, 2=út, 3=st, 4=čt, 5=pá, 6=so.
setInterval(() => {
  const now = new Date();
  const isObchuzkaDen = now.getDay() === 3 || now.getDay() === 6;
  if (isObchuzkaDen && now.getHours() === 7 && now.getMinutes() < 5) {
    announceObchuzka();
  }
  if (isObchuzkaDen && now.getHours() === 18 && now.getMinutes() < 5) {
    runObchuzka();
  }
}, 60 * 1000);

// Startup — načti aktuální stavy jako baseline + vytvoř rodinný dashboard + sync kontextu
setTimeout(async () => {
  // 1. Načti HA stavy jako baseline pro sledování návyků
  let states = [];
  try {
    states = await haGet('states');
    for (const s of states) {
      const domain = s.entity_id.split('.')[0];
      if (HABIT_DOMAINS.includes(domain)) lastStates[s.entity_id] = s.state;
    }
    console.log(`📊 Baseline načten: ${Object.keys(lastStates).length} sledovaných entit`);
  } catch (e) { console.warn('⚠️ Baseline load selhal:', e.message); }

  // 2. Sync místností z HA area registry → memory.rooms
  try {
    const areas = await haRegistry('area_registry');
    console.log(`🏠 Area registry raw:`, JSON.stringify(areas)?.substring(0, 200));
    if (Array.isArray(areas) && areas.length > 0) {
      const memory = loadMemory();
      let changed = false;
      for (const area of areas) {
        const key = area.area_id;
        if (!memory.rooms[key]) {
          memory.rooms[key] = { name: area.name, area_id: area.area_id };
          changed = true;
        } else if (memory.rooms[key].name !== area.name) {
          memory.rooms[key].name = area.name;
          changed = true;
        }
      }
      if (changed) {
        saveMemory(memory);
        console.log(`🏠 Místnosti sync: ${areas.map(a => a.name).join(', ')}`);
      }
    }
  } catch (e) { console.warn('⚠️ Area sync selhal:', e.message); }

  // 3. Sync zařízení ze stavů → memory.devices (jen pokud je devices prázdné)
  try {
    const memory = loadMemory();
    if (states.length > 0 && Object.keys(memory.devices || {}).length === 0) {
      const skipDomains = ['zone', 'sun', 'device_tracker', 'update', 'person', 'persistent_notification', 'weather', 'automation', 'script', 'scene', 'timer', 'counter'];
      const interestingDomains = ['light', 'switch', 'sensor', 'binary_sensor', 'climate', 'cover', 'media_player', 'fan', 'input_boolean', 'input_number'];
      const interesting = states.filter(s => interestingDomains.some(d => s.entity_id.startsWith(d + '.')));
      for (const s of interesting.slice(0, 100)) {
        const name = s.attributes.friendly_name || s.entity_id;
        memory.devices[s.entity_id] = { name, entity_id: s.entity_id, domain: s.entity_id.split('.')[0], state: s.state };
      }
      saveMemory(memory);
      console.log(`🔌 Zařízení sync: ${interesting.length} entit načteno do paměti`);
    }
  } catch (e) { console.warn('⚠️ Devices sync selhal:', e.message); }

  // 4. Aktualizuj known_entities
  try {
    const memory = loadMemory();
    const skipDomains = ['zone', 'sun', 'device_tracker', 'update', 'person', 'persistent_notification'];
    const all = states.filter(s => !skipDomains.some(d => s.entity_id.startsWith(d + '.'))).map(s => s.entity_id);
    if (all.length > 0) {
      const prev = memory.known_entities || [];
      const newOnes = all.filter(e => !prev.includes(e));
      memory.known_entities = all;
      saveMemory(memory);
      if (newOnes.length > 0) console.log(`🔍 ${newOnes.length} nových entit od posledního startu`);
    }
  } catch (e) { console.warn('⚠️ Known entities sync selhal:', e.message); }

  await createFamilyDashboard();
}, 5000);

// Startup
connectSamba();
console.log('🏠 Žán v5 spuštěn');
console.log(`🧭 Routing: FAST=${MODEL_FAST} | SMART=${MODEL_SMART} | SERVIS=${MODEL_SERVIS}`);
console.log(`📱 Ondra: ${CHAT_ONDRA} | Jana: ${CHAT_JANA}`);
console.log(`🏡 HA: ${HA_URL}`);
console.log(`📁 Config: ${HA_CONFIG_PATH}`);
console.log('🧠 Sledování návyků aktivní — analýza každou neděli v 20:00');
