function isEntityId(value, domain) {
  const s = String(value || '').trim();
  if (!/^[a-z0-9_]+\.[a-z0-9_]+$/.test(s)) return false;
  return !domain || s.startsWith(`${domain}.`);
}

function normalizeMessage(message) {
  return String(message || '').replace(/\s+/g, ' ').trim();
}

function buildTtsSpeakPayload(input = {}) {
  const message = normalizeMessage(input.message);
  const mediaPlayer = String(input.media_player_entity_id || '').trim();
  const ttsEntity = String(input.tts_entity_id || '').trim();

  if (!message) return { error: 'Chybí text oznámení.' };
  if (message.length > 300) return { error: 'Oznámení je moc dlouhé, zkrať ho na 300 znaků.' };
  if (!isEntityId(mediaPlayer, 'media_player')) return { error: 'Cíl musí být media_player.xxx.' };
  if (!isEntityId(ttsEntity, 'tts')) return { error: 'TTS hlas musí být tts.xxx.' };

  const data = {
    media_player_entity_id: mediaPlayer,
    message,
    cache: input.cache !== false,
  };

  if (input.language) data.language = String(input.language);
  if (input.options && typeof input.options === 'object' && !Array.isArray(input.options)) {
    data.options = input.options;
  }

  return {
    path: 'services/tts/speak',
    payload: {
      entity_id: ttsEntity,
      ...data,
    },
    summary: {
      tts_entity_id: ttsEntity,
      media_player_entity_id: mediaPlayer,
      message,
    },
  };
}

async function announceHome(haPost, input = {}) {
  const built = buildTtsSpeakPayload(input);
  if (built.error) return built;
  await haPost(built.path, built.payload);
  return { success: true, confirmed: true, ...built.summary };
}

module.exports = {
  announceHome,
  buildTtsSpeakPayload,
};
