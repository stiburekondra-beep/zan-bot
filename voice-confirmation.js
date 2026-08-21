'use strict';

// Rutinní hlasová aktuace už po návratu nástroje nepotřebuje druhé kolo LLM.
// Fast-path je úmyslně úzký: právě jeden potvrzený zásah do světla/zásuvky.
// Neověřené, vícenásobné a citlivé akce pokračují normální modelovou cestou.
const PHRASES = {
  turn_on: {
    light: ['Rozsvíceno.', 'Světlo svítí.', 'Hotovo, svítí.'],
    switch: ['Zapnuto.', 'Je to zapnuté.', 'Hotovo, zapnuto.'],
  },
  turn_off: {
    light: ['Zhasnuto.', 'Světlo je zhasnuté.', 'Hotovo, nesvítí.'],
    switch: ['Vypnuto.', 'Je to vypnuté.', 'Hotovo, vypnuto.'],
  },
  toggle: {
    light: ['Přepnuto.', 'Světlo je přepnuté.', 'Hotovo, přepnuto.'],
    switch: ['Přepnuto.', 'Stav je přepnutý.', 'Hotovo, přepnuto.'],
  },
};

function buildVoiceFastConfirmation({ voice, toolExecutions, variantIndex = 0 }) {
  if (!voice || !Array.isArray(toolExecutions)) return null;
  const safeReads = new Set(['get_state', 'get_states', 'get_areas']);
  const actions = toolExecutions.filter(execution => !safeReads.has(execution && execution.name));
  if (actions.length !== 1) return null;
  const execution = actions[0] || {};
  const entityId = execution.input && execution.input.entity_id;
  const domain = typeof entityId === 'string' ? entityId.split('.')[0] : '';
  const phrases = PHRASES[execution.name] && PHRASES[execution.name][domain];
  const result = execution.result;

  if (!phrases || !result || result.success !== true || result.confirmed !== true) return null;
  const index = Math.abs(Number(variantIndex) || 0) % phrases.length;
  return phrases[index];
}

module.exports = { buildVoiceFastConfirmation };
