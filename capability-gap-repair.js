'use strict';

function normalize(text) {
  return String(text || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function classifyCapability(userMessage, finalText) {
  const t = normalize(`${userMessage} ${finalText}`);
  if (/(hudb|pisn|skladb|spotify|youtube|coldplay|linkin|prehraj|pust)/u.test(t)) return 'music';
  if (/(hlas|reproduktor|mluv|tts|voice|piper)/u.test(t)) return 'voice';
  if (/(kamera|fotk|snimek|obraz|rtsp)/u.test(t)) return 'camera';
  if (/(mapa domu|pudorys|soused|mistnost|kde je|vedle)/u.test(t)) return 'house_map';
  if (/(technolog|manual|dokumentac|rekuper|klimatiz|modbus|co2)/u.test(t)) return 'technology_or_hvac';
  if (/(automatiz|pripomen|casovac|rozvrh|package|yaml)/u.test(t)) return 'automation';
  if (/(svetl|zasuvk|zapn|vypn|ovlad|zarizen)/u.test(t)) return 'home_control';
  return 'unknown_capability';
}

function hasRefusalOrLimit(finalText) {
  const t = normalize(finalText);
  return /(\bneumim\b|\bnedokazu\b|\bnemam (k tomu )?(pristup|prehravac|moznost|nastroj|data|informac)|\bnejde to\b|\bneni mozne\b|\bnesmim\b|\bnemuzu\b|\bnemohu\b|\bpotrebuju .*(cidlo|model|manual|token|prehravac|entitu|pristup|hardware|hw))/u.test(t);
}

function hasConcreteNextStep(finalText) {
  const t = normalize(finalText);
  return /(dalsi krok|zkusim|zkus prosim|rekni mi|posli mi|potrebuju|nastav|zapni|overim|ulozim|zapsal jsem|poslal jsem pozadavek|firma to|muze[sš]|staci|dodej|dopln|vyber|potvrd prosim|potrebuji potvrzeni|cekam na potvrzeni)/u.test(t);
}

function buildRepairInput(userMessage, finalText, options = {}) {
  const capability = options.capability || classifyCapability(userMessage, finalText);
  const titleByCapability = {
    music: 'Konverzační mezera: hudební povel nemá jistou cestu',
    voice: 'Konverzační mezera: hlasový kanál neumí dokončit požadavek',
    camera: 'Konverzační mezera: kamera/snímek nemá jistou cestu',
    house_map: 'Konverzační mezera: mapa domu nemá potřebná data',
    technology_or_hvac: 'Konverzační mezera: technologie nebo HVAC chybí v datech',
    automation: 'Konverzační mezera: automatizace nebo časování nemá jistou cestu',
    home_control: 'Konverzační mezera: ovládání domu nemá ověřenou cestu',
    unknown_capability: 'Konverzační mezera: Žán narazil na limit schopnosti',
  };
  return {
    source: 'konverzace',
    capability,
    dedupe_key: capability,
    severity: capability === 'home_control' || capability === 'technology_or_hvac' ? 'warning' : 'info',
    title: titleByCapability[capability] || titleByCapability.unknown_capability,
    detail: 'Žán v konverzaci narazil na limit schopnosti nebo chybějící data. Text zpráv se kvůli soukromí neukládá; záznam slouží firmě jako anonymní backlog mezera.',
    next_step: 'CEO/programátor zkontroluje repair inbox, rozhodne zda z toho vznikne karta, nebo jestli stačí doplnit domácí data, dokumentaci či tester scénář.',
    evidence: {
      kind: 'conversation_capability_gap',
      refusal_or_limit_detected: true,
      next_step_missing: !hasConcreteNextStep(finalText),
      privacy: 'raw_conversation_not_stored',
    },
  };
}

function appendNextStep(finalText, capability) {
  const suffix = capability === 'unknown_capability'
    ? 'Zapsal jsem to jako mezeru pro firmu; další krok je, že firma rozhodne, jestli doplnit schopnost, data nebo test.'
    : 'Zapsal jsem to jako mezeru pro firmu; další krok je doplnit konkrétní schopnost nebo data a ověřit to testem.';
  const trimmed = String(finalText || '').trim();
  if (!trimmed) return suffix;
  return /[.!?…]$/.test(trimmed) ? `${trimmed} ${suffix}` : `${trimmed}. ${suffix}`;
}

function handleCapabilityGap(finalText, userMessage, options = {}) {
  if (!hasRefusalOrLimit(finalText)) {
    return { text: finalText, changed: false, recorded: false, capability: null };
  }

  const repairFile = options.repairFile;
  const upsertRepair = options.upsertRepair;
  const repair = buildRepairInput(userMessage, finalText, options);
  let recorded = false;
  let error = null;
  if (repairFile && typeof upsertRepair === 'function') {
    try {
      upsertRepair(repairFile, repair, options.now ? { now: options.now } : {});
      recorded = true;
    } catch (e) {
      error = e;
    }
  }

  const needsNextStep = !hasConcreteNextStep(finalText);
  const text = needsNextStep ? appendNextStep(finalText, repair.capability) : finalText;
  return {
    text,
    changed: needsNextStep,
    recorded,
    capability: repair.capability,
    error,
    repair,
  };
}

module.exports = {
  normalize,
  classifyCapability,
  hasRefusalOrLimit,
  hasConcreteNextStep,
  buildRepairInput,
  handleCapabilityGap,
};
