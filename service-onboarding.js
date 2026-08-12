'use strict';

const fs = require('fs');
const { URL } = require('url');
const { tokenOk } = require('./voice-channel');

const SERVICES = [
  {
    id: 'ha-cloud',
    name: 'Home Assistant Cloud',
    mark: 'HA',
    status: 'needs_login',
    needsAccount: true,
    text: 'Vzdálený přístup a bezpečný návrat z přihlášení.',
    action: 'Připojit',
  },
  {
    id: 'spotify',
    name: 'Spotify',
    mark: 'SP',
    status: 'needs_login',
    needsAccount: true,
    text: 'Hudba přes Music Assistant. Pokud účet běží přes Facebook, dlaždice to řekne jako blokaci.',
    action: 'Připojit',
  },
  {
    id: 'youtube-cast',
    name: 'YouTube / Cast',
    mark: 'YT',
    status: 'no_login',
    needsAccount: false,
    text: 'Veřejné video přes Cast obvykle nepotřebuje účet.',
    action: 'Ověřit přehrávač',
  },
  {
    id: 'smart-tv',
    name: 'Chytrá TV',
    mark: 'TV',
    status: 'needs_device',
    needsAccount: false,
    text: 'Samsung nebo LG se páruje přes televizi; potvrzení se dělá na obrazovce.',
    action: 'Spustit párování',
  },
  {
    id: 'music-assistant',
    name: 'Music Assistant',
    mark: 'MA',
    status: 'needs_setup',
    needsAccount: false,
    text: 'Lokální hudební centrum v Home Assistantu. Bez něj je Spotify jen účet bez přehrávání.',
    action: 'Zkontrolovat',
  },
  {
    id: 'radio',
    name: 'Rádio fallback',
    mark: 'FM',
    status: 'ready',
    needsAccount: false,
    text: 'Záložní přehrávání bez přihlašování, když Spotify ještě nejde.',
    action: 'Hotovo',
  },
];

const STATUS = {
  needs_login: { label: 'Nepřipojeno', tone: 'todo' },
  no_login: { label: 'Bez přihlášení', tone: 'ready' },
  needs_device: { label: 'Čeká na zařízení', tone: 'wait' },
  needs_setup: { label: 'Nejde teď', tone: 'blocked' },
  ready: { label: 'Připraveno', tone: 'ready' },
  connected: { label: 'Připojeno', tone: 'done' },
  blocked: { label: 'Nejde teď', tone: 'blocked' },
};

function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(require('path').dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
}

function loadState(file) {
  const raw = readJson(file, {});
  return raw && typeof raw === 'object' && raw.services && typeof raw.services === 'object'
    ? raw
    : { services: {} };
}

function serviceTiles(file) {
  const state = loadState(file);
  return SERVICES.map((svc) => {
    const saved = state.services[svc.id] || {};
    const status = saved.status || svc.status;
    return {
      ...svc,
      status,
      statusLabel: (STATUS[status] || STATUS.blocked).label,
      tone: (STATUS[status] || STATUS.blocked).tone,
      connectedAt: saved.connectedAt || null,
      reason: saved.reason || null,
    };
  });
}

function mockConnect(file, serviceId, now = new Date()) {
  const svc = SERVICES.find((s) => s.id === serviceId);
  if (!svc) return { ok: false, error: 'unknown service' };
  if (svc.status === 'needs_setup' || svc.status === 'needs_device') {
    return { ok: false, error: 'blocked', reason: svc.text };
  }
  const state = loadState(file);
  state.services[serviceId] = {
    status: 'connected',
    connectedAt: now.toISOString(),
  };
  writeJson(file, state);
  return { ok: true, service: serviceTiles(file).find((s) => s.id === serviceId) };
}

function requestAuthorized(req, token, parsedUrl) {
  if (!token) return false;
  const queryToken = parsedUrl.searchParams.get('t') || parsedUrl.searchParams.get('token');
  if (queryToken && tokenOk(`Bearer ${queryToken}`, token)) return true;
  return tokenOk(req.headers.authorization, token);
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function sendHtml(res, html) {
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(html);
}

function renderOnboardingHtml() {
  return `<!doctype html>
<html lang="cs">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Žán - připojení služeb</title>
<style>
:root{font-family:Inter,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#17211c;background:#f5f7f4}
*{box-sizing:border-box}body{margin:0;min-height:100vh;background:#f5f7f4}.shell{max-width:1040px;margin:0 auto;padding:22px 16px 36px}
header{display:flex;align-items:flex-start;justify-content:space-between;gap:18px;margin-bottom:18px}.brand{display:flex;gap:12px;align-items:center}.logo{width:44px;height:44px;border-radius:8px;background:#234034;color:#fff;display:grid;place-items:center;font-weight:800}.title h1{font-size:28px;line-height:1.08;margin:0;color:#102019}.title p{margin:6px 0 0;color:#52615a;font-size:15px;max-width:680px}.safe{font-size:13px;color:#27493a;border:1px solid #bed5c8;background:#eaf4ee;border-radius:8px;padding:9px 11px;max-width:260px}
.grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}.tile{background:#fff;border:1px solid #d8e1dc;border-radius:8px;padding:14px;min-height:190px;display:flex;flex-direction:column;gap:12px;box-shadow:0 1px 0 rgba(16,32,25,.04)}.top{display:flex;gap:10px;align-items:center}.mark{width:38px;height:38px;border-radius:8px;background:#e7ece9;color:#173126;display:grid;place-items:center;font-weight:800}.name{font-weight:750;font-size:18px;color:#14231c}.badge{margin-left:auto;border-radius:999px;padding:5px 8px;font-size:12px;font-weight:700;white-space:nowrap}.todo{background:#fff2cf;color:#6b4b00}.ready,.done{background:#dff4e7;color:#18552d}.wait{background:#e5edf7;color:#23466e}.blocked{background:#fde3df;color:#843226}.desc{font-size:14px;line-height:1.38;color:#44524b;margin:0;flex:1}.meta{font-size:13px;color:#61726a}.actions{display:flex;gap:8px}.btn{appearance:none;border:0;border-radius:8px;background:#244b3c;color:#fff;font-weight:750;font-size:15px;padding:11px 12px;min-height:44px;cursor:pointer}.btn.secondary{background:#e8eee9;color:#1d3429}.btn:disabled{background:#d5ddd8;color:#6d7973;cursor:not-allowed}.empty{padding:22px;border:1px dashed #b8c6bf;border-radius:8px;background:#fff;color:#596960}
dialog{border:0;border-radius:8px;padding:0;max-width:430px;width:calc(100% - 28px);box-shadow:0 18px 70px rgba(0,0,0,.25)}dialog::backdrop{background:rgba(7,20,14,.45)}.modal{padding:18px}.modal h2{margin:0 0 8px;font-size:22px}.modal p{color:#4c5a53;line-height:1.45}.modal .row{display:flex;gap:8px;justify-content:flex-end;margin-top:18px}.notice{margin-top:14px;color:#385344;font-size:14px}
@media(max-width:780px){.grid{grid-template-columns:1fr}header{display:block}.safe{max-width:none;margin-top:12px}.title h1{font-size:25px}.tile{min-height:170px}}
</style>
</head>
<body>
<main class="shell">
  <header>
    <div class="brand"><div class="logo">Ž</div><div class="title"><h1>Připojení služeb</h1><p>Projdi jednu dlaždici po druhé. Když služba účet nepotřebuje nebo nejde připojit hned, Žán to řekne přímo.</p></div></div>
    <div class="safe">Heslo sem nikdy nepíšeš. Přihlášení probíhá jen u poskytovatele služby.</div>
  </header>
  <section id="tiles" class="grid" aria-live="polite"></section>
  <p class="notice">Stav se ukládá lokálně v této domácnosti.</p>
</main>
<dialog id="oauth"><div class="modal"><h2 id="modal-title">Připojit službu</h2><p id="modal-text"></p><div class="row"><button class="btn secondary" id="close">Zavřít</button><button class="btn" id="simulate">Simulovat návrat</button></div></div></dialog>
<script>
const token = new URLSearchParams(location.search).get('t') || new URLSearchParams(location.search).get('token') || '';
const api = (path) => path + (token ? '?t=' + encodeURIComponent(token) : '');
let active = null;
function esc(s){return String(s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function render(items){
  const root = document.getElementById('tiles');
  if (!items.length) { root.innerHTML = '<div class="empty">Zatím tu nejsou žádné služby.</div>'; return; }
  root.innerHTML = items.map(s => '<article class="tile" data-id="'+esc(s.id)+'"><div class="top"><div class="mark">'+esc(s.mark)+'</div><div class="name">'+esc(s.name)+'</div><span class="badge '+esc(s.tone)+'">'+esc(s.statusLabel)+'</span></div><p class="desc">'+esc(s.text)+'</p><div class="meta">'+(s.needsAccount ? 'Účet potřebuje' : 'Účet nepotřebuje')+'</div><div class="actions"><button class="btn" '+(s.status==='connected'||s.status==='ready'?'disabled':'')+'>'+esc(s.status==='connected'?'Připojeno':s.action)+'</button></div></article>').join('');
  root.querySelectorAll('.tile .btn').forEach(btn => btn.addEventListener('click', () => openModal(btn.closest('.tile').dataset.id)));
}
async function load(){
  const r = await fetch(api('/api/onboarding/services'), { headers: token ? {} : {} });
  if (!r.ok) throw new Error('Onboarding není dostupný.');
  render((await r.json()).services || []);
}
function openModal(id){
  active = id;
  const name = document.querySelector('[data-id="'+CSS.escape(id)+'"] .name').textContent;
  document.getElementById('modal-title').textContent = name;
  document.getElementById('modal-text').textContent = 'Teď by se otevřelo přihlášení poskytovatele. Heslo se nepíše Žánovi ani Baklažánu; po návratu se jen uloží stav připojeno.';
  document.getElementById('oauth').showModal();
}
document.getElementById('close').onclick = () => document.getElementById('oauth').close();
document.getElementById('simulate').onclick = async () => {
  if (!active) return;
  await fetch(api('/api/onboarding/mock-connect'), { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ service_id: active }) });
  document.getElementById('oauth').close();
  await load();
};
load().catch(e => { document.getElementById('tiles').innerHTML = '<div class="empty">'+esc(e.message)+'</div>'; });
</script>
</body>
</html>`;
}

function handleOnboardingRequest(req, res, { token, stateFile }) {
  const parsed = new URL(req.url, 'http://zan.local');
  const path = parsed.pathname.replace(/\/+$/, '') || '/';
  if (!['/onboarding', '/api/onboarding/services', '/api/onboarding/mock-connect'].includes(path)) return false;
  if (!requestAuthorized(req, token, parsed)) {
    res.writeHead(404);
    res.end();
    return true;
  }
  if (req.method === 'GET' && path === '/onboarding') {
    sendHtml(res, renderOnboardingHtml());
    return true;
  }
  if (req.method === 'GET' && path === '/api/onboarding/services') {
    sendJson(res, 200, { services: serviceTiles(stateFile) });
    return true;
  }
  if (req.method === 'POST' && path === '/api/onboarding/mock-connect') {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 4096) req.destroy(); });
    req.on('end', () => {
      let body = {};
      try { body = raw ? JSON.parse(raw) : {}; } catch { return sendJson(res, 400, { error: 'bad json' }); }
      const out = mockConnect(stateFile, body.service_id);
      sendJson(res, out.ok ? 200 : 409, out);
    });
    return true;
  }
  sendJson(res, 405, { error: 'method not allowed' });
  return true;
}

module.exports = {
  SERVICES,
  STATUS,
  loadState,
  serviceTiles,
  mockConnect,
  requestAuthorized,
  renderOnboardingHtml,
  handleOnboardingRequest,
};
