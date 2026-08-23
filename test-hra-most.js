#!/usr/bin/env node
'use strict';
// Testy mostu HA ↔ Telegram pro pomocníka ve hrách (hra-most.js).
// Spuštění: node --test test-hra-most.js   (nebo: node test-hra-most.js)
//
// Mock Telegram = zachycený sendMessage, mock HA = zachycený haPost/readState.
// Bez sítě, bez tokenů. Navíc kontraktní část čte bot.js jako text a hlídá,
// že zapojení (route /hra, callback hra:*, /konec) z bot.js zase nevypadne.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const hm = require('./hra-most');

const TOKEN = 'test-token-hra';
const AUTH = `Bearer ${TOKEN}`;
const ALLOWED = [2001, 2002];

function mockHa(states = {}) {
  const calls = [];
  return {
    calls,
    states,
    haPost: async (cesta, data) => { calls.push({ cesta, data }); return {}; },
    readState: async (entity) => (entity in states ? { entity_id: entity, state: states[entity] } : null),
  };
}

function mockTelegram() {
  const sent = [];
  return {
    sent,
    sendMessage: async (chatId, text, extra) => { sent.push({ chatId, text, extra }); return { message_id: 100 + sent.length }; },
  };
}

function handler(ha, tg, extra = {}) {
  return hm.createHraHandler({
    token: TOKEN, allowedChats: ALLOWED, defaultChatId: 2001,
    readState: ha.readState, sendMessage: tg.sendMessage, ...extra,
  });
}

// ── POST /hra ────────────────────────────────────────────────────────────
test('POST /hra: zpráva pomocníkovi s tlačítky + Konec hry automaticky', async () => {
  const ha = mockHa(); const tg = mockTelegram();
  const out = await handler(ha, tg)({ authHeader: AUTH, body: {
    text: 'Přepnuli obě páky?',
    tlacitka: [{ text: '✅ splnili', data: 'hra:ano' }, { text: '❌ nesplnili', data: 'hra:ne' }, { text: '🙋 to jsem byl já', data: 'hra:ja' }],
    komu: 'pomocnik',
  } });
  assert.equal(out.status, 200);
  assert.deepEqual(out.json, { ok: true, message_id: 101, chat_id: 2001 });
  assert.equal(tg.sent.length, 1);
  assert.equal(tg.sent[0].chatId, 2001);
  assert.equal(tg.sent[0].text, 'Přepnuli obě páky?');
  const kb = tg.sent[0].extra.reply_markup.inline_keyboard;
  assert.deepEqual(kb[0].map((b) => b.callback_data), ['hra:ano', 'hra:ne', 'hra:ja']);
  assert.deepEqual(kb[kb.length - 1], [{ text: '⏹ Konec hry', callback_data: 'hra:konec' }]);
});

test('POST /hra: Konec hry se nepřidá dvakrát, když ho HA (script.hra_telegram) už poslala', async () => {
  const ha = mockHa(); const tg = mockTelegram();
  await handler(ha, tg)({ authHeader: AUTH, body: {
    text: 'Příprava: schovej hůlku.',
    tlacitka: [{ text: '✅ hotovo', data: 'hra:hotovo' }, { text: '⏹ Konec hry', data: 'hra:konec' }],
  } });
  const vsechna = tg.sent[0].extra.reply_markup.inline_keyboard.flat().map((b) => b.callback_data);
  assert.deepEqual(vsechna, ['hra:hotovo', 'hra:konec']);
});

test('POST /hra: bez tlačítek = jen Konec hry (informační zpráva)', async () => {
  const ha = mockHa(); const tg = mockTelegram();
  const out = await handler(ha, tg)({ authHeader: AUTH, body: { text: 'Po hře: sklenička je v koupelně.' } });
  assert.equal(out.status, 200);
  assert.deepEqual(tg.sent[0].extra.reply_markup.inline_keyboard, [[{ text: '⏹ Konec hry', callback_data: 'hra:konec' }]]);
});

test('POST /hra: špatný / chybějící token → 401, nic se neposílá', async () => {
  const ha = mockHa(); const tg = mockTelegram();
  const h = handler(ha, tg);
  assert.equal((await h({ authHeader: 'Bearer spatny', body: { text: 'x' } })).status, 401);
  assert.equal((await h({ authHeader: undefined, body: { text: 'x' } })).status, 401);
  assert.equal(tg.sent.length, 0);
});

test('POST /hra: neznámé tlačítko (mimo allowlist) → 400, nic se neposílá', async () => {
  const ha = mockHa(); const tg = mockTelegram();
  const out = await handler(ha, tg)({ authHeader: AUTH, body: {
    text: 'x', tlacitka: [{ text: 'odemkni', data: 'lock:unlock:lock.vchod' }],
  } });
  assert.equal(out.status, 400);
  assert.match(out.json.error, /neznámé herní tlačítko/);
  assert.equal(tg.sent.length, 0);
});

test('POST /hra: prázdný text → 400', async () => {
  const ha = mockHa(); const tg = mockTelegram();
  assert.equal((await handler(ha, tg)({ authHeader: AUTH, body: { text: '  ' } })).status, 400);
});

test('POST /hra: pomocník z HA input_text.hra_pomocnik_chat (jen když je v allowlistu)', async () => {
  const ha = mockHa({ [hm.ENTITA_POMOCNIK_CHAT]: '2002' }); const tg = mockTelegram();
  const out = await handler(ha, tg)({ authHeader: AUTH, body: { text: 'Ahoj pomocníku' } });
  assert.equal(out.json.chat_id, 2002);

  const ha2 = mockHa({ [hm.ENTITA_POMOCNIK_CHAT]: '9999' }); const tg2 = mockTelegram();
  const out2 = await handler(ha2, tg2)({ authHeader: AUTH, body: { text: 'Ahoj' } });
  assert.equal(out2.json.chat_id, 2001, 'cizí chat id v HA → výchozí chat, nikdy cizí');
});

test('POST /hra: komu = číslo mimo allowlist → 400', async () => {
  const ha = mockHa(); const tg = mockTelegram();
  const out = await handler(ha, tg)({ authHeader: AUTH, body: { text: 'x', komu: 4444 } });
  assert.equal(out.status, 400);
  assert.equal(tg.sent.length, 0);
});

test('POST /hra: Telegram spadne → 502 s ok:false (HA rest_command má continue_on_error)', async () => {
  const ha = mockHa();
  const h = handler(ha, { sendMessage: async () => { throw new Error('ETELEGRAM 400'); } });
  const out = await h({ authHeader: AUTH, body: { text: 'x' } });
  assert.equal(out.status, 502);
  assert.equal(out.json.ok, false);
});

// ── callback hra:* → HA ──────────────────────────────────────────────────
test('callback hra:ano → input_boolean.turn_on hra_pomocnik_ano (a zpětně ověřeno on)', async () => {
  const ha = mockHa({ 'input_boolean.hra_pomocnik_ano': 'on' });
  const r = await hm.zpracujHraCallback({ data: 'hra:ano', chatId: 2001, haPost: ha.haPost, readState: ha.readState });
  assert.equal(r.ok, true);
  assert.deepEqual(ha.calls, [{ cesta: 'services/input_boolean/turn_on', data: { entity_id: 'input_boolean.hra_pomocnik_ano' } }]);
  assert.equal(r.znacka, '✅ splnili');
});

test('callback: tabulka ne / hotovo / ja / konec → správná služba a entita', async () => {
  const ocekavani = {
    'hra:ne': ['services/input_boolean/turn_on', 'input_boolean.hra_pomocnik_ne'],
    'hra:hotovo': ['services/input_boolean/turn_on', 'input_boolean.hra_priprava_hotovo'],
    'hra:ja': ['services/input_boolean/turn_on', 'input_boolean.hra_pomocnik_to_jsem_ja'],
    'hra:konec': ['services/script/turn_on', 'script.hra_konec'],
  };
  for (const [data, [cesta, entity]] of Object.entries(ocekavani)) {
    const ha = mockHa({ [entity]: 'on' });
    const r = await hm.zpracujHraCallback({ data, chatId: 2001, haPost: ha.haPost, readState: ha.readState });
    assert.equal(r.ok, true, data);
    assert.deepEqual(ha.calls, [{ cesta, data: { entity_id: entity } }], data);
  }
});

test('callback: HA vrátilo 200, ale boolean zůstal off → nepotvrzeno (duch actuation-guard)', async () => {
  const ha = mockHa({ 'input_boolean.hra_pomocnik_ne': 'off' });
  const r = await hm.zpracujHraCallback({ data: 'hra:ne', chatId: 2001, haPost: ha.haPost, readState: ha.readState });
  assert.equal(r.ok, false);
  assert.match(r.text, /nepotvrdil/);
});

test('callback: HA neodpovídá → ok:false, žádná výjimka ven', async () => {
  const r = await hm.zpracujHraCallback({ data: 'hra:konec', chatId: 2001, haPost: async () => { throw new Error('ECONNREFUSED'); }, readState: async () => null });
  assert.equal(r.ok, false);
  assert.match(r.text, /HA neodpověděl/);
});

test('callback na neznámou entitu / cizí data → odmítnuto, HA se nevolá', async () => {
  for (const data of ['hra:lock:unlock', 'hra:input_boolean.ai_stop', 'hra:', 'hra:ano:x', 'confirm:abc', 'hra:pokoj:../etc', 'hra:pokoj:Loznice']) {
    const ha = mockHa();
    const r = await hm.zpracujHraCallback({ data, chatId: 2001, haPost: ha.haPost, readState: ha.readState });
    assert.equal(r.ok, false, data);
    assert.equal(ha.calls.length, 0, `HA se nesmí volat pro ${data}`);
  }
});

test('allowlist: jediné cílové entity jsou hra_* a script.hra_konec', () => {
  for (const [data, a] of Object.entries(hm.AKCE)) {
    assert.match(a.entity_id, /^(input_boolean\.hra_|script\.hra_konec$)/, data);
  }
  assert.match(hm.ENTITA_POMOCNIK_ODPOVED, /^input_text\.hra_/);
});

test('callback hra:pokoj:<slug> → input_text.hra_pomocnik_odpoved = slug (P1 výběr pokoje)', async () => {
  const ha = mockHa();
  const r = await hm.zpracujHraCallback({ data: 'hra:pokoj:koupelna', chatId: 2001, haPost: ha.haPost, readState: ha.readState });
  assert.equal(r.ok, true);
  assert.deepEqual(ha.calls, [{ cesta: 'services/input_text/set_value', data: { entity_id: 'input_text.hra_pomocnik_odpoved', value: 'koupelna' } }]);
});

// ── volný text pomocníka ─────────────────────────────────────────────────
test('text pomocníka: po výzvě a v herním režimu → zapsán do input_text.hra_pomocnik_odpoved', async () => {
  const cekani = hm.vytvorCekani();
  const ha = mockHa({ [hm.ENTITA_REZIM]: 'hra' }); const tg = mockTelegram();
  await handler(ha, tg, { cekani })({ authHeader: AUTH, body: {
    text: 'Kam jsi schoval skleničku?', tlacitka: [{ text: '✍️ napíšu', data: 'hra:text' }],
  } });
  const r = await hm.zpracujTextPomocnika({ chatId: 2001, text: 'sklenička v koupelně', cekani, readState: ha.readState, haPost: ha.haPost });
  assert.deepEqual(r, { zapsano: true, value: 'sklenička v koupelně' });
  assert.deepEqual(ha.calls.at(-1), { cesta: 'services/input_text/set_value', data: { entity_id: 'input_text.hra_pomocnik_odpoved', value: 'sklenička v koupelně' } });
  assert.equal(await hm.zpracujTextPomocnika({ chatId: 2001, text: 'další', cekani, readState: ha.readState, haPost: ha.haPost }), null, 'čekání je jednorázové');
});

test('text mimo herní režim → ignorován (HA se nevolá, čekání zrušeno, bot jede normálně)', async () => {
  const cekani = hm.vytvorCekani();
  cekani.nastav(2001);
  const ha = mockHa({ [hm.ENTITA_REZIM]: 'normalni' });
  const r = await hm.zpracujTextPomocnika({ chatId: 2001, text: 'sklenička v koupelně', cekani, readState: ha.readState, haPost: ha.haPost });
  assert.equal(r.ignorovano, true);
  assert.equal(ha.calls.length, 0);
  assert.equal(cekani.size(), 0);
});

test('text bez výzvy / od jiného chatu / po expiraci → null (nic pro hru)', async () => {
  let t = 0;
  const cekani = hm.vytvorCekani(() => t);
  const ha = mockHa({ [hm.ENTITA_REZIM]: 'hra' });
  assert.equal(await hm.zpracujTextPomocnika({ chatId: 2001, text: 'ahoj', cekani, readState: ha.readState, haPost: ha.haPost }), null);
  cekani.nastav(2001);
  assert.equal(await hm.zpracujTextPomocnika({ chatId: 2002, text: 'ahoj', cekani, readState: ha.readState, haPost: ha.haPost }), null, 'jiný chat');
  t = hm.CEKANI_NA_TEXT_MS + 1;
  assert.equal(await hm.zpracujTextPomocnika({ chatId: 2001, text: 'pozdě', cekani, readState: ha.readState, haPost: ha.haPost }), null, 'expirace');
  assert.equal(ha.calls.length, 0);
});

// ── kontrakt zapojení v bot.js (text) ────────────────────────────────────
test('bot.js: route /hra, herní callback před pendingConfirm, /konec, volný text', () => {
  const src = fs.readFileSync(path.join(__dirname, 'bot.js'), 'utf8');
  assert.match(src, /require\('\.\/hra-most'\)/);
  assert.match(src, /req\.url === '\/hra' \? hra/);
  const iCb = src.indexOf('hraMost.jeHerniCallback(q.data)');
  const iPending = src.indexOf("const [act, token] = String(q.data || '').split(':')");
  assert.ok(iCb > 0 && iPending > iCb, 'herní větev musí být před pendingConfirm logikou');
  assert.match(src, /cmdText === '\/konec'/);
  assert.match(src, /hraMost\.zpracujTextPomocnika\(/);
  assert.match(src, /ZAN_HRA_CHAT_ID/);
});

// Spuštění `node test-hra-most.js` bez --test: node:test testy proběhnou a vypíší TAP.
