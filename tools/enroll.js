#!/usr/bin/env node
'use strict';
/*
 Device enrollment for Life HQ v2 (per-device public-key encryption).
   node tools/enroll.js '<enrollment json from the app>'   add or update a device (+ its push subscription)
   node tools/enroll.js -                                   same, JSON on stdin
   node tools/enroll.js list                                list enrolled devices
   node tools/enroll.js remove <id|name>                    remove a device (and its push subscription)
 Enrollment JSON (from the app's 'Enroll this device' screen):
   {"lifeHqEnroll":2, "deviceName":"Pixel phone", "devicePublicKey":{"kty":"EC","crv":"P-256","x":"…","y":"…"},
    "kid":"…", "pushSubscription":{…} | null}
 Writes <secrets>/devices.json and <secrets>/subscriptions.json (both outside the repo, mode 600).
 Run tools/publish.sh afterwards so the new device is added as a recipient.
*/
const fs = require('fs');
const P = require('./paths');
const { kidFromJwk, validatePublicJwk } = require('./v2-crypto');
const { loadDevices, saveDevices } = require('./devices-lib');
const { loadSubs, saveSubs, validateSub, shortEndpoint } = require('./push-lib');

const fp = kid => kid.match(/.{1,4}/g).join(' ');
function cleanName(s) {
  s = String(s || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 40);
  return s || 'Unnamed device';
}

async function enroll(input) {
  input = String(input || '').trim();
  if (!input || input === '-') { try { input = fs.readFileSync(0, 'utf8').trim(); } catch (e) { input = ''; } }
  if (!input) { console.error("Usage: node tools/enroll.js '<enrollment json>' | list | remove <id|name>"); return 2; }
  let j;
  try { j = JSON.parse(input); } catch (e) { console.error('ERROR: not valid JSON: ' + e.message); return 1; }
  const jwk = j && (j.devicePublicKey || j.publicKeyJwk);
  if (!jwk) { console.error('ERROR: no devicePublicKey in that JSON (a bare push subscription? use: node tools/add-sub.js)'); return 1; }
  let clean;
  try { clean = await validatePublicJwk(jwk); } catch (e) { console.error('ERROR: invalid device public key: ' + e.message); return 1; }
  const id = await kidFromJwk(clean);
  if (j.kid && j.kid !== id) { console.error(`ERROR: fingerprint mismatch (app says ${j.kid}, key gives ${id}); the code was altered or truncated`); return 1; }
  const name = cleanName(j.deviceName);

  const devices = loadDevices();
  const now = new Date().toISOString();
  const idx = devices.findIndex(d => d.id === id);
  if (devices.some((d, i) => i !== idx && d.name.toLowerCase() === name.toLowerCase())) console.error(`WARNING: another device is already named "${name}"; remove the old one if it was this device before its data was cleared.`);
  if (idx >= 0) devices[idx] = Object.assign(devices[idx], { name, publicKeyJwk: clean, updatedAt: now });
  else devices.push({ id, name, publicKeyJwk: clean, addedAt: now });
  saveDevices(devices);
  console.log(`${idx >= 0 ? 'UPDATED' : 'ENROLLED'} device "${name}"  id/fingerprint ${id}  (${fp(id)})  total ${devices.length} in ${P.DEVICES_FILE}`);

  if (j.pushSubscription) {
    const sub = j.pushSubscription;
    const err = validateSub(sub);
    if (err) { console.error('WARNING: push subscription ignored (invalid: ' + err + ')'); }
    else {
      const subs = loadSubs();
      const rec = { endpoint: sub.endpoint, expirationTime: sub.expirationTime ?? null, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth }, addedAt: now, deviceId: id, deviceName: name };
      const si = subs.findIndex(s => s.endpoint === rec.endpoint);
      if (si >= 0) { rec.addedAt = subs[si].addedAt || now; subs[si] = rec; } else subs.push(rec);
      saveSubs(subs);
      console.log(`${si >= 0 ? 'UPDATED' : 'ADDED'} push subscription ${shortEndpoint(rec.endpoint)} (total ${subs.length}) in ${P.SUBS_FILE}`);
    }
  } else console.log('no push subscription in the code (enable notifications in the app and paste again to add one)');
  console.log('Next: tools/publish.sh  (re-encrypts the data for all enrolled devices)');
  return 0;
}

function list() {
  const devices = loadDevices();
  if (!devices.length) { console.log(`no devices enrolled (${P.DEVICES_FILE})`); return 0; }
  const subs = loadSubs();
  for (const d of devices) console.log(`${d.id}  ${d.name.padEnd(24)}  added ${d.addedAt}${d.updatedAt ? ' updated ' + d.updatedAt : ''}  push: ${subs.filter(s => s.deviceId === d.id).length}`);
  console.log(`${devices.length} device(s) in ${P.DEVICES_FILE}`);
  return 0;
}

function remove(who) {
  if (!who) { console.error('Usage: node tools/enroll.js remove <id|name>'); return 2; }
  const devices = loadDevices();
  const w = who.toLowerCase();
  const hit = devices.filter(d => d.id === who || d.name.toLowerCase() === w);
  if (!hit.length) { console.error(`ERROR: no device with id or name "${who}"`); return 1; }
  if (hit.length > 1) { console.error(`ERROR: "${who}" matches ${hit.length} devices; remove by id: ${hit.map(d => d.id).join(', ')}`); return 1; }
  const d = hit[0];
  saveDevices(devices.filter(x => x !== d));
  const subs = loadSubs();
  const keep = subs.filter(s => s.deviceId !== d.id);
  if (keep.length !== subs.length) saveSubs(keep);
  console.log(`REMOVED device "${d.name}" (${d.id}); ${subs.length - keep.length} push subscription(s) removed. ${devices.length - 1} device(s) left.`);
  console.log('Next: tools/publish.sh  (the removed device cannot read data published from now on; it can still read what it already downloaded)');
  return 0;
}

async function main(argv) {
  if (argv[0] === 'list') return list();
  if (argv[0] === 'remove') return remove(argv.slice(1).join(' '));
  return enroll(argv.join(' '));
}
module.exports = { main };
if (require.main === module) main(process.argv.slice(2)).then(c => process.exit(c), e => { console.error('ERROR: ' + e.message); process.exit(1); });
