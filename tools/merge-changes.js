#!/usr/bin/env node
'use strict';
/*
 Merges the "Changes to sync" JSON copied from the app into the private data file.
   node tools/merge-changes.js '<json>'      or     ... | node tools/merge-changes.js -     [--dry-run]
 Applies: maintenance.done -> task.lastDone (only if newer), supply.update -> status/lastBought,
 card.status / bill.status -> status, charging.charged -> device.lastCharged. Sets updatedAt = now.
 Then run tools/publish.sh to re-encrypt. Devices ignore local taps older than the new updatedAt.
*/
const fs = require('fs');
const P = require('./paths');
const args = process.argv.slice(2);
const dry = args.includes('--dry-run');
let input = args.filter(a => a !== '--dry-run').join(' ').trim();
if (!input || input === '-') input = fs.readFileSync(0, 'utf8').trim();
let ch;
try { ch = JSON.parse(input); } catch (e) { console.error('ERROR: not valid JSON: ' + e.message); process.exit(2); }
if (!ch || ch.lifeHqChanges !== 1 || !Array.isArray(ch.changes)) { console.error('ERROR: not a Life HQ changes export'); process.exit(2); }
const data = JSON.parse(fs.readFileSync(P.DATA, 'utf8'));
const find = (list, id) => (list || []).find(x => x.id === id);
const tasks = () => ((data.maintenance || {}).appliances || []).flatMap(a => a.tasks || []);
const isYMD = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
let applied = 0;
for (const c of ch.changes) {
  let msg = null;
  if (c.type === 'maintenance.done') { const t = find(tasks(), c.id); if (t && isYMD(c.date) && (!t.lastDone || c.date > t.lastDone)) { t.lastDone = c.date; msg = `task ${c.id} lastDone=${c.date}`; } }
  else if (c.type === 'supply.update') { const it = find((data.supplies || {}).items, c.id); if (it) { if (['ok', 'low', 'out'].includes(c.status)) it.status = c.status; if (isYMD(c.lastBought)) it.lastBought = c.lastBought; msg = `supply ${c.id} status=${it.status} lastBought=${it.lastBought}`; } }
  else if (c.type === 'card.status' || c.type === 'bill.status') { const it = find((data.money || {})[c.type === 'card.status' ? 'cards' : 'bills'], c.id); if (it && ['paid', 'unpaid'].includes(c.status)) { it.status = c.status; if (c.status === 'paid' && isYMD(c.date)) it.paidOn = c.date; msg = `${c.type.split('.')[0]} ${c.id} status=${c.status}`; } }
  else if (c.type === 'charging.charged') { const d = find((data.charging || {}).devices, c.id); if (d && isYMD(c.date)) { d.lastCharged = c.date; msg = `device ${c.id} lastCharged=${c.date}`; } }
  console.log((msg ? 'APPLIED ' + msg : `IGNORED ${c.type} ${c.id}`));
  if (msg) applied++;
}
data.updatedAt = new Date().toISOString();
if (dry) { console.log(`DRY RUN: ${applied} change(s) would be applied`); process.exit(0); }
const tmp = P.DATA + '.tmp';
fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
fs.renameSync(tmp, P.DATA);
console.log(`MERGED ${applied} change(s) into ${P.DATA}; updatedAt=${data.updatedAt}. Now run tools/publish.sh.`);
