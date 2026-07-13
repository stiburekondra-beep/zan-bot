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
    async startPolling() {
      calls.push(['startPolling']);
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
    ['startPolling']
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
  await testDeadmanAlertAfterRepeatedRestartFailures();
  console.log('polling watchdog contract OK');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
