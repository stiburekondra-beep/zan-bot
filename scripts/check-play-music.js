#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { resolveMusicPlayer, buildMusicServiceData, playMusic } = require('../play-music');
const { VOICE_CONTROL_TOOLS } = require('../tool-profiles');

const states = [
  { entity_id: 'media_player.zan_media_player', state: 'idle', attributes: { friendly_name: 'Žán media player' } },
  { entity_id: 'media_player.hrajici', state: 'playing', attributes: { media_title: 'Numb', media_artist: 'Linkin Park' } },
  { entity_id: 'media_player.vypnuty', state: 'unavailable', attributes: {} },
  { entity_id: 'light.kuchyn', state: 'on', attributes: {} },
];

assert.strictEqual(
  resolveMusicPlayer({ states, requestedPlayer: '', defaultPlayer: '' }).entity_id,
  'media_player.zan_media_player',
  'bez konfigurace použije jen ověřený známý default',
);
assert.strictEqual(
  resolveMusicPlayer({ states, requestedPlayer: 'light.kuchyn', defaultPlayer: '' }).entity_id,
  'media_player.zan_media_player',
  'nemedia_player requested target se ignoruje a neotevře náhodný cíl',
);
const unavailable = resolveMusicPlayer({ states, requestedPlayer: 'media_player.vypnuty', defaultPlayer: '' });
assert.strictEqual(unavailable.ok, false, 'unavailable player není použitelný');
assert.strictEqual(unavailable.reason, 'player_unavailable', 'unavailable má konkrétní důvod');
const missing = resolveMusicPlayer({ states: [], requestedPlayer: '', defaultPlayer: '' });
assert.strictEqual(missing.ok, false, 'bez ověřeného přehrávače fail');
assert(missing.next_step.includes('ZAN_MUSIC_PLAYER_ENTITY_ID'), 'fallback nese další krok');

assert.deepStrictEqual(
  buildMusicServiceData({ query: '  Coldplay  ', mediaType: 'artist', playerEntityId: 'media_player.zan_media_player' }),
  {
    ok: true,
    data: {
      entity_id: 'media_player.zan_media_player',
      media_id: 'Coldplay',
      media_type: 'artist',
      enqueue: 'replace',
    },
  },
  'payload pro Music Assistant je úzký a kontrolovaný',
);
assert.deepStrictEqual(
  buildMusicServiceData({ query: 'dechovka', mediaType: 'radio', playerEntityId: 'media_player.hrajici' }),
  {
    ok: true,
    data: {
      entity_id: 'media_player.hrajici',
      media_id: 'dechovka',
      media_type: 'radio',
      enqueue: 'replace',
    },
  },
  'nový hudební povel na už hrajícím přehrávači nahrazuje aktuální hudbu',
);
assert.strictEqual(
  buildMusicServiceData({ query: 'Coldplay', mediaType: 'service', playerEntityId: 'media_player.zan_media_player' }).data.media_type,
  'track',
  'neznámý media_type spadne na bezpečný default',
);
assert.strictEqual(
  buildMusicServiceData({ query: 'Coldplay', mediaType: 'track', playerEntityId: 'light.kuchyn' }).ok,
  false,
  'cílový player musí být media_player.*',
);

(async () => {
  const calls = [];
  const result = await playMusic({
    input: { query: 'Linkin Park - Numb', media_type: 'track' },
    defaultPlayer: '',
    haGet: async (path) => {
      calls.push(['get', path]);
      if (path === 'states') return states;
      if (path === 'states/media_player.zan_media_player') return { entity_id: 'media_player.zan_media_player', state: 'playing', attributes: { media_title: 'Numb' } };
      throw new Error(`unexpected get ${path}`);
    },
    haPost: async (path, data) => {
      calls.push(['post', path, data]);
      assert.strictEqual(path, 'services/music_assistant/play_media', 'nevolá se obecný call_service ani jiná doména');
      assert.strictEqual(data.entity_id, 'media_player.zan_media_player');
      assert.strictEqual(data.media_id, 'Linkin Park - Numb');
    },
  });
  assert.strictEqual(result.success, true, 'úspěšné volání vrací success');
  assert.strictEqual(result.player_state, 'playing', 'po volání ověří stav playeru');
  assert(VOICE_CONTROL_TOOLS.includes('play_music'), 'hlasový profil obsahuje play_music');
  assert(!VOICE_CONTROL_TOOLS.includes('music_assistant'), 'hlasový profil neotevírá celou doménu');

  const noPlayer = await playMusic({
    input: { query: 'Coldplay' },
    haGet: async () => [],
    haPost: async () => { throw new Error('haPost neměl být volán'); },
  });
  assert.strictEqual(noPlayer.success, false, 'bez playeru nevolá HA službu');
  assert.strictEqual(noPlayer.reason, 'player_missing', 'bez playeru je konkrétní gap');
  assert(noPlayer.next_step.includes('ZAN_MUSIC_PLAYER_ENTITY_ID'), 'bez playeru neskončí holým neumím');

  const switchCalls = [];
  const switched = await playMusic({
    input: { query: 'dechovka', media_type: 'radio', player_entity_id: 'media_player.hrajici' },
    haGet: async (path) => {
      switchCalls.push(['get', path]);
      if (path === 'states') return states;
      if (path === 'states/media_player.hrajici') return { entity_id: 'media_player.hrajici', state: 'playing', attributes: { media_title: 'Dechovka' } };
      throw new Error(`unexpected get ${path}`);
    },
    haPost: async (path, data) => {
      switchCalls.push(['post', path, data]);
      assert.strictEqual(path, 'services/music_assistant/play_media');
      assert.strictEqual(data.entity_id, 'media_player.hrajici');
      assert.strictEqual(data.media_id, 'dechovka');
      assert.strictEqual(data.enqueue, 'replace');
    },
  });
  assert.strictEqual(switched.success, true, 'přepnutí už hrajícího přehrávače volá Music Assistant');
  assert(switchCalls.some(c => c[0] === 'post'), 'nová žádost o jiný obsah není považovaná za už splněnou');

  // --- Robustnost přehrávače (karta 2026-08-16-programator-zana-06) ---
  const okGet = async (path) => {
    if (path === 'states') return states;
    if (path === 'states/media_player.zan_media_player') return { entity_id: 'media_player.zan_media_player', state: 'playing' };
    throw new Error(`unexpected get ${path}`);
  };
  const transient500 = () => { const e = new Error('500'); e.response = { status: 500 }; return e; };
  const httpTimeout = () => { const e = new Error('timeout'); e.code = 'ECONNABORTED'; return e; };
  const badRequest = () => { const e = new Error('400'); e.response = { status: 400 }; return e; };

  // (a) přechodné 500 → 1 retry → druhé selhání = success:false backend_transient, ne fabulace
  let postCalls = 0;
  const trans = await playMusic({
    input: { query: 'Coldplay' }, defaultPlayer: '', sleepMs: 0,
    haGet: okGet,
    haPost: async () => { postCalls += 1; throw transient500(); },
  });
  assert.strictEqual(postCalls, 2, 'přechodná chyba se zkusí právě dvakrát (1 řízený retry)');
  assert.strictEqual(trans.success, false, 'opakované přechodné selhání nefabuluje úspěch');
  assert.strictEqual(trans.confirmed, false, 'neúspěch není confirmed');
  assert.strictEqual(trans.reason, 'backend_transient', 'přechodné selhání má konkrétní důvod');
  assert(trans.next_step && /znovu|Music Assistant/.test(trans.next_step), 'transient neskončí holým neumím');

  // (b) timeout se také bere jako přechodné a retryuje
  let toCalls = 0;
  const to = await playMusic({
    input: { query: 'Coldplay' }, defaultPlayer: '', sleepMs: 0,
    haGet: okGet,
    haPost: async () => { toCalls += 1; throw httpTimeout(); },
  });
  assert.strictEqual(toCalls, 2, 'timeout je přechodná chyba a retryuje');
  assert.strictEqual(to.reason, 'backend_transient', 'timeout klasifikován jako přechodný');

  // (c) 4xx (špatný dotaz) → žádný retry, nezacyklí se
  let badCalls = 0;
  const bad = await playMusic({
    input: { query: 'Coldplay' }, defaultPlayer: '', sleepMs: 0,
    haGet: okGet,
    haPost: async () => { badCalls += 1; throw badRequest(); },
  });
  assert.strictEqual(badCalls, 1, '4xx se neopakuje (retry jen na přechodné chyby)');
  assert.strictEqual(bad.success, false, '4xx nefabuluje úspěch');
  assert.strictEqual(bad.reason, 'backend_error', '4xx má vlastní důvod, ne backend_transient');

  // (d) přechodné selhání pak úspěch na druhý pokus → success bez fabulace neúspěchu
  let recCalls = 0;
  const rec = await playMusic({
    input: { query: 'Coldplay' }, defaultPlayer: '', sleepMs: 0,
    haGet: okGet,
    haPost: async () => { recCalls += 1; if (recCalls === 1) throw transient500(); },
  });
  assert.strictEqual(recCalls, 2, 'po přechodné chybě se druhý pokus provede');
  assert.strictEqual(rec.success, true, 'úspěch na druhý pokus je úspěch');

  // (e) postState po odeslání ukazuje unavailable → success, ale NEfabuluje „Pouštím"
  const deadPost = await playMusic({
    input: { query: 'Coldplay' }, defaultPlayer: '', sleepMs: 0,
    haGet: async (path) => {
      if (path === 'states') return states;
      if (path === 'states/media_player.zan_media_player') return { entity_id: 'media_player.zan_media_player', state: 'unavailable' };
      throw new Error(`unexpected get ${path}`);
    },
    haPost: async () => {},
  });
  assert.strictEqual(deadPost.success, true, 'povel odeslán bez chyby = success');
  assert.strictEqual(deadPost.confirmed, false, 'mrtvý přehrávač po odeslání není potvrzené hraní');
  assert(!/^Pouštím/.test(deadPost.message), 'nefabuluje holé „Pouštím" na unavailable přehrávači');
  assert(/nemusí hrát|ozval se zvuk/.test(deadPost.message), 'poctivá výhrada u mrtvého přehrávače');

  // (f) latence startu (idle) → NEhlásí selhání, ale ani falešné potvrzení
  const idlePost = await playMusic({
    input: { query: 'Coldplay' }, defaultPlayer: '', sleepMs: 0,
    haGet: async (path) => {
      if (path === 'states') return states;
      if (path === 'states/media_player.zan_media_player') return { entity_id: 'media_player.zan_media_player', state: 'idle' };
      throw new Error(`unexpected get ${path}`);
    },
    haPost: async () => {},
  });
  assert.strictEqual(idlePost.success, true, 'idle po odeslání není selhání (latence startu je normální)');
  assert.strictEqual(idlePost.confirmed, false, 'idle není potvrzené hraní');

  // (g) playing → beze změny: potvrzené hraní
  const playingPost = await playMusic({
    input: { query: 'Coldplay' }, defaultPlayer: '', sleepMs: 0,
    haGet: okGet,
    haPost: async () => {},
  });
  assert.strictEqual(playingPost.confirmed, true, 'playing po odeslání = confirmed bez regrese');
  assert(/^Pouštím/.test(playingPost.message), 'potvrzené hraní hlásí „Pouštím"');

  console.log('check-play-music: OK');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
