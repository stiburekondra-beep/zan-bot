#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.resolve(__dirname, '..');
const botPath = path.join(root, 'bot.js');

function loadBotWithFastModel(model) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zan-model-options-'));
  delete require.cache[require.resolve(botPath)];
  process.env.ZAN_TEST_EXPORTS = '1';
  process.env.ZAN_DATA_DIR = tmp;
  process.env.TELEGRAM_TOKEN = '000000:test-token';
  process.env.CHAT_ID_ONDRA = '1001';
  process.env.CHAT_ID_JANA = '1002';
  process.env.EXTRA_CHAT_IDS = '';
  process.env.ANTHROPIC_API_KEY = 'test';
  process.env.OPENAI_API_KEY = 'test';
  process.env.HA_URL = 'http://127.0.0.1:8123';
  process.env.HA_TOKEN = 'test';
  process.env.ZAN_MODEL_FAST = model;
  process.env.ZAN_MODEL_SMART = 'claude-sonnet-5';
  process.env.ZAN_MODEL_SERVIS = 'claude-opus-4-8';
  return require(botPath);
}

let bot = loadBotWithFastModel('claude-sonnet-5');
assert.strictEqual(bot.modelSupportsTemperature('claude-sonnet-5'), false, 'sonnet-5 nesmí dostat temperature');
assert.strictEqual(bot.modelSupportsTemperature('claude-opus-4-8'), false, 'opus nesmí dostat temperature');
assert.deepStrictEqual(
  Object.keys(bot.claudeRequestOptionsForModel('claude-sonnet-5')).sort(),
  ['max_tokens'],
  'FAST=sonnet-5 request options nesmí obsahovat temperature',
);

bot = loadBotWithFastModel('claude-haiku-4-5');
const haikuOptions = bot.claudeRequestOptionsForModel('claude-haiku-4-5');
assert.strictEqual(haikuOptions.temperature, 0.35, 'haiku FAST si drží temperature');
assert.strictEqual(haikuOptions.max_tokens, 900, 'haiku FAST si drží krátký max_tokens');

assert.deepStrictEqual(
  Object.keys(bot.claudeRequestOptionsForModel('claude-opus-4-8')).sort(),
  ['max_tokens'],
  'SERVIS/opus request options nesmí obsahovat temperature',
);

console.log('Model request options OK');
