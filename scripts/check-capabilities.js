const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const botPath = path.join(root, 'bot.js');
const registryPath = path.join(root, 'zan_capabilities.json');
const skillsPath = process.env.ZAN_SKILLS_PATH
  ? path.resolve(process.env.ZAN_SKILLS_PATH)
  : path.resolve(root, '..', 'CHoS-', 'projects', 'baklazan', 'zan', 'SKILLS.md');

function findFunctionBody(source, functionName) {
  const marker = `function ${functionName}`;
  const start = source.indexOf(marker);
  assert(start >= 0, `${functionName} not found`);
  const open = source.indexOf('{', start);
  assert(open >= 0, `${functionName} body start not found`);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '{') depth += 1;
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  throw new Error(`${functionName} body end not found`);
}

function extractToolNamesFromBot(source) {
  const body = findFunctionBody(source, 'buildTools');
  return Array.from(body.matchAll(/\bname:\s*['"`]([a-zA-Z0-9_]+)['"`]/g), m => m[1]);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function uniqueSorted(values) {
  return Array.from(new Set(values)).sort();
}

function diff(left, right) {
  const rightSet = new Set(right);
  return left.filter(item => !rightSet.has(item));
}

const botNames = uniqueSorted(extractToolNamesFromBot(fs.readFileSync(botPath, 'utf8')));
const registry = readJson(registryPath);
assert.strictEqual(registry.version, 1, 'registry version must be 1');
assert(Array.isArray(registry.capabilities), 'registry.capabilities must be an array');

const registryNames = registry.capabilities.map(c => c.name);
assert.strictEqual(new Set(registryNames).size, registryNames.length, 'capabilities must be unique');

for (const cap of registry.capabilities) {
  assert(cap.name && typeof cap.name === 'string', 'capability.name is required');
  assert(cap.scope && typeof cap.scope === 'string', `${cap.name}: scope is required`);
  assert.strictEqual(typeof cap.admin_only, 'boolean', `${cap.name}: admin_only must be boolean`);
  assert.strictEqual(typeof cap.skills_required, 'boolean', `${cap.name}: skills_required must be boolean`);
}

assert.deepStrictEqual(diff(botNames, registryNames), [], 'bot.js tools missing from zan_capabilities.json');
assert.deepStrictEqual(diff(registryNames, botNames), [], 'zan_capabilities.json tools missing from bot.js buildTools()');

if (!fs.existsSync(skillsPath)) {
  throw new Error(`SKILLS.md not found: ${skillsPath}. Set ZAN_SKILLS_PATH when running outside /opt/baklazan.`);
}

const skillsText = fs.readFileSync(skillsPath, 'utf8');
const missingFromSkills = registry.capabilities
  .filter(cap => cap.skills_required)
  .map(cap => cap.name)
  .filter(name => !skillsText.includes(`\`${name}\``));

assert.deepStrictEqual(missingFromSkills, [], 'SKILLS.md missing capability rows');

console.log(`capabilities ok: ${registryNames.length} tools checked against bot.js and SKILLS.md`);
