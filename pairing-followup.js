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

// Fallback text naplánované kontrolní zprávy. Použije se JEN když se reálná
// kontrola nových entit při doběhnutí okna nepovede (chyba HA) — proto nesmí
// slibovat autonomní akci, kterou mechanismus v tu chvíli neprovede
// (dřív tvrdil „Teď zkontroluju…", ale message-akce jen odešle text = fabulace
// follow-through). Poctivá pobídka místo slibu.
function buildPairingReminderMessage({ backend, duration } = {}) {
  const label = backend ? ` (${backend})` : '';
  return `Párovací okno${label} doběhlo. Napiš „zkontroluj“ a hned se podívám na nová zařízení, nebo párování spusť znovu.`;
}

// Suffix za hlášku „párování zapnuto" u zigbee_permit_join. Větví se podle toho,
// jestli se kontrolní zpráva REÁLNĚ naplánovala — bez toho by Žán sliboval
// „sám se ozvu", i když follow-up scheduling selhal (fronta plná / zápis).
function pairingFollowupSuffix(scheduled) {
  if (scheduled) {
    return ' Aktivuj teď párování na zařízení; po doběhnutí okna se sám ozvu a zkontroluju nová zařízení.';
  }
  return ' Aktivuj teď párování na zařízení a napiš „zkontroluj“ — samočinnou kontrolu se mi teď nepodařilo naplánovat, tak mě prosím pobídni.';
}

// Domény, které get_new_entities záměrně ignoruje (šum, ne nová zařízení).
const PAIRING_CHECK_IGNORE = ['zone', 'sun', 'device_tracker', 'update', 'person', 'persistent_notification'];

// REÁLNÁ kontrola nových entit po doběhnutí párovacího okna. Čistá logika
// (states − known baseline), závislosti se injektují → testovatelné bez HA.
// Aktualizuje baseline, aby se stejné zařízení nehlásilo dvakrát.
async function runPairingCheck({ haGet, getKnown, setKnown }) {
  const states = await haGet('states');
  const known = (typeof getKnown === 'function' ? getKnown() : null) || [];
  const all = (Array.isArray(states) ? states : [])
    .filter(s => s && s.entity_id && !PAIRING_CHECK_IGNORE.some(d => s.entity_id.startsWith(d + '.')))
    .map(s => s.entity_id);
  const newEntities = all.filter(e => !known.includes(e));
  if (typeof setKnown === 'function') setKnown(all);
  const entities = [];
  for (const e of newEntities.slice(0, 20)) {
    let name = e;
    try {
      const s = await haGet(`states/${e}`);
      name = (s && s.attributes && s.attributes.friendly_name) || e;
    } catch { /* název je bonus, ne blocker */ }
    entities.push({ entity_id: e, name });
  }
  return { count: newEntities.length, entities };
}

// Baseline pro runPairingCheck: PREFERUJ zmražený snapshot z DOBY NAPLÁNOVÁNÍ
// (action.known_snapshot), ne živé memory.known_entities. Živý baseline mezitím
// přepíše periodická pollStates smyčka (à 5 min) a absorbuje právě spárované
// zařízení → kontrola by ho po ~75 s okně už neviděla (race sc.65, ~25 % párování).
// Snapshot je zmražený v naplánované akci, takže je proti tomu imunní. Fallback
// na živý baseline drží zpětnou kompatibilitu se starými akcemi bez snapshotu.
function resolvePairingBaseline(action, liveKnown) {
  if (action && Array.isArray(action.known_snapshot)) return action.known_snapshot;
  return Array.isArray(liveKnown) ? liveKnown : [];
}

// Zpráva z VÝSLEDKU reálné kontroly (ne slib). Nikdy netvrdí „hotovo/přidal
// jsem" — jen co kontrola našla + konkrétní další krok.
function buildPairingCheckMessage({ backend, count, entities = [] } = {}) {
  const label = backend ? ` (${backend})` : '';
  if (count > 0) {
    const names = entities.slice(0, 5).map(e => e.name || e.entity_id).join(', ');
    const more = count > entities.length ? ` a dalších ${count - entities.length}` : '';
    return `Párovací okno${label} doběhlo — zkontroloval jsem to a přibylo ${count} nové zařízení: ${names}${more}. Chceš je pojmenovat a zařadit do místnosti?`;
  }
  return `Párovací okno${label} doběhlo — zkontroloval jsem nová zařízení, ale žádné zatím nevidím. Ověř, že je zařízení v párovacím režimu, a napiš „zkontroluj“ — spustím kontrolu znovu.`;
}

module.exports = {
  buildPairingNotification,
  buildPairingReminderMessage,
  pairingFollowupSuffix,
  runPairingCheck,
  resolvePairingBaseline,
  buildPairingCheckMessage,
};
