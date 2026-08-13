'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  SERVICES,
  serviceTiles,
  mockConnect,
  requestAuthorized,
  renderOnboardingHtml,
} = require('../service-onboarding');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zan-service-onboarding-'));
const stateFile = path.join(tmp, 'service_onboarding.json');
const token = 'app-token-123';

assert(SERVICES.length >= 5, 'v1 má víc než pár dlaždic, ne prázdný stub');

let tiles = serviceTiles(stateFile);
assert(tiles.some((s) => s.id === 'spotify' && s.needsAccount), 'Spotify má účet jako explicitní požadavek');
assert(tiles.some((s) => s.id === 'youtube-cast' && !s.needsAccount && s.status === 'no_login'), 'YouTube/Cast umí větev bez přihlášení');
assert(tiles.some((s) => s.statusLabel === 'Nejde teď'), 'poctivá blokace má vlastní stav');

assert.strictEqual(
  requestAuthorized({ headers: {} }, token, new URL('http://zan/onboarding?t=app-token-123')),
  true,
  'query token projde pro browser stránku',
);
assert.strictEqual(
  requestAuthorized({ headers: { authorization: 'Bearer app-token-123' } }, token, new URL('http://zan/api/onboarding/services')),
  true,
  'bearer token projde pro API klienta',
);
assert.strictEqual(
  requestAuthorized({ headers: {} }, token, new URL('http://zan/onboarding')),
  false,
  'bez tokenu fail-closed',
);
assert.strictEqual(
  requestAuthorized({ headers: {} }, '', new URL('http://zan/onboarding?t=app-token-123')),
  false,
  'bez očekávaného tokenu fail-closed',
);

const html = renderOnboardingHtml();
assert(html.includes('Připojení služeb'), 'HTML má zákaznickou onboarding obrazovku');
assert(html.includes('Heslo sem nikdy nepíšeš'), 'HTML nese bezpečnostní pravidlo bez hesel');
assert(!/<input\b[^>]*type=["']?password/i.test(html), 'HTML nesmí obsahovat password input');
assert(!/name=["']?password/i.test(html), 'HTML nesmí mít password pole ani jiným atributem');
assert(html.includes('/api/onboarding/mock-connect'), 'mock OAuth návrat je jen prototyp, žádné reálné OAuth volání');

let out = mockConnect(stateFile, 'spotify', new Date('2026-08-12T12:00:00.000Z'));
assert.strictEqual(out.ok, true, 'Spotify mock connect projde');
assert.strictEqual(out.service.status, 'connected', 'Spotify se po návratu přebarví na připojeno');
assert.strictEqual(out.service.connectedAt, '2026-08-12T12:00:00.000Z', 'stav se uloží do zákaznického zan_data');

out = mockConnect(stateFile, 'music-assistant');
assert.strictEqual(out.ok, false, 'blokovaná služba se netváří jako připojená');
assert.strictEqual(out.error, 'blocked', 'blokace je explicitní, ne tichá chyba');

out = mockConnect(stateFile, 'neexistuje');
assert.strictEqual(out.ok, false, 'neznámá služba se odmítne');

console.log('check-service-onboarding: OK (tiles + auth + no password inputs + mock state)');
