const CATEGORY_HINTS = {
  camera: {
    domains: ['camera'],
    keywords: ['camera', 'kamera', 'cam', 'tapo c', 'rtsp', 'onvif'],
    vendors: ['tp-link', 'tapo', 'hikvision', 'dahua', 'reolink', 'axis'],
    handlers: ['generic', 'onvif'],
  },
  plug: {
    domains: ['switch'],
    keywords: ['plug', 'zasuvka', 'zásuvka', 'socket', 'shelly plug', 'tapo p', 'sonoff s', 'power plug'],
    vendors: ['shelly', 'tp-link', 'tapo', 'sonoff', 'ewelink', 'athom', 'nous'],
    handlers: ['shelly', 'tplink', 'tuya'],
  },
  tv: {
    domains: ['media_player'],
    keywords: ['tv', 'television', 'televize', 'webos', 'bravia', 'samsung', 'lg ', 'android tv', 'chromecast'],
    vendors: ['samsung', 'lg', 'sony', 'philips', 'hisense', 'tcl', 'xiaomi', 'google'],
    handlers: ['samsungtv', 'webostv', 'androidtv'],
  },
  climate: {
    domains: ['climate'],
    keywords: ['climate', 'klima', 'klimatizace', 'ac ', 'air conditioner', 'daikin', 'midea', 'mitsubishi', 'toshiba'],
    vendors: ['daikin', 'midea', 'mitsubishi', 'toshiba', 'panasonic', 'gree', 'sinclair'],
    handlers: ['daikin', 'midea_ac', 'tuya'],
  },
};

const PLUG_HANDLER_GUIDES = [
  {
    handler: 'shelly',
    match: ['shelly'],
    confidence: 'medium',
    reason: 'Shelly plug/relay má oficiální HA integraci Shelly a běžně se páruje lokálně.',
  },
  {
    handler: 'tplink',
    match: ['tp-link', 'tplink', 'tapo', 'kasa'],
    confidence: 'medium',
    reason: 'TP-Link/Kasa/Tapo zásuvky patří pod oficiální HA integraci TP-Link Smart Home.',
  },
  {
    handler: 'matter',
    match: ['matter'],
    confidence: 'low',
    reason: 'Matter zásuvka se páruje přes HA Matter, typicky vyžaduje párovací kód a uživatelské potvrzení.',
  },
];

const PLUG_RISK_KEYWORDS = [
  'cerpadlo',
  'čerpadlo',
  'pump',
  'kotel',
  'boiler',
  'topeni',
  'topení',
  'heater',
  'radiator',
  'vrata',
  'garage',
  'brana',
  'brána',
  'gate',
  'zamok',
  'zámek',
  'lock',
  'freezer',
  'mrazak',
  'mrazák',
  'fridge',
  'lednice',
];

function normalizeText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function uniq(values) {
  return [...new Set(values.filter(Boolean))];
}

function candidateText(candidate = {}) {
  return [
    candidate.hostname,
    candidate.name,
    candidate.friendly_name,
    candidate.vendor,
    candidate.manufacturer,
    candidate.model,
    candidate.integration,
    candidate.entity_id,
    candidate.handler,
  ].join(' ');
}

function mergeCandidate(input = {}) {
  return {
    ...(input.candidate && typeof input.candidate === 'object' ? input.candidate : {}),
    hostname: input.hostname || input.host || (input.candidate && input.candidate.hostname),
    name: input.name || input.device_name || (input.candidate && input.candidate.name),
    vendor: input.vendor || (input.candidate && input.candidate.vendor),
    manufacturer: input.manufacturer || (input.candidate && input.candidate.manufacturer),
    model: input.model || (input.candidate && input.candidate.model),
    integration: input.integration || (input.candidate && input.candidate.integration),
    entity_id: input.entity_id || (input.candidate && input.candidate.entity_id),
    domain: input.domain || (input.candidate && input.candidate.domain),
  };
}

function inferPlugOnboarding(candidate = {}) {
  const haystack = normalizeText(candidateText(candidate));
  const recommendedHandlers = [];

  for (const guide of PLUG_HANDLER_GUIDES) {
    const matched = guide.match.filter(token => haystack.includes(normalizeText(token)));
    if (matched.length) {
      recommendedHandlers.push({
        handler: guide.handler,
        confidence: guide.confidence,
        reason: guide.reason,
        matched,
      });
    }
  }

  const riskMatches = PLUG_RISK_KEYWORDS.filter(token => haystack.includes(normalizeText(token)));
  return {
    recommended_handlers: recommendedHandlers.length
      ? recommendedHandlers
      : [{
          handler: null,
          confidence: 'none',
          reason: 'Z dostupných metadat nejde bezpečně vybrat Shelly/TP-Link/Matter integraci. Žán si má říct o výrobce/model nebo nechat uživatele vybrat ručně v HA.',
          matched: [],
        }],
    automation_safety: {
      risky_load: riskMatches.length > 0,
      matched: uniq(riskMatches),
      rule: riskMatches.length > 0
        ? 'Nenabízet automatické zapínání/vypínání. Jen ruční ovládání, dokud uživatel výslovně nepotvrdí, co je do zásuvky zapojené.'
        : 'Automatizaci jen nabídnout a zapsat až po výslovném potvrzení uživatele.',
    },
    after_pairing: [
      'ověřit novou switch entitu přes get_new_entities nebo ha_setup_list',
      'zeptat se na místnost a přiřadit zařízení přes ha_setup_assign_device až po potvrzení',
      'automatizaci pouze nabídnout; write_package volat až po jasném OK',
    ],
  };
}

function inferCandidateCategory(candidate = {}) {
  const haystack = normalizeText(candidateText(candidate));
  const domain = String(candidate.domain || candidate.entity_id || '').split('.')[0];
  const scored = [];

  for (const [category, hints] of Object.entries(CATEGORY_HINTS)) {
    const reasons = [];
    if (hints.domains.includes(domain)) reasons.push(`domain:${domain}`);
    for (const vendor of hints.vendors) {
      if (haystack.includes(normalizeText(vendor))) reasons.push(`vendor:${vendor}`);
    }
    for (const keyword of hints.keywords) {
      if (haystack.includes(normalizeText(keyword))) reasons.push(`keyword:${keyword}`);
    }
    if (reasons.length) {
      scored.push({
        category,
        confidence: reasons.some(r => r.startsWith('domain:')) ? 'medium' : 'low',
        reasons: uniq(reasons),
        suggested_handlers: hints.handlers,
      });
    }
  }

  scored.sort((a, b) => {
    const score = x => (x.confidence === 'medium' ? 10 : 0) + x.reasons.length;
    return score(b) - score(a);
  });

  return {
    category_guess: scored[0] ? scored[0].category : null,
    confidence: scored[0] ? scored[0].confidence : 'none',
    candidates: scored,
    plug_onboarding: scored.some(item => item.category === 'plug') ? inferPlugOnboarding(candidate) : undefined,
    note: scored.length
      ? 'Jen návrh kategorie podle názvu/výrobce/domény. Finální typ a dokončení párování musí potvrdit uživatel.'
      : 'Kategorie nejde spolehlivě odhadnout z dostupných metadat.',
  };
}

function buildCameraFlowInput(input = {}) {
  const streamPath = input.stream_path || '/stream1';
  if (!input.host || !input.username || !input.password) {
    return {
      error: 'Kamera potřebuje host, username a password z lokálního Camera Accountu.',
    };
  }
  return {
    handler: 'generic',
    userInput: {
      stream_source: `rtsp://${input.host}:554${streamPath}`,
      username: input.username,
      password: input.password,
      advanced: { framerate: 2, verify_ssl: false, rtsp_transport: 'tcp', authentication: 'basic' },
    },
  };
}

function buildOnboardDeviceRequest(input = {}) {
  const category = String(input.category || '').trim().toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(CATEGORY_HINTS, category) && category !== 'generic') {
    return { error: 'Neznámá kategorie. Povolené: camera, plug, tv, climate, generic.' };
  }

  if (category === 'camera') {
    return { category, ...buildCameraFlowInput(input) };
  }

  const candidate = mergeCandidate(input);
  const plugOnboarding = category === 'plug' ? inferPlugOnboarding(candidate) : null;
  const handler = String(input.handler || '').trim();
  if (!handler) {
    return {
      category,
      needs_handler: true,
      suggested_handlers: plugOnboarding
        ? plugOnboarding.recommended_handlers
        : (CATEGORY_HINTS[category] ? CATEGORY_HINTS[category].handlers : []),
      automation_safety: plugOnboarding ? plugOnboarding.automation_safety : undefined,
      after_pairing: plugOnboarding ? plugOnboarding.after_pairing : undefined,
      message: plugOnboarding && plugOnboarding.recommended_handlers[0].handler
        ? 'Vyber konkrétní HA integraci podle doporučení a potvrzení uživatele. Žán nesmí dokončit párování ani automatizaci naslepo.'
        : 'Nejdřív vyber konkrétní HA integraci podle výrobce/modelu. Žán nesmí tipovat handler.',
    };
  }

  return {
    category,
    handler,
    userInput: input.flow_input && typeof input.flow_input === 'object' ? input.flow_input : null,
    automation_safety: plugOnboarding ? plugOnboarding.automation_safety : undefined,
    after_pairing: plugOnboarding ? plugOnboarding.after_pairing : undefined,
  };
}

module.exports = {
  CATEGORY_HINTS,
  PLUG_HANDLER_GUIDES,
  inferPlugOnboarding,
  inferCandidateCategory,
  buildOnboardDeviceRequest,
};
