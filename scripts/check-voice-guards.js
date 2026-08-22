#!/usr/bin/env node
'use strict';
// Kontraktní test pro kartu 2026-08-21-programator-zana-02: hlas dřív šel
// cestou dispatch → processMessage a AI STOP / rate limit / HA-offline brzdu
// úplně obešel (žádný z předchozích 43 testů to nehlídal). Tenhle test volá
// PŘÍMO produkční `voiceDispatch` (stejnou funkci, kterou startVoiceChannel
// zapojuje do /voice) a mockuje HA REST API, aby ověřil, že guardy fakt
// blokují dřív, než by se sáhlo na model (žádný requirement na Anthropic klíč).
//
// Záměrně netestuje "guard je čistý → hlas projde až k modelu" — to by
// vyžadovalo mockovat Anthropic SDK, což je jiná (dražší) vrstva. Plumbing
// "dispatch stub → model" už hlídá scripts/check-voice-channel.js.

const assert = require('assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zan-voice-guards-'));

// ── Mock HA REST API: GET /api/ (online check) + GET /api/states/input_boolean.ai_stop ──
const haState = { up: true, stop: false };
const haServer = http.createServer((req, res) => {
  if (req.url === '/api/' || req.url === '/api') {
    res.writeHead(haState.up ? 200 : 500, { 'Content-Type': 'application/json' });
    return res.end('{}');
  }
  if (req.url === '/api/states/input_boolean.ai_stop') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ state: haState.stop ? 'on' : 'off' }));
  }
  res.writeHead(404);
  res.end();
});

haServer.listen(0, '127.0.0.1', () => {
  const port = haServer.address().port;
  process.env.ZAN_TEST_EXPORTS = '1';
  process.env.ZAN_DATA_DIR = tmp;
  process.env.CHAT_ID_ONDRA = '2001';
  process.env.CHAT_ID_JANA = '2002';
  process.env.CHAT_NAME_ONDRA = 'Ondra';
  process.env.CHAT_NAME_JANA = 'Jana';
  process.env.TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || 'test-token';
  process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'test-key';
  process.env.HA_URL = `http://127.0.0.1:${port}`;
  process.env.HA_TOKEN = 'test-ha-token';
  process.env.ZAN_HARNESS_ONLY = '1';

  const bot = require('../bot');
  const { createNarratorHandler } = require('../voice-channel');

  (async () => {
    // ── A) HA offline blokuje hlas dřív, než by šlo do processMessage ──
    haState.up = false; haState.stop = false;
    let reply = await bot.voiceDispatch(9101, 'zhasni v obýváku');
    assert.match(String(reply), /Home Assistant není dostupný/, 'HA-offline brzda musí zablokovat hlas (voiceDispatch), ne jen Telegram');

    // ── B) AI STOP blokuje hlas ──
    haState.up = true; haState.stop = true;
    reply = await bot.voiceDispatch(9102, 'zhasni v obýváku');
    assert.match(String(reply), /AI STOP je aktivní/, 'AI STOP musí zablokovat hlas (voiceDispatch), ne jen Telegram — tohle je jádro karty 2026-08-21-programator-zana-02');

    // ── C) rate limit platí i na hlas, nezávisle na HA stavu ──
    haState.up = false; haState.stop = false; // ať žádné z 10 povolených volání neprojde až k processMessage
    let last;
    for (let i = 0; i < 11; i++) last = await bot.voiceDispatch(9103, 'kolik je hodin');
    assert.match(String(last), /Příliš mnoho zpráv/, '11. hlasový povel do minuty musí narazit na stejný rate limit jako Telegram');

    // ── D) vypravěč (/narrate) mlčí, když je STOP — samostatný modul, žádný HA/model ──
    haState.up = true; haState.stop = true;
    const narrate = createNarratorHandler({ token: 't', pickFiller: () => 'Chviličku, dívám se…', checkStop: bot.isAiStopped });
    const out = await narrate({ authHeader: 'Bearer t', body: { text: 'zhasni v obýváku' } });
    assert.strictEqual(out.json.narrate, false, 'vypravěč nesmí mluvit (narrate:false), když je AI STOP aktivní');
    assert.strictEqual(out.json.narrator, '', 'vypravěč nesmí vrátit frázi, když je AI STOP aktivní');

    console.log('check-voice-guards: OK (HA-offline + AI STOP + rate limit blokují voiceDispatch; /narrate mlčí při STOP)');
    haServer.close();
    process.exit(0);
  })().catch((e) => {
    console.error(e);
    haServer.close();
    process.exit(1);
  });
});
