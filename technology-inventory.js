'use strict';

const fs = require('fs');
const path = require('path');

const VALID_STATUS = new Set(['aktivní', 'read-only', 'plánováno-nezapojeno']);

const SEED_TECHNOLOGIES = [
  {
    id: 'samsung_kanalova_jednotka_1',
    name: 'Samsung kanálová jednotka 1',
    type: 'kanálová jednotka',
    manufacturer: 'Samsung',
    model: '?',
    status: 'plánováno-nezapojeno',
    integration: 'čeká na dokumentaci a fyzické zapojení; netvrdit řízení teploty',
    documentation: {
      status: 'čeká na dodání od Ondry',
      path: 'docs/samsung-kanalova-jednotka-1/',
    },
    notes: 'Jednotka je v inventáři jako plánovaná technologie vlastního domu/LABu. Není zapojená a Žán ji dnes neovládá.',
  },
  {
    id: 'samsung_kanalova_jednotka_2',
    name: 'Samsung kanálová jednotka 2',
    type: 'kanálová jednotka',
    manufacturer: 'Samsung',
    model: '?',
    status: 'plánováno-nezapojeno',
    integration: 'čeká na dokumentaci a fyzické zapojení; netvrdit řízení teploty',
    documentation: {
      status: 'čeká na dodání od Ondry',
      path: 'docs/samsung-kanalova-jednotka-2/',
    },
    notes: 'Jednotka je v inventáři jako plánovaná technologie vlastního domu/LABu. Není zapojená a Žán ji dnes neovládá.',
  },
  {
    id: 'rekuperacni_jednotka',
    name: 'Rekuperační jednotka',
    type: 'rekuperace',
    manufacturer: '?',
    model: '?',
    status: 'plánováno-nezapojeno',
    integration: 'Modbus TCP/RTU podle dokumentace; registry nevymýšlet',
    documentation: {
      status: 'čeká na dodání od Ondry',
      path: 'docs/rekuperacni-jednotka/',
    },
    notes: 'Zatím jen znalostní položka pro budoucí Modbus LAB. Bez modelu a mapy registrů Žán nesmí hlásit hotové řízení ani generovat registry.',
  },
];

function emptyInventory(docsDir) {
  return {
    version: 1,
    updated_at: new Date().toISOString(),
    docs_dir: docsDir,
    note: 'Dokumentaci ukládej do podsložek pod docs_dir. Hesla a tokeny sem nepatří.',
    technologies: SEED_TECHNOLOGIES,
  };
}

function normalizeTechnology(item, docsDir) {
  const technology = { ...item };
  if (!technology.id) technology.id = slugify(technology.name || technology.type || 'technologie');
  if (!technology.name) technology.name = technology.id;
  if (!technology.type) technology.type = 'technologie';
  if (!technology.manufacturer) technology.manufacturer = '?';
  if (!technology.model) technology.model = '?';
  if (!VALID_STATUS.has(technology.status)) technology.status = 'plánováno-nezapojeno';
  if (!technology.integration) technology.integration = 'čeká na doplnění';
  if (!technology.documentation || typeof technology.documentation !== 'object') {
    technology.documentation = { status: 'čeká na dodání', path: `docs/${technology.id}/` };
  }
  if (!technology.documentation.status) technology.documentation.status = 'čeká na dodání';
  if (!technology.documentation.path) technology.documentation.path = `docs/${technology.id}/`;
  technology.docs_absolute_path = path.join(docsDir, technology.documentation.path.replace(/^docs\/?/, ''));
  return technology;
}

function slugify(value) {
  return String(value || 'technologie')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64) || 'technologie';
}

function ensureTechnologyInventory(file, docsDir) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.mkdirSync(docsDir, { recursive: true });

  let inventory;
  try {
    if (fs.existsSync(file)) {
      inventory = JSON.parse(fs.readFileSync(file, 'utf8'));
    }
  } catch {}

  if (!inventory || !Array.isArray(inventory.technologies)) {
    inventory = emptyInventory(docsDir);
    fs.writeFileSync(file, JSON.stringify(inventory, null, 2), 'utf8');
  }

  const byId = new Map(inventory.technologies.map(t => [t.id, t]));
  let changed = false;
  for (const seed of SEED_TECHNOLOGIES) {
    if (!byId.has(seed.id)) {
      inventory.technologies.push(seed);
      changed = true;
    }
  }
  if (inventory.docs_dir !== docsDir) {
    inventory.docs_dir = docsDir;
    changed = true;
  }
  if (changed) {
    inventory.updated_at = new Date().toISOString();
    fs.writeFileSync(file, JSON.stringify(inventory, null, 2), 'utf8');
  }

  return {
    ...inventory,
    technologies: inventory.technologies.map(t => normalizeTechnology(t, docsDir)),
  };
}

function getTechnologyInventory(file, docsDir, opts = {}) {
  const inventory = ensureTechnologyInventory(file, docsDir);
  const id = opts.id ? String(opts.id) : '';
  if (id) {
    const found = inventory.technologies.find(t => t.id === id || slugify(t.name) === slugify(id));
    return {
      docs_dir: inventory.docs_dir,
      note: inventory.note,
      technology: found || null,
      error: found ? undefined : `Technologie "${id}" v inventáři není.`,
    };
  }
  return {
    docs_dir: inventory.docs_dir,
    note: inventory.note,
    count: inventory.technologies.length,
    technologies: inventory.technologies.map(t => ({
      id: t.id,
      name: t.name,
      type: t.type,
      manufacturer: t.manufacturer,
      model: t.model,
      status: t.status,
      integration: t.integration,
      documentation: t.documentation,
      notes: t.notes,
    })),
  };
}

function formatTechnologyInventory(file, docsDir, opts = {}) {
  const data = getTechnologyInventory(file, docsDir, opts);
  if (data.error) return data.error;
  if (data.technology) return formatOne(data.technology, data.docs_dir);
  const rows = data.technologies.map(t => `- ${t.name}: ${t.status}; model ${t.model}; dokumentace ${t.documentation.status} (${path.join(data.docs_dir, t.documentation.path.replace(/^docs\/?/, ''))})`);
  return [
    `Inventář technologií: ${data.count} položky.`,
    `Dokumentace patří do: ${data.docs_dir}`,
    ...rows,
    'Pozor: plánované/nezapojené položky nejsou důkaz, že je Žán ovládá.',
  ].join('\n');
}

function formatOne(t, docsDir) {
  return [
    `${t.name}`,
    `Typ: ${t.type}`,
    `Výrobce/model: ${t.manufacturer} / ${t.model}`,
    `Stav: ${t.status}`,
    `Integrace: ${t.integration}`,
    `Dokumentace: ${t.documentation.status} (${path.join(docsDir, t.documentation.path.replace(/^docs\/?/, ''))})`,
    `Poznámka: ${t.notes || '-'}`,
  ].join('\n');
}

module.exports = {
  SEED_TECHNOLOGIES,
  ensureTechnologyInventory,
  getTechnologyInventory,
  formatTechnologyInventory,
};
