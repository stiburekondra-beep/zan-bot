'use strict';
// ═══════════════════════════════════════════════════════════════════════
// subscription-auth.js — IZOLOVANÝ PROTOTYP (feature-flag OFF by default)
//
// Cíl (karta 2026-08-16-programator-zana-02, Ondrova volba C): umožnit
// domácímu Žánovi běžet na PŘEDPLATNÉM (Claude Max/Pro přes komunitní OAuth
// proxy) a na placené API se přepnout JEN když je tarif vyčerpaný (429/limit),
// po cooldownu (okno tarifu) zpět na předplatné.
//
// POCTIVÁ HRANA (Ondra ji zná z research/2026-08-17_zan-predplatne-vs-api.md
// a přesto zvolil C na FIREMNÍM účtu): autentizace bota přes předplatné je
// proti podmínkám Anthropic a NEpřenositelná na zákazníky. Proto:
//   • DEFAULT = 'api' → produkce běží beze změny, tenhle modul nic neovlivní.
//   • Subscription režim se aktivuje VÝHRADNĚ vědomým nastavením env
//     (ZAN_AUTH_MODE=subscription + proxy URL + token) na firemním účtu.
//   • Cokoli chybí/půl-nastavené → fail-safe fallback na 'api' (bot nikdy
//     nespadne kvůli neúplné subscription konfiguraci).
//
// Tenhle modul je ČISTÝ (žádný SDK ani síť) → plně jednotkově testovatelný.
// Živé ověření OAuth proxy cesty je GATOVANÉ na Ondrův firemní-účet test,
// ne součást téhle vrstvy (nefabulujeme, že proxy reálně vrací completiony).
// ═══════════════════════════════════════════════════════════════════════

const DEFAULT_COOLDOWN_MS = 5 * 60 * 60 * 1000; // 5 h = typické okno tarifu předplatného

// Přečti auth konfiguraci z prostředí. Vrací i `reason`, proč subscription
// NENÍ aktivní (diagnostika bez fabulace).
function resolveAuthConfig(env = process.env) {
  const requested = String(env.ZAN_AUTH_MODE || 'api').trim().toLowerCase();
  const proxyUrl = String(env.ZAN_SUBSCRIPTION_PROXY_URL || '').trim();
  const token = String(env.ZAN_SUBSCRIPTION_TOKEN || '').trim();

  let cooldownMs = parseInt(env.ZAN_SUBSCRIPTION_COOLDOWN_MS || String(DEFAULT_COOLDOWN_MS), 10);
  if (!Number.isFinite(cooldownMs) || cooldownMs <= 0) cooldownMs = DEFAULT_COOLDOWN_MS;

  let reason = 'ok';
  if (requested !== 'subscription') reason = 'not_requested';
  else if (!proxyUrl) reason = 'missing_proxy_url';
  else if (!token) reason = 'missing_token';

  const active = reason === 'ok';
  return {
    requested,
    mode: active ? 'subscription' : 'api', // efektivní režim (fail-safe na 'api')
    active,
    reason,
    proxyUrl,
    token,
    cooldownMs,
  };
}

// Je chyba "tarif vyčerpán / přetížení" (→ přepnout na API)? Konzervativně:
// jen 429 a rate_limit/overloaded typy. 4xx/validace se NEbere jako limit,
// aby se nezacyklila legitimní chyba requestu (past z play-music retry).
function isLimitError(err) {
  if (!err) return false;
  const status = err.status || err.statusCode || (err.response && err.response.status);
  if (status === 429) return true;
  const t = String((err.error && err.error.type) || err.type || '').toLowerCase();
  return t.includes('rate_limit') || t.includes('overloaded');
}

// Parametry pro Anthropic klienta v subscription režimu (proxy baseURL +
// OAuth Bearer token). NEVYTVÁŘÍ klienta — jen vrací options, ať jde
// otestovat volbu bez SDK/sítě.
function subscriptionClientOptions(cfg) {
  return {
    baseURL: cfg.proxyUrl,
    authToken: cfg.token, // SDK pošle `Authorization: Bearer <token>` místo x-api-key
  };
}

// Stavový automat: který režim teď použít + kdy zpět na subscription po limitu.
// `now` se injektuje → testovatelné bez reálného času.
class SubscriptionRouter {
  constructor(cfg, now = Date.now) {
    this.cfg = cfg || { active: false, cooldownMs: DEFAULT_COOLDOWN_MS };
    this.now = now;
    this.limitedUntil = 0; // do kdy jedeme na API po vyčerpání tarifu
  }

  // 'subscription' jen když je aktivní a NEjsme v cooldownu; jinak 'api'.
  currentMode() {
    if (!this.cfg.active) return 'api';
    return this.now() < this.limitedUntil ? 'api' : 'subscription';
  }

  // Zavolej po limit-chybě na subscription cestě → spusť cooldown na okno tarifu.
  markLimited() {
    if (!this.cfg.active) return; // v api režimu nemá cooldown smysl
    this.limitedUntil = this.now() + this.cfg.cooldownMs;
  }

  msUntilSubscription() {
    return Math.max(0, this.limitedUntil - this.now());
  }
}

module.exports = {
  DEFAULT_COOLDOWN_MS,
  resolveAuthConfig,
  isLimitError,
  subscriptionClientOptions,
  SubscriptionRouter,
};
