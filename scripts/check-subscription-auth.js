#!/usr/bin/env node
'use strict';
// Kontrakt pro subscription-auth.js (karta 2026-08-16-programator-zana-02).
// Hlídá zejména BEZPEČNÝ DEFAULT: bez explicitní subscription konfigurace
// je efektivní režim vždy 'api' → produkce beze změny (feature-flag OFF).

const assert = require('assert');
const {
  DEFAULT_COOLDOWN_MS,
  resolveAuthConfig,
  isLimitError,
  subscriptionClientOptions,
  SubscriptionRouter,
} = require('../subscription-auth');

let n = 0;
const ok = (msg) => { n++; };

// ─── 1) DEFAULT OFF: prázdné prostředí → 'api', nic se neaktivuje ──────────
{
  const cfg = resolveAuthConfig({});
  assert.strictEqual(cfg.mode, 'api', 'prázdné env musí dát api režim');
  assert.strictEqual(cfg.active, false, 'prázdné env: subscription NEaktivní');
  assert.strictEqual(cfg.reason, 'not_requested');
  ok('default OFF');
}

// ─── 2) subscription požadován, ale nekompletní → fail-safe 'api' ──────────
{
  const noProxy = resolveAuthConfig({ ZAN_AUTH_MODE: 'subscription', ZAN_SUBSCRIPTION_TOKEN: 't' });
  assert.strictEqual(noProxy.mode, 'api', 'bez proxy URL musí fallback na api');
  assert.strictEqual(noProxy.active, false);
  assert.strictEqual(noProxy.reason, 'missing_proxy_url');

  const noToken = resolveAuthConfig({ ZAN_AUTH_MODE: 'subscription', ZAN_SUBSCRIPTION_PROXY_URL: 'https://p' });
  assert.strictEqual(noToken.mode, 'api', 'bez tokenu musí fallback na api');
  assert.strictEqual(noToken.active, false);
  assert.strictEqual(noToken.reason, 'missing_token');
  ok('nekompletní subscription → api');
}

// ─── 3) plně nakonfigurovaný subscription → aktivní ────────────────────────
{
  const cfg = resolveAuthConfig({
    ZAN_AUTH_MODE: 'subscription',
    ZAN_SUBSCRIPTION_PROXY_URL: 'https://proxy.local/v1',
    ZAN_SUBSCRIPTION_TOKEN: 'oauth-abc',
  });
  assert.strictEqual(cfg.mode, 'subscription');
  assert.strictEqual(cfg.active, true);
  assert.strictEqual(cfg.reason, 'ok');
  assert.strictEqual(cfg.cooldownMs, DEFAULT_COOLDOWN_MS, 'default cooldown = 5 h');
  ok('plná konfigurace → aktivní');
}

// ─── 4) neplatný cooldown → default (fail-safe) ────────────────────────────
{
  const bad = resolveAuthConfig({
    ZAN_AUTH_MODE: 'subscription',
    ZAN_SUBSCRIPTION_PROXY_URL: 'https://p',
    ZAN_SUBSCRIPTION_TOKEN: 't',
    ZAN_SUBSCRIPTION_COOLDOWN_MS: '-5',
  });
  assert.strictEqual(bad.cooldownMs, DEFAULT_COOLDOWN_MS);
  const good = resolveAuthConfig({
    ZAN_AUTH_MODE: 'subscription',
    ZAN_SUBSCRIPTION_PROXY_URL: 'https://p',
    ZAN_SUBSCRIPTION_TOKEN: 't',
    ZAN_SUBSCRIPTION_COOLDOWN_MS: '60000',
  });
  assert.strictEqual(good.cooldownMs, 60000);
  ok('cooldown validace');
}

// ─── 5) isLimitError: jen 429 / rate_limit / overloaded ────────────────────
{
  assert.strictEqual(isLimitError({ status: 429 }), true);
  assert.strictEqual(isLimitError({ response: { status: 429 } }), true);
  assert.strictEqual(isLimitError({ error: { type: 'rate_limit_error' } }), true);
  assert.strictEqual(isLimitError({ type: 'overloaded_error' }), true);
  assert.strictEqual(isLimitError({ status: 400 }), false, '4xx validace není limit');
  assert.strictEqual(isLimitError({ status: 500 }), false, '5xx server error není limit-switch');
  assert.strictEqual(isLimitError(null), false);
  ok('isLimitError klasifikace');
}

// ─── 6) subscriptionClientOptions: proxy + Bearer token ────────────────────
{
  const cfg = resolveAuthConfig({
    ZAN_AUTH_MODE: 'subscription',
    ZAN_SUBSCRIPTION_PROXY_URL: 'https://proxy.local/v1',
    ZAN_SUBSCRIPTION_TOKEN: 'oauth-abc',
  });
  const opts = subscriptionClientOptions(cfg);
  assert.strictEqual(opts.baseURL, 'https://proxy.local/v1');
  assert.strictEqual(opts.authToken, 'oauth-abc');
  assert.ok(!('apiKey' in opts) || opts.apiKey == null, 'v subscription režimu se API klíč nepoužívá');
  ok('client options');
}

// ─── 7) SubscriptionRouter — přepínání a cooldown (injektovaný čas) ─────────
{
  let t = 1000;
  const clock = () => t;
  const cfg = resolveAuthConfig({
    ZAN_AUTH_MODE: 'subscription',
    ZAN_SUBSCRIPTION_PROXY_URL: 'https://p',
    ZAN_SUBSCRIPTION_TOKEN: 'x',
    ZAN_SUBSCRIPTION_COOLDOWN_MS: '10000',
  });
  const r = new SubscriptionRouter(cfg, clock);
  assert.strictEqual(r.currentMode(), 'subscription', 'start: jede na subscription');

  r.markLimited(); // tarif vyčerpán
  assert.strictEqual(r.currentMode(), 'api', 'po limitu: přepnuto na api');
  assert.strictEqual(r.msUntilSubscription(), 10000);

  t += 9999;
  assert.strictEqual(r.currentMode(), 'api', 'těsně před koncem cooldownu ještě api');
  t += 2;
  assert.strictEqual(r.currentMode(), 'subscription', 'po cooldownu zpět na subscription');
  ok('router přepínání + cooldown');
}

// ─── 8) inactive router (api režim) → vždy api, markLimited je no-op ────────
{
  const r = new SubscriptionRouter(resolveAuthConfig({}), () => 0);
  assert.strictEqual(r.currentMode(), 'api');
  r.markLimited();
  assert.strictEqual(r.currentMode(), 'api', 'v api režimu markLimited nic nemění');
  assert.strictEqual(r.msUntilSubscription(), 0);
  ok('inactive router');
}

console.log(`subscription-auth ok: ${n} kontrol PASS`);
