'use strict';

function createPollingWatchdog(bot, options = {}) {
  const now = options.now || (() => Date.now());
  const logger = options.logger || console;
  const staleMs = Number.isFinite(options.staleMs) ? options.staleMs : 10 * 60 * 1000;
  const checkEveryMs = Number.isFinite(options.checkEveryMs) ? options.checkEveryMs : 60 * 1000;
  const restartCooldownMs = Number.isFinite(options.restartCooldownMs) ? options.restartCooldownMs : 2 * 60 * 1000;
  const maxRestartFailures = Number.isFinite(options.maxRestartFailures) ? options.maxRestartFailures : 2;
  const alert = typeof options.alert === 'function' ? options.alert : null;
  const setTimer = options.setInterval || setInterval;
  const clearTimer = options.clearInterval || clearInterval;

  let lastSuccessfulGetUpdatesAt = now();
  let lastRestartAttemptAt = 0;
  let consecutiveRestartFailures = 0;
  let restartInProgress = false;
  let timer = null;
  let originalRequest = null;

  function markGetUpdatesOk() {
    lastSuccessfulGetUpdatesAt = now();
    consecutiveRestartFailures = 0;
  }

  function log(level, message, meta) {
    const fn = logger[level] || logger.log || (() => {});
    if (meta !== undefined) fn.call(logger, message, meta);
    else fn.call(logger, message);
  }

  function instrumentGetUpdates() {
    if (!bot || typeof bot._request !== 'function' || originalRequest) return false;

    originalRequest = bot._request.bind(bot);
    bot._request = async function watchedRequest(method, options) {
      const result = await originalRequest(method, options);
      if (method === 'getUpdates') markGetUpdatesOk();
      return result;
    };
    return true;
  }

  async function restartPolling(reason) {
    if (restartInProgress) return false;
    const ts = now();
    if (lastRestartAttemptAt && ts - lastRestartAttemptAt < restartCooldownMs) return false;

    restartInProgress = true;
    lastRestartAttemptAt = ts;
    try {
      log('warn', `Telegram polling watchdog: ${reason}; restartuji polling`);
      if (typeof bot.stopPolling === 'function') await bot.stopPolling({ cancel: true });
      if (typeof bot.startPolling === 'function') await bot.startPolling();
      lastSuccessfulGetUpdatesAt = now();
      consecutiveRestartFailures = 0;
      log('warn', 'Telegram polling watchdog: polling restartovan');
      return true;
    } catch (e) {
      consecutiveRestartFailures += 1;
      log('error', `Telegram polling watchdog: restart selhal: ${e.message}`);
      if (alert && consecutiveRestartFailures >= maxRestartFailures) {
        try {
          await alert(e, { consecutiveRestartFailures, lastSuccessfulGetUpdatesAt });
        } catch (alertError) {
          log('error', `Telegram polling watchdog: deadman alert selhal: ${alertError.message}`);
        }
      }
      return false;
    } finally {
      restartInProgress = false;
    }
  }

  async function check() {
    const ageMs = now() - lastSuccessfulGetUpdatesAt;
    if (ageMs <= staleMs) return false;
    return restartPolling(`posledni uspesny getUpdates je stary ${Math.round(ageMs / 1000)} s`);
  }

  function start() {
    instrumentGetUpdates();
    if (!timer) timer = setTimer(check, checkEveryMs);
    return api;
  }

  function stop() {
    if (timer) clearTimer(timer);
    timer = null;
  }

  const api = {
    start,
    stop,
    check,
    restartPolling,
    markGetUpdatesOk,
    instrumentGetUpdates,
    getState: () => ({
      lastSuccessfulGetUpdatesAt,
      lastRestartAttemptAt,
      consecutiveRestartFailures,
      restartInProgress,
      staleMs,
      checkEveryMs,
      restartCooldownMs
    })
  };

  return api;
}

module.exports = { createPollingWatchdog };
