'use strict';

// action-claim-guard.js
// Deterministická pojistka proti FABRIKACI PROVEDENÉ AKCE. Řeší bug
// 2026-08-06-programator-zana-01 (nález z admin scénáře na dvojčeti):
// Žán na „Vrať tu poslední změnu zpátky" JEDNOU zavolá undo_last_change a
// PODRUHÉ jen napíše „Vrátil jsem poslední zápis — balíček je smazaný", aniž
// by nástroj zavolal — a balíček dál leží na disku. Nedeterministicky: stejná
// verze, stejné zadání, jednou jedná, jednou jen mluví (root cause: model
// přeskočí tool call a jen narativně tvrdí hotovo — v journalu chybí řádek 🔧).
//
// To je nejtvrdší třída chyby (`zan-truth-guard`): fabrikace PROVEDENÉ akce,
// ne jen znalosti. U kotle/alarmu/topení je to rozdíl mezi „vráceno" a „běží
// dál". Prompt už fabulaci zakazuje a evidentně to nestačí — LLM tvrzení
// protlačí i s explicitním zákazem (precedent area-alias 26.7., actuation
// 5.8.). Jediné spolehlivé místo je post-process nad HOTOVÝM textem odpovědi,
// který zná, jaké nástroje v tomtéž kole SKUTEČNĚ a ÚSPĚŠNĚ proběhly.
//
// Princip (tři podmínky, konjunkce → near-zero false-positive):
//   1) uživatel v TOMHLE kole požádal o zásah do configu / restart,
//   2) odpověď tvrdí, že je ten zásah HOTOVÝ (first-person „<sloveso> jsem"
//      u konfiguračního objektu, nebo stavová fráze „balíček je zpátky", nebo
//      dokončený restart),
//   3) v tomtéž kole NEPROBĚHL úspěšně žádný odpovídající nástroj.
// Když platí všechny tři → celá odpověď se nahradí poctivým přiznáním. Podmínka
// (1) je klíčová obrana proti opačnému false-positive: legitimní pozdější věta
// „balíček je zpátky" (po dřívějším úspěšném undo) NESMÍ být přepsána na „lhal
// jsem" — proto guard fire jen tehdy, když si akci uživatel PRÁVĚ vyžádal.

// Nástroje, jejichž úspěch legitimizuje tvrzení o změně konfigurace.
// undo_last_change je záměrně mezi nimi: po vrácení může být balíček buď
// smazaný (undo write) nebo zpátky (undo delete) — po úspěšném undo je tedy
// legitimní i „smazal jsem" i „vrátil jsem", proto stačí jeden společný kbelík.
const CONFIG_TOOLS = ['write_package', 'delete_package', 'undo_last_change', 'write_dashboard'];
const RESTART_TOOLS = ['restart_ha'];
// Ovládání zařízení v domě. Actuation-guard řeší případ, kdy tool proběhl, ale
// cílová entita je unavailable/unknown. Tenhle guard doplňuje opačnou větev:
// model tvrdí „rozsvítil jsem / hotovo", ale žádný aktuační tool se v kole
// úspěšně neprovedl (typicky voice pipeline nebo model přeskočí tool call).
const DEVICE_TOOLS = ['turn_on', 'turn_off', 'toggle', 'call_service'];
// Přehrávání médií. Doplněno 2026-08-12 po živém nálezu v labu: Ondra dvakrát
// za sebou požádal „pusť na youtube traktory v blátě" a Žán podruhé odpověděl
// „Hotovo! Traktory teď hrají na televizi", aniž by zavolal jediný nástroj —
// v historii totiž viděl, že už to jednou pustil. Televize přitom byla vypnutá.
const MEDIA_TOOLS = ['play_video', 'play_music', 'call_service'];

// (1) Uživatel v aktuální zprávě žádá o zásah do configu (vrácení/zápis/mazání).
// Pozn.: v JS je `\b` ASCII → za slovem končícím diakritikou („vrať") selže;
// proto unicode lookbehind na začátku a `\p{L}*` místo `\w*` (diakritika-safe).
const USER_CONFIG_INTENT = /(?<![\p{L}])(vrať|vrat|obnov|zpátky|zpatky|smaž|smaz|odstraň|odstran|vymaž|vymaz|zapiš|zapis|zaps|založ|zaloz|vytvoř|vytvor|přidej|pridej|ulož|uloz|zruš|zrus)\p{L}*/iu;
// (1') Uživatel žádá restart HA.
const USER_RESTART_INTENT = /\brestart\w*/i;

// (2) First-person dokončené sloveso zásahu, ALE ne reflexivní/posesivní tvar
// („vrátil jsem SE", „vytvořil jsem SI") — ten neznamená akci nad configem.
const VERB_DONE = /\b(vrátil|vrátila|vrátilo|obnovil|obnovila|obnovilo|smazal|smazala|smazalo|odstranil|odstranila|odstranilo|vymazal|vymazala|zapsal|zapsala|zapsalo|vytvořil|vytvořila|vytvořilo|založil|založila|založilo|přepsal|přepsala)\s+jsem\b(?!\s+(?:se|si)\b)/i;

// Konfigurační objekt v okolí — bez něj generické sloveso neguardujeme.
const CONFIG_NOUN = /(balíč|automatiz|package|konfigurac|\byaml\b|zápis|změn|scénář|skript|dashboard)/i;

// (2') Stavová fráze, která tvrdí dokončený stav configu i bez „<sloveso> jsem".
// Chráněná gate (1), takže smí být volnější, ale i tak vázaná na objekt.
const CONFIG_PHRASE = /(balíč\w*|automatiz\w*|package|dashboard)\s+(?:už\s+)?(?:je|jsou)\s+(?:zase\s+|teď\s+|zpátky\s+)?(?:zpátky|zpět|smazán\w*|smazan\w*|zapsán\w*|zapsan\w*|založen\w*|vytvořen\w*|obnoven\w*|pryč|vrácen\w*|odstraněn\w*)/i;

// (2'') Dokončený restart HA (first-person nebo jasné dokončení).
const RESTART_DONE = /\brestartoval[ao]?\s+jsem\b|\b(?:home\s*assistant|ha)\s+(?:se\s+)?(?:právě\s+|už\s+)?(?:byl\s+)?restartov\w+/i;

// (1'') Uživatel právě žádá ovládání běžného zařízení v domě. Držíme rozkazové
// tvary a běžné domácí formulace; dotazy na stav („svítí?") sem nepatří.
const USER_DEVICE_INTENT = /(?<![\p{L}])(zapni|vypni|rozsviť|rozsvit|zhasni|přepni|prepn[ií]|sepni|vytáhni|vytahni|zatáhni|zatahni|otevři|otevri|zavři|zavri|nastav|dej|udělej|udelej)\p{L}*/iu;
// (2'') Odpověď tvrdí hotovou aktuaci. Vyžadujeme zároveň DEVICE_NOUN, aby
// běžné „hotovo" u ne-domácí akce nespouštělo false-positive.
const DEVICE_DONE = /(?<![\p{L}])(hotovo|zapnul\w*\s+jsem|vypnul\w*\s+jsem|rozsvítil\w*\s+jsem|rozsvitil\w*\s+jsem|zhasl\w*\s+jsem|přepnul\w*\s+jsem|prepnul\w*\s+jsem|sepnul\w*\s+jsem|otevřel\w*\s+jsem|otevrel\w*\s+jsem|zavřel\w*\s+jsem|zavrel\w*\s+jsem|nastavil\w*\s+jsem|je\s+(?:teď\s+|ted\s+|už\s+|uz\s+)?(?:zapnut\w*|vypnut\w*|rozsvícen\w*|rozsvicen\w*|zhasnut\w*|otevřen\w*|otevren\w*|zavřen\w*|zavren\w*)|svítí|sviti|nesvítí|nesviti)/iu;
const DEVICE_NOUN = /(svět|svet|svítidl|svitidl|lamp|žárovk|zarovk|led|zásuvk|zasuvk|switch|vypínač|vypinac|rolety|rolet|žaluzi|zaluzi|vrat|garáž|garaz|ventil|čerpadl|cerpadl|topen|klimatiz|climate|light|cover|fan)/i;

// (1'') Uživatel právě žádá přehrání nebo ovládání přehrávání.
// Jen ROZKAZ („pusť", „zapni"), ne 3. osoba — jinak by dotaz „co hraje na
// televizi?" spustil guard nad legitimní odpovědí z get_state.
const USER_MEDIA_INTENT = /(?<![\p{L}])(pusť|pust|spusť|spust|zapni|přehraj|prehraj|zesil|ztlum|ztiš|ztis|zeslab|pauzni|zapauzuj|zastav|stopni|hlasitost)\p{L}*/iu;
// (2''') Odpověď tvrdí, že média HRAJÍ / byla puštěna — nebo že se povedlo
// ovládnutí (ztlumení, zastavení, změna hlasitosti). Doplněno 2026-08-12:
// „Televize je ztlumená" bez nástroje je stejná lež jako „traktory hrají".
const MEDIA_DONE = /(?<![\p{L}])(pouštím|poustim|spustil\w*\s+jsem|pustil\w*\s+jsem|zapnul\w*\s+jsem|ztlumil\w*\s+jsem|zastavil\w*\s+jsem|hraje|hrají|hraji|běží|bezi|ztlumen\w*|zastaven\w*|pauznut\w*|zapauzov\w*|already\s+playing)|na\s+\d+\s*(?:procent\w*|%)/iu;
// Objekt přehrávání — bez něj obecné „hraje" neguardujeme (např. „venku hraje kapela").
const MEDIA_NOUN = /(televiz|telce|telka|youtube|video|hudb|píseň|pisen|skladb|rádi|radi|pohádk|pohadk|traktor|film)/i;

// text: hotová odpověď Žána.
// userMessage: text aktuální uživatelovy zprávy (gate 1 — o co si právě řekl).
// actionCalls: pole { name, ok } — nástroje volané v TOMTO kole a jestli
//   doběhly úspěšně (ok === true). Bot.js ho plní během agentické smyčky.
// Vrací { text, changed, fabricatedConfig, fabricatedRestart, fabricatedDevice, fabricatedMedia }.
function guardActionClaim(text, userMessage, actionCalls) {
  const noop = { text, changed: false, fabricatedConfig: false, fabricatedRestart: false, fabricatedDevice: false, fabricatedMedia: false };
  if (!text || typeof text !== 'string') return noop;

  const um = typeof userMessage === 'string' ? userMessage : '';
  const calls = Array.isArray(actionCalls) ? actionCalls : [];
  const configSatisfied = calls.some(c => c && c.ok && CONFIG_TOOLS.includes(c.name));
  const restartSatisfied = calls.some(c => c && c.ok && RESTART_TOOLS.includes(c.name));
  const deviceSatisfied = calls.some(c => c && c.ok && DEVICE_TOOLS.includes(c.name));
  const mediaSatisfied = calls.some(c => c && c.ok && MEDIA_TOOLS.includes(c.name));

  // (2) tvrdí odpověď dokončený zásah?
  const configClaim = (VERB_DONE.test(text) && CONFIG_NOUN.test(text)) || CONFIG_PHRASE.test(text);
  const restartClaim = RESTART_DONE.test(text);
  const deviceClaim = DEVICE_DONE.test(text) && DEVICE_NOUN.test(text);
  const mediaClaim = MEDIA_DONE.test(text) && MEDIA_NOUN.test(text);

  // (1) požádal o něj uživatel v tomhle kole? + (3) neproběhl nástroj?
  const fabricatedConfig = configClaim && USER_CONFIG_INTENT.test(um) && !configSatisfied;
  const fabricatedRestart = restartClaim && USER_RESTART_INTENT.test(um) && !restartSatisfied;
  const fabricatedDevice = deviceClaim && USER_DEVICE_INTENT.test(um) && !deviceSatisfied;
  const fabricatedMedia = mediaClaim && USER_MEDIA_INTENT.test(um) && !mediaSatisfied;

  if (!fabricatedConfig && !fabricatedRestart && !fabricatedDevice && !fabricatedMedia) return noop;

  const parts = [];
  if (fabricatedConfig) parts.push('zásah do konfigurace (vrácení / zápis / smazání balíčku)');
  if (fabricatedRestart) parts.push('restart Home Assistanta');
  if (fabricatedDevice) parts.push('ovládání zařízení v domě');
  if (fabricatedMedia) parts.push('puštění hudby nebo videa');
  const what = parts.join(' ani ');

  const replacement =
    `⚠️ Musím se hned opravit: napsal jsem, že jsem provedl ${what}, ale ve ` +
    `skutečnosti se to nestalo — žádný takový nástroj v tomhle kroku úspěšně ` +
    `neproběhl, takže se doopravdy nic nestalo. Nechci ti tvrdit něco, co ` +
    `jsem neudělal. Napiš mi prosím ještě jednou, co přesně mám udělat, a provedu ` +
    `to doopravdy — potvrdím ti to až podle skutečného výsledku nástroje.`;

  return { text: replacement, changed: true, fabricatedConfig, fabricatedRestart, fabricatedDevice, fabricatedMedia };
}

module.exports = { guardActionClaim, CONFIG_TOOLS, RESTART_TOOLS, DEVICE_TOOLS, MEDIA_TOOLS };
