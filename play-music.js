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

async function playMusic({ input = {}, haGet, haPost, defaultPlayer }) {
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

  await haPost('services/music_assistant/play_media', payload.data);
  const postState = await haGet(`states/${player.entity_id}`).catch(() => null);
  return {
    success: true,
    confirmed: true,
    service: 'music_assistant.play_media',
    query,
    media_type: payload.data.media_type,
    player_entity_id: player.entity_id,
    player_source: player.source,
    player_state: postState ? postState.state : 'neověřeno',
    message: `Pouštím ${query}.`,
  };
}

module.exports = {
  DEFAULT_KNOWN_PLAYER,
  resolveMusicPlayer,
  buildMusicServiceData,
  playMusic,
};
