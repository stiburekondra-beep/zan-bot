'use strict';
// Noční ticho 22:00–7:00 pro zprávy na Ondrův telefon (Ondra 6. 10. 2026: „notifikace nechci po 22h!“).
// Stejná pravidla jako společná brána Hubu (CHoS- zan-hub/docs/nocni-ticho.md), ale bot běží jako HA add-on
// mimo HQ, takže má vlastní frontu v DATA_DIR. V tichu zpráva jde do fronty a po 7:00 odejde jednou souhrnem.
// Výjimka: Ondra sám napsal v posledních 10 minutách (odpověď jemu). Fronta nejde zapsat → v noci se NEPOSÍLÁ.
const fs = require('fs');
const path = require('path');

const ZACATEK = 22, KONEC = 7, OKNO_ODPOVEDI_MS = 10 * 60 * 1000;

function hodinaPraha(ms) {
  const h = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Prague', hour: '2-digit', hourCycle: 'h23' }).format(new Date(ms));
  return parseInt(h, 10);
}
function jeTicho(ms = Date.now()) { const h = hodinaPraha(ms); return h >= ZACATEK || h < KONEC; }

function vytvor(dataDir, now = () => Date.now()) {
  const dir = path.join(dataDir, 'ticho-fronta');
  const naposled = path.join(dir, 'ondra-naposled.txt');
  const soubor = path.join(dir, 'fronta.jsonl');

  function ondraNapsal() {
    try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(naposled, String(now())); } catch (e) { console.warn('ticho: zápis času Ondrovy zprávy:', e.message); }
  }
  function ondraPsalNedavno() {
    try { return now() - parseInt(fs.readFileSync(naposled, 'utf8'), 10) < OKNO_ODPOVEDI_MS; } catch { return false; }
  }
  // → 'poslat' | 'fronta'
  function brana(text) {
    if (!jeTicho(now())) return 'poslat';
    if (ondraPsalNedavno()) return 'poslat';
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(soubor, JSON.stringify({ t: now(), text: String(text).slice(0, 2000) }) + '\n');
    } catch (e) {
      console.error('ticho: fronta nejde zapsat, v noci neposílám:', e.message);
    }
    return 'fronta';
  }
  // Po 7:00: vezme frontu (přejmenováním, souhrn nejde dvakrát) a pošle jednou souhrnnou zprávou.
  async function vyprazdni(odeslat) {
    if (jeTicho(now()) || !fs.existsSync(soubor)) return false;
    const vzato = soubor + '.' + now();
    try { fs.renameSync(soubor, vzato); } catch { return false; }
    const radky = fs.readFileSync(vzato, 'utf8').split('\n').filter(Boolean).map((r) => { try { return JSON.parse(r); } catch { return null; } }).filter(Boolean);
    if (!radky.length) { fs.unlinkSync(vzato); return false; }
    const cas = (t) => new Intl.DateTimeFormat('cs-CZ', { timeZone: 'Europe/Prague', hour: '2-digit', minute: '2-digit' }).format(new Date(t));
    const souhrn = `🌙 Noční souhrn (${radky.length}):\n\n` + radky.map((r) => `${cas(r.t)} ${r.text}`).join('\n\n');
    try { await odeslat(souhrn.slice(0, 3900)); fs.unlinkSync(vzato); return true; }
    catch (e) { try { fs.renameSync(vzato, soubor); } catch {} console.error('ticho: souhrn se nepodařil, zůstává ve frontě:', e.message); return false; }
  }
  return { brana, vyprazdni, ondraNapsal, jeTicho: () => jeTicho(now()) };
}

module.exports = { vytvor, jeTicho };
