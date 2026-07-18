const assert = require('assert');
const { formatBudgetReport } = require('../budget-report');

const now = new Date('2026-07-18T09:30:00Z');
const defaultModel = 'claude-3-5-haiku-latest';

const legacyReport = formatBudgetReport({
  days: {
    '2026-07-18': {
      calls: 12,
      input: 10000,
      output: 1200,
      cache_read: 25000,
      cache_write: 500,
    },
  },
}, { now, defaultModel });

assert(legacyReport.includes('*Spotřeba Žána*'));
assert(legacyReport.includes('*Dnes:* 12 volání'));
assert(legacyReport.includes('3-5-haiku-latest: 12×'));
assert(legacyReport.includes('souhrn bez stitku modelu'));
assert(legacyReport.includes('*Tento měsíc:* 12 volání'));
assert(!legacyReport.includes('Dnešní útrata:'));

const modelReport = formatBudgetReport({
  days: {
    '2026-07-18': {
      calls: 3,
      input: 3000,
      output: 900,
      cache_read: 1000,
      cache_write: 100,
      models: {
        'claude-3-5-haiku-latest': { calls: 2, input: 2000, output: 500, cache_read: 1000, cache_write: 100 },
        'claude-sonnet-4-20250514': { calls: 1, input: 1000, output: 400, cache_read: 0, cache_write: 0 },
      },
    },
  },
}, { now, defaultModel });

assert(modelReport.includes('3-5-haiku-latest: 2×'));
assert(modelReport.includes('sonnet-4-20250514: 1×'));
assert(!modelReport.includes('souhrn bez stitku modelu'));
assert(modelReport.includes('*Tento měsíc:* 3 volání'));

console.log('budget report contract OK');
