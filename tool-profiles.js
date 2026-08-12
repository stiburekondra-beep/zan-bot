'use strict';
// ═══════════════════════════════════════════════════════════════════════
// TOOL PROFILY — pojmenované podmnožiny nástrojů podle KANÁLU, ve kterém
// zpráva přišla (zast. 65, research 2026-08-05 §4).
//
// Proč: buildTools() dnes posílá modelu vždy všechno, na co má chat práva
// (~34 pro rodinu, 62 pro admina). Čím víc možností, tím častěji malý model
// sáhne vedle — a hlavně: hlasový kanál potřebuje malý, RYCHLÝ profil.
//
// TVRDÉ pravidlo (prompt cache): profil MUSÍ být stabilní per kanál. Cache
// je prefix-match přes tools + system; kdyby se profil měnil zprávu od
// zprávy, cache se rozbije a provoz zdraží. Hlas má proto VŽDY stejný profil.
// Filtr je deterministický (zachovává původní pořadí pole) → identický
// cache prefix při každé zprávě téhož kanálu.
// ═══════════════════════════════════════════════════════════════════════

// Hlasový / ovládací profil: jen to, co dává smysl mluvenou řečí u satelitu.
// Žádné zápisy (write_package/dashboard), žádná správa domu — hlas NENÍ admin
// (zápisy YAML hlasem stejně nechceme). Podmnožina non-admin sady, takže
// hlasový chat nemusí být admin.
const VOICE_CONTROL_TOOLS = [
  'get_states',
  'get_state',
  'get_areas',
  'turn_on',
  'turn_off',
  'toggle',
  'call_service',
  'schedule_action',
  'announce_home',
  'play_music',
  'play_video',
  'read_cookbook',
];

// Profil → allowlist jmen. null = bez filtru (dnešní sada daného chatu).
const PROFILES = {
  ovladani: VOICE_CONTROL_TOOLS, // hlasový kanál, krátké povely
  rodina: null, // Telegram non-admin: dnešní non-admin sada
  admin: null, // Telegram admin: vše (dnešní stav)
};

// Který profil použít: explicitně vyžádaný kanálem, jinak podle admin gate
// (zpětná kompatibilita — Telegram se chová PŘESNĚ jako dnes).
function resolveProfile(requested, isAdmin) {
  if (requested && Object.prototype.hasOwnProperty.call(PROFILES, requested)) return requested;
  return isAdmin ? 'admin' : 'rodina';
}

// Filtr nad HOTOVÝM polem nástrojů. null allowlist → beze změny.
// Zachovává pořadí vstupního pole (deterministické, cache-stabilní).
function filterToolsByProfile(tools, profile) {
  const allow = PROFILES[profile];
  if (!allow) return tools;
  const allowSet = new Set(allow);
  return tools.filter((t) => t && allowSet.has(t.name));
}

module.exports = { PROFILES, VOICE_CONTROL_TOOLS, resolveProfile, filterToolsByProfile };
