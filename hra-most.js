'use strict';
// ═══════════════════════════════════════════════════════════════════════
// HRA-MOST — most mezi HA (dětský režim Žána, `packages/ostatni/zan_hry.yaml`)
// a Telegramem pomocníka, který nehraje (rodič / starší brácha).
//
// Směr HA → pomocník: HA kostka `script.hra_telegram` volá
// `rest_command.hra_zan_bot` = `POST /hra` (stejný bearer token jako /voice).
// Bot pošle pomocníkovi zprávu s inline tlačítky (✅ splnili / ❌ nesplnili /
// ✅ hotovo / 🙋 to jsem byl já …) a KE KAŽDÉ herní zprávě přidá „⏹ Konec hry"
// (README her §5d: konec musí být vždy na dosah jedním klikem).
//
// Směr pomocník → HA: klik na tlačítko (`callback_query` s `hra:*`) → jedno
// REST volání do HA podle ALLOWLISTU níže. Nic jiného herní callback volat
// NESMÍ — žádné `light.*`, `lock.*`, žádná libovolná entita z `callback_data`
// (callback_data je z Telegramu = nedůvěryhodný vstup, proto tabulka, ne
// parser). Kanál pomocníka = Telegram (Ondra 23. 8. 2026 11:02, návrh §12t bod 1).
//
// Modul je framework-agnostický (jako voice-channel.js): Telegram i HA se
// injektují, takže se dá otestovat bez sítě (test-hra-most.js).
// ═══════════════════════════════════════════════════════════════════════
const { tokenOk } = require('./voice-channel');

const TLACITKO_KONEC = Object.freeze({ text: '⏹ Konec hry', data: 'hra:konec' });

// Entity v HA (zan_hry.yaml) — jediné, na které most sahá.
const ENTITA_POMOCNIK_CHAT = 'input_text.hra_pomocnik_chat';       // kdo je dnes pomocník (Telegram chat id), prázdné = výchozí
const ENTITA_POMOCNIK_ODPOVED = 'input_text.hra_pomocnik_odpoved'; // volná odpověď / vybraný pokoj (P1, P4)
const ENTITA_REZIM = 'input_select.zan_rezim';                      // volný text se zapisuje jen když == 'hra'

// Allowlist herních callbacků → přesně jedno HA volání.
// `over: 'on'` = po zavolání přečíst stav zpět a potvrdit jen, když je fakt
// 'on' (duch actuation-guard.js: HA vrátí 200 i když se nic nestalo).
const AKCE = Object.freeze({
  'hra:ano':    { sluzba: 'input_boolean/turn_on', entity_id: 'input_boolean.hra_pomocnik_ano',        over: 'on', potvrzeni: '✅ splnili' },
  'hra:ne':     { sluzba: 'input_boolean/turn_on', entity_id: 'input_boolean.hra_pomocnik_ne',         over: 'on', potvrzeni: '❌ nesplnili' },
  'hra:hotovo': { sluzba: 'input_boolean/turn_on', entity_id: 'input_boolean.hra_priprava_hotovo',     over: 'on', potvrzeni: '✅ hotovo' },
  'hra:ja':     { sluzba: 'input_boolean/turn_on', entity_id: 'input_boolean.hra_pomocnik_to_jsem_ja', over: 'on', potvrzeni: '🙋 to jsem byl já' },
  'hra:konec':  { sluzba: 'script/turn_on',        entity_id: 'script.hra_konec',                      potvrzeni: '⏹ Konec hry' },
});

const SLUG_RE = /^hra:pokoj:([a-z0-9_]{1,40})$/;
const CEKANI_NA_TEXT_MS = 10 * 60 * 1000; // volná odpověď platí 10 minut od výzvy
const MAX_TEXT = 3900;                     // limit Telegram zprávy
const MAX_ODPOVED = 255;                   // input_text max

// Z callback_data udělá popis akce, nebo null (= neznámé / zakázané tlačítko).
function hraAkce(data) {
  const d = String(data || '');
  if (AKCE[d]) return { data: d, ...AKCE[d] };
  const m = SLUG_RE.exec(d);
  if (m) {
    return {
      data: d, sluzba: 'input_text/set_value', entity_id: ENTITA_POMOCNIK_ODPOVED,
      value: m[1], potvrzeni: `📍 ${m[1]}`,
    };
  }
  if (d === 'hra:text') return { data: d, cekatText: true, potvrzeni: '✍️ Napiš odpověď jednou zprávou' };
  return null;
}

function jeHerniCallback(data) {
  return String(data || '').startsWith('hra:');
}

// Ověří tlačítka z HA a složí inline klávesnici: odpovědi v řádcích po 3,
// „Konec hry" vždy na samostatném posledním řádku (HA si ho může přidat sama —
// `script.hra_telegram` to dělá — proto dedupe, ať není dvakrát).
function sestavKlavesnici(tlacitka) {
  const seznam = Array.isArray(tlacitka) ? tlacitka : [];
  const odpovedi = [];
  for (const t of seznam) {
    if (!t || typeof t !== 'object') return { error: 'tlačítko musí být objekt {text, data}' };
    const text = String(t.text || '').trim();
    const data = String(t.data || '').trim();
    if (!text) return { error: 'tlačítko bez textu' };
    if (!hraAkce(data)) return { error: `neznámé herní tlačítko: ${data || '(prázdné)'}` };
    if (data === TLACITKO_KONEC.data) continue; // přidá se sám dole
    if (Buffer.byteLength(data) > 64) return { error: `callback_data přes 64 bytů: ${data}` };
    odpovedi.push({ text: text.slice(0, 40), callback_data: data });
  }
  const radky = [];
  for (let i = 0; i < odpovedi.length; i += 3) radky.push(odpovedi.slice(i, i + 3));
  radky.push([{ text: TLACITKO_KONEC.text, callback_data: TLACITKO_KONEC.data }]);
  return { inline_keyboard: radky, cekaText: odpovedi.some((b) => b.callback_data === 'hra:text') };
}

// Kdo je pomocník: `komu` z requestu (číslo z allowlistu) > HA
// input_text.hra_pomocnik_chat (číslo z allowlistu) > výchozí chat (admin).
// Cizí/neznámý chat NIKDY — kanál nesmí psát mimo ALLOWED_CHATS.
async function vyberChat({ komu, allowedChats, defaultChatId, readState }) {
  const n = Number(komu);
  if (komu !== undefined && komu !== null && komu !== '' && komu !== 'pomocnik') {
    if (Number.isInteger(n) && allowedChats.includes(n)) return n;
    return null;
  }
  if (readState) {
    try {
      const s = await readState(ENTITA_POMOCNIK_CHAT);
      const v = Number(s && typeof s === 'object' ? s.state : s);
      if (Number.isInteger(v) && v !== 0 && allowedChats.includes(v)) return v;
    } catch { /* HA nedostupná → výchozí chat */ }
  }
  return Number.isInteger(defaultChatId) ? defaultChatId : null;
}

// Paměť „čekám na volnou odpověď" — per chat, s expirací. Samostatná
// instance na bot, injektuje se do handleru i do zpracování textu.
function vytvorCekani(now = Date.now) {
  const mapa = new Map();
  return {
    nastav(chatId, info = {}) { mapa.set(chatId, { since: now(), ...info }); },
    vezmi(chatId) {
      const z = mapa.get(chatId);
      if (!z) return null;
      if (now() - z.since > CEKANI_NA_TEXT_MS) { mapa.delete(chatId); return null; }
      return z;
    },
    zrus(chatId) { mapa.delete(chatId); },
    size() { return mapa.size; },
  };
}

// HTTP handler `POST /hra` — {authHeader, body:{text, tlacitka, komu}} → {status, json}.
// sendMessage(chatId, text, extra) → Promise<{message_id}> (v provozu bot.sendMessage).
function createHraHandler({ token, allowedChats, defaultChatId, readState, sendMessage, cekani }) {
  const ceka = cekani || vytvorCekani();
  return async function handle({ authHeader, body }) {
    if (!tokenOk(authHeader, token)) return { status: 401, json: { error: 'unauthorized' } };
    const text = body && typeof body.text === 'string' ? body.text.trim() : '';
    if (!text) return { status: 400, json: { error: 'missing text' } };
    const kl = sestavKlavesnici(body.tlacitka);
    if (kl.error) return { status: 400, json: { error: kl.error } };
    const chatId = await vyberChat({ komu: body.komu, allowedChats, defaultChatId, readState });
    if (!Number.isInteger(chatId)) return { status: 400, json: { error: 'no valid chat' } };
    try {
      const sent = await sendMessage(chatId, text.slice(0, MAX_TEXT), {
        reply_markup: { inline_keyboard: kl.inline_keyboard },
        disable_notification: false,
      });
      const messageId = sent && sent.message_id;
      if (kl.cekaText || body.odpoved === 'text') ceka.nastav(chatId, { message_id: messageId });
      return { status: 200, json: { ok: true, message_id: messageId, chat_id: chatId } };
    } catch (e) {
      return { status: 502, json: { ok: false, error: `telegram: ${e.message}` } };
    }
  };
}

// Klik na herní tlačítko. Vrací {ok, text (pro answerCallbackQuery), znacka
// (text do upravené zprávy), akce}. haPost(cesta, data) = HA REST
// `services/<domain>/<service>`; readState(entity) pro zpětné ověření.
async function zpracujHraCallback({ data, chatId, haPost, readState, cekani }) {
  const akce = hraAkce(data);
  if (!akce) return { ok: false, text: 'Neznámé herní tlačítko — nic jsem neprovedl.', znacka: '⚠️ neznámé tlačítko' };
  if (akce.cekatText) {
    if (cekani) cekani.nastav(chatId);
    return { ok: true, text: akce.potvrzeni, znacka: akce.potvrzeni, akce };
  }
  const payload = { entity_id: akce.entity_id };
  if (akce.value !== undefined) payload.value = akce.value;
  try {
    await haPost(`services/${akce.sluzba}`, payload);
  } catch (e) {
    return { ok: false, text: `HA neodpověděl: ${e.message}`, znacka: `⚠️ ${akce.potvrzeni} — HA neodpověděl`, akce };
  }
  if (akce.over && readState) {
    let stav = null;
    try { const s = await readState(akce.entity_id); stav = s && typeof s === 'object' ? s.state : s; } catch { stav = null; }
    if (stav !== null && stav !== undefined && stav !== akce.over) {
      return { ok: false, text: `HA nepotvrdil (stav ${stav}) — zkus to znovu.`, znacka: `⚠️ ${akce.potvrzeni} — HA nepotvrdil`, akce, stav };
    }
  }
  return { ok: true, text: `Zapsáno: ${akce.potvrzeni}`, znacka: akce.potvrzeni, akce };
}

// Volný text od pomocníka po herní výzvě („sklenička v koupelně").
// null = pro hru nezajímavé (bot pokračuje normálně); {zapsano} = uloženo do
// HA; {ignorovano} = čekali jsme, ale hra neběží → čekání zrušeno, bot
// pokračuje normálně.
async function zpracujTextPomocnika({ chatId, text, cekani, readState, haPost }) {
  if (!cekani || !cekani.vezmi(chatId)) return null;
  const t = String(text || '').trim();
  if (!t || t.startsWith('/')) return null;
  let rezim = null;
  try { const s = await readState(ENTITA_REZIM); rezim = s && typeof s === 'object' ? s.state : s; } catch { rezim = null; }
  if (rezim !== 'hra') { cekani.zrus(chatId); return { ignorovano: true, rezim }; }
  const value = t.slice(0, MAX_ODPOVED);
  await haPost('services/input_text/set_value', { entity_id: ENTITA_POMOCNIK_ODPOVED, value });
  cekani.zrus(chatId);
  return { zapsano: true, value };
}

module.exports = {
  TLACITKO_KONEC, AKCE, ENTITA_POMOCNIK_CHAT, ENTITA_POMOCNIK_ODPOVED, ENTITA_REZIM, CEKANI_NA_TEXT_MS,
  hraAkce, jeHerniCallback, sestavKlavesnici, vyberChat, vytvorCekani,
  createHraHandler, zpracujHraCallback, zpracujTextPomocnika,
};
