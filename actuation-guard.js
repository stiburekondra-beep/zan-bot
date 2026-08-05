'use strict';

// actuation-guard.js
// Deterministická pojistka proti fabulovanému úspěchu aktuace na NEDOSTUPNÉM
// zařízení. Řeší bug 2026-08-05-programator-zana-03: Žán řekl „Hurá, obě světla
// jsou zapnutá 💡" i na entity, o kterých sám před chvílí řekl, že jsou
// `unavailable` (zbminir2 offline → success report do tmy). Příčina: tool
// turn_on/turn_off/toggle vracel po `haPost` BEZPODMÍNEČNĚ
// { success:true, message:"✅ zapnuto", confirmed:true } — HA REST service-call
// vrací 200 i pro unavailable entitu (služba přijata, zařízení nereaguje).
//
// Fix běží na TOOL VRSTVĚ, ne v system promptu: rozhoduje o reportu podle stavu
// cílové entity ZÍSKANÉHO PO aktuaci. Prompt-only mitigace tuhle třídu neuhlídá —
// LLM „Hurá" protlačí (precedent area-alias-guard.js / pracovna=Dílna). Tady je
// navíc pravda o stavu strojově známá (isUnavailableState), takže se dá guardovat
// deterministicky, ne prosbou k modelu.

// Stavy, které znamenají „zařízení nereaguje / je offline" — nelze na nich
// potvrdit úspěch aktuace.
function isUnavailableStateValue(state) {
  return state === 'unavailable' || state === 'unknown';
}

const VERB_PAST = { turn_on: 'zapnuto', turn_off: 'vypnuto', toggle: 'přepnuto' };

// Vytáhne holý stav z HA state objektu i z holého stringu.
function stateOf(postState) {
  if (postState == null) return null;
  if (typeof postState === 'object') return postState.state;
  return postState;
}

// Rozhodne tvar tool-resultu aktuace podle stavu cílové entity PO aktuaci.
//
// action    : 'turn_on' | 'turn_off' | 'toggle'
// entityId  : string (entity_id cílové entity)
// postState : HA state objekt cílové entity získaný PO aktuaci, holý string stavu,
//             nebo null/undefined když se stav nepodařilo přečíst.
//
// Zásady:
//  - unavailable/unknown PO aktuaci → NEHLÁSIT úspěch, poctivě přiznat nedostupnost.
//  - stav se nepodařilo přečíst → NEházet falešné selhání (success zůstává), ale
//    označit jako neověřený, ať model netvrdí bezvýhradné „hotovo".
//  - jinak → potvrzený úspěch jako dosud.
//
// Vrací tool-result tvar { success, confirmed, message, ... } — přímo návrat toolu.
function evaluateActuation({ action, entityId, postState }) {
  const verb = VERB_PAST[action] || 'provedeno';
  const id = entityId || 'zařízení';

  if (postState === undefined || postState === null) {
    return {
      success: true,
      confirmed: false,
      unverified: true,
      message: `Poslal jsem ${id} příkaz „${verb}", ale nemůžu ověřit výsledek — stav zařízení se nepodařilo načíst.`,
    };
  }

  const state = stateOf(postState);
  if (isUnavailableStateValue(state)) {
    return {
      success: false,
      confirmed: false,
      unavailable: true,
      entity_state: state,
      message: `Zkusil jsem ${id} ${verb}, ale zařízení je ve stavu „${state}" — je nedostupné (offline nebo nereaguje). Nemůžu potvrdit, že se akce provedla.`,
    };
  }

  return { success: true, confirmed: true, message: `✅ ${id} ${verb}` };
}

module.exports = { evaluateActuation, isUnavailableStateValue };
