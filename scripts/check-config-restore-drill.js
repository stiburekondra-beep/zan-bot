'use strict';

// Restore drill (karta 2026-08-05-programator-zana-02): dokázat NAD KOPIÍ
// configu, že "než Žán něco změní, zálohuje to — a umí to vzít zpátky" fakt
// platí. Cvičí REÁLNOU logiku z config-restore.js (ne reimplementaci), přes
// dočasnou fixture. Žádný živý dům, žádný HA restart, žádné reálné entity.
// PASS jen když po rollbacku sedí byte-for-byte původní YAML.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { backupFile, restoreChange } = require('../config-restore');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zan-restore-drill-'));
const backupDir = path.join(tmp, 'backups');
const pkg = path.join(tmp, 'topeni.yaml');

// Snapshot hook loguje volání, ať ověříme, že se side-effect zavolal se
// správnými labely (before/after undo), ale nesahá na žádný git.
const snapshots = [];
const hooks = { onSnapshot: (label, changedFile) => snapshots.push({ label, changedFile }) };

// ── Case 1: přepis existujícího souboru → rollback musí vrátit byte-for-byte ──
const original = 'automation:\n  - alias: nocni utlum\n    trigger: []\n# konec\n';
fs.writeFileSync(pkg, original, 'utf8');
const originalBytes = fs.readFileSync(pkg); // Buffer pro byte-for-byte diff

const backup = backupFile(pkg, backupDir);
assert.ok(backup && fs.existsSync(backup), 'záloha existujícího souboru musí vzniknout');
assert.ok(fs.readFileSync(backup).equals(originalBytes), 'záloha je byte-for-byte kopie originálu');

// Žán soubor přepíše (simulace write_package nad kopií configu)
const mutated = 'automation: []\n'; // agresivní ořez — kdyby rollback selhal, pozná se to
fs.writeFileSync(pkg, mutated, 'utf8');
assert.ok(!fs.readFileSync(pkg).equals(originalBytes), 'po zápisu se obsah reálně změnil (sanity)');

const lastChange1 = { file: pkg, backup, wasNew: false, when: '2026-08-05T00:00:00Z' };
snapshots.length = 0;
const r1 = restoreChange(lastChange1, hooks);
assert.strictEqual(r1.success, true, 'rollback přepisu musí uspět');
assert.strictEqual(r1.was_new_file_deleted, false, 'přepsaný soubor se nemaže, obnovuje');
assert.ok(fs.readFileSync(pkg).equals(originalBytes), 'BYTE-FOR-BYTE: po rollbacku sedí původní YAML');
assert.deepStrictEqual(
  snapshots.map((s) => s.label),
  ['before Zan undo topeni.yaml', 'after Zan undo topeni.yaml'],
  'git snapshot hook se volá před i po rollbacku'
);
assert.strictEqual(snapshots[1].changedFile, pkg, 'after-snapshot dostane cestu obnoveného souboru');

// ── Case 2: nově vytvořený soubor → rollback ho musí SMAZAT (žádná záloha) ──
const newFile = path.join(tmp, 'novy_balicek.yaml');
const backupNew = backupFile(newFile, backupDir);
assert.strictEqual(backupNew, null, 'neexistující soubor nemá co zálohovat → null');
fs.writeFileSync(newFile, 'sensor: []\n', 'utf8'); // Žán vytvořil nový soubor
const lastChange2 = { file: newFile, backup: null, wasNew: true, when: '2026-08-05T00:01:00Z' };
const r2 = restoreChange(lastChange2, hooks);
assert.strictEqual(r2.success, true, 'rollback nového souboru musí uspět');
assert.strictEqual(r2.was_new_file_deleted, true, 'nový soubor se při undo maže');
assert.ok(!fs.existsSync(newFile), 'po undo nový soubor fyzicky zmizel');

// ── Case 3: chybí záloha (přepis, ale backup pryč) → POCTIVÁ chyba, ne tichý OK ──
const lostBackup = { file: pkg, backup: path.join(backupDir, 'neexistuje.bak'), wasNew: false, when: 'x' };
const r3 = restoreChange(lostBackup, hooks);
assert.ok(r3.error && /Záloha se nenašla/.test(r3.error), 'chybějící záloha = jasná chyba, ne fabulovaný úspěch');
assert.ok(!r3.success, 'bez zálohy se nesmí hlásit success');

// ── Case 4: nic k vrácení (undo bez zápisu od startu) ──
const r4 = restoreChange(null, hooks);
assert.ok(r4.error && /Není co vracet/.test(r4.error), 'undo bez zaznamenaného zápisu = jasná hláška');

// ── Case 5: retence — max 10 záloh na soubor ──
const retFile = path.join(tmp, 'ret.yaml');
fs.writeFileSync(retFile, 'a: 1\n', 'utf8');
for (let i = 0; i < 15; i++) {
  // drobná pauza v timestampu simulovaná změnou obsahu (backupFile stampuje ISO čas)
  fs.writeFileSync(retFile, `a: ${i}\n`, 'utf8');
  backupFile(retFile, backupDir);
}
const retBackups = fs.readdirSync(backupDir).filter((f) => f.startsWith('ret.yaml.'));
assert.ok(retBackups.length <= 10, `retence drží max 10 záloh na soubor (je jich ${retBackups.length})`);

// úklid
fs.rmSync(tmp, { recursive: true, force: true });

console.log('check-config-restore-drill: OK (5 kontrol — byte-for-byte rollback, undo nového souboru, chybějící záloha, prázdné undo, retence)');
