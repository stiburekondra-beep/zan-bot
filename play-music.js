'use strict';

const DEFAULT_KNOWN_PLAYER = 'media_player.zan_media_player';
const ALLOWED_MEDIA_TYPES = new Set(['track', 'artist', 'album', 'playlist', 'radio']);

function normalizeEntityId(value) {
  const s = String(value || '').trim();
  if (!s) return '';
  return s.startsWith('media_player.') ? s : '';
}

function normalizeQuery(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, 160);
}

function findState(states, entityId) {
  return (Array.isArray(states) ? states : []).find(s => s && s.entity_id === entityId) || null;
}

function stateIsUsable(state) {
  return !!state && !['unavailable', 'unknown'].includes(String(state.state || '').toLowerCase());
}

function resolveMusicPlayer({ states, requestedPlayer, defaultPlayer }) {
  const requested = normalizeEntityId(requestedPlayer);
  const configured = normalizeEntityId(defaultPlayer);
  const candidates = [requested, configured, DEFAULT_KNOWN_PLAYER].filter(Boolean);

  for (const entityId of candidates) {
    const state = findState(states, entityId);
    if (stateIsUsable(state)) return { ok: true, entity_id: entityId, source: entityId === requested ? 'requested' : entityId === configured ? 'configured' : 'known_default' };
    if (state && !stateIsUsable(state)) {
      return {
        ok: false,
        reason: 'player_unavailable',
        entity_id: entityId,
        state: state.state,
        next_step: `Přehrávač ${entityId} existuje, ale je ${state.state}; zapni ho nebo nastav jiný ZAN_MUSIC_PLAYER_ENTITY_ID.`,
      };
    }
  }

  return {
    ok: false,
    reason: 'player_missing',
    next_step: `Potřebuju nastavit Music Assistant přehrávač, například ${DEFAULT_KNOWN_PLAYER}, nebo vyplnit ZAN_MUSIC_PLAYER_ENTITY_ID v add-onu.`,
  };
}

function buildMusicServiceData({ query, mediaType, playerEntityId }) {
  const q = normalizeQuery(query);
  if (!q) return { ok: false, error: 'Chybí, co mám pustit.' };
  const mt = ALLOWED_MEDIA_TYPES.has(String(mediaType || '').trim()) ? String(mediaType).trim() : 'track';
  const player = normalizeEntityId(playerEntityId);
  if (!player) return { ok: false, error: 'Cílový přehrávač musí být media_player.*.' };
  return {
    ok: true,
    data: {
      entity_id: player,
      media_id: q,
      media_type: mt,
      enqueue: 'replace',
    },
  };
}

// Rozliší přechodnou chybu backendu (retryovat) od trvalé (neopakovat).
// 5xx server error a 429 rate limit jsou přechodné; 4xx (špatný dotaz) ne,
// aby se nezacyklila legitimní chyba typu „nenašel jsem skladbu". Žádná HTTP
// odpověď (síť/timeout: ECONNABORTED, ETIMEDOUT, ECONNRESET…) = přechodné.
function isTransientHaError(err) {
  if (!err) return false;
  const status = err.response && err.response.status;
  if (typeof status === 'number') return status >= 500 || status === 429;
  return true;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function playMusic({ input = {}, haGet, haPost, defaultPlayer, sleepMs = 400 }) {
  const query = normalizeQuery(input.query);
  if (!query) {
    return {
      success: false,
      error: 'Chybí, co mám pustit.',
      next_step: 'Řekni název interpreta, skladby nebo playlistu.',
    };
  }

  const states = await haGet('states');
  const player = resolveMusicPlayer({
    states,
    requestedPlayer: input.player_entity_id,
    defaultPlayer,
  });
  if (!player.ok) {
    return {
      success: false,
      error: 'Nemám ověřený Music Assistant přehrávač.',
      reason: player.reason,
      entity_id: player.entity_id,
      state: player.state,
      next_step: player.next_step,
    };
  }

  const payload = buildMusicServiceData({
    query,
    mediaType: input.media_type,
    playerEntityId: player.entity_id,
  });
  if (!payload.ok) {
    return { success: false, error: payload.error };
  }

  // Odeslání povelu s 1 řízeným retry POUZE na přechodnou chybu backendu (500/timeout).
  // haPost voláme s retries:0 (vypnutý vnitřní retry), opakování řídíme tady deterministicky;
  // na 4xx neopakujeme, ať se nezacyklí legitimní „nenašel jsem skladbu".
  let sendErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await haPost('services/music_assistant/play_media', payload.data, 0);
      sendErr = null;
      break;
    } catch (e) {
      sendErr = e;
      if (!isTransientHaError(e) || attempt === 1) break;
      await sleep(sleepMs);
    }
  }
  if (sendErr) {
    const transient = isTransientHaError(sendErr);
    return {
      success: false,
      confirmed: false,
      reason: transient ? 'backend_transient' : 'backend_error',
      error: transient
        ? 'Přehrávač teď nereaguje (dočasná chyba přehrávače).'
        : 'Povel k přehrání se nepodařilo odeslat.',
      query,
      player_entity_id: player.entity_id,
      next_step: transient
        ? 'Zkus to prosím za chvíli znovu; pokud to bude přetrvávat, prověřím Music Assistant.'
        : 'Prověřím nastavení Music Assistantu; zkus jiný dotaz nebo přehrávač.',
    };
  }

  // Nefabulovat úspěch: „hraje" potvrdíme jen když to přehrávač po odeslání skutečně
  // hlásí (playing/buffering). Krátká latence startu je normální (idle/paused/nečitelný
  // stav) → povel odeslán, ale confirmed:false, žádné falešné selhání. Mrtvý přehrávač
  // (unavailable/unknown/off) → poctivá výhrada místo holého „Pouštím".
  const postState = await haGet(`states/${player.entity_id}`).catch(() => null);
  const rawState = postState ? String(postState.state || '') : '';
  const s = rawState.toLowerCase();
  const started = s === 'playing' || s === 'buffering';
  const dead = s === 'unavailable' || s === 'unknown' || s === 'off';
  let message;
  if (started) {
    message = `Pouštím ${query}.`;
  } else if (dead) {
    message = `Poslal jsem povel pustit ${query}, ale přehrávač je teď ${rawState} — nemusí hrát. Řekni, jestli se ozval zvuk.`;
  } else {
    message = `Pustil jsem ${query}.`;
  }
  return {
    success: true,
    confirmed: started,
    service: 'music_assistant.play_media',
    query,
    media_type: payload.data.media_type,
    player_entity_id: player.entity_id,
    player_source: player.source,
    player_state: postState ? postState.state : 'neověřeno',
    message,
  };
}

module.exports = {
  DEFAULT_KNOWN_PLAYER,
  resolveMusicPlayer,
  buildMusicServiceData,
  playMusic,
};
