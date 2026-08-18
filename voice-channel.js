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
//  - Bezpečnost stojí na fail-closed bearer tokenu (bez tokenu kanál vůbec
//    neexistuje), NE na izolaci sítě: add-on má host_network:true, takže se
//    produkčně bindne 0.0.0.0 kvůli dosažitelnosti z HA Core kontejneru
//    (172.30.32.1:8099) — port je pak dosažitelný i na LAN, proto NIKDY bez tokenu.
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

// ── NARRATOR (vypravěč) endpoint ────────────────────────────────────────
// Instant krycí fráze BEZ volání mozku — HA hlasová pipeline ji zavolá HNED
// po STT (a promluví ji), zatímco na pozadí běží /voice (Claude mozek).
// Tím se ZAMLUVÍ latence přemýšlení (karta 2026-08-18-programator-zana-04
// bod 1b, Ondrův směr 21:55). Šablona = ~0 ms, žádný druhý LLM call, žádný
// HA/tool přístup → strukturálně NEMŮŽE fabulovat výsledek (honesty jádro).
//
// `pickFiller(text)` se injektuje (narrator.pickNarratorFiller) → modul
// zůstává framework-agnostický a testovatelný bez závislostí. Fail-closed
// bearer token stejně jako /voice: bez tokenu endpoint neexistuje (401).
// Vrací { narrate, narrator } — `narrate:false` = triviální zpráva (mozek
// odpoví hned), pipeline pak žádnou frázi nepřehrává.
function createNarratorHandler({ token, pickFiller }) {
  return async function handle({ authHeader, body }) {
    if (!tokenOk(authHeader, token)) {
      return { status: 401, json: { error: 'unauthorized' } };
    }
    const text = body && typeof body.text === 'string' ? body.text.trim() : '';
    if (!text) return { status: 400, json: { error: 'missing text' } };
    let filler = null;
    try { filler = pickFiller(text); } catch { filler = null; }
    return { status: 200, json: { narrate: !!filler, narrator: filler || '' } };
  };
}

module.exports = { tokenOk, resolveVoiceChat, createVoiceHandler, createNarratorHandler };
