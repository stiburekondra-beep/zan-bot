'use strict';
const assert = require('assert');
const { tokenOk, resolveVoiceChat, createVoiceHandler } = require('../voice-channel');

const TOKEN = 'sekret-voice-token-123';
const ALLOWED = [111, 222];
const DEFAULT_CHAT = 111;

// ── 1) tokenOk: fail-closed, bearer, timing-safe délka-guard ──
assert.strictEqual(tokenOk(`Bearer ${TOKEN}`, TOKEN), true, 'správný bearer token projde');
assert.strictEqual(tokenOk(`bearer ${TOKEN}`, TOKEN), true, 'bearer je case-insensitive');
assert.strictEqual(tokenOk(`Bearer ${TOKEN}x`, TOKEN), false, 'jiná délka neprojde (guard)');
assert.strictEqual(tokenOk('Bearer spatny', TOKEN), false, 'špatný token neprojde');
assert.strictEqual(tokenOk(TOKEN, TOKEN), false, 'token bez Bearer prefixu neprojde');
assert.strictEqual(tokenOk('', TOKEN), false, 'prázdná hlavička neprojde');
assert.strictEqual(tokenOk(undefined, TOKEN), false, 'chybějící hlavička neprojde');
assert.strictEqual(tokenOk(`Bearer ${TOKEN}`, ''), false, 'FAIL-CLOSED: bez očekávaného tokenu NIKDY neprojde');
assert.strictEqual(tokenOk(`Bearer ${TOKEN}`, undefined), false, 'FAIL-CLOSED: undefined token neprojde');

// ── 2) resolveVoiceChat: jen allowlist, jinak default ──
assert.strictEqual(resolveVoiceChat(222, ALLOWED, DEFAULT_CHAT), 222, 'povolený chat z requestu');
assert.strictEqual(resolveVoiceChat('222', ALLOWED, DEFAULT_CHAT), 222, 'string chat_id se převede');
assert.strictEqual(resolveVoiceChat(999, ALLOWED, DEFAULT_CHAT), DEFAULT_CHAT, 'nepovolený chat → default');
assert.strictEqual(resolveVoiceChat(undefined, ALLOWED, DEFAULT_CHAT), DEFAULT_CHAT, 'bez chat_id → default');
assert.strictEqual(resolveVoiceChat('abc', ALLOWED, DEFAULT_CHAT), DEFAULT_CHAT, 'nevalidní chat_id → default');

// ── 3) createVoiceHandler end-to-end se STUB dispatchem (bez modelu) ──
let dispatched = null;
const dispatch = async (chatId, text) => {
  dispatched = { chatId, text };
  return `echo: ${text}`;
};
const handle = createVoiceHandler({ token: TOKEN, allowedChats: ALLOWED, defaultChatId: DEFAULT_CHAT, dispatch });

(async () => {
  // 3a) bez tokenu → 401, dispatch se NEZAVOLÁ
  dispatched = null;
  let out = await handle({ authHeader: 'Bearer spatny', body: { text: 'zapni světlo' } });
  assert.strictEqual(out.status, 401, 'špatný token → 401');
  assert.strictEqual(dispatched, null, 'při 401 se dispatch nesmí zavolat');

  // 3b) prázdný text → 400
  out = await handle({ authHeader: `Bearer ${TOKEN}`, body: { text: '   ' } });
  assert.strictEqual(out.status, 400, 'prázdný text → 400');

  // 3c) validní požadavek → 200 + reply, dispatch dostal voice chat + text
  dispatched = null;
  out = await handle({ authHeader: `Bearer ${TOKEN}`, body: { text: 'zapni světlo v obýváku' } });
  assert.strictEqual(out.status, 200, 'validní request → 200');
  assert.strictEqual(out.json.reply, 'echo: zapni světlo v obýváku', 'vrací odpověď z dispatch');
  assert.strictEqual(out.json.chat_id, DEFAULT_CHAT, 'default chat, když request žádný nedal');
  assert.strictEqual(dispatched.chatId, DEFAULT_CHAT, 'dispatch dostal správný chatId');
  assert.strictEqual(dispatched.text, 'zapni světlo v obýváku', 'dispatch dostal trimnutý text');

  // 3d) explicitní povolený chat se respektuje
  out = await handle({ authHeader: `Bearer ${TOKEN}`, body: { text: 'kolik je stupňů', chat_id: 222 } });
  assert.strictEqual(out.json.chat_id, 222, 'povolený chat z requestu se použije');

  // 3e) nepovolený chat spadne na default (ne cizí chat)
  out = await handle({ authHeader: `Bearer ${TOKEN}`, body: { text: 'ahoj', chat_id: 999 } });
  assert.strictEqual(out.json.chat_id, DEFAULT_CHAT, 'nepovolený chat → default, ne cizí chat');

  // 3f) chyba v dispatch → 500 (ne pád procesu)
  const failing = createVoiceHandler({
    token: TOKEN, allowedChats: ALLOWED, defaultChatId: DEFAULT_CHAT,
    dispatch: async () => { throw new Error('model down'); },
  });
  out = await failing({ authHeader: `Bearer ${TOKEN}`, body: { text: 'test' } });
  assert.strictEqual(out.status, 500, 'chyba dispatch → 500');
  assert.strictEqual(out.json.error, 'model down', 'chyba se propíše');

  console.log('check-voice-channel: OK (auth + chat resolve + handler e2e)');
})().catch((e) => { console.error(e); process.exit(1); });
