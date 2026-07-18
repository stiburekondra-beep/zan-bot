const USD_CZK_DEFAULT = 23;

const EMPTY_USAGE = { calls: 0, input: 0, output: 0, cache_read: 0, cache_write: 0 };

function usageBucket(d = {}) {
  return {
    calls: d.calls || 0,
    input: d.input || 0,
    output: d.output || 0,
    cache_read: d.cache_read || 0,
    cache_write: d.cache_write || 0,
    models: d.models || null,
  };
}

function modelPricing(model = '') {
  // [input, output, cache_read, cache_write] USD za MTok.
  const m = String(model);
  if (m.includes('haiku')) return [1, 5, 0.1, 1.25];
  if (m.includes('opus')) return [15, 75, 1.5, 18.75];
  return [3, 15, 0.3, 3.75]; // sonnet a ostatni
}

function usageCostUsd(d, defaultModel = '') {
  const day = usageBucket(d);
  if (day.models && Object.keys(day.models).length) {
    return Object.entries(day.models).reduce((sum, [m, v]) => {
      const b = usageBucket(v);
      const [pi, po, pcr, pcw] = modelPricing(m);
      return sum + (b.input * pi + b.output * po + b.cache_read * pcr + b.cache_write * pcw) / 1e6;
    }, 0);
  }
  const [pi, po, pcr, pcw] = modelPricing(defaultModel);
  return (day.input * pi + day.output * po + day.cache_read * pcr + day.cache_write * pcw) / 1e6;
}

function aggregateUsage(days) {
  return days.reduce((a, v) => {
    const b = usageBucket(v);
    return {
      calls: a.calls + b.calls,
      input: a.input + b.input,
      output: a.output + b.output,
      cache_read: a.cache_read + b.cache_read,
      cache_write: a.cache_write + b.cache_write,
    };
  }, { ...EMPTY_USAGE });
}

function todayModelBuckets(day, defaultModel) {
  const d = usageBucket(day);
  if (d.models && Object.keys(d.models).length) {
    return Object.entries(d.models).map(([model, usage]) => ({
      model,
      usage: usageBucket(usage),
      legacy: false,
    }));
  }
  if (d.calls > 0) {
    return [{
      model: defaultModel || 'neznamy-model',
      usage: d,
      legacy: true,
    }];
  }
  return [];
}

function shortModelName(model) {
  return String(model || 'neznamy-model').replace(/^claude-/, '');
}

function formatBudgetReport(usage, opts = {}) {
  const defaultModel = opts.defaultModel || '';
  const usdCzk = opts.usdCzk || USD_CZK_DEFAULT;
  const now = opts.now instanceof Date ? opts.now : new Date(opts.now || Date.now());
  const days = (usage && usage.days) || {};
  const today = now.toISOString().slice(0, 10);
  const month = today.slice(0, 7);
  const d = usageBucket(days[today]);
  const monthDays = Object.entries(days).filter(([k]) => k.startsWith(month));
  const m = aggregateUsage(monthDays.map(([, v]) => v));
  const dUsd = usageCostUsd(d, defaultModel);
  const mUsd = monthDays.reduce((s, [, v]) => s + usageCostUsd(v, defaultModel), 0);

  const perModel = todayModelBuckets(d, defaultModel)
    .map(({ model, usage: v, legacy }) => {
      const usd = usageCostUsd(v, model);
      const note = legacy ? ' (souhrn bez stitku modelu)' : '';
      return `• ${shortModelName(model)}: ${v.calls}× ≈ ${(usd * usdCzk).toFixed(2)} Kč${note}`;
    })
    .join('\n');

  return (
    `💰 *Spotřeba Žána* (výchozí model: ${defaultModel || 'neznamy'})\n\n` +
    `*Dnes:* ${d.calls} volání\n` +
    `• input ${d.input.toLocaleString('cs-CZ')} | output ${d.output.toLocaleString('cs-CZ')}\n` +
    `• cache: čtení ${d.cache_read.toLocaleString('cs-CZ')} | zápis ${d.cache_write.toLocaleString('cs-CZ')}\n` +
    `• ≈ $${dUsd.toFixed(3)} (${(dUsd * usdCzk).toFixed(2)} Kč)\n` +
    (perModel ? `${perModel}\n` : '• modely: dnes zatím žádná spotřeba\n') +
    `\n*Tento měsíc:* ${m.calls} volání ≈ $${mUsd.toFixed(2)} (${(mUsd * usdCzk).toFixed(0)} Kč)\n\n` +
    `_Sleduje se od v5.3.3 — starší spotřeba v console.anthropic.com_`
  );
}

module.exports = { modelPricing, usageCostUsd, formatBudgetReport };
