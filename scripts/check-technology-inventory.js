'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  ensureTechnologyInventory,
  getTechnologyInventory,
  formatTechnologyInventory,
} = require('../technology-inventory');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zan-tech-'));
const file = path.join(tmp, 'technologies.json');
const docsDir = path.join(tmp, 'docs');

const inventory = ensureTechnologyInventory(file, docsDir);
assert.strictEqual(inventory.version, 1);
assert.strictEqual(inventory.technologies.length, 3);
assert.ok(fs.existsSync(file), 'inventory file must be created');
assert.ok(fs.existsSync(docsDir), 'docs dir must be created');

const names = inventory.technologies.map(t => t.name);
assert.deepStrictEqual(names, [
  'Samsung kanálová jednotka LSP Slim Duct ACO71 (7,1 kW)',
  'Samsung kanálová jednotka MSP Duct HighEE AC071 (6,8 kW)',
  'Rekuperační jednotka Komfovent DOMEKT-R-400-V-L1',
]);

const models = inventory.technologies.map(t => t.model);
assert.deepStrictEqual(models, [
  'LSP Slim Duct ACO71 (7,1 kW)',
  'MSP Duct HighEE AC071 (6,8 kW)',
  'DOMEKT-R-400-V-L1',
]);

for (const item of inventory.technologies) {
  assert.strictEqual(item.status, 'plánováno-nezapojeno', 'seed drží plánováno-nezapojeno');
  assert.notStrictEqual(item.model, '?', 'reálný model musí být doplněn');
  assert.ok(item.documentation.path.startsWith('docs/'));
  assert.ok(item.docs_absolute_path.startsWith(docsDir));
  assert.ok(!/aktivní|ovládá teplot/i.test(`${item.status} ${item.notes}`), 'seed must not claim active control');
}

const detail = getTechnologyInventory(file, docsDir, { id: 'rekuperacni_jednotka' });
assert.strictEqual(detail.technology.type, 'rekuperace');
assert.ok(detail.technology.integration.includes('registry nevymýšlet'));

const text = formatTechnologyInventory(file, docsDir);
assert.ok(text.includes('Dokumentace patří do:'));
assert.ok(text.includes('plánováno-nezapojeno'));
assert.ok(text.includes('nejsou důkaz, že je Žán ovládá'));

// Placeholder-upgrade guard: stará položka s '?' se doplní z reálného seedu,
// ale hodnota, kterou dům/uživatel reálně upřesnil, se NIKDY nepřepíše.
const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'zan-tech-up-'));
const file2 = path.join(tmp2, 'technologies.json');
const docsDir2 = path.join(tmp2, 'docs');
fs.mkdirSync(docsDir2, { recursive: true });
fs.writeFileSync(file2, JSON.stringify({
  version: 1,
  docs_dir: docsDir2,
  technologies: [
    // stará položka se stále nedoplněným '?' → má se upgradovat
    { id: 'samsung_kanalova_jednotka_1', name: 'Samsung kanálová jednotka 1', type: 'kanálová jednotka', manufacturer: 'Samsung', model: '?', status: 'plánováno-nezapojeno' },
    // rekuperace, kterou už dům upřesnil na jiný model → NESMÍ se přepsat
    { id: 'rekuperacni_jednotka', name: 'Rekuperace', type: 'rekuperace', manufacturer: 'Jinývýrobce', model: 'RUČNĚ-ZADANÝ', status: 'plánováno-nezapojeno' },
  ],
}, null, 2), 'utf8');
const upgraded = ensureTechnologyInventory(file2, docsDir2);
const s1 = upgraded.technologies.find(t => t.id === 'samsung_kanalova_jednotka_1');
assert.strictEqual(s1.model, 'LSP Slim Duct ACO71 (7,1 kW)', 'placeholder model se doplní ze seedu');
const rek = upgraded.technologies.find(t => t.id === 'rekuperacni_jednotka');
assert.strictEqual(rek.model, 'RUČNĚ-ZADANÝ', 'reálná hodnota se nesmí přepsat seedem');
assert.strictEqual(rek.manufacturer, 'Jinývýrobce', 'reálný výrobce se nesmí přepsat seedem');
fs.rmSync(tmp2, { recursive: true, force: true });

fs.rmSync(tmp, { recursive: true, force: true });
console.log('technology inventory contract OK');
