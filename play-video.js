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

function stateIsUsable(state) {
  return !!state && !['unavailable', 'unknown'].includes(String(state.state || '').toLowerCase());
}

function supportsPlayMedia(state) {
  const feat = Number(state && state.attributes && state.attributes.supported_features) || 0;
  return (feat & 512) === 512; // SUPPORT_PLAY_MEDIA
}

// Kandidát na cast cíl: umí play_media, není to Music Assistant fronta ani
// hlasový satelit. Když jich je víc, nehádáme — chceme explicitní nastavení.
function castCandidates(states) {
  return (Array.isArray(states) ? states : []).filter((s) => {
    if (!s || !String(s.entity_id || '').startsWith('media_player.')) return false;
    if (!stateIsUsable(s) || !supportsPlayMedia(s)) return false;
    const appId = String((s.attributes && s.attributes.app_id) || '').toLowerCase();
    if (MUSIC_APP_IDS.has(appId)) return false;
    if (/voice|assist|satellite/i.test(s.entity_id)) return false;
    return true;
  });
}

function resolveVideoPlayer({ states, requestedPlayer, defaultPlayer }) {
  const requested = normalizeEntityId(requestedPlayer);
  const configured = normalizeEntityId(defaultPlayer);

  for (const entityId of [requested, configured].filter(Boolean)) {
    const state = (Array.isArray(states) ? states : []).find(s => s && s.entity_id === entityId) || null;
    if (stateIsUsable(state)) return { ok: true, entity_id: entityId, source: entityId === requested ? 'requested' : 'configured' };
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
  if (candidates.length === 1) return { ok: true, entity_id: candidates[0].entity_id, source: 'autodetect' };
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
  const sleep = sleepImpl || (ms => new Promise(r => setTimeout(r, ms)));
  let playerState = 'neověřeno';
  let playingTitle = '';
  for (let i = 0; i < 3; i++) {
    await sleep(waitMs);
    const st = await haGet(`states/${player.entity_id}`).catch(() => null);
    if (st) {
      playerState = st.state;
      playingTitle = (st.attributes && st.attributes.media_title) || playingTitle;
      if (['playing', 'buffering'].includes(String(st.state).toLowerCase())) break;
    }
  }

  const confirmed = ['playing', 'buffering'].includes(String(playerState).toLowerCase());
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

module.exports = {
  extractVideoId,
  resolveVideoPlayer,
  buildCastPayload,
  parseSearchHtml,
  searchYouTube,
  playVideo,
};
