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

function normalizeText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function uniq(values) {
  return [...new Set(values.filter(Boolean))];
}

function inferCandidateCategory(candidate = {}) {
  const fields = [
    candidate.hostname,
    candidate.name,
    candidate.friendly_name,
    candidate.vendor,
    candidate.manufacturer,
    candidate.model,
    candidate.integration,
    candidate.entity_id,
  ];
  const haystack = normalizeText(fields.join(' '));
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

  const handler = String(input.handler || '').trim();
  if (!handler) {
    return {
      category,
      needs_handler: true,
      suggested_handlers: CATEGORY_HINTS[category] ? CATEGORY_HINTS[category].handlers : [],
      message: 'Nejdřív vyber konkrétní HA integraci podle výrobce/modelu. Žán nesmí tipovat handler.',
    };
  }

  return {
    category,
    handler,
    userInput: input.flow_input && typeof input.flow_input === 'object' ? input.flow_input : null,
  };
}

module.exports = {
  CATEGORY_HINTS,
  inferCandidateCategory,
  buildOnboardDeviceRequest,
};
