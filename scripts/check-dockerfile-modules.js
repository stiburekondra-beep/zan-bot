#!/usr/bin/env node
'use strict';
// Každý lokální modul, který bot.js vyžaduje, MUSÍ být v Dockerfile vyjmenovaný
// jako COPY — jinak image spadne hned při startu na MODULE_NOT_FOUND a Žán je
// celý dole (Telegram i hlasový kanál). Stalo se 2026-07-14 (polling-watchdog.js,
// v5.7.2) a znovu 2026-08-12 (play-video.js, v5.12.0). Tenhle test to hlídá
// strojově, ať se to nemusí pamatovat.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const bot = fs.readFileSync(path.join(root, 'bot.js'), 'utf8');
const dockerfile = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8');

// require('./modul') → modul.js (JSON a další přípony bereme, jak jsou zapsané)
const required = [...bot.matchAll(/require\(['"]\.\/([^'"]+)['"]\)/g)]
  .map(m => (path.extname(m[1]) ? m[1] : `${m[1]}.js`));

const copied = new Set(
  [...dockerfile.matchAll(/^COPY\s+([^\s]+)\s/gm)].map(m => m[1].replace(/^\.\//, '')),
);

const missing = [...new Set(required)].filter(f => !copied.has(f) && fs.existsSync(path.join(root, f)));

assert.deepStrictEqual(
  missing,
  [],
  `bot.js vyžaduje moduly, které Dockerfile nekopíruje do image (add-on by spadl na MODULE_NOT_FOUND): ${missing.join(', ')}`,
);

console.log(`dockerfile-modules ok: ${new Set(required).size} lokálních modulů bot.js je v Dockerfile`);
