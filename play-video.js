'use strict';

// ═══════════════════════════════════════════════════════════════════════
// PLAY_VIDEO — pustí YouTube video na Chromecast/TV přes Home Assistant.
//
// Proč zvlášť od play-music: hudba jde přes Music Assistant (audio fronta),
// tohle posílá na Chromecast NATIVNÍ YouTube receiver (special cast app),
// tedy obraz na televizi. Music Assistant tohle neumí — jeho YouTube Music
// provider je jen audio katalog.
//
// Payload je záměrně úzký: jen media_player.play_media s media_content_type
// 'cast' a app_name 'youtube'. Žádný obecný call_service.
//
// Účet / Premium: cast z HA otevře YouTube receiver pod účtem, který je
// přihlášený na TV zařízení. HA žádné přihlášení nepředává a Žán nikdy
// nepracuje s Google cookie ani heslem.
// ═══════════════════════════════════════════════════════════════════════

const VIDEO_ID_RE = /^[a-zA-Z0-9_-]{11}$/;
const MUSIC_APP_IDS = new Set(['music_assistant']);

function normalizeQuery(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, 160);
}

function normalizeEntityId(value) {
  const s = String(value || '').trim();
  return s.startsWith('media_player.') ? s : '';
}

// Přijme přímé ID, youtu.be/ID, watch?v=ID, /shorts/ID, /embed/ID.
function extractVideoId(value) {
  const s = String(value || '').trim();
  if (!s) return '';
  if (VIDEO_ID_RE.test(s)) return s;
  const patterns = [
    /[?&]v=([a-zA-Z0-9_-]{11})/,
    /youtu\.be\/([a-zA-Z0-9_-]{11})/,
    /\/shorts\/([a-zA-Z0-9_-]{11})/,
    /\/embed\/([a-zA-Z0-9_-]{11})/,
  ];
  for (const re of patterns) {
    const m = s.match(re);
    if (m) return m[1];
  }
  return '';
}

function isYouTubeApp(app) {
  const s = String(app || '').toLowerCase();
  return s.includes('youtube') || s === '233637de'; // cast app ID YouTube receiveru
}

function stateIsUsable(state) {
  return !!state && !['unavailable', 'unknown'].includes(String(state.state || '').toLowerCase());
}

function supportsPlayMedia(state) {
  const feat = Number(state && state.attributes && state.attributes.supported_features) || 0;
  return (feat & 512) === 512; // SUPPORT_PLAY_MEDIA
}

// Cast-schopná obrazovka: umí play_media, není to Music Assistant fronta ani
// hlasový satelit. POZOR: platí i na cíl, který si vyžádal model — jinak
// pošle cast payload do MA fronty a z „videa" vyleze zvuk (stalo se 2026-08-12,
// play_video -> media_player.living_room_tv, což je MA entita).
function isCastCapable(state) {
  if (!state || !String(state.entity_id || '').startsWith('media_player.')) return false;
  if (!stateIsUsable(state) || !supportsPlayMedia(state)) return false;
  const appId = String((state.attributes && state.attributes.app_id) || '').toLowerCase();
  if (MUSIC_APP_IDS.has(appId)) return false;
  if (/voice|assist|satellite/i.test(state.entity_id)) return false;
  return true;
}

function castCandidates(states) {
  return (Array.isArray(states) ? states : []).filter(isCastCapable);
}

function resolveVideoPlayer({ states, requestedPlayer, defaultPlayer }) {
  const requested = normalizeEntityId(requestedPlayer);
  const configured = normalizeEntityId(defaultPlayer);
  const rejected = [];

  for (const entityId of [requested, configured].filter(Boolean)) {
    const state = (Array.isArray(states) ? states : []).find(s => s && s.entity_id === entityId) || null;
    if (stateIsUsable(state) && !isCastCapable(state)) {
      // Existuje, ale na video se nehodí (typicky Music Assistant fronta) —
      // nepoužít a zkusit další v pořadí, ne poslat video do zvukové fronty.
      rejected.push(entityId);
      continue;
    }
    if (stateIsUsable(state)) {
      return {
        ok: true,
        entity_id: entityId,
        source: entityId === requested ? 'requested' : 'configured',
        ...(rejected.length ? { rejected_players: rejected } : {}),
      };
    }
    if (state) {
      return {
        ok: false,
        reason: 'player_unavailable',
        entity_id: entityId,
        state: state.state,
        next_step: `Televize ${entityId} je ${state.state}; zapni ji nebo nastav jiný ZAN_VIDEO_PLAYER_ENTITY_ID.`,
      };
    }
  }

  const candidates = castCandidates(states);
  if (candidates.length === 1) {
    return {
      ok: true,
      entity_id: candidates[0].entity_id,
      source: 'autodetect',
      ...(rejected.length ? { rejected_players: rejected } : {}),
    };
  }
  if (candidates.length > 1) {
    return {
      ok: false,
      reason: 'player_ambiguous',
      candidates: candidates.map(c => c.entity_id),
      next_step: `Vidím víc obrazovek (${candidates.map(c => c.entity_id).join(', ')}); řekni kterou, nebo nastav ZAN_VIDEO_PLAYER_ENTITY_ID.`,
    };
  }
  return {
    ok: false,
    reason: 'player_missing',
    next_step: 'Nemám v Home Assistantu žádnou televizi s Google Cast; přidej integraci Google Cast a vyplň ZAN_VIDEO_PLAYER_ENTITY_ID.',
  };
}

function buildCastPayload({ videoId, playerEntityId }) {
  const id = String(videoId || '').trim();
  if (!VIDEO_ID_RE.test(id)) return { ok: false, error: 'Neplatné ID YouTube videa.' };
  const player = normalizeEntityId(playerEntityId);
  if (!player) return { ok: false, error: 'Cílová obrazovka musí být media_player.*.' };
  return {
    ok: true,
    data: {
      entity_id: player,
      media_content_type: 'cast',
      media_content_id: JSON.stringify({ app_name: 'youtube', media_id: id }),
    },
  };
}

// Oficiální Data API, když je klíč; jinak veřejná stránka výsledků.
// Scrape je fallback, ne hlavní cesta — kdyby se rozbil, hlásíme to nahlas.
function parseSearchHtml(html) {
  const re = /"videoRenderer":\{"videoId":"([a-zA-Z0-9_-]{11})".{0,600}?"title":\{"runs":\[\{"text":"(.*?)"\}/g;
  const m = re.exec(String(html || ''));
  if (!m) return null;
  let title = m[2];
  try { title = JSON.parse(`"${m[2]}"`); } catch { /* ponech syrový text */ }
  return { videoId: m[1], title };
}

async function searchYouTube({ query, apiKey, fetchImpl }) {
  const q = normalizeQuery(query);
  if (!q) return { ok: false, reason: 'empty_query', next_step: 'Řekni, co mám na televizi pustit.' };
  const doFetch = fetchImpl || globalThis.fetch;

  if (apiKey) {
    const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&maxResults=1&regionCode=CZ&relevanceLanguage=cs&q=${encodeURIComponent(q)}&key=${encodeURIComponent(apiKey)}`;
    try {
      const r = await doFetch(url);
      if (r.ok) {
        const j = await r.json();
        const item = j && Array.isArray(j.items) ? j.items[0] : null;
        if (item && item.id && item.id.videoId) {
          return { ok: true, videoId: item.id.videoId, title: (item.snippet && item.snippet.title) || q, source: 'data_api' };
        }
        return { ok: false, reason: 'no_results', next_step: `Na YouTube jsem k „${q}" nic nenašel; zkus to říct jinak.` };
      }
    } catch { /* spadni na scrape */ }
  }

  try {
    const r = await doFetch(`https://www.youtube.com/results?search_query=${encodeURIComponent(q)}&hl=cs&gl=CZ`, {
      headers: {
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        'accept-language': 'cs-CZ,cs;q=0.9',
      },
    });
    if (!r.ok) return { ok: false, reason: 'search_failed', next_step: 'YouTube mi teď neodpověděl; zkus to za chvíli znovu.' };
    const hit = parseSearchHtml(await r.text());
    if (!hit) return { ok: false, reason: 'no_results', next_step: `Na YouTube jsem k „${q}" nic nenašel; zkus to říct jinak.` };
    return { ok: true, videoId: hit.videoId, title: hit.title, source: 'scrape' };
  } catch (e) {
    return { ok: false, reason: 'search_failed', next_step: 'Na YouTube jsem se teď nedostal; zkus to za chvíli znovu.' };
  }
}

async function playVideo({ input = {}, haGet, haPost, defaultPlayer, apiKey, fetchImpl, sleepImpl, waitMs = 3000 }) {
  const query = normalizeQuery(input.query);
  if (!query) {
    return { success: false, error: 'Chybí, co mám pustit.', next_step: 'Řekni název videa, třeba „traktory v blátě".' };
  }

  const states = await haGet('states');
  const player = resolveVideoPlayer({ states, requestedPlayer: input.player_entity_id, defaultPlayer });
  if (!player.ok) {
    return {
      success: false,
      error: 'Nemám ověřenou obrazovku pro video.',
      reason: player.reason,
      entity_id: player.entity_id,
      state: player.state,
      next_step: player.next_step,
    };
  }

  const direct = extractVideoId(input.video_id || query);
  let title = query;
  let videoId = direct;
  let searchSource = 'direct';
  if (!videoId) {
    const found = await searchYouTube({ query, apiKey, fetchImpl });
    if (!found.ok) {
      return { success: false, error: 'Video jsem nenašel.', reason: found.reason, next_step: found.next_step };
    }
    videoId = found.videoId;
    title = found.title;
    searchSource = found.source;
  }

  const payload = buildCastPayload({ videoId, playerEntityId: player.entity_id });
  if (!payload.ok) return { success: false, error: payload.error };

  await haPost('services/media_player/play_media', payload.data);

  // Ověření, ne domněnka: Chromecast chvíli bufferuje, tak se ptáme víckrát.
  // Nestačí „playing" — na téže entitě může hrát něco úplně jiného (Music
  // Assistant). Úspěch = běží YouTube app.
  const sleep = sleepImpl || (ms => new Promise(r => setTimeout(r, ms)));
  let playerState = 'neověřeno';
  let playingTitle = '';
  let runningApp = '';
  for (let i = 0; i < 3; i++) {
    await sleep(waitMs);
    const st = await haGet(`states/${player.entity_id}`).catch(() => null);
    if (st) {
      playerState = st.state;
      const attrs = st.attributes || {};
      playingTitle = attrs.media_title || playingTitle;
      runningApp = attrs.app_name || attrs.app_id || runningApp;
      const playing = ['playing', 'buffering'].includes(String(st.state).toLowerCase());
      if (playing && isYouTubeApp(runningApp)) break;
    }
  }

  const isPlaying = ['playing', 'buffering'].includes(String(playerState).toLowerCase());
  const confirmed = isPlaying && isYouTubeApp(runningApp);
  if (isPlaying && !confirmed) {
    return {
      success: false,
      confirmed: false,
      reason: 'wrong_app',
      error: 'Na obrazovce neběží YouTube.',
      video_id: videoId,
      player_entity_id: player.entity_id,
      player_state: playerState,
      running_app: runningApp || 'neznámá',
      next_step: `Na ${player.entity_id} běží ${runningApp || 'jiná aplikace'}, ne YouTube — vypni, co tam hraje (typicky hudba z Music Assistantu), a zkus to znovu.`,
      message: `Video se mi na televizi nepodařilo pustit — běží tam ${runningApp || 'něco jiného'} místo YouTube.`,
    };
  }
  return {
    success: true,
    confirmed,
    service: 'media_player.play_media',
    query,
    video_id: videoId,
    video_title: playingTitle || title,
    search_source: searchSource,
    player_entity_id: player.entity_id,
    player_source: player.source,
    player_state: playerState,
    message: confirmed
      ? `Pouštím na televizi: ${playingTitle || title}.`
      : `Poslal jsem na televizi ${playingTitle || title}, ale zatím hlásí stav ${playerState}. Zkontroluj, jestli je televize zapnutá na správném vstupu.`,
  };
}

// ── Ovládání toho, co na televizi běží ───────────────────────────────
// Cast entita v labu umí PAUSE/PLAY/STOP/VOLUME_SET/MUTE, ale NE VOLUME_STEP —
// „hlasitěji/tišeji" se proto počítá z aktuální hlasitosti a posílá jako
// absolutní volume_set.
const VIDEO_ACTIONS = new Set(['pause', 'resume', 'stop', 'volume', 'volume_up', 'volume_down', 'mute', 'unmute']);
const VOLUME_STEP = 0.1;

function clampVolume(v) {
  return Math.min(1, Math.max(0, Math.round(v * 100) / 100));
}

function buildControlCall({ action, volumePercent, currentVolume }) {
  const a = String(action || '').trim();
  if (!VIDEO_ACTIONS.has(a)) return { ok: false, error: `Neznámý povel pro televizi: ${action}.` };
  const cur = Number.isFinite(Number(currentVolume)) ? Number(currentVolume) : 0.5;

  if (a === 'pause') return { ok: true, service: 'media_player/media_pause', data: {} };
  if (a === 'resume') return { ok: true, service: 'media_player/media_play', data: {} };
  if (a === 'stop') return { ok: true, service: 'media_player/media_stop', data: {} };
  if (a === 'mute') return { ok: true, service: 'media_player/volume_mute', data: { is_volume_muted: true } };
  if (a === 'unmute') return { ok: true, service: 'media_player/volume_mute', data: { is_volume_muted: false } };

  if (a === 'volume') {
    const pct = Number(volumePercent);
    if (!Number.isFinite(pct)) return { ok: false, error: 'Chybí hlasitost v procentech.' };
    return { ok: true, service: 'media_player/volume_set', data: { volume_level: clampVolume(pct / 100) } };
  }
  const next = clampVolume(cur + (a === 'volume_up' ? VOLUME_STEP : -VOLUME_STEP));
  return { ok: true, service: 'media_player/volume_set', data: { volume_level: next } };
}

async function controlVideo({ input = {}, haGet, haPost, defaultPlayer, sleepImpl, waitMs = 1500 }) {
  const states = await haGet('states');
  const player = resolveVideoPlayer({ states, requestedPlayer: input.player_entity_id, defaultPlayer });
  if (!player.ok) {
    return { success: false, error: 'Nemám ověřenou obrazovku.', reason: player.reason, next_step: player.next_step };
  }
  const before = (Array.isArray(states) ? states : []).find(s => s && s.entity_id === player.entity_id) || {};
  const call = buildControlCall({
    action: input.action,
    volumePercent: input.volume_percent,
    currentVolume: before.attributes && before.attributes.volume_level,
  });
  if (!call.ok) return { success: false, error: call.error };

  await haPost(`services/${call.service}`, { entity_id: player.entity_id, ...call.data });

  const sleep = sleepImpl || (ms => new Promise(r => setTimeout(r, ms)));
  await sleep(waitMs);
  const after = await haGet(`states/${player.entity_id}`).catch(() => null);
  const vol = after && after.attributes ? after.attributes.volume_level : null;
  const volPct = Number.isFinite(Number(vol)) ? Math.round(Number(vol) * 100) : null;
  return {
    success: true,
    confirmed: !!after,
    action: input.action,
    player_entity_id: player.entity_id,
    player_state: after ? after.state : 'neověřeno',
    volume_percent: volPct,
    message: /^volume/.test(String(input.action))
      ? `Hlasitost televize je na ${volPct != null ? volPct : '?'} procentech.`
      : `Televize: ${after ? after.state : 'neověřeno'}.`,
  };
}

// Jednoznačný povel "pusť tohle na televizi / na youtube / video" — rozkaz
// (ne dotaz) + cíl obrazovka. Používá bot.js k vynucení nástroje v prvním
// kole agentické smyčky, aby model nemohl odpovědět "hotovo" bez akce.
const VIDEO_ORDER = /(?<![\p{L}])(pusť|pust|spusť|spust|přehraj|prehraj|hoď|hod|dej)\p{L}*/iu;
const VIDEO_TARGET = /(youtube|youtub|na\s+telev|na\s+telc|na\s+telk|na\s+tv\b|televiz\p{L}*|video|videj?ko)/iu;
// Ovládání běžící obrazovky — stejný nástroj (action), takže se vynucuje taky.
// „vypni televizi" schválně NENÍ mezi nimi: to je turn_off, ne ovládání videa.
const VIDEO_CONTROL_ORDER = /(?<![\p{L}])(ztlum|ztiš|ztis|zesil|zeslab|zeslabuj|pauzni|pauza|zapauzuj|zastav|stopni|nastav\s+hlasitost|dej\s+hlasitost|hlasitost)\p{L}*/iu;

function requiresVideoTool(text) {
  const s = String(text || '');
  if (/\?\s*$/.test(s.trim())) return false; // otázka není rozkaz
  if (/vypni/i.test(s) && !/zvuk|hlasitost/i.test(s)) return false; // "vypni televizi" = turn_off
  if (!VIDEO_TARGET.test(s)) return false;
  return VIDEO_ORDER.test(s) || VIDEO_CONTROL_ORDER.test(s);
}

module.exports = {
  requiresVideoTool,
  isYouTubeApp,
  buildControlCall,
  controlVideo,
  extractVideoId,
  resolveVideoPlayer,
  buildCastPayload,
  parseSearchHtml,
  searchYouTube,
  playVideo,
};
