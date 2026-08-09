'use strict';

const assert = require('assert');
const { createPollingWatchdog } = require('../polling-watchdog');

async function testRestartOnStalePolling() {
  let currentTime = 1_000_000;
  const calls = [];
  const fakeBot = {
    async _request(method) {
      calls.push(['request', method]);
      return { ok: true };
    },
    async stopPolling(options) {
      calls.push(['stopPolling', options]);
    },
    async startPolling(options) {
      calls.push(['startPolling', options]);
    }
  };

  const watchdog = createPollingWatchdog(fakeBot, {
    now: () => currentTime,
    staleMs: 1000,
    checkEveryMs: 100,
    restartCooldownMs: 0,
    setInterval: () => 1,
    clearInterval: () => {},
    logger: { log() {}, warn() {}, error() {} }
  }).start();

  await fakeBot._request('getUpdates');
  currentTime += 1500;
  const restarted = await watchdog.check();

  assert.strictEqual(restarted, true);
  assert.deepStrictEqual(calls, [
    ['request', 'getUpdates'],
    ['stopPolling', { cancel: true }],
    ['startPolling', { restart: true }]
  ]);
  assert.strictEqual(watchdog.getState().consecutiveRestartFailures, 0);
}

// Regrese incidentu 2026-08-08: node-telegram-bot-api 0.66 hází při
// stopPolling({cancel:true}) na zaseknutém requestu TypeError
// „lastRequest.cancel is not a function". Watchdog to MUSÍ přežít a
// startPolling přesto zavolat — jinak zůstane příjem mrtvý (reálně 7×
// „restart selhal", bot hluchý ~4,5 h). Před fixem tenhle test padal.
async function testRecoversWhenStopPollingThrows() {
  let currentTime = 3_000_000;
  const calls = [];
  const fakeBot = {
    async _request(method) {
      calls.push(['request', method]);
      return { ok: true };
    },
    async stopPolling(options) {
      calls.push(['stopPolling', options]);
      throw new TypeError('lastRequest.cancel is not a function');
    },
    async startPolling(options) {
      calls.push(['startPolling', options]);
    }
  };

  const watchdog = createPollingWatchdog(fakeBot, {
    now: () => currentTime,
    staleMs: 1000,
    checkEveryMs: 100,
    restartCooldownMs: 0,
    setInterval: () => 1,
    clearInterval: () => {},
    logger: { log() {}, warn() {}, error() {} }
  }).start();

  await fakeBot._request('getUpdates');
  currentTime += 1500;
  const restarted = await watchdog.check();

  // Recovery MUSÍ uspět i přes pád stopPolling a startPolling se MUSÍ volat.
  assert.strictEqual(restarted, true, 'recovery musí uspět i když stopPolling hodí TypeError');
  assert.deepStrictEqual(calls, [
    ['request', 'getUpdates'],
    ['stopPolling', { cancel: true }],
    ['startPolling', { restart: true }]
  ]);
  assert.strictEqual(watchdog.getState().consecutiveRestartFailures, 0);
}

async function testDeadmanAlertAfterRepeatedRestartFailures() {
  let currentTime = 2_000_000;
  let alerts = 0;
  const fakeBot = {
    async _request() {
      return { ok: true };
    },
    async stopPolling() {},
    async startPolling() {
      throw new Error('simulated start failure');
    }
  };

  const watchdog = createPollingWatchdog(fakeBot, {
    now: () => currentTime,
    staleMs: 1000,
    restartCooldownMs: 0,
    maxRestartFailures: 2,
    setInterval: () => 1,
    clearInterval: () => {},
    logger: { log() {}, warn() {}, error() {} },
    alert: async () => { alerts += 1; }
  }).start();

  currentTime += 1500;
  assert.strictEqual(await watchdog.check(), false);
  currentTime += 1500;
  assert.strictEqual(await watchdog.check(), false);

  assert.strictEqual(alerts, 1);
  assert.strictEqual(watchdog.getState().consecutiveRestartFailures, 2);
}

async function main() {
  await testRestartOnStalePolling();
  await testRecoversWhenStopPollingThrows();
  await testDeadmanAlertAfterRepeatedRestartFailures();
  console.log('polling watchdog contract OK');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
