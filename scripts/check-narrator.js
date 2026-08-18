#!/usr/bin/env node
'use strict';
// Contract test vypravěče (narrator.js) — karta 2026-08-18-programator-zana-04.
// Hlídá TVRDÝ honesty mantinel: krycí fráze vypravěče NIKDY nesmí fabulovat
// výsledek/akci — a to ověřujeme proti REÁLNÉMU action-claim-guardu, ne jen
// vlastním slovníkem (test na vlastních datech ověřuje sám sebe, ne rozhraní).

const assert = require('assert');
const t = require('../narrator');
const { guardActionClaim } = require('../action-claim-guard');

let n = 0;
function ok(label, cond) {
  n += 1;
  assert.ok(cond, `FAIL: ${label}`);
}

// ── JÁDRO: žádná krycí fráze nefabuluje akci ────────────────────────────
// Nejtvrdší kontext: uživatel PRÁVĚ žádal ovládání a ŽÁDNÝ nástroj neproběhl
// (actionCalls prázdné). Kdyby fráze tvrdila výsledek, guard by ji přepsal.
const HARSH_USER_MSGS = [
  'rozsviť v obýváku',
  'zhasni v ložnici',
  'zapni topení',
  'pusť Coldplay',
  'můžeš rozsvítit světlo?',
  'vypni zásuvku na terase',
];
const allFillers = [...t.FILLERS.control, ...t.FILLERS.query, ...t.FILLERS.general];
for (const filler of allFillers) {
  // 1) vlastní slovník: fráze neobsahuje result-claim
  ok(`fráze bez result-claim: "${filler}"`, t.fillerIsHonest(filler));
  // 2) reálný guard: na frázi NEFIRE ani v nejtvrdším device-intent kontextu
  for (const um of HARSH_USER_MSGS) {
    const g = guardActionClaim(filler, um, []);
    ok(`guard NEfire na vypravěče "${filler}" @ "${um}"`, g.changed === false);
  }
}

// Kontrola diskriminace: guard MUSÍ fire na skutečný fabrikovaný claim —
// jinak by test 2 byl falešně zelený (guard co nikdy nefire).
ok('kontrola: guard FIRE na reálnou fabrikaci',
  guardActionClaim('Rozsvítil jsem ti v obýváku.', 'rozsviť v obýváku', []).changed === true);

// ── shouldNarrate: triviální nekrýt, práci krýt ─────────────────────────
ok('trivial: ahoj → nekrýt', t.shouldNarrate('ahoj') === false);
ok('trivial: děkuju → nekrýt', t.shouldNarrate('děkuju') === false);
ok('trivial: jo → nekrýt', t.shouldNarrate('jo') === false);
ok('trivial: ok → nekrýt', t.shouldNarrate('ok') === false);
ok('prázdná zpráva → nekrýt', t.shouldNarrate('') === false && t.shouldNarrate(null) === false);
ok('krátká bez práce → nekrýt', t.shouldNarrate('no nic') === false);
ok('povel → krýt', t.shouldNarrate('rozsviť v obýváku') === true);
ok('dotaz na stav → krýt', t.shouldNarrate('co je v ložnici?') === true);
ok('hledání → krýt', t.shouldNarrate('zkontroluj jestli je zamčeno u garáže') === true);
ok('delší obecný dotaz → krýt', t.shouldNarrate('pověz mi něco o počasí na víkend') === true);

// ── classifyIntent: kategorie ───────────────────────────────────────────
ok('control: rozsviť', t.classifyIntent('rozsviť v obýváku') === 'control');
ok('control: pusť hudbu', t.classifyIntent('pusť dechovku') === 'control');
ok('control má přednost před dotazem', t.classifyIntent('zapni topení ať je tepleji') === 'control');
ok('query: co je kde', t.classifyIntent('co je v ložnici?') === 'query');
ok('query: koncový otazník', t.classifyIntent('bude pršet?') === 'query');
ok('general: bez povelu/dotazu', t.classifyIntent('pověz mi něco pěkného na dobrou noc') === 'general');

// ── pickNarratorFiller: vrací frázi ze správné kategorie, deterministicky ─
const fControl = t.pickNarratorFiller('rozsviť v obýváku');
ok('filler control z control poolu', t.FILLERS.control.includes(fControl));
const fQuery = t.pickNarratorFiller('co je v ložnici?');
ok('filler query z query poolu', t.FILLERS.query.includes(fQuery));
ok('trivial → filler null', t.pickNarratorFiller('ahoj') === null);
ok('deterministické: stejný vstup → stejný výstup',
  t.pickNarratorFiller('zapni topení') === t.pickNarratorFiller('zapni topení'));
ok('variantSeed střídá frázi',
  t.pickNarratorFiller('rozsviť', 0) === t.FILLERS.control[0] &&
  t.pickNarratorFiller('rozsviť', 1) === t.FILLERS.control[1]);

// Každá vygenerovaná fráze pro reálné dotazy je honest (double-check přes picker)
for (const um of HARSH_USER_MSGS) {
  const f = t.pickNarratorFiller(um);
  ok(`picker fráze honest @ "${um}"`, f !== null && t.fillerIsHonest(f) &&
    guardActionClaim(f, um, []).changed === false);
}

console.log(`narrator ok: ${n} kontrol`);
