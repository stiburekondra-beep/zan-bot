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
    keywords: ['climate', 'klima', 'klimatizace', 'ac ', 'air conditioner', 'heat pump', 'tepelne cerpadlo', 'tepelné čerpadlo', 'hvac', 'daikin', 'midea', 'mitsubishi', 'toshiba'],
    vendors: ['daikin', 'midea', 'mitsubishi', 'toshiba', 'panasonic', 'gree', 'sinclair', 'tuya', 'sensibo', 'broadlink'],
    handlers: ['daikin', 'melcloud', 'melcloud_home', 'gree', 'ccm15', 'tuya', 'smartthings', 'sensibo'],
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

const TV_HANDLER_GUIDES = [
  {
    handler: 'samsungtv',
    match: ['samsung', 'tizen'],
    confidence: 'medium',
    reason: 'Samsung Smart TV má oficiální HA integraci a Home Assistant ji umí často autodetekovat.',
  },
  {
    handler: 'webostv',
    match: ['lg', 'webos', 'web os'],
    confidence: 'medium',
    reason: 'LG webOS TV má oficiální HA integraci; pro ruční flow obvykle stačí host/IP a potvrzení na TV.',
  },
  {
    handler: 'androidtv_remote',
    match: ['android tv', 'google tv', 'chromecast', 'sony android', 'philips android', 'tcl android', 'xiaomi'],
    confidence: 'medium',
    reason: 'Android/Google TV preferuje oficiální HA integraci Android TV Remote; párování vyžaduje potvrzení zobrazené na TV.',
  },
  {
    handler: 'braviatv',
    match: ['bravia', 'sony'],
    confidence: 'medium',
    reason: 'Sony Bravia TV má oficiální HA integraci; u Android/Google TV může být vhodnější Android TV Remote nebo Google Cast podle modelu.',
  },
  {
    handler: 'philips_js',
    match: ['philips'],
    confidence: 'medium',
    reason: 'Philips TV má oficiální HA integraci pro podporované modely.',
  },
  {
    handler: 'cast',
    match: ['cast', 'chromecast', 'google cast'],
    confidence: 'low',
    reason: 'Google Cast je bezpečný fallback pro cast/media funkce, ale nemusí pokrýt plné ovládání TV.',
  },
  {
    handler: 'dlna_dmr',
    match: ['dlna', 'dmr', 'upnp', 'ssdp'],
    confidence: 'low',
    reason: 'DLNA/SSDP zařízení může být jen renderer; začít read-only ověřením media_player entity, neslibovat plné ovládání.',
  },
];

const CLIMATE_HANDLER_GUIDES = [
  {
    handler: 'daikin',
    match: ['daikin'],
    confidence: 'medium',
    reason: 'Daikin AC má oficiální HA integraci Daikin. Začni přidáním integrace a po párování jen ověř climate/sensor entity.',
  },
  {
    handler: 'melcloud',
    match: ['mitsubishi', 'melcloud', 'mel cloud', 'kirigamine'],
    confidence: 'medium',
    reason: 'Mitsubishi klimatizace používající MELCloud patří pod oficiální HA integraci MELCloud; vyžaduje účet výrobce.',
  },
  {
    handler: 'melcloud_home',
    match: ['melcloud home', 'mel cloud home'],
    confidence: 'medium',
    reason: 'MELCloud Home má samostatnou oficiální HA integraci; použij ji jen když uživatel potvrdí právě MELCloud Home hub.',
  },
  {
    handler: 'gree',
    match: ['gree', 'sinclair', 'inventor', 'tosot', 'cooper&hunter', 'cooper hunter', 'heiwa'],
    confidence: 'medium',
    reason: 'Gree a část rebrandů používá oficiální HA integraci Gree Climate; před ovládáním ověř konkrétní model a vznik climate entity.',
  },
  {
    handler: 'ccm15',
    match: ['midea ccm15', 'ccm15'],
    confidence: 'medium',
    reason: 'Midea CCM15 controller má oficiální HA integraci ccm15. Běžná Midea Wi-Fi jednotka bez CCM15 není tímto automaticky pokrytá.',
  },
  {
    handler: 'tuya',
    match: ['tuya', 'smart life', 'smartlife'],
    confidence: 'low',
    reason: 'Tuya/Smart Life AC může jít přes oficiální HA integraci Tuya, ale zařízení musí být nejdřív v účtu/appce a po reloadu ověřené jako climate entita.',
  },
  {
    handler: 'smartthings',
    match: ['smartthings', 'samsung air conditioner', 'samsung ac'],
    confidence: 'low',
    reason: 'SmartThings umí některé air conditioner/thermostat capability jako climate entity, ale je to cloudová cesta přes účet výrobce.',
  },
  {
    handler: 'sensibo',
    match: ['sensibo'],
    confidence: 'low',
    reason: 'Sensibo je podporovaná HA integrace pro IR klimatizace přes existující Sensibo bridge; bez bridge nejde IR-only jednotku přidat softwarem.',
  },
  {
    handler: 'broadlink',
    match: ['broadlink', 'ir blaster', 'infrared', 'ir-only', 'ir only', 'infra'],
    confidence: 'low',
    reason: 'IR-only klimatizace potřebuje podporovaný IR bridge/proxy. Bez fyzického IR HW Žán nesmí slibovat přidání klimatizace.',
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

const AREA_CONFIRMATION_RULE =
  'místnost použít přesně podle uživatele; pokud v HA není stejný název, zeptat se na vytvoření nebo výběr existující místnosti; nikdy nedomýšlet alias typu "pracovna = Dílna" bez explicitního potvrzení';

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
    candidate.ssdp_st,
    candidate.ssdp_usn,
    candidate.ssdp_server,
    candidate.mdns_name,
    candidate.dhcp_hostname,
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
    ssdp_st: input.ssdp_st || (input.candidate && input.candidate.ssdp_st),
    ssdp_usn: input.ssdp_usn || (input.candidate && input.candidate.ssdp_usn),
    ssdp_server: input.ssdp_server || (input.candidate && input.candidate.ssdp_server),
    mdns_name: input.mdns_name || (input.candidate && input.candidate.mdns_name),
    dhcp_hostname: input.dhcp_hostname || (input.candidate && input.candidate.dhcp_hostname),
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
      AREA_CONFIRMATION_RULE,
      'přiřadit zařízení přes ha_setup_assign_device až po výslovném potvrzení konkrétní area_id',
      'automatizaci pouze nabídnout; write_package volat až po jasném OK',
    ],
  };
}

function inferTvOnboarding(candidate = {}) {
  const haystack = normalizeText(candidateText(candidate));
  const recommendedHandlers = [];

  for (const guide of TV_HANDLER_GUIDES) {
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

  return {
    recommended_handlers: recommendedHandlers.length
      ? recommendedHandlers
      : [{
          handler: null,
          confidence: 'none',
          reason: 'Z dostupných metadat nejde bezpečně vybrat Samsung/LG/Android TV/Bravia/Philips/Cast/DLNA integraci. Žán si má říct o výrobce/model TV nebo nechat uživatele vybrat ručně v HA.',
          matched: [],
        }],
    pairing: {
      requires_screen_confirmation: true,
      rule: 'TV párování ber jako běžný krok flow: uživateli řekni, ať zapne TV a potvrdí kód/žádost na obrazovce. Dokud get_states/get_new_entities nepotvrdí novou media_player entitu, neříkej hotovo.',
    },
    after_pairing: [
      'ověřit novou media_player entitu přes get_new_entities nebo get_states',
      'pokud flow vrátí form/pairing krok, předej uživateli instrukci k potvrzení na obrazovce TV a čekej na jeho potvrzení',
      AREA_CONFIRMATION_RULE,
      'přiřadit zařízení přes ha_setup_assign_device až po výslovném potvrzení konkrétní area_id',
      'ovládání omezit na schopnosti konkrétní integrace; neslibovat zdroj/hlasitost/power univerzálně',
    ],
  };
}

function inferClimateOnboarding(candidate = {}) {
  const haystack = normalizeText(candidateText(candidate));
  const recommendedHandlers = [];

  for (const guide of CLIMATE_HANDLER_GUIDES) {
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

  const irOnly = ['ir-only', 'ir only', 'infrared', 'ir blaster', 'broadlink'].some(token => haystack.includes(normalizeText(token)));

  return {
    recommended_handlers: recommendedHandlers.length
      ? recommendedHandlers
      : [{
          handler: null,
          confidence: 'none',
          reason: 'Z dostupných metadat nejde bezpečně vybrat Daikin/MELCloud/Gree/CCM15/Tuya/SmartThings/Sensibo integraci. Žán si má říct o výrobce, model a způsob připojení (Wi-Fi/cloud vs. IR-only).',
          matched: [],
        }],
    control_safety: {
      read_only_default: true,
      ir_only_requires_hardware: irOnly,
      rule: irOnly
        ? 'IR-only klimatizaci nelze přidat bez podporovaného IR bridge/proxy. Zapiš potřebuju_dokoupit, neříkej hotovo.'
        : 'Po onboardingu jen ověř stav climate/sensor entity. Změnu teploty, režimu, zapnutí/vypnutí nebo automatizaci proveď až po výslovném potvrzení uživatele.',
    },
    after_pairing: [
      'ověřit novou climate entitu přes get_new_entities nebo get_states',
      'pokud vzniknou jen sensor entity, říct uživateli, že jde zatím o read-only stav',
      'zeptat se na místnost a přiřadit zařízení přes ha_setup_assign_device až po potvrzení',
      'nesahat na packages/topeni_* ani na domovní regulaci; karta řeší jen doplňkovou Wi-Fi/cloud AC jednotku',
      'změnu teploty/režimu/zapnutí nebo write_package automatizaci dělat až po jasném OK',
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
    tv_onboarding: scored.some(item => item.category === 'tv') ? inferTvOnboarding(candidate) : undefined,
    climate_onboarding: scored.some(item => item.category === 'climate') ? inferClimateOnboarding(candidate) : undefined,
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
  const tvOnboarding = category === 'tv' ? inferTvOnboarding(candidate) : null;
  const climateOnboarding = category === 'climate' ? inferClimateOnboarding(candidate) : null;
  const handler = String(input.handler || '').trim();
  if (!handler) {
    return {
      category,
      needs_handler: true,
      suggested_handlers: plugOnboarding
        ? plugOnboarding.recommended_handlers
        : tvOnboarding
          ? tvOnboarding.recommended_handlers
          : climateOnboarding
            ? climateOnboarding.recommended_handlers
            : (CATEGORY_HINTS[category] ? CATEGORY_HINTS[category].handlers : []),
      automation_safety: plugOnboarding ? plugOnboarding.automation_safety : undefined,
      tv_pairing: tvOnboarding ? tvOnboarding.pairing : undefined,
      climate_safety: climateOnboarding ? climateOnboarding.control_safety : undefined,
      after_pairing: plugOnboarding
        ? plugOnboarding.after_pairing
        : tvOnboarding
          ? tvOnboarding.after_pairing
          : climateOnboarding
            ? climateOnboarding.after_pairing
            : undefined,
      message: plugOnboarding && plugOnboarding.recommended_handlers[0].handler
        ? 'Vyber konkrétní HA integraci podle doporučení a potvrzení uživatele. Žán nesmí dokončit párování ani automatizaci naslepo.'
        : tvOnboarding && tvOnboarding.recommended_handlers[0].handler
          ? 'Vyber konkrétní HA integraci podle doporučení a potvrzení uživatele. U TV počítej s potvrzením na obrazovce a hotovo říkej až po ověření media_player entity.'
          : climateOnboarding && climateOnboarding.recommended_handlers[0].handler
            ? 'Vyber konkrétní HA integraci podle výrobce/modelu a potvrzení uživatele. U klimatizace je výchozí režim read-only: hotovo říkej až po ověření climate entity, ovládání až po jasném OK.'
            : 'Nejdřív vyber konkrétní HA integraci podle výrobce/modelu. Žán nesmí tipovat handler.',
    };
  }

  return {
    category,
    handler,
    userInput: input.flow_input && typeof input.flow_input === 'object' ? input.flow_input : null,
    automation_safety: plugOnboarding ? plugOnboarding.automation_safety : undefined,
    tv_pairing: tvOnboarding ? tvOnboarding.pairing : undefined,
    climate_safety: climateOnboarding ? climateOnboarding.control_safety : undefined,
    after_pairing: plugOnboarding
      ? plugOnboarding.after_pairing
      : tvOnboarding
        ? tvOnboarding.after_pairing
        : climateOnboarding
          ? climateOnboarding.after_pairing
          : undefined,
  };
}

module.exports = {
  CATEGORY_HINTS,
  PLUG_HANDLER_GUIDES,
  TV_HANDLER_GUIDES,
  CLIMATE_HANDLER_GUIDES,
  inferPlugOnboarding,
  inferTvOnboarding,
  inferClimateOnboarding,
  inferCandidateCategory,
  buildOnboardDeviceRequest,
};
