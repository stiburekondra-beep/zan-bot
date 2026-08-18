'use strict';

// ═══════════════════════════════════════════════════════════════════════
// NARRATOR (vypravěč) — krycí řeč, která ZAMLUVÍ ticho, zatímco Žánův
// (Claude) mozek na pozadí hledá / ovládá / formuluje skutečnou odpověď.
// Karta 2026-08-18-programator-zana-04 bod 1b (Ondrův závazný směr 21:55:
// „latence u přemýšlení nevadí, Žán ji ale musí umět zamluvit když hledá“;
// analogie řidiče — začne zastavovat, ale povídat si může dál).
//
// Vztah k mozku: vypravěč JEN naplní ticho hned; skutečnou odpověď dodá
// Claude mozek a ten převezme slovo (čistý handoff). Vypravěč NENAHRAZUJE
// mozek ani jeho honesty guardy — je to front-end vrstva, ne změna
// architektury (mantinel karty: NEztratit Žána).
//
// ── TVRDÝ honesty mantinel (jádro) ──────────────────────────────────────
// Vypravěč SMÍ jen potvrdit, že se pustil do práce / naplnit ticho.
// NIKDY neříká VÝSLEDEK ani „hotovo / rozsvítil jsem / svítí / našel jsem".
// Kdyby fabuloval výsledek akce, kterou mozek teprve provede, byla by to
// přesně třída chyby, proti níž stojí honesty guardy (#36 actuation, #41
// action-claim). Proto jsou všechny fráze VÝHRADNĚ progresivní/budoucí
// („dělám na tom", „kouknu se na to") — žádná dokončená akce. Contract test
// (check-narrator.js) to vynucuje proti REÁLNÉMU guardActionClaim: žádná
// fráze nesmí fire ani v nejtvrdším kontextu (uživatel žádal ovládání,
// žádný nástroj neproběhl).
//
// ── DESIGN: šablona, NE druhý LLM call (eliminuj před automatizací) ──────
// Ondra navrhl „rozdvojit model" — dvě vrstvy (vypravěč + mozek) tu jsou,
// ale vypravěč je DETERMINISTICKÁ ŠABLONA, ne druhé volání modelu. Proč:
//   1. FYZIKA LATENCE: vypravěč má MASKOVAT latenci mozku. Druhý LLM call
//      by sám přidal stovky ms latence, kterou má zamluvit (paradox).
//      Šablona = 0 ms = opravdu instant (celý smysl vypravěče).
//   2. HONESTY: šablona strukturálně NEMŮŽE fabulovat výsledek (nemá k němu
//      přístup). Druhý model by mohl — a rozbil by honesty vrstvu na hraně.
// Kontextově chytřejší vypravěč (lehký model, věta šitá dotazu) je možná
// pozdější nadstavba, ne teď — a i pak by běžel paralelně s mozkem, ne v cestě.
//
// Modul je čistě funkční (žádné HA / LLM / IO) — instant a testovatelný bez
// modelu. Vzor: voice-response.js / temperature-sense.js. Doručení fráze
// (hlas přes HA custom component, nebo Telegram sendMessage) je samostatná
// WIRING fáze — dnešní /voice kanál je synchronní 1-request→1-response,
// takže druhá (dřívější) zpráva vyžaduje úpravu doručovacího kanálu.
// ═══════════════════════════════════════════════════════════════════════

function normalizeText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // strip diakritiky
    .toLowerCase()
    .trim();
}

// Povel k ovládání domu (rozkaz i infinitiv i „pusť/nastav") — dotaz, který
// spustí tool práci → mozek chvíli mlčí → namístě zamluvit. Držíme širší než
// action-claim USER_DEVICE_INTENT (přidáno pusť/spusť/přehraj/najdi/zjisti…),
// protože vypravěč kryje i ne-aktuační práci (hledání, media).
const CONTROL_INTENT = /(?<![\p{L}])(zapni|zapnout|vypni|vypnout|rozsvi[tť]\p{L}*|zhasni|zhasnout|přepni|prepni|přepnout|prepnout|sepni|sepnout|vytáhni|vytahni|zatáhni|zatahni|otevři|otevri|otevřít|otevrit|zavři|zavri|zavřít|zavrit|nastav|nastavit|spusť|spust|pusť|pust|přehraj|prehraj|uděl\p{L}*|udel\p{L}*|zamkni|odemkni|ztlum|zesil|nastartuj|restartuj)\p{L}*/iu;

// Dotaz na stav / hledání informace → mozek musí přečíst HA / historii →
// taky se hodí zamluvit. Tázací slova + koncový otazník.
const QUERY_INTENT = /(?<![\p{L}])(co|kde|kdy|kolik|jak|jaká|jaké|jaký|jaka|jake|jaky|proč|proc|kdo|svítí|sviti|nesvítí|nesviti|je\s+|jsou\s+|máme|mame|máš|mas|zkontroluj|najdi|zjisti|ukaž|ukaz|podívej|podivej)\p{L}*/iu;

// Triviální zpráva, u které mozek odpoví HNED → vypravěč by zněl divně
// („Moment, dívám se…" → hned „Ahoj!"). Čistý pozdrav / poděkování /
// potvrzení, nebo velmi krátká zpráva bez otázky a bez povelu.
const TRIVIAL_RE = /^(ahoj|čau|cau|nazdar|zdar|dobrý den|dobry den|dobré ráno|dobre rano|dobrý večer|dobry vecer|čus|cus|hej|díky|diky|dík|dik|děkuju|dekuju|děkuji|dekuji|díky moc|diky moc|ok|oukej|okej|jo|jasně|jasne|ano|ne|super|paráda|parada|fajn|dobře|dobre|nashle|ahojky|čauky|cauky|pa|měj se|mej se)[!.\s]*$/i;

// Bezpečnostní pojistka: žádná fráze vypravěče NESMÍ obsahovat tvrzení
// o VÝSLEDKU / dokončené akci. Používá se v samo-testu níže i v contractu.
const RESULT_CLAIM_RE = /(?<![\p{L}])(hotovo|rozsvítil\s+jsem|rozsvitil\s+jsem|zhasl\s+jsem|zapnul\s+jsem|vypnul\s+jsem|přepnul\s+jsem|prepnul\s+jsem|otevřel\s+jsem|otevrel\s+jsem|zavřel\s+jsem|zavrel\s+jsem|našel\s+jsem|nasel\s+jsem|svítí|sviti|je\s+(?:teď\s+|ted\s+|už\s+|uz\s+)?(?:zapnut\w*|vypnut\w*|rozsvícen\w*|rozsvicen\w*|hotov\w*)|pustil\s+jsem|přehrál\s+jsem|prehral\s+jsem)/iu;

// Krycí fráze podle kategorie. VÝHRADNĚ progresivní/budoucí — „pustil jsem
// se do toho", ne „udělal jsem to". Bez čísel (české TTS neskloňuje číslice),
// bez emoji, mluvené, krátké. Každá musí projít RESULT_CLAIM_RE (self-test).
const FILLERS = {
  control: [
    'Jasně, hned se do toho pustím.',
    'Dobře, zařizuju to.',
    'Rozumím, dělám na tom.',
  ],
  query: [
    'Moment, kouknu se na to.',
    'Vteřinku, zjišťuju to.',
    'Podívám se ti na to.',
  ],
  general: [
    'Moment, přemýšlím nad tím.',
    'Chvilku, koukám se na to.',
  ],
};

// Kategorie dotazu — řídí, jakou krycí větu vypravěč zvolí. Ovládání má
// přednost před dotazem („zapni topení, ať je tepleji" = control).
function classifyIntent(userMessage) {
  const norm = normalizeText(userMessage);
  if (!norm) return 'general';
  if (CONTROL_INTENT.test(norm)) return 'control';
  if (QUERY_INTENT.test(norm) || /\?\s*$/.test(String(userMessage || '').trim())) return 'query';
  return 'general';
}

// Má vypravěč vůbec promluvit? NE u triviálních zpráv (mozek odpoví hned).
// ANO u čehokoli, co vypadá na práci (povel / dotaz / delší text).
function shouldNarrate(userMessage) {
  const raw = String(userMessage || '').trim();
  if (!raw) return false;
  const norm = normalizeText(raw);
  if (TRIVIAL_RE.test(norm)) return false;
  // Velmi krátká zpráva bez otázky a bez povelu = spíš triviální → nekrýt.
  const words = norm.split(/\s+/).filter(Boolean);
  const hasWork = CONTROL_INTENT.test(norm) || QUERY_INTENT.test(norm) || /\?/.test(raw);
  if (words.length <= 2 && !hasWork) return false;
  return true;
}

// Vybere krycí frázi. Deterministické (stejný vstup → stejný výstup), ať jde
// testovat; střídání frází je odvozené z délky zprávy (levné, bez Math.random,
// aby test nebyl flaky). Když se krýt nemá, vrátí null.
function pickNarratorFiller(userMessage, variantSeed) {
  if (!shouldNarrate(userMessage)) return null;
  const category = classifyIntent(userMessage);
  const pool = FILLERS[category] || FILLERS.general;
  const seed = Number.isInteger(variantSeed)
    ? variantSeed
    : normalizeText(userMessage).replace(/\s+/g, '').length;
  return pool[seed % pool.length];
}

// Bezpečnostní kontrola jedné fráze (pro contract test / obranu): fráze
// nesmí tvrdit výsledek. True = bezpečná (žádný result-claim).
function fillerIsHonest(filler) {
  return typeof filler === 'string' && filler.length > 0 && !RESULT_CLAIM_RE.test(filler);
}

module.exports = {
  normalizeText,
  classifyIntent,
  shouldNarrate,
  pickNarratorFiller,
  fillerIsHonest,
  FILLERS,
  RESULT_CLAIM_RE,
  CONTROL_INTENT,
  QUERY_INTENT,
};
