'use strict';

function buildPairingNotification({ phase, category, handler, checkAfterSeconds, instruction, verifyTool }) {
  const safePhase = String(phase || 'needs_action');
  const safeCategory = String(category || 'device');
  const safeHandler = handler ? String(handler) : null;
  const safeCheckAfter = Number.isFinite(Number(checkAfterSeconds))
    ? Math.max(10, Math.round(Number(checkAfterSeconds)))
    : null;

  return {
    proactive: true,
    phase: safePhase,
    category: safeCategory,
    handler: safeHandler,
    instruction: String(instruction || '').trim() || null,
    verify_tool: verifyTool || 'get_new_entities',
    check_after_seconds: safeCheckAfter,
    rule: 'Žán má aktivně oznámit stav a další krok. Nesmí říct hotovo, dokud ověřovací nástroj nepotvrdí novou entitu nebo úspěšný flow.',
  };
}

function buildPairingReminderMessage({ backend, duration, verifyTool = 'get_new_entities' }) {
  const label = backend ? ` (${backend})` : '';
  return `Párovací okno${label} doběhlo. Teď zkontroluju nová zařízení přes ${verifyTool}; pokud nic nového neuvidím, řeknu konkrétní další krok místo čekání na tvoje doptání.`;
}

module.exports = { buildPairingNotification, buildPairingReminderMessage };
