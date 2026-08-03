const ALLOWED_SIGNALS = ['fall', 'long_inactivity', 'sos', 'activity'];
const RAW_DATA_BLOCKLIST = [
  'heart_rate',
  'hrv',
  'sleep',
  'spo2',
  'blood_pressure',
  'raw_health',
  'health_trend',
  'diagnosis',
  'medical',
];
const MEDICAL_WORDS = [
  'diagnóza',
  'diagnoza',
  'nemoc',
  'lékař',
  'lekar',
  'zdravotní stav',
  'zdravotni stav',
  'prevence',
  'infarkt',
  'srdce',
  'saturace',
  'tep',
  'tlak',
];

function normalizeText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function normalizeSignal(signal) {
  const s = normalizeText(signal).replace(/[-\s]+/g, '_');
  if (['pad', 'fall_detected'].includes(s)) return 'fall';
  if (['dlouha_necinnost', 'necinnost', 'no_motion', 'inactivity'].includes(s)) return 'long_inactivity';
  if (['sos_button', 'panic', 'help'].includes(s)) return 'sos';
  if (['aktivita', 'motion', 'movement'].includes(s)) return 'activity';
  return s;
}

function publicSignal(signal) {
  const normalized = normalizeSignal(signal);
  return ALLOWED_SIGNALS.includes(normalized) ? normalized : null;
}

function consentIsActive(consent = {}) {
  return consent.enabled === true
    && String(consent.subject || '').trim().length > 0
    && String(consent.recipient || '').trim().length > 0
    && consent.explained_at
    && consent.accepted_at
    && !consent.revoked_at;
}

function buildConsentState(input = {}) {
  const action = String(input.action || 'status').toLowerCase();
  const current = input.current && typeof input.current === 'object' ? input.current : {};
  const next = { ...current };

  if (action === 'enable') {
    const subject = String(input.subject || current.subject || '').trim();
    const recipient = String(input.recipient || current.recipient || '').trim();
    const explainedAt = input.explained_at || new Date().toISOString();
    if (!subject || !recipient) {
      return {
        ok: false,
        error: 'Souhlas nejde zapnout bez subjektu údajů a konkrétního příjemce.',
        consent: current,
      };
    }
    return {
      ok: true,
      consent: {
        enabled: true,
        subject,
        recipient,
        allowed_signals: ALLOWED_SIGNALS,
        explained_at: explainedAt,
        accepted_at: input.accepted_at || explainedAt,
        revoked_at: null,
        disclaimer: 'Doplňková notifikace rodině, není to náhrada tísňové linky ani lékaře.',
      },
    };
  }

  if (action === 'disable') {
    return {
      ok: true,
      consent: {
        ...next,
        enabled: false,
        revoked_at: input.revoked_at || new Date().toISOString(),
      },
    };
  }

  return {
    ok: true,
    consent: next,
    active: consentIsActive(next),
  };
}

function validateCareRule(rule = {}) {
  const signal = publicSignal(rule.signal);
  const errors = [];
  const warnings = [];
  const source = String(rule.source || '').trim();
  const message = String(rule.message || '');
  const rawData = Array.isArray(rule.raw_data) ? rule.raw_data.map(normalizeText) : [];
  const messageNorm = normalizeText(message);
  const medicalScanText = messageNorm
    .replace(/neni to nahrada tisnove linky ani lekare/g, '')
    .replace(/neni to nahrada tisnove pece ani lekare/g, '');

  if (!signal) errors.push('Pravidlo smí sdílet jen odvozené signály: pád, dlouhá nečinnost, SOS nebo aktivita.');
  if (!source) errors.push('Pravidlo musí mít konkrétní senzor/helper jako zdroj.');
  const blockedRaw = rawData.filter(item => RAW_DATA_BLOCKLIST.some(blocked => item.includes(blocked)));
  if (blockedRaw.length) errors.push(`Surová zdravotní data nesmí opustit dům: ${blockedRaw.join(', ')}.`);
  const medicalWords = MEDICAL_WORDS.filter(word => medicalScanText.includes(normalizeText(word)));
  if (medicalWords.length) errors.push('Text notifikace nesmí dělat zdravotní tvrzení ani diagnostiku.');
  if (signal === 'fall' && !messageNorm.includes('neni to nahrada tisnove linky') && !messageNorm.includes('neni to nahrada tisnove pece')) {
    warnings.push('U pádu musí výsledná komunikace nést disclaimer: doplněk, ne tísňová linka ani lékař.');
  }

  return {
    ok: errors.length === 0,
    signal,
    errors,
    warnings,
    safe_payload: errors.length === 0 ? {
      signal,
      source,
      recipient: rule.recipient || null,
      message: message || defaultMessageForSignal(signal),
      shares_raw_data: false,
    } : null,
  };
}

function defaultMessageForSignal(signal) {
  const s = publicSignal(signal);
  if (s === 'fall') return 'Žán zachytil možný pád. Je to doplňková notifikace rodině, ne náhrada tísňové linky ani lékaře.';
  if (s === 'long_inactivity') return 'Žán vidí dlouhou nečinnost. Prosím koukni, jestli je všechno v pořádku.';
  if (s === 'sos') return 'Žán dostal SOS požadavek o pomoc.';
  if (s === 'activity') return 'U dědy je zaznamenaná běžná aktivita.';
  return 'Žán má pečovatelský signál ke kontrole.';
}

function evaluateCareEvent(input = {}) {
  const consent = input.consent || {};
  const ruleCheck = validateCareRule(input.rule || input);
  if (!ruleCheck.ok) {
    return {
      action: 'blocked',
      reason: 'unsafe_rule',
      rule: ruleCheck,
      notification: null,
    };
  }
  if (!consentIsActive(consent)) {
    return {
      action: 'blocked',
      reason: 'missing_consent',
      message: 'Sdílení pečovatelského signálu není zapnuté. Bez výslovného opt-in souhlasu neposílat nic ven.',
      rule: ruleCheck,
      notification: null,
    };
  }

  return {
    action: 'notify',
    reason: 'consent_active',
    rule: ruleCheck,
    notification: {
      recipient: consent.recipient,
      signal: ruleCheck.signal,
      message: ruleCheck.safe_payload.message,
      shares_raw_data: false,
      disclaimer: consent.disclaimer || 'Doplňková notifikace rodině, není to náhrada tísňové linky ani lékaře.',
    },
  };
}

function buildCareProfile(input = {}) {
  const rules = Array.isArray(input.rules) ? input.rules : [];
  const checkedRules = rules.map(validateCareRule);
  const consent = buildConsentState(input.consent || { action: 'status', current: input.current_consent || {} });
  return {
    status: checkedRules.every(rule => rule.ok) ? 'draft_ready' : 'needs_fix',
    mode: 'local_evaluation_only',
    allowed_signals: ALLOWED_SIGNALS,
    prohibited: ['raw health data sharing', 'medical diagnosis', 'health trends', 'emergency-service promise'],
    consent,
    rules: checkedRules,
    safety: {
      sends_messages: false,
      writes_home_assistant: false,
      rule: 'Tenhle helper jen vyhodnocuje bezpečný tvar. Produkční notifikace a HA zápisy musí vzniknout až po samostatném schválení a testu.',
    },
  };
}

module.exports = {
  ALLOWED_SIGNALS,
  buildCareProfile,
  buildConsentState,
  consentIsActive,
  evaluateCareEvent,
  validateCareRule,
};
