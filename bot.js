require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const Anthropic = require('@anthropic-ai/sdk');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const FormData = require('form-data');

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

const MEMORY_FILE       = path.join(__dirname, 'home_memory.json');
const LOG_FILE          = path.join(__dirname, 'zan_actions.log');

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

// Pending confirmations
const pendingConfirm = new Map(); // chatId -> { action, entity, resolve }

// ═══════════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════════
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
const anthropic = new Anthropic({ apiKey: ANTHROPIC_KEY });
let conversationHistory = {}; // per chatId

const PACKAGE_CATEGORIES = {
  osvetleni: 'Osvětlení', topeni: 'Topení a klimatizace', zasuvky: 'Zásuvky a spotřebiče',
  zahrada: 'Zahrada', zabezpeceni: 'Zabezpečení', energie: 'Energie', system: 'Systémové', ostatni: 'Ostatní',
};

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

async function isAiStopped() {
  try { const s = await haGet('states/input_boolean.ai_stop'); return s.state === 'on'; } catch { return false; }
}

// ═══════════════════════════════════════════════
// YAML HELPERS
// ═══════════════════════════════════════════════
function getPackagePath(cat, fn) {
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
      name: 'scan_all_devices',
      description: 'Kompletní sken všech zařízení v HA — device registry, entity registry, oblasti. Vrátí zařízení podle místností, nezařazená zařízení, výrobce (Tuya, Sonoff, eWeLink, Zigbee apod.).',
      input_schema: { type: 'object', properties: {}, required: [] },
    },
    {
      name: 'rename_entity',
      description: 'Přejmenuje entitu v HA registru (friendly_name).',
      input_schema: {
        type: 'object',
        properties: {
          entity_id: { type: 'string' },
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
      name: 'generate_report',
      description: 'Vygeneruje report o stavu domu — teploty, pohyb, počasí, energie, co se dělo.',
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
Pro testovací účely přidej příponu -test k názvu souboru (např. zahrada-test.yaml).
VŽDY nejdřív list_packages + read_package. Nikdy nezapisuj mimo packages/ nebo dashboards/.
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
        description: 'Zapíše YAML dashboard. Pro testovací dashboardy použij název s příponou -test (např. zahrada-test.yaml).',
        input_schema: {
          type: 'object',
          properties: { filename: { type: 'string' }, content: { type: 'string' }, description: { type: 'string' } },
          required: ['filename', 'content', 'description'],
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
        description: 'Reloadne část HA po změně YAML.',
        input_schema: {
          type: 'object',
          properties: { what: { type: 'string', enum: ['automations', 'scripts', 'scenes', 'helpers', 'lovelace'] } },
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
  const adminOnlyTools = ['write_package', 'write_dashboard', 'reload_ha', 'restart_ha'];
  if (adminOnlyTools.includes(name) && !isAdmin(chatId)) {
    logSecurity(chatId, `blocked_admin_tool:${name}`);
    return { error: 'Tato akce je dostupná pouze pro administrátora.' };
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
        const [areaReg, entityReg, deviceReg] = await Promise.all([
          haGet('config/area_registry/list').catch(() => []),
          haGet('config/entity_registry/list').catch(() => []),
          haGet('config/device_registry/list').catch(() => []),
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
        if (input.category === 'all') return memory;
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

      case 'rename_entity': {
        if (!isAdmin(chatId)) return { error: 'Přejmenování vyžaduje admin přístup.' };
        try {
          await haPost('config/entity_registry/update', {
            entity_id: input.entity_id,
            name: input.new_name,
          });
          logAction(chatId, user.name, 'rename', input.entity_id, input.new_name);
          return { success: true, message: `Přejmenováno na: ${input.new_name}` };
        } catch (e) {
          // Fallback — přes WS není vždy dostupné přes REST
          return { error: `Přejmenování přes API selhalo: ${e.message}. Přejmenuj ručně v HA Settings → Entities.` };
        }
      }

      case 'scan_all_devices': {
        const errors = {};
        const [deviceReg, entityReg, areaReg] = await Promise.all([
          haGet('config/device_registry/list').catch(e => { errors.device_registry = e.message; return null; }),
          haGet('config/entity_registry/list').catch(e => { errors.entity_registry = e.message; return null; }),
          haGet('config/area_registry/list').catch(e => { errors.area_registry = e.message; return null; }),
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
          const areas = Array.isArray(areaReg) ? areaReg.map(a => ({ area_id: a.area_id, name: a.name })) : [];
          return {
            total_entities: filtered.length,
            total_areas: areas.length,
            areas,
            by_domain: byDomain,
            registry_errors: errors,
            note: 'Registry API nedostupné — zobrazuji entity ze stavů. Oblasti jsou ' + (areas.length ? areas.map(a => a.name).join(', ') : 'prázdné, vytvoř je v HA: Nastavení → Oblasti'),
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
          const result = await haPost('config/area_registry/create', { name: input.name });
          logAction(chatId, user.name, 'create_area', input.name, 'ok');
          // HA vrací přímo objekt oblasti nebo { area_id, name }
          const area_id = result.area_id || result.id || null;
          const name = result.name || input.name;
          return { success: true, area_id, name, raw: result };
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
          const areas = await haGet('config/area_registry/list').catch(() => []);
          const area = Array.isArray(areas) ? areas.find(a => a.name.toLowerCase() === input.area_name.toLowerCase()) : null;
          if (!area) {
            return { error: `Oblast "${input.area_name}" nenalezena.`, available: Array.isArray(areas) ? areas.map(a => a.name) : [] };
          }
          await haPost('config/entity_registry/update', { entity_id: input.entity_id, area_id: area.area_id });
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
            const areas = await haGet('config/area_registry/list').catch(() => []);
            const found = Array.isArray(areas) ? areas.find(a => a.name.toLowerCase() === area_id.toLowerCase()) : null;
            if (!found) return { error: `Oblast "${area_id}" nenalezena.`, available: Array.isArray(areas) ? areas.map(a => a.name) : [] };
            area_id = found.area_id;
          }
          await haPost('config/device_registry/update', { device_id: input.device_id, area_id });
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

      case 'list_packages': return { packages: listPackages(), categories: PACKAGE_CATEGORIES };

      case 'read_package': {
        const fp = getPackagePath(input.category, input.filename);
        const content = readYamlFile(fp);
        if (!content) return { error: `Soubor neexistuje: ${input.category}/${input.filename}` };
        return { content };
      }

      case 'write_package': {
        const fp = getPackagePath(input.category, input.filename);
        const oldContent = readYamlFile(fp);
        const ok = writeYamlFile(fp, input.content);
        if (!ok) return { error: `Zápis selhal. Zkontroluj Samba připojení.` };
        memory.notes.push({ text: `Balíček ${input.category}/${input.filename}: ${input.description}`, date: new Date().toLocaleDateString('cs-CZ') });
        saveMemory(memory);
        logAction(chatId, user.name, 'write_package', `${input.category}/${input.filename}`, 'ok');
        const isTest = input.filename.includes('-test');
        return {
          success: true,
          path: `packages/${input.category}/${input.filename}`,
          was_new: !oldContent,
          is_test: isTest,
          human_diff_hint: oldContent
            ? 'Soubor existoval — popiš uživateli CO KONKRÉTNĚ se změnilo, ne technické detaily'
            : `Nový soubor vytvořen${isTest ? ' (TESTOVACÍ — bez reálného HW)' : ''} — popiš co jsi vytvořil a proč to bude užitečné`,
        };
      }

      case 'write_dashboard': {
        const fp = getDashboardPath(input.filename);
        const ok = writeYamlFile(fp, input.content);
        if (!ok) return { error: 'Zápis dashboardu selhal.' };
        logAction(chatId, user.name, 'write_dashboard', input.filename, 'ok');
        const isTest = input.filename.includes('-test');
        return { success: true, path: `dashboards/${input.filename}`, is_test: isTest };
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
          fs.unlinkSync(fp);
          logAction(chatId, user.name, 'delete_dashboard', input.filename, 'ok');
          return { success: true, message: `Dashboard ${input.filename} smazán` };
        } catch (e) { return { error: e.message }; }
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
        const map = {
          automations: 'config/automation/reload',
          scripts: 'config/script/reload',
          scenes: 'config/scene/reload',
          helpers: 'config/helper/reload',
          lovelace: 'lovelace/reload',
        };
        await haPost(map[input.what]);
        logAction(chatId, user.name, 'reload_ha', input.what, 'ok');
        return { success: true };
      }

      case 'restart_ha': {
        logAction(chatId, user.name, 'restart_ha', '-', input.reason);
        await haPost('config/core/restart');
        return { success: true, message: 'HA restartuje — bude dostupný za ~60 sekund.' };
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
const GARDEN_FILE = path.join(__dirname, 'zan_garden.json');

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

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
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

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 700,
    messages: [{ role: 'user', content: prompt }],
  });

  return response.content.find(b => b.type === 'text')?.text || 'Hezké zahradničení Jano! 🌱';
}

// ═══════════════════════════════════════════════
// AGENTIC LOOP
// ═══════════════════════════════════════════════
async function processMessage(chatId, userMessage, imageBase64 = null) {
  const user = getUser(chatId);
  const memory = loadMemory();

  if (!conversationHistory[chatId]) conversationHistory[chatId] = [];
  
  const residents = memory.residents || {};
  const residentNames = Object.values(residents).map(r => r.name || r).join(', ') || 'zatím neznám';

  const garden = loadGarden();
  const month = new Date().getMonth() + 1;
  const seasonal = getSeasonalTasks(month);
  const isJana = chatId === CHAT_JANA;

  const systemPrompt = `Jsi Žán — veselý, oddaný a chytrý správce domu "${memory.home_name}". Jsi jako Alfred u Batmana, ale pro chytrý dům.
Komunikuješ česky, přirozeně, s lehkou dávkou humoru. Používáš jména lidí.

AKTUÁLNÍ UŽIVATEL: ${user.name} (${user.role === 'admin' ? 'administrátor — má plná práva' : 'uživatel — může ovládat zařízení, ne YAML'})

OBYVATELÉ: ${residentNames}
Detaily: ${JSON.stringify(residents)}
Místnosti: ${JSON.stringify(memory.rooms)}
Zařízení: ${JSON.stringify(memory.devices)}
Preference: ${JSON.stringify(memory.preferences)}
Poznámky: ${memory.notes.slice(-6).map(n => n.text).join(' | ')}

${isJana ? `🌱 ZAHRADNÍ KONTEXT (Jana je zahradnice):
Mapa zón: ${Object.entries(garden.map || {}).map(([k,v]) => `${v.name}: ${(v.plants||[]).join(', ')}`).join(' | ') || 'zatím nenastavena — zeptej se Jany'}
Rostliny: zelenina (${garden.plants.zelenina.join(', ')}), stromy (${garden.plants.ovocne_stromy.join(', ')}), keře (${garden.plants.kere.join(', ')})
Profily rostlin: ${Object.keys(garden.plant_profiles || {}).length} profilů
Měsíc: ${seasonal.season} | Sezónní úkoly: ${seasonal.tasks.slice(0,3).join(', ')}
Zahradní poznámky: ${garden.notes.slice(-2).map(n => n.text).join(' | ') || 'žádné'}

ZAHRADNÍ NÁSTROJE (používej aktivně):
- garden_map: správa mapy zahrady a zón
- garden_plant_profile: profil každé rostliny (výsadba, foto, poznámky)  
- garden_planting_plan: výsadbová historie a střídání plodin
- garden_note: zahradní deník
Když Jana popisuje zahradu nebo rostlinu → automaticky ulož do příslušného nástroje.
Když pošle fotku rostliny → nabídni vytvoření profilu a zařazení na mapu.
` : ''}

TVOJE CHOVÁNÍ:
- Vždy potvrď SKUTEČNOU akci — nikdy netvrď že jsi něco provedl pokud jsi nezavolal nástroj
- Po každé změně YAML popiš změny LIDSKY a srozumitelně, ne technicky
- Automaticky si pamatuj nové info o domě, o lidech, o preferencích
- Jednou týdně se nenásilně zeptej na věci o domě (přes checkin_schedule)
- Navrhuj konkrétní IoT HW s modelem a cenou když vidíš příležitost
- Pro testovací věci (plánování bez HW) používej dashboardy a balíčky s příponou -test
- Kdykoli se dozvíš info o členovi rodiny nebo domě → update_family_member / update_house_info

ROZLIŠENÍ REÁLNÉ vs. SIMULOVANÉ ENTITY:
Helpery (simulace) = entity začínající na: input_boolean, input_number, input_select, input_datetime, input_text, counter, timer
Reálné fyzické senzory = sensor, binary_sensor, light, switch, climate, cover, media_player, fan
Pokud NEVÍŠ jestli je entita reálná nebo helper → ZEPTEJ SE ("Je to fyzické zařízení nebo jen simulace v HA?")
V dashboardech vždy označ helpery jako "(sim)", reálné entity bez označení.
Při návrhu automatizací upozorni: "Tato automatizace funguje jen pokud [entita] je reálný senzor, ne helper."

RODINA — ${Object.values(memory.residents || {}).map(r => `${r.emoji || ''} ${r.name} (*${r.born || ''}*)`).join(', ')}:
- Detaily: ${JSON.stringify(memory.residents)}
- Domeček: ${JSON.stringify(memory.house || {})}
- update_family_member: kdykoli řeknou info o sobě (koníčky, oblíbené věci, zdraví atd.)
- update_house_info: kdykoli řeknou info o domě (adresa, typ, rok stavby, foto)
- Rodinný dashboard Rodina.yaml se automaticky přegeneruje po každé aktualizaci

BEZPEČNOST:
- Kotel, alarm, zámky = jen po výslovném potvrzení
- Pokud HA není online, oznam to a neprovádej akce
- Nikdy nezapisuj mimo packages/ nebo dashboards/

REPORT (když uživatel napíše "report"):
- Použij generate_report pro data
- Napiš přehledný lidský report: teploty, co běží, počasí, energie, zajímavosti

NOVÉ ZAŘÍZENÍ — kompletní workflow (spusť automaticky kdykoli uživatel zmíní nové/přidané zařízení):
1. scan_all_devices — získej přehled VŠECH zařízení, místností a integrací
2. Identifikuj nové/nezařazené zařízení podle kontextu (co uživatel popsal, jaká místnost)
3. Navrhni logický český název (např. "Světlo obývák strop", "Senzor CO2 obývák")
4. rename_entity — přejmenuj každou entitu zařízení
5. Pokud místnost neexistuje → create_area ji vytvoř
6. assign_device_to_area — přiřaď celé zařízení do místnosti (preferuj přes device_id)
7. Navrhni automatizace odpovídající typu zařízení (světlo→stmívání/rozsvícení při pohybu, senzor CO2→upozornění nad 1000ppm, teploměr→topení)
8. write_package — po potvrzení zapiš automatizace jako YAML balíček
9. Navrhni doplňující HW nákupy (konkrétní model, značka, orientační cena v Kč)

IDENTIFIKACE INTEGRACE ZE scan_all_devices:
- integration obsahuje "tuya" → Tuya zařízení (žárovky, zásuvky, čidla přes Tuya app nebo cloud)
- integration obsahuje "ewelink" → Sonoff přes eWeLink (spínače, zásuvky, sonoff série)
- integration obsahuje "zha" nebo "zigbee" → Zigbee zařízení (Aqara, IKEA, Philips Hue atd.)
- integration obsahuje "mqtt" → MQTT zařízení (Tasmota, ESPHome atd.)
- manufacturer obsahuje "Xiaomi"/"Aqara" → Zigbee nebo Mi Home

SENZORY — co dělat s různými typy:
- temperature + humidity → navrhni automatizaci topení, upozornění na extrémní hodnoty
- CO2 (unit ppm) → upozornění Telegram při >1000ppm, při >1500ppm varování, navrhni větrání
- motion → automatizace světel, bezpečnostní upozornění
- door/window sensor → upozornění při otevření v noci, při dešti
- power/energy sensor → monitoring spotřeby, upozornění při anomálii
- smoke/gas → okamžité Telegram upozornění

NÁKUPNÍ DOPORUČENÍ — navrhni vždy konkrétně:
Formát: "💡 Doplnit by šlo: [název] ([značka] [model]) ~[cena] Kč — [co to přidá]"
Příklady doplnění:
- Ke světlu bez stmívání → Shelly Dimmer 2 (~800 Kč) nebo Philips Hue (~600-1200 Kč/ks)
- K teploměru bez topení → termostatická hlavice Aqara SRTS-A01 (~800 Kč) nebo Danfoss Ally (~1500 Kč)
- K pohybovému senzoru → Aqara FP2 (mmWave přítomnost, ~1500 Kč) — přesnější než PIR
- Chybí CO2 → SenseAir S8 DIY nebo Aranet4 (~2500 Kč) nebo Aqara TVOC Air Quality Monitor (~900 Kč)
- Chybí měření spotřeby → Shelly EM (~1200 Kč) nebo Sonoff POW Elite (~600 Kč)
- Chybí dveřní senzor → Aqara Door/Window (~400 Kč) nebo Sonoff SNZB-04 (~250 Kč)

ÚKLID DASHBOARDU — workflow (spusť když uživatel říká "udělej pořádek", "vyčisti dashboard", "bordel", "přepiš dashboard"):
1. list_dashboards — zjisti jaké dashboardy existují
2. validate_dashboard — přečti dashboard a zkontroluj které entity existují v HA a které ne
3. Vyhodnoť co v dashboardu je:
   - entity které neexistují v HA → smaž
   - duplicitní karty → slij do jedné
   - nesmyslné spouštěče/scény bez entity → odstraň
   - entity které existují → zachovej a hezky uspořádej
4. Navrhni novou strukturu dashboardu — popiš uživateli CO smažeš a CO přidáš, ČEKEJ na souhlas
5. Po souhlasu: write_dashboard — přepiš dashboardem novým čistým YAML
6. reload_ha (lovelace) — načti změny
Nikdy nemaž dashboard bez výslovného souhlasu uživatele!

TESTOVACÍ DASHBOARDY — kompletní workflow:
Kdykoli uživatel chce "zkusit", "otestovat", "naplánovat" nebo "vyzkoušet" dashboard:

1. scan_all_devices — načti skutečná dostupná zařízení
2. get_states — načti aktuální entity (světla, senzory, zásuvky atd.)
3. Vymysli moderní dashboard pro danou místnost/téma
4. Pokud chybí reálná zařízení → navrhni pomocné entity (helpers):
   - input_boolean → virtuální přepínač (simuluje světlo, zásuvku)
   - input_number → virtuální stmívač/teplota/CO2 hodnota
   - input_select → virtuální výběr režimu (Den/Noc/Pryč)
   - input_datetime → virtuální čas/datum
   - counter → virtuální čítač (návštěvy, otevření dveří)
   - timer → virtuální časovač
5. write_package (kategorie: system, název: helpers-[tema]-test.yaml) — zapiš helpers
6. write_dashboard (název: [Tema]-test.yaml) — zapiš dashboard
7. reload_ha (what: helpers) — aktivuj helpery

PRAVIDLA PRO TESTOVACÍ DASHBOARDY:
- Název souboru VŽDY končí -test (např. Svetla-test.yaml, Obyvak-test.yaml)
- Nadpis dashboardu obsahuje "🧪 TEST:" (např. "🧪 TEST: Obývák")
- Každá karta s helperem má v title nebo label text "(simulace)"
- Na začátek dashboardu přidej info kartu s vysvětlením co je real a co sim:
  type: markdown
  content: "🧪 **Testovací dashboard** — ovládání označená _(sim)_ jsou simulovaná pomocí helperů HA. Skutečná zařízení jsou označena normálně."

MODERNÍ DASHBOARD YAML — preferované karty (vestavěné v HA, vždy fungují):
\`\`\`yaml
# Přepínač světla
- type: tile
  entity: light.svetlo_obyvak
  name: "Světlo obývák"

# Senzor s historií
- type: sensor
  entity: sensor.co2_obyvak
  graph: line

# Skupina karet vedle sebe
- type: horizontal-stack
  cards:
    - type: tile
      entity: light.xxx
    - type: tile
      entity: switch.xxx

# Stmívač
- type: light
  entity: light.xxx

# Rychlé tlačítko
- type: button
  entity: light.xxx
  tap_action:
    action: toggle

# Gauge (teploměr/CO2)
- type: gauge
  entity: sensor.teplota
  min: 0
  max: 40
  severity:
    green: 18
    yellow: 25
    red: 30
\`\`\`

MUSHROOM CARDS (pokud uživatel má HACS + mushroom nainstalováno — zeptej se):
\`\`\`yaml
- type: custom:mushroom-light-card
  entity: light.xxx
  show_brightness_control: true
  show_color_control: true
  collapsible_controls: true

- type: custom:mushroom-climate-card
  entity: climate.xxx
  show_temperature_control: true

- type: custom:mushroom-chips-card
  chips:
    - type: entity
      entity: sensor.teplota
    - type: entity
      entity: sensor.co2
\`\`\`

HELPERS YAML PŘÍKLAD (packages/system/helpers-obyvak-test.yaml):
\`\`\`yaml
input_boolean:
  sim_svetlo_obyvak:
    name: "💡 Světlo obývák (sim)"
    icon: mdi:ceiling-light

input_number:
  sim_jas_obyvak:
    name: "🔆 Jas obývák (sim)"
    min: 0
    max: 100
    step: 5
    unit_of_measurement: "%"
    icon: mdi:brightness-6
  sim_co2_obyvak:
    name: "💨 CO2 obývák (sim)"
    min: 400
    max: 2000
    step: 10
    unit_of_measurement: "ppm"
    icon: mdi:molecule-co2

input_select:
  sim_rezim_obyvak:
    name: "🏠 Režim obývák (sim)"
    options: [Den, Večer, Noc, Pryč]
    icon: mdi:home-clock
\`\`\`

Po vytvoření vždy:
- Vysvětli co je reálné a co je simulované
- Napiš kde v HA dashboard najít (Settings → Dashboards)
- Navrhni co by šlo přikoupit aby se simulace stala realitou (s cenami)

Čas: ${new Date().toLocaleString('cs-CZ')}`;

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

  conversationHistory[chatId].push({ role: 'user', content: userContent });
  const messages = [...conversationHistory[chatId]];
  const tools = buildTools(chatId);

  // Agentic loop
  while (true) {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4096,
      system: systemPrompt,
      tools,
      messages,
    });

    messages.push({ role: 'assistant', content: response.content });

    if (response.stop_reason === 'end_turn') {
      const textBlock = response.content.find(b => b.type === 'text');
      const finalText = textBlock ? textBlock.text : 'Hotovo.';
      conversationHistory[chatId].push({ role: 'assistant', content: finalText });
      if (conversationHistory[chatId].length > 20) conversationHistory[chatId] = conversationHistory[chatId].slice(-20);
      return finalText;
    }

    if (response.stop_reason === 'tool_use') {
      const toolResults = [];
      for (const block of response.content) {
        if (block.type === 'tool_use') {
          const result = await executeTool(block.name, block.input, chatId);
          toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(result) });
        }
      }
      messages.push({ role: 'user', content: toolResults });
    } else {
      break;
    }
  }

  return 'Nastala neočekávaná chyba.';
}

// ═══════════════════════════════════════════════
// TELEGRAM HANDLERS
// ═══════════════════════════════════════════════
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;

  // Security — neznámý chat
  if (!ALLOWED_CHATS.includes(chatId)) {
    logSecurity(chatId, 'unauthorized_access');
    bot.sendMessage(chatId, '⛔ Přístup odepřen.');
    return;
  }

  // Rate limiting
  if (!checkRateLimit(chatId)) {
    bot.sendMessage(chatId, '⏳ Příliš mnoho zpráv. Počkej chvíli.');
    return;
  }

  // HA online check
  if (!(await isHaOnline()) && msg.text !== '/start' && msg.text !== '/pamet') {
    bot.sendMessage(chatId, '🔴 Home Assistant není dostupný. Akce nelze provést.');
    return;
  }

  // AI stop check
  if (msg.text !== '/start' && msg.text !== '/pamet' && await isAiStopped()) {
    bot.sendMessage(chatId, '🛑 *AI STOP je aktivní.* Deaktivuj ho v Home Assistant.', { parse_mode: 'Markdown' });
    return;
  }

  const user = getUser(chatId);

  // ── HLASOVÁ ZPRÁVA ──
  if (msg.voice) {
    bot.sendChatAction(chatId, 'typing');
    try {
      const fileId = msg.voice.file_id;
      const fileInfo = await bot.getFile(fileId);
      const fileUrl = `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${fileInfo.file_path}`;
      const audioResp = await axios.get(fileUrl, { responseType: 'arraybuffer', timeout: 15000 });
      const buffer = Buffer.from(audioResp.data);
      bot.sendMessage(chatId, '🎤 Přepisuji hlasovku...');
      const text = await transcribeVoice(buffer, 'audio/ogg');
      bot.sendMessage(chatId, `📝 Rozuměl jsem: _"${text}"_`, { parse_mode: 'Markdown' });
      logAction(chatId, user.name, 'voice_transcribed', '-', text.substring(0, 50));
      const response = await processMessage(chatId, text);
      bot.sendMessage(chatId, response, { parse_mode: 'Markdown' });
    } catch (e) {
      console.error('Voice error:', e.message);
      bot.sendMessage(chatId, '❌ Nepodařilo se zpracovat hlasovku: ' + e.message);
    }
    return;
  }

  // ── FOTKA ──
  if (msg.photo) {
    bot.sendChatAction(chatId, 'typing');
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
        bot.sendMessage(chatId, saveMsg, { parse_mode: 'Markdown' });
        const userCaption = caption || 'Fotka uložena pro dashboard.';
        const response = await processMessage(chatId, `${userCaption} (fotka uložena jako ${localUrl})`, base64);
        bot.sendMessage(chatId, response, { parse_mode: 'Markdown' });
      } else if (isGardenPhoto) {
        bot.sendMessage(chatId, '🌱 Koukám na fotku...');
        const garden = loadGarden();
        const memory = loadMemory();
        const analysis = await analyzeGardenPhoto(base64, caption, garden, memory);
        bot.sendMessage(chatId, analysis, { parse_mode: 'Markdown' });
      } else {
        const userCaption = caption || 'Co vidíš na této fotce? Jak to souvisí s domem?';
        const response = await processMessage(chatId, userCaption, base64);
        bot.sendMessage(chatId, response, { parse_mode: 'Markdown' });
      }
    } catch (e) {
      console.error('Photo error:', e.message);
      bot.sendMessage(chatId, '❌ Nepodařilo se zpracovat fotku: ' + e.message);
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
      bot.sendMessage(chatId,
        `👋 Ahoj ${user.name}! Jsem *Žán* — váš věrný správce domu! 🏠\n\n` +
        'Jsem tu aby se o vás postaral. Ale nejdřív se musím trochu seznámit!\n\n' +
        '*Kdo jste a jak vypadá váš dům?*\n\n' +
        '_Například: "Jsem Ondra, s přítelkyní Janou. Máme obývák, kuchyň, ložnici, koupelnu, záchod a technickou místnost."_',
        { parse_mode: 'Markdown' }
      );
    } else {
      const residents = memory.residents || {};
      const names = Object.values(residents).map(r => r.name).join(' a ');
      bot.sendMessage(chatId,
        `👋 Ahoj ${user.name}! Jsem zpět — správce domu ${memory.home_name}.\n\n` +
        `Pamatuji si ${names ? names : 'vás'}, ${Object.keys(memory.rooms).length} místností a ${Object.keys(memory.devices).length} zařízení.\n\n` +
        '*Co potřebuješ?* 😊\n\n' +
        '/balicky · /dashboardy · /pamet · /stav · /log',
        { parse_mode: 'Markdown' }
      );
    }
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
    bot.sendMessage(chatId, out, { parse_mode: 'Markdown' });
    return;
  }

  if (text === '/reset') {
    conversationHistory[chatId] = [];
    bot.sendMessage(chatId, '🔄 Konverzace vymazána. Paměť domu zůstala.');
    return;
  }

  if (text === '/stav') {
    try {
      const states = await haGet('states');
      const relevant = states
        .filter(s => ['light', 'switch', 'climate', 'sensor'].some(d => s.entity_id.startsWith(d + '.')))
        .map(s => `${s.attributes.friendly_name || s.entity_id}: ${s.state}${s.attributes.unit_of_measurement || ''}`)
        .join('\n');
      bot.sendMessage(chatId, `📊 *Zařízení:*\n\n${relevant}`, { parse_mode: 'Markdown' });
    } catch (e) { bot.sendMessage(chatId, '❌ ' + e.message); }
    return;
  }

  if (text === '/balicky') {
    const packages = listPackages();
    if (Object.keys(packages).length === 0) { bot.sendMessage(chatId, '📦 Zatím žádné balíčky.'); return; }
    let out = '📦 *YAML balíčky:*\n\n';
    for (const [cat, files] of Object.entries(packages)) {
      const testFiles = files.filter(f => f.includes('-test'));
      const realFiles = files.filter(f => !f.includes('-test'));
      if (realFiles.length) out += `*${cat}/*\n${realFiles.map(f => `  • ${f}`).join('\n')}\n`;
      if (testFiles.length) out += `*${cat}/ (testovací)*\n${testFiles.map(f => `  🧪 ${f}`).join('\n')}\n`;
      out += '\n';
    }
    bot.sendMessage(chatId, out, { parse_mode: 'Markdown' });
    return;
  }

  if (text === '/dashboardy') {
    const dashDir = path.join(HA_CONFIG_PATH, 'dashboards');
    try {
      if (!fs.existsSync(dashDir)) { bot.sendMessage(chatId, '📊 Složka dashboards neexistuje.'); return; }
      const files = fs.readdirSync(dashDir).filter(f => f.endsWith('.yaml'));
      if (files.length === 0) { bot.sendMessage(chatId, '📊 Zatím žádné dashboardy.'); return; }
      const real = files.filter(f => !f.includes('-test'));
      const test = files.filter(f => f.includes('-test'));
      let out = '📊 *Dashboardy:*\n\n';
      if (real.length) out += `*Produkční:*\n${real.map(f => `• ${f}`).join('\n')}\n\n`;
      if (test.length) out += `*Testovací:*\n${test.map(f => `🧪 ${f}`).join('\n')}`;
      bot.sendMessage(chatId, out, { parse_mode: 'Markdown' });
    } catch (e) { bot.sendMessage(chatId, '❌ ' + e.message); }
    return;
  }

  if (text === '/zahrada') {
    bot.sendChatAction(chatId, 'typing');
    try {
      const advice = await generateGardenAdvice(chatId);
      bot.sendMessage(chatId, `🌱 *Zahradní brief:*\n\n${advice}`, { parse_mode: 'Markdown' });
    } catch (e) { bot.sendMessage(chatId, '❌ ' + e.message); }
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
    bot.sendMessage(chatId, out, { parse_mode: 'Markdown' });
    return;
  }

  if (text === '/analyza' && isAdmin(chatId)) {
    bot.sendMessage(chatId, '🧠 Spouštím analýzu návyků...');
    analyzeHabits();
    return;
  }

  if (text === '/log' && isAdmin(chatId)) {
    try {
      if (!fs.existsSync(LOG_FILE)) { bot.sendMessage(chatId, '📋 Log je prázdný.'); return; }
      const lines = fs.readFileSync(LOG_FILE, 'utf8').split('\n').filter(Boolean).slice(-20);
      bot.sendMessage(chatId, `📋 *Posledních 20 akcí:*\n\n\`\`\`\n${lines.join('\n')}\n\`\`\``, { parse_mode: 'Markdown' });
    } catch (e) { bot.sendMessage(chatId, '❌ ' + e.message); }
    return;
  }

  bot.sendChatAction(chatId, 'typing');
  try {
    const response = await processMessage(chatId, text);
    bot.sendMessage(chatId, response, { parse_mode: 'Markdown' });
  } catch (error) {
    console.error('Chyba:', error.message);
    bot.sendMessage(chatId, '❌ Chyba: ' + error.message);
  }
});

bot.on('polling_error', (e) => console.error('Polling error:', e.message));

// ═══════════════════════════════════════════════
// SLEDOVÁNÍ NÁVYKŮ — state poller každých 5 minut
// ═══════════════════════════════════════════════
const EVENTS_FILE = path.join(__dirname, 'zan_events.json');
const HABITS_FILE = path.join(__dirname, 'zan_habits.json');

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

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1000,
      messages: [{ role: 'user', content: prompt }],
    });

    const suggestion = response.content.find(b => b.type === 'text')?.text;
    if (!suggestion) return;

    // Pošli návrh Ondrovi
    await bot.sendMessage(CHAT_ONDRA, `🧠 *Týdenní analýza návyků:*\n\n${suggestion}`, { parse_mode: 'Markdown' });

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
// RODINNÝ DASHBOARD
// ═══════════════════════════════════════════════
function generateFamilyDashboardYaml(residents, house) {
  const r = residents || {};
  const h = house || {};

  function esc(s) { return (s || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"'); }
  function ageCard(member) {
    const { name, born, emoji, info } = member;
    const bornDisplay = born.split('-').reverse().join('. ');
    const infoText = info ? esc(info) : 'Doplň mi info o sobě 🙂';
    const age = `{{ ((as_timestamp(now()) - as_timestamp(strptime('${born}', '%Y-%m-%d'))) / (365.25 * 86400)) | int }}`;
    return `          - type: markdown\n            content: "${emoji} **${name}** | 🎂 ${bornDisplay} · **${age} let**\\n${infoText}"`;
  }

  const parents = ['ondra', 'jana'].filter(k => r[k]).map(k => ageCard(r[k])).join('\n');
  const kids    = ['stepan', 'matej', 'eliska'].filter(k => r[k]).map(k => ageCard(r[k])).join('\n');

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
      try { await haPost('lovelace/reload'); } catch {} // tiše — dashboard nemusí být registrovaný
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

// Startup — načti aktuální stavy jako baseline + vytvoř rodinný dashboard
setTimeout(async () => {
  try {
    const states = await haGet('states');
    for (const s of states) {
      const domain = s.entity_id.split('.')[0];
      if (HABIT_DOMAINS.includes(domain)) lastStates[s.entity_id] = s.state;
    }
    console.log(`📊 Baseline načten: ${Object.keys(lastStates).length} sledovaných entit`);
  } catch {}
  await createFamilyDashboard();
}, 5000);

// Startup
connectSamba();
console.log('🏠 Žán v5 spuštěn');
console.log(`📱 Ondra: ${CHAT_ONDRA} | Jana: ${CHAT_JANA}`);
console.log(`🏡 HA: ${HA_URL}`);
console.log(`📁 Config: ${HA_CONFIG_PATH}`);
console.log('🧠 Sledování návyků aktivní — analýza každou neděli v 20:00');
