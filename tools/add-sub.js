#!/usr/bin/env node
'use strict';
// Usage: node tools/add-sub.js '<subscription json>'   (or pipe JSON on stdin: ... | node tools/add-sub.js -)
const fs = require('fs');
const { loadSubs, saveSubs, validateSub, shortEndpoint, P } = require('./push-lib');

function addSub(input) {
  input = String(input || '').trim();
  if (!input || input === '-') { try { input = fs.readFileSync(0, 'utf8').trim(); } catch (e) { input = ''; } }
  if (!input) { console.error("Usage: node tools/add-sub.js '<subscription json>'"); return 2; }
  let sub;
  try { sub = JSON.parse(input); } catch (e) { console.error('ERROR: not valid JSON: ' + e.message); return 1; }
  if (sub && sub.subscription && !sub.endpoint) sub = sub.subscription;
  const err = validateSub(sub);
  if (err) { console.error('ERROR: invalid subscription: ' + err); return 1; }
  const clean = { endpoint: sub.endpoint, expirationTime: sub.expirationTime ?? null, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth }, addedAt: new Date().toISOString() };
  const subs = loadSubs();
  const idx = subs.findIndex(s => s.endpoint === clean.endpoint);
  if (idx >= 0) { clean.addedAt = subs[idx].addedAt || clean.addedAt; subs[idx] = clean; saveSubs(subs); console.log(`UPDATED existing subscription ${shortEndpoint(clean.endpoint)} (total ${subs.length}) in ${P.SUBS_FILE}`); }
  else { subs.push(clean); saveSubs(subs); console.log(`ADDED subscription ${shortEndpoint(clean.endpoint)} (total ${subs.length}) in ${P.SUBS_FILE}`); }
  return 0;
}
module.exports = { addSub };
if (require.main === module) process.exit(addSub(process.argv.slice(2).join(' ')));
