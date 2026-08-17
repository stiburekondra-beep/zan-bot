const assert = require('assert');
const { guardActionClaim } = require('../action-claim-guard');

// Nástroje, které v kole úspěšně proběhly. Prázdné = model jen mluvil.
const NONE = [];
const UNDO_OK = [{ name: 'undo_last_change', ok: true }];
const UNDO_FAIL = [{ name: 'undo_last_change', ok: false }];
const WRITE_OK = [{ name: 'write_package', ok: true }];
const DELETE_OK = [{ name: 'delete_package', ok: true }];
const RESTART_OK = [{ name: 'restart_ha', ok: true }];
const TURN_ON_OK = [{ name: 'turn_on', ok: true }];
const TURN_ON_FAIL = [{ name: 'turn_on', ok: false }];
const CALL_SERVICE_OK = [{ name: 'call_service', ok: true }];
const ENTITY_ARCHIVE_OK = [{ name: 'entity_archive', ok: true }];
const PERMIT_JOIN_OK = [{ name: 'zigbee_permit_join', ok: true }];
const PERMIT_JOIN_FAIL = [{ name: 'zigbee_permit_join', ok: false }];

// ── 1) PŘESNÁ repro věta z bugu (msg #3): undo bez tool callu → FIRE ──────────
const bug1 = 'Vrátil jsem poslední zápis — balíček je smazaný a HA ho už nezná.';
const r1 = guardActionClaim(bug1, 'Vrať prosím tu poslední změnu zpátky.', NONE);
assert.strictEqual(r1.changed, true, '1: fabrikovaný undo musí být zachycen');
assert.strictEqual(r1.fabricatedConfig, true, '1: fabricatedConfig');
assert.ok(/neudělal|nestalo|neproběhl/i.test(r1.text), '1: poctivé přiznání');
assert.ok(!/Vrátil jsem poslední zápis/.test(r1.text), '1: původní lež nesmí zůstat');

// ── 2) Druhá repro věta z bugu (msg #4-turn): stavová fráze bez toolu → FIRE ──
const bug2 = 'Balíček je zpátky — automatizace test_svetlo běží zase normálně.';
const r2 = guardActionClaim(bug2, 'ano, vrať to', NONE);
assert.strictEqual(r2.changed, true, '2: „balíček je zpátky" bez undo musí být zachyceno');

// ── 3) STEJNÁ věta, ale undo TENTOKRÁT proběhlo úspěšně → SILENT (legit) ──────
const r3 = guardActionClaim(bug1, 'Vrať prosím tu poslední změnu zpátky.', UNDO_OK);
assert.strictEqual(r3.changed, false, '3: po úspěšném undo je tvrzení pravdivé');
assert.strictEqual(r3.text, bug1, '3: text beze změny');

// ── 4) Tool zavolán, ale SELHAL (case b), model přesto tvrdí hotovo → FIRE ────
const r4 = guardActionClaim(bug1, 'vrať to', UNDO_FAIL);
assert.strictEqual(r4.changed, true, '4: neúspěšný tool + tvrzení úspěchu = fabrikace');

// ── 5) write_package: „balíček je zapsaný" bez toolu → FIRE; s toolem → SILENT
const w = 'Balíček je zapsaný a automatizace běží.';
assert.strictEqual(guardActionClaim(w, 'založ balíček dvojce_test', NONE).changed, true, '5a: fabrikovaný zápis');
assert.strictEqual(guardActionClaim(w, 'založ balíček dvojce_test', WRITE_OK).changed, false, '5b: reálný zápis je legit');

// ── 6) delete_package: „smazal jsem balíček" ─────────────────────────────────
const d = 'Smazal jsem balíček dvojce_test, konfigurace je čistá.';
assert.strictEqual(guardActionClaim(d, 'smaž ten balíček', NONE).changed, true, '6a: fabrikované smazání');
assert.strictEqual(guardActionClaim(d, 'smaž ten balíček', DELETE_OK).changed, false, '6b: reálné smazání je legit');

// ── 7) restart_ha ────────────────────────────────────────────────────────────
const rs = 'Restartoval jsem Home Assistant, za chvíli naběhne.';
assert.strictEqual(guardActionClaim(rs, 'restartuj HA', NONE).fabricatedRestart, true, '7a: fabrikovaný restart');
assert.strictEqual(guardActionClaim(rs, 'restartuj HA', RESTART_OK).changed, false, '7b: reálný restart je legit');

// ── 8) FALSE-POSITIVE OBRANA: uživatel NEŽÁDAL akci (jen poděkoval),
//        model odkazuje na dřívější úspěch → SILENT (gate 1 chrání) ───────────
const later = 'Není zač! Balíček je zpátky a automatizace běží normálně dál.';
const r8 = guardActionClaim(later, 'super, díky moc', NONE);
assert.strictEqual(r8.changed, false, '8: bez žádosti uživatele se guard nesmí spustit (opačný FP)');
assert.strictEqual(r8.text, later, '8: text beze změny');

// ── 9) FALSE-POSITIVE OBRANA: budoucí/podmíněný slib, ne dokončení → SILENT ───
const future = 'Můžu ti tu poslední změnu vrátit přes undo_last_change, mám to udělat?';
assert.strictEqual(guardActionClaim(future, 'vrať to prosím', NONE).changed, false, '9: nabídka ≠ tvrzení hotovo');

// ── 10) FALSE-POSITIVE OBRANA: reflexivní „vrátil jsem SE" ────────────────────
const reflex = 'Vrátil jsem se k tomu balíčku a našel jsem v něm chybu ve struktuře.';
assert.strictEqual(guardActionClaim(reflex, 'vrať se k tomu balíčku', NONE).changed, false, '10: „vrátil jsem se" není akce nad configem');

// ── 11) FALSE-POSITIVE OBRANA: běžná ne-admin odpověď → SILENT ────────────────
const normal = 'V obýváku je teď 21,5 °C a světlo svítí. Chceš ještě něco?';
assert.strictEqual(guardActionClaim(normal, 'jaká je teplota v obýváku?', NONE).changed, false, '11: běžná odpověď se nesmí měnit');

// ── 12) Prázdný / nevalidní vstup → no-op ────────────────────────────────────
assert.strictEqual(guardActionClaim('', 'cokoli', NONE).changed, false, '12a: prázdný text');
assert.strictEqual(guardActionClaim(null, 'cokoli', NONE).changed, false, '12b: null text');
assert.strictEqual(guardActionClaim(bug1, 'vrať to', null).changed, true, '12c: chybějící actionCalls = žádný tool = fabrikace');

// ── 13) ŽIVÝ BUG 2026-08-12: „Hotovo, traktory hrají na televizi" bez nástroje ─
const mediaLie = 'Hotovo! "Traktory v blátě" teď hrají na televizi v pokoji.';
const r13 = guardActionClaim(mediaLie, 'pusť na youtube traktory v blátě', NONE);
assert.strictEqual(r13.changed, true, '13a: tvrzení o puštěném videu bez nástroje = fabrikace');
assert.strictEqual(r13.fabricatedMedia, true, '13b: označeno jako fabrikace média');
assert(r13.text.includes('puštění hudby nebo videa'), '13c: přiznání pojmenuje, co se nestalo');

// ── 14) Legitimní: nástroj proběhl → věta o hraní projde beze změny ──────────
const mediaOk = guardActionClaim(mediaLie, 'pusť na youtube traktory v blátě', [{ name: 'play_video', ok: true }]);
assert.strictEqual(mediaOk.changed, false, '14: po úspěšném play_video je tvrzení legitimní');
assert.strictEqual(
  guardActionClaim('Pouštím ti Coldplay do obýváku.', 'pusť coldplay', [{ name: 'play_music', ok: true }]).changed,
  false,
  '14b: play_music legitimizuje hudební tvrzení',
);

// ── 15) FALSE-POSITIVE OBRANA: dotaz „co hraje" není rozkaz ──────────────────
assert.strictEqual(
  guardActionClaim('Na televizi teď hraje YouTube — TRAKTORY V BAHNĚ.', 'co hraje na televizi?', [{ name: 'get_state', ok: true }]).changed,
  false,
  '15: odpověď na dotaz o stavu se nesmí přepsat na přiznání',
);

// ── 16) FALSE-POSITIVE OBRANA: poctivé přiznání neúspěchu projde ─────────────
assert.strictEqual(
  guardActionClaim('Video se mi pustit nepodařilo, televize je vypnutá.', 'pusť na youtube traktory', [{ name: 'play_video', ok: false }]).changed,
  false,
  '16: přiznání neúspěchu není tvrzení o hraní',
);

// ── 17) Ovládání televize bez nástroje je taky lež ───────────────────────────
const muteLie = guardActionClaim('Hotovo! Televize je ztlumená.', 'ztlum televizi', NONE);
assert.strictEqual(muteLie.changed, true, '17a: tvrzení o ztlumení bez nástroje = fabrikace');
assert.strictEqual(
  guardActionClaim('Hotovo! Televize je ztlumená.', 'ztlum televizi', [{ name: 'play_video', ok: true }]).changed,
  false,
  '17b: po úspěšném nástroji je tvrzení legitimní',
);
assert.strictEqual(
  guardActionClaim('Video na televizi je zastavené.', 'zastav video na televizi', NONE).changed,
  true,
  '17c: tvrzení o zastavení bez nástroje = fabrikace',
);

// ── 18) HLASOVÝ BUG 2026-08-14: „rozsvítil jsem" bez aktuace → FIRE ─────────
const lightLie = 'Hotovo, světla v obýváku jsou rozsvícená.';
const r18 = guardActionClaim(lightLie, 'rozsviť světla v obýváku', NONE);
assert.strictEqual(r18.changed, true, '18a: tvrzení o rozsvícení bez toolu = fabrikace');
assert.strictEqual(r18.fabricatedDevice, true, '18b: označeno jako fabrikace ovládání zařízení');
assert(r18.text.includes('ovládání zařízení v domě'), '18c: přiznání pojmenuje ovládání zařízení');

// ── 19) Neúspěšný aktuační tool + hotovo tvrzení → FIRE; úspěšný → SILENT ───
assert.strictEqual(
  guardActionClaim('Rozsvítil jsem LED pásek.', 'zapni LED pásek', TURN_ON_FAIL).changed,
  true,
  '19a: neúspěšný turn_on nelegitimizuje „rozsvítil jsem"',
);
assert.strictEqual(
  guardActionClaim('Rozsvítil jsem LED pásek.', 'zapni LED pásek', TURN_ON_OK).changed,
  false,
  '19b: úspěšný turn_on legitimizuje tvrzení o světle',
);
assert.strictEqual(
  guardActionClaim('Hotovo, zásuvka je zapnutá.', 'zapni zásuvku u kávovaru', CALL_SERVICE_OK).changed,
  false,
  '19c: úspěšný call_service legitimizuje jedno-entitovou aktuaci',
);

// ── 20) FALSE-POSITIVE OBRANA: dotaz na stav světel není povel ──────────────
assert.strictEqual(
  guardActionClaim('Světlo v obýváku svítí.', 'svítí v obýváku světlo?', NONE).changed,
  false,
  '20: odpověď na dotaz o stavu se nesmí přepsat na přiznání',
);

// ── 21) Poctivé přiznání selhání aktuace projde ─────────────────────────────
assert.strictEqual(
  guardActionClaim('Světlo se mi rozsvítit nepodařilo, je nedostupné.', 'rozsviť světlo', TURN_ON_FAIL).changed,
  false,
  '21: přiznání neúspěchu aktuace není tvrzení hotovo',
);

// ── 22) Archivace entity bez entity_archive toolu nesmí tvrdit hotovo ───────
const archiveLie = 'Schoval jsem entitu sensor.stary_test do archivu.';
assert.strictEqual(
  guardActionClaim(archiveLie, 'ukliď/smaž entitu sensor.stary_test z aplikace', NONE).changed,
  true,
  '22a: tvrzení o archivaci entity bez toolu = fabrikace',
);
assert.strictEqual(
  guardActionClaim(archiveLie, 'ukliď/smaž entitu sensor.stary_test z aplikace', ENTITY_ARCHIVE_OK).changed,
  false,
  '22b: úspěšný entity_archive legitimizuje tvrzení o archivaci',
);

// ── 23) DÍRA 1 (tester 2026-08-15): krátká hlasová odpověď se silným device-verbem
//        BEZ noun v odpovědi → musí FIRE (dřív noun-gate leakoval u voice) ──────
assert.strictEqual(
  guardActionClaim('Zhasl jsem 👍', 'zhasni v obýváku', NONE).changed,
  true,
  '23a: „Zhasl jsem 👍" (silný verb, bez noun, žádný tool) = fabrikace',
);
assert.strictEqual(
  guardActionClaim('Rozsvítil jsem 💡', 'rozsviť v obýváku', NONE).changed,
  true,
  '23b: „Rozsvítil jsem 💡" bez noun = fabrikace',
);
assert.strictEqual(
  guardActionClaim('Přepnul jsem.', 'přepni světlo', NONE).changed,
  true,
  '23c: „Přepnul jsem" bez noun = fabrikace',
);
// úspěšný tool silný verb legitimizuje i bez noun
assert.strictEqual(
  guardActionClaim('Zhasl jsem 👍', 'zhasni v obýváku', TURN_ON_OK).changed,
  false,
  '23d: po úspěšném toolu je „Zhasl jsem" legitimní',
);

// ── 24) DÍRA 2 (tester 2026-08-15): infinitivní žádost uživatele → gate 1 chytne
assert.strictEqual(
  guardActionClaim('Rozsvítil jsem světlo 💡', 'můžeš rozsvítit světlo?', NONE).changed,
  true,
  '24a: infinitiv „můžeš rozsvítit" + fabrikace = fire',
);
assert.strictEqual(
  guardActionClaim('Zhasl jsem světlo.', 'jde zhasnout v ložnici?', NONE).changed,
  true,
  '24b: infinitiv „jde zhasnout" + fabrikace = fire',
);

// ── 25) FALSE-POSITIVE OBRANA (díra 1): „hotovo" u ne-domácí akce zůstává gated
//        na DEVICE_NOUN — bez noun a bez device intentu se nesmí měnit ──────────
assert.strictEqual(
  guardActionClaim('Hotovo, mám to zapsané.', 'poznamenej si, že jedu v pátek pryč', NONE).changed,
  false,
  '25: „Hotovo" bez device noun a bez device intentu se nesmí přepsat',
);
assert.strictEqual(
  guardActionClaim('Vrátil jsem se k tomu a je to opravené.', 'zapni to zpátky', NONE).changed,
  false,
  '25b: „vrátil jsem se" (reflexivní) není device claim ani se silným kbelíkem',
);

// ── 26) Živý incident 16.8. (karta -03): „zapni párování" + úspěšný ──────────
//        zigbee_permit_join → guard NEsmí přepsat na „nic jsem neudělal".
//        Před fixem 4× po sobě false-positive (permit_join ok, ale neuznaný).
const pairText = 'Zapnul jsem párování na 60 sekund. Teď na tom switchi v obýváku stiskni reset tlačítko.';
assert.strictEqual(
  guardActionClaim(pairText, 'ty světla musíme napárovat znovu, zapni párování', PERMIT_JOIN_OK).changed,
  false,
  '26a: úspěšný zigbee_permit_join legitimizuje „zapnul jsem párování" (repro incidentu 16.8.)',
);
// Kontrola, že fixtura diskriminuje: BEZ toolu je to reálná fabrikace párování.
assert.strictEqual(
  guardActionClaim(pairText, 'ty světla musíme napárovat znovu, zapni párování', NONE).changed,
  true,
  '26b: tvrzení „zapnul jsem párování" bez proběhlého permit_join = fabrikace',
);
// Kontrola case (b): permit_join zavolán, ale SELHAL (offline bridge) → fabrikace.
assert.strictEqual(
  guardActionClaim(pairText, 'zapni párování zigbee dongle', PERMIT_JOIN_FAIL).changed,
  true,
  '26c: neúspěšný permit_join + tvrzení „zapnul jsem" = fabrikace (bridge offline)',
);

console.log('check-action-claim-guard: OK (28 scénářů)');
