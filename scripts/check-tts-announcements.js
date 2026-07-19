const assert = require('assert');
const { announceHome, buildTtsSpeakPayload } = require('../tts-announcements');

async function main() {
  const payload = buildTtsSpeakPayload({
    message: 'Večeře je na stole.',
    tts_entity_id: 'tts.piper',
    media_player_entity_id: 'media_player.kuchyn',
    language: 'cs',
  });

  assert.ifError(payload.error);
  assert.strictEqual(payload.path, 'services/tts/speak');
  assert.deepStrictEqual(payload.payload, {
    entity_id: 'tts.piper',
    media_player_entity_id: 'media_player.kuchyn',
    message: 'Večeře je na stole.',
    cache: true,
    language: 'cs',
  });

  assert.strictEqual(buildTtsSpeakPayload({ message: 'Ahoj', tts_entity_id: 'sensor.x', media_player_entity_id: 'media_player.kuchyn' }).error, 'TTS hlas musí být tts.xxx.');
  assert.strictEqual(buildTtsSpeakPayload({ message: 'Ahoj', tts_entity_id: 'tts.piper', media_player_entity_id: 'light.kuchyn' }).error, 'Cíl musí být media_player.xxx.');
  assert.strictEqual(buildTtsSpeakPayload({ message: 'x'.repeat(301), tts_entity_id: 'tts.piper', media_player_entity_id: 'media_player.kuchyn' }).error, 'Oznámení je moc dlouhé, zkrať ho na 300 znaků.');

  const calls = [];
  const result = await announceHome(async (path, data) => calls.push({ path, data }), {
    message: '  Pes   chce ven. ',
    tts_entity_id: 'tts.piper',
    media_player_entity_id: 'media_player.chodba',
    cache: false,
  });

  assert.deepStrictEqual(calls, [{
    path: 'services/tts/speak',
    data: {
      entity_id: 'tts.piper',
      media_player_entity_id: 'media_player.chodba',
      message: 'Pes chce ven.',
      cache: false,
    },
  }]);
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.message, 'Pes chce ven.');

  console.log('check-tts-announcements: PASS');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
