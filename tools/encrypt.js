#!/usr/bin/env node
'use strict';
/*
 Encrypts the private data file into <repo>/data.enc.json (safe to publish) for every enrolled device.
   node tools/encrypt.js [--out path]
 Format v2: {v:2, alg:'ECDH-P256+HKDF-SHA256+A256GCM', recipients:[{kid, epk, salt, iv, wrapped}], iv, ct}
 A fresh random data key (DEK) and IV every run; the DEK is wrapped (ECIES) to each device public key listed in
 <secrets>/devices.json (enroll with tools/enroll.js). No password, no password-derived recipient.
 Refuses to run when no device is enrolled.
*/
const fs = require('fs');
const path = require('path');
const P = require('./paths');
const { encryptEnvelope } = require('./v2-crypto');
const { loadDevices } = require('./devices-lib');

const args = process.argv.slice(2);
const outPath = args.includes('--out') ? path.resolve(args[args.indexOf('--out') + 1]) : P.ENC;
const die = (m, c = 1) => { console.error('ERROR: ' + m); process.exit(c); };

(async () => {
  let devices;
  try { devices = loadDevices(); } catch (e) { die(`cannot read ${P.DEVICES_FILE}: ${e.message}`); }
  if (!devices.length) die(`no devices enrolled in ${P.DEVICES_FILE}. Enroll one first: node tools/enroll.js '<code from the app>'`, 3);

  let plain;
  try { plain = fs.readFileSync(P.DATA, 'utf8'); } catch (e) { die(`cannot read data file ${P.DATA}: ${e.message}`); }
  let data;
  try { data = JSON.parse(plain); } catch (e) { die(`data file is not valid JSON: ${e.message}`); }
  if (!data.schemaVersion) die('data file has no schemaVersion');

  const env = await encryptEnvelope(Buffer.from(JSON.stringify(data), 'utf8'), devices);
  const tmp = outPath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(env) + '\n');
  fs.renameSync(tmp, outPath);
  console.log(`ENCRYPTED ${P.DATA} -> ${outPath} (v2, ${env.recipients.length} device${env.recipients.length === 1 ? '' : 's'}: ${env.recipients.map(r => r.kid).join(', ')}; schemaVersion ${data.schemaVersion}, updatedAt ${data.updatedAt || 'n/a'})`);
})().catch(e => die(e.message));
