'use strict';
// ═══════════════════════════════════════════════════════════════════════
// VOICE CHANNEL — vstupní kanál "text in → odpověď out" pro HA custom
// conversation component (zast. 65/66, research 2026-08-05 §1 varianta B).
//
// Rozhodnutí HTTP vs. file bridge → HTTP na localhost + bearer token:
//  - HA conversation component dělá SYNCHRONNÍ request/response — HTTP je
//    přirozený tvar; file write+poll na HA straně by byl krkolomný.
//  - Hlas potřebuje sub-sekundový pickup; file polling přidá až celý poll
//    interval (research: file polling ≤ 500 ms, jinak HTTP).
//  - Žádná nová VEŘEJNÁ plocha: bind na 127.0.0.1 + bearer token, fail-closed
//    (bez tokenu kanál neexistuje) — mantinel karty splněn.
//
// Tento modul je framework-agnostický a bez závislosti na Anthropic/HA —
// dispatch (text→odpověď) se injektuje, takže jde otestovat bez modelu.
// ═══════════════════════════════════════════════════════════════════════
const crypto = require('crypto');

// Timing-safe porovnání bearer tokenu + délka-guard (crypto.timingSafeEqual
// hází na různých délkách). Fail-closed: bez očekávaného tokenu NIKDY neprojde.
function tokenOk(authHeader, expected) {
  if (!expected) return false;
  const m = /^Bearer\s+(.+)$/i.exec(String(authHeader || '').trim());
  if (!m) return false;
  const got = Buffer.from(m[1]);
  const exp = Buffer.from(String(expected));
  if (got.length !== exp.length) return false;
  return crypto.timingSafeEqual(got, exp);
}

// Cílový chat: z requestu jen když je v allowlistu (paměť/historie je per
// chatId — kanál nesmí adresovat cizí/neexistující chat), jinak default.
function resolveVoiceChat(requestedChatId, allowedChats, defaultChatId) {
  const n = Number(requestedChatId);
  if (Number.isInteger(n) && allowedChats.includes(n)) return n;
  return defaultChatId;
}

// Framework-agnostický handler: dostane {authHeader, body:{text,chat_id}},
// vrátí {status, json}. dispatch(chatId, text) → Promise<string> (v provozu
// processMessage přes frontu chatu, v testu stub).
function createVoiceHandler({ token, allowedChats, defaultChatId, dispatch }) {
  return async function handle({ authHeader, body }) {
    if (!tokenOk(authHeader, token)) {
      return { status: 401, json: { error: 'unauthorized' } };
    }
    const text = body && typeof body.text === 'string' ? body.text.trim() : '';
    if (!text) return { status: 400, json: { error: 'missing text' } };
    const chatId = resolveVoiceChat(body && body.chat_id, allowedChats, defaultChatId);
    if (!Number.isInteger(chatId)) return { status: 400, json: { error: 'no valid chat' } };
    try {
      const reply = await dispatch(chatId, text);
      return { status: 200, json: { reply: String(reply == null ? '' : reply), chat_id: chatId } };
    } catch (e) {
      return { status: 500, json: { error: e.message } };
    }
  };
}

module.exports = { tokenOk, resolveVoiceChat, createVoiceHandler };
