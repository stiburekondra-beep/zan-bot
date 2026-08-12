#!/usr/bin/env node
'use strict';

const assert = require('assert');
const {
  extractVideoId,
  resolveVideoPlayer,
  buildCastPayload,
  parseSearchHtml,
  searchYouTube,
  playVideo,
  isYouTubeApp,
  buildControlCall,
  controlVideo,
} = require('../play-video');
const { VOICE_CONTROL_TOOLS } = require('../tool-profiles');

const states = [
  { entity_id: 'media_player.tv_obyvak_cast', state: 'off', attributes: { supported_features: 152461 } },
  { entity_id: 'media_player.zan_media_player', state: 'idle', attributes: { supported_features: 7796287, app_id: 'music_assistant' } },
  { entity_id: 'media_player.living_room_tv', state: 'idle', attributes: { supported_features: 8320575, app_id: 'music_assistant' } },
  { entity_id: 'media_player.home_assistant_voice_0a93a5_media_player', state: 'idle', attributes: { supported_features: 1200653 } },
  { entity_id: 'light.kuchyn', state: 'on', attributes: {} },
];

// ── ID videa ─────────────────────────────────────────────────────────
assert.strictEqual(extractVideoId('qmOfZe47eok'), 'qmOfZe47eok', 'holé ID projde');
assert.strictEqual(extractVideoId('https://www.youtube.com/watch?v=qmOfZe47eok&t=10s'), 'qmOfZe47eok', 'watch URL');
assert.strictEqual(extractVideoId('https://youtu.be/qmOfZe47eok'), 'qmOfZe47eok', 'krátká URL');
assert.strictEqual(extractVideoId('https://www.youtube.com/shorts/qmOfZe47eok'), 'qmOfZe47eok', 'shorts URL');
assert.strictEqual(extractVideoId('traktory v blátě'), '', 'běžný dotaz není ID');

// ── výběr obrazovky ──────────────────────────────────────────────────
assert.strictEqual(
  resolveVideoPlayer({ states, requestedPlayer: '', defaultPlayer: 'media_player.tv_obyvak_cast' }).entity_id,
  'media_player.tv_obyvak_cast',
  'konfigurovaný cíl se použije',
);
const auto = resolveVideoPlayer({ states, requestedPlayer: '', defaultPlayer: '' });
assert.strictEqual(auto.ok, true, 'autodetekce najde jedinou cast obrazovku');
assert.strictEqual(auto.entity_id, 'media_player.tv_obyvak_cast', 'Music Assistant fronta ani hlasový satelit nejsou obrazovka');
assert.strictEqual(auto.source, 'autodetect', 'autodetekce se přizná v source');

const ambiguous = resolveVideoPlayer({
  states: [...states, { entity_id: 'media_player.tv_loznice_cast', state: 'off', attributes: { supported_features: 152461 } }],
  requestedPlayer: '',
  defaultPlayer: '',
});
assert.strictEqual(ambiguous.ok, false, 'víc obrazovek se nehádá');
assert.strictEqual(ambiguous.reason, 'player_ambiguous', 'nejednoznačnost má konkrétní důvod');
assert(ambiguous.next_step.includes('ZAN_VIDEO_PLAYER_ENTITY_ID'), 'nejednoznačnost nese další krok');

const unavailable = resolveVideoPlayer({
  states: [{ entity_id: 'media_player.tv_obyvak_cast', state: 'unavailable', attributes: { supported_features: 152461 } }],
  requestedPlayer: 'media_player.tv_obyvak_cast',
  defaultPlayer: '',
});
assert.strictEqual(unavailable.reason, 'player_unavailable', 'nedostupná TV má konkrétní důvod');

const missing = resolveVideoPlayer({ states: [], requestedPlayer: '', defaultPlayer: '' });
assert.strictEqual(missing.reason, 'player_missing', 'bez cast obrazovky fail');
assert(missing.next_step.includes('Google Cast'), 'chybějící integrace se pojmenuje');

// ── payload ──────────────────────────────────────────────────────────
assert.deepStrictEqual(
  buildCastPayload({ videoId: 'qmOfZe47eok', playerEntityId: 'media_player.tv_obyvak_cast' }),
  {
    ok: true,
    data: {
      entity_id: 'media_player.tv_obyvak_cast',
      media_content_type: 'cast',
      media_content_id: '{"app_name":"youtube","media_id":"qmOfZe47eok"}',
    },
  },
  'payload je úzký cast payload, žádný obecný call_service',
);
assert.strictEqual(buildCastPayload({ videoId: 'x', playerEntityId: 'media_player.tv_obyvak_cast' }).ok, false, 'nesmyslné ID neprojde');
assert.strictEqual(buildCastPayload({ videoId: 'qmOfZe47eok', playerEntityId: 'light.kuchyn' }).ok, false, 'cíl musí být media_player.*');

// ── parsování výsledků hledání ───────────────────────────────────────
const html = 'xx{"videoRenderer":{"videoId":"qmOfZe47eok","thumbnail":{},"title":{"runs":[{"text":"TRAKTORY V BAHN\\u011a"}]}}}';
assert.deepStrictEqual(parseSearchHtml(html), { videoId: 'qmOfZe47eok', title: 'TRAKTORY V BAHNĚ' }, 'z HTML se vytáhne první video i s escapovaným titulkem');
assert.strictEqual(parseSearchHtml('nic tady není'), null, 'rozbité HTML nevrací smyšlené video');

(async () => {
  // hledání přes Data API, když je klíč
  const apiHit = await searchYouTube({
    query: 'traktory v blátě',
    apiKey: 'KLIC',
    fetchImpl: async (url) => {
      assert(url.includes('googleapis.com/youtube/v3/search'), 's klíčem jde oficiální API');
      assert(url.includes('key=KLIC'), 'klíč se posílá');
      return { ok: true, json: async () => ({ items: [{ id: { videoId: 'qmOfZe47eok' }, snippet: { title: 'Traktory v bahně' } }] }) };
    },
  });
  assert.deepStrictEqual(
    { ok: apiHit.ok, videoId: apiHit.videoId, source: apiHit.source },
    { ok: true, videoId: 'qmOfZe47eok', source: 'data_api' },
    'Data API cesta vrací ID',
  );

  // bez klíče se použije veřejná stránka výsledků
  const scrapeHit = await searchYouTube({
    query: 'traktory v blátě',
    apiKey: '',
    fetchImpl: async (url) => {
      assert(url.includes('youtube.com/results'), 'bez klíče fallback na stránku výsledků');
      return { ok: true, text: async () => html };
    },
  });
  assert.strictEqual(scrapeHit.source, 'scrape', 'fallback se přizná v source');

  // hledání bez výsledku nesmí nic pustit
  const noResults = await searchYouTube({ query: 'aaa', apiKey: '', fetchImpl: async () => ({ ok: true, text: async () => 'prazdno' }) });
  assert.strictEqual(noResults.ok, false, 'bez nálezu fail');
  assert(noResults.next_step, 'bez nálezu je další krok');

  // ── celý průchod ───────────────────────────────────────────────────
  const calls = [];
  const result = await playVideo({
    input: { query: 'traktory v blátě' },
    defaultPlayer: 'media_player.tv_obyvak_cast',
    apiKey: '',
    waitMs: 0,
    sleepImpl: async () => {},
    fetchImpl: async () => ({ ok: true, text: async () => html }),
    haGet: async (path) => {
      calls.push(['GET', path]);
      if (path === 'states') return states;
      return { entity_id: 'media_player.tv_obyvak_cast', state: 'playing', attributes: { app_name: 'YouTube', media_title: 'TRAKTORY V BAHNĚ' } };
    },
    haPost: async (path, data) => {
      calls.push(['POST', path, data]);
      return {};
    },
  });
  assert.strictEqual(result.success, true, 'happy path uspěje');
  assert.strictEqual(result.confirmed, true, 'potvrzení se opírá o stav přehrávače');
  assert.strictEqual(result.video_id, 'qmOfZe47eok', 'pustí se nalezené video');
  assert(calls.some(c => c[0] === 'POST' && c[1] === 'services/media_player/play_media'), 'volá se jen media_player.play_media');
  assert.strictEqual(
    calls.find(c => c[0] === 'POST')[2].media_content_type,
    'cast',
    'posílá se cast payload',
  );

  // TV vypnutá / nereaguje → žádné falešné potvrzení
  const notConfirmed = await playVideo({
    input: { query: 'https://youtu.be/qmOfZe47eok' },
    defaultPlayer: 'media_player.tv_obyvak_cast',
    waitMs: 0,
    sleepImpl: async () => {},
    haGet: async (path) => (path === 'states' ? states : { state: 'off', attributes: {} }),
    haPost: async () => ({}),
  });
  assert.strictEqual(notConfirmed.confirmed, false, 'stav off se nevydává za přehrávání');
  assert(notConfirmed.message.includes('zapnutá'), 'nepotvrzený stav nese další krok pro člověka');
  assert.strictEqual(notConfirmed.search_source, 'direct', 'URL od uživatele se nehledá znovu');

  // prázdný dotaz
  const empty = await playVideo({ input: {}, haGet: async () => states, haPost: async () => ({}) });
  assert.strictEqual(empty.success, false, 'bez dotazu se nic nepouští');

  // ── regrese 2026-08-12: cast payload nesmí skončit v Music Assistant frontě ──
  const maRequested = resolveVideoPlayer({
    states,
    requestedPlayer: 'media_player.living_room_tv', // MA entita, model si ji vybral sám
    defaultPlayer: 'media_player.tv_obyvak_cast',
  });
  assert.strictEqual(maRequested.entity_id, 'media_player.tv_obyvak_cast', 'MA entita se odmítne i když si ji vyžádal model');
  assert.deepStrictEqual(maRequested.rejected_players, ['media_player.living_room_tv'], 'odmítnutý cíl se přizná');

  assert.strictEqual(isYouTubeApp('YouTube'), true, 'app_name YouTube je YouTube');
  assert.strictEqual(isYouTubeApp('233637DE'), true, 'cast app ID YouTube receiveru');
  assert.strictEqual(isYouTubeApp('Music Assistant'), false, 'Music Assistant není YouTube');

  // hraje, ale hraje hudba → NESMÍ hlásit úspěch (bug: "Hotovo, traktory hrají")
  const wrongApp = await playVideo({
    input: { query: 'https://youtu.be/qmOfZe47eok' },
    defaultPlayer: 'media_player.tv_obyvak_cast',
    waitMs: 0,
    sleepImpl: async () => {},
    haGet: async (path) => (path === 'states' ? states : { state: 'playing', attributes: { app_name: 'Music Assistant', media_title: 'Media' } }),
    haPost: async () => ({}),
  });
  assert.strictEqual(wrongApp.success, false, 'hudba na obrazovce není úspěšně puštěné video');
  assert.strictEqual(wrongApp.reason, 'wrong_app', 'špatná aplikace má konkrétní důvod');
  assert(wrongApp.next_step.includes('Music Assistant'), 'next_step pojmenuje, co tam běží');

  // ── ovládání televize ────────────────────────────────────────────────
  assert.deepStrictEqual(
    buildControlCall({ action: 'volume', volumePercent: 35 }),
    { ok: true, service: 'media_player/volume_set', data: { volume_level: 0.35 } },
    'konkrétní hlasitost jde jako volume_set',
  );
  assert.strictEqual(buildControlCall({ action: 'volume_up', currentVolume: 0.95 }).data.volume_level, 1, 'zesílení se ořízne na 100 %');
  assert.strictEqual(buildControlCall({ action: 'volume_down', currentVolume: 0.05 }).data.volume_level, 0, 'ztlumení se ořízne na 0 %');
  assert.strictEqual(buildControlCall({ action: 'pause' }).service, 'media_player/media_pause', 'pauza');
  assert.strictEqual(buildControlCall({ action: 'mute' }).data.is_volume_muted, true, 'ztlumení');
  assert.strictEqual(buildControlCall({ action: 'volume' }).ok, false, 'volume bez hodnoty neprojde');
  assert.strictEqual(buildControlCall({ action: 'sebedestrukce' }).ok, false, 'neznámý povel neprojde');

  const volCalls = [];
  const volResult = await controlVideo({
    input: { action: 'volume_up' },
    defaultPlayer: 'media_player.tv_obyvak_cast',
    waitMs: 0,
    sleepImpl: async () => {},
    haGet: async (path) => (path === 'states'
      ? [{ entity_id: 'media_player.tv_obyvak_cast', state: 'playing', attributes: { supported_features: 152461, app_name: 'YouTube', volume_level: 0.4 } }]
      : { state: 'playing', attributes: { volume_level: 0.5 } }),
    haPost: async (path, data) => { volCalls.push([path, data]); return {}; },
  });
  assert.deepStrictEqual(volCalls[0], ['services/media_player/volume_set', { entity_id: 'media_player.tv_obyvak_cast', volume_level: 0.5 }], 'zesílení počítá z aktuální hlasitosti');
  assert.strictEqual(volResult.volume_percent, 50, 'výsledek hlásí ověřenou hlasitost');

  // profil hlasu
  assert(VOICE_CONTROL_TOOLS.includes('play_video'), 'play_video je dostupný hlasem u satelitu');

  console.log('check-play-video: OK');
})().catch((e) => {
  console.error('check-play-video FAIL:', e.message);
  process.exit(1);
});
