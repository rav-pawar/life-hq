'use strict';
// Enrolled devices: <secrets>/devices.json = [{id, name, publicKeyJwk, addedAt, updatedAt?}]  (id = key fingerprint / kid).
// Public keys only, but kept PRIVATE (out of the repo): knowing a device public key lets someone encrypt data for it.
const fs = require('fs');
const P = require('./paths');
const { writeJson600 } = require('./push-lib');

function loadDevices() {
  if (!fs.existsSync(P.DEVICES_FILE)) return [];
  const txt = fs.readFileSync(P.DEVICES_FILE, 'utf8').trim();
  if (!txt) return [];
  const arr = JSON.parse(txt);
  if (!Array.isArray(arr)) throw new Error('devices.json must be a JSON array');
  for (const d of arr) if (!d || !d.id || !d.publicKeyJwk) throw new Error('devices.json entry without id/publicKeyJwk');
  return arr;
}
const saveDevices = list => writeJson600(P.DEVICES_FILE, list);
module.exports = { loadDevices, saveDevices };
