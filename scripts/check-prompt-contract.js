#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'bot.js'), 'utf8');

function normalize(text) {
  return String(text)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[–—]/g, '-')
    .toLowerCase();
}

const text = normalize(source);

function assertIncludes(needle, label) {
  const normalizedNeedle = normalize(needle);
  if (!text.includes(normalizedNeedle)) {
    throw new Error(`Missing prompt contract: ${label}`);
  }
}

function assertRegex(regex, label) {
  if (!regex.test(text)) {
    throw new Error(`Missing prompt contract: ${label}`);
  }
}

assertIncludes('STYL ODPOVEDI', 'style section exists');
assertIncludes('Bezna odpoved ma max 3-4 kratke vety', 'default answer length');
assertIncludes('Pis jednoduse jako cloveku v kuchyni', 'human tone stays');
assertIncludes('Nepouzivej seznamy, nadpisy ani tabulky', 'lists are not default');
assertIncludes('report, inventuru zarizeni, rozpocet, potvrzeni citlive akce ci YAML/admin vystup', 'structured-output exceptions');
assertIncludes('Emoji nejvys jedno', 'emoji limit');
assertIncludes('Kdyz je tema velke, dej kratke jadro odpovedi a nabidni pokracovani', 'offer continuation instead of flooding');

assertRegex(/const\s+fast_max_tokens\s*=\s*900\s*;/, 'FAST max token limit');
assertRegex(/temperature:\s*model\s*===\s*model_fast\s*\?\s*0\.35\s*:\s*0\.5/, 'FAST lower temperature');
assertRegex(/model\s*===\s*model_servis[\s\S]*servis/, 'service/admin route still exists');

console.log('Prompt contract OK');
