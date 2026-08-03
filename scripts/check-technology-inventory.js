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
  'Samsung kanálová jednotka 1',
  'Samsung kanálová jednotka 2',
  'Rekuperační jednotka',
]);

for (const item of inventory.technologies) {
  assert.strictEqual(item.status, 'plánováno-nezapojeno');
  assert.strictEqual(item.model, '?');
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

fs.rmSync(tmp, { recursive: true, force: true });
console.log('technology inventory contract OK');
