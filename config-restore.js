'use strict';

// Záchranná vrstva YAML zápisů (fáze 0 auditu 2026-07-05) — vytažená z bot.js
// do samostatného modulu, aby šla otestovat izolovaně nad KOPIÍ configu
// (restore drill, karta 2026-08-05-programator-zana-02). Živý rollback v domě
// se jinak "otestuje" až při prvním incidentu — což je pozdě. Logika je 1:1
// s původním bot.js: měníme jen to, že cesty/side-efekty jdou parametrem,
// ne z modulového stavu.

const fs = require('fs');
const path = require('path');

function backupFile(fp, backupDir, maxBackups = 10) {
  // Kopie do <backupDir>/<soubor>.<timestamp>, drží se posledních maxBackups
  // záloh na soubor. Vrací cestu k záloze, null když originál neexistuje
  // (= nový soubor, zálohovat není co).
  try {
    if (!fs.existsSync(fp)) return null;
    fs.mkdirSync(backupDir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const bp = path.join(backupDir, `${path.basename(fp)}.${ts}`);
    fs.copyFileSync(fp, bp);
    const siblings = fs.readdirSync(backupDir)
      .filter(f => f.startsWith(path.basename(fp) + '.')).sort();
    while (siblings.length > maxBackups) {
      try { fs.unlinkSync(path.join(backupDir, siblings.shift())); } catch {}
    }
    return bp;
  } catch (e) { console.warn('backupFile:', e.message); return null; }
}

function restoreChange(lastChange, hooks = {}) {
  // Vrátí poslední zápis: nový soubor smaže, přepsaný obnoví ze zálohy.
  // hooks.onSnapshot(label, changedFile?) je volitelný git-snapshot side-effect
  // (bot.js dodá reálný snapshotConfigGit; test dodá no-op).
  // Pozor: NEmění stav volajícího — reset lastChange na null řeší volající
  // po úspěchu (stejně jako v původním bot.js).
  if (!lastChange) return { error: 'Není co vracet — od startu add-onu žádný zaznamenaný zápis.' };
  const onSnapshot = typeof hooks.onSnapshot === 'function' ? hooks.onSnapshot : () => {};
  try {
    const { file, backup, wasNew, when } = lastChange;
    onSnapshot(`before Zan undo ${path.basename(file)}`);
    if (wasNew) { if (fs.existsSync(file)) fs.unlinkSync(file); }
    else if (backup && fs.existsSync(backup)) fs.copyFileSync(backup, file);
    else return { error: 'Záloha se nenašla — obnov ručně z /config/zan_data/backups/.' };
    onSnapshot(`after Zan undo ${path.basename(file)}`, file);
    return { success: true, restored: path.basename(file), was_new_file_deleted: wasNew, change_from: when };
  } catch (e) { return { error: e.message }; }
}

module.exports = { backupFile, restoreChange };
