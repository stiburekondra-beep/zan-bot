#!/usr/bin/env node

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'bot.js'), 'utf8');
const dockerfile = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8');

assert.match(source, /const\s+LOCAL_TIME_ZONE\s*=\s*process\.env\.ZAN_TIME_ZONE\s*\|\|\s*'Europe\/Prague'/, 'bot has Europe/Prague fallback');
assert.match(source, /process\.env\.TZ\s*=\s*LOCAL_TIME_ZONE/, 'bot sets process TZ from local timezone');
assert.match(source, /timeZone:\s*LOCAL_TIME_ZONE/, 'bot formats dynamic time with explicit local timezone');
assert.match(source, /Čas:\s*\$\{formatLocalDateTime\(\)\}\s*\(\$\{LOCAL_TIME_ZONE\},\s*\$\{localDayPeriod\(\)\}\)/, 'dynamic context includes local time, timezone and day period');
assert.match(source, /noc \/ po půlnoci/, 'midnight is labelled as night after midnight');
assert.match(dockerfile, /apk add --no-cache[^\n]*tzdata/, 'Docker image installs tzdata');
assert.match(dockerfile, /ENV\s+TZ=Europe\/Prague/, 'Docker image sets TZ');

const sampleUtc = new Date('2026-07-15T22:31:00Z');
const parts = Object.fromEntries(new Intl.DateTimeFormat('cs-CZ', {
  timeZone: 'Europe/Prague',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
}).formatToParts(sampleUtc).filter(p => p.type !== 'literal').map(p => [p.type, p.value]));

assert.deepStrictEqual(parts, { hour: '00', minute: '31' }, '2026-07-15T22:31Z is 00:31 in Prague');

console.log('Local time context contract OK');
