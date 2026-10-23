#!/usr/bin/env node
'use strict';
/*
 Public-site smoke test. No browser and no dependencies.
   node tests/smoke.mjs [repoDir]
 Checks the CSP, manifest, required section anchors, the v2 envelope shape, the service worker,
 and that no private files were accidentally committed to the public repo.
*/
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(here, '..');
const problems = [];
const read = file => {
  try { return fs.readFileSync(path.join(root, file), 'utf8'); }
  catch (e) { problems.push(`missing/unreadable ${file}: ${e.message}`); return ''; }
};
const exists = file => fs.existsSync(path.join(root, file));
const need = (file, bytes = 1) => {
  try { if (fs.statSync(path.join(root, file)).size >= bytes) return true; }
  catch (e) { /* handled below */ }
  problems.push(`missing/empty ${file}`);
  return false;
};

for (const file of ['index.html', 'styles.css', 'app.js', 'logic.js', 'crypto.js', 'db.js', 'sw.js',
  'config.js', 'manifest.webmanifest', 'data.enc.json', 'privacy.html', '.nojekyll',
  'icons/icon-192.png', 'icons/icon-512.png']) need(file, file === '.nojekyll' ? 0 : (file.endsWith('.html') ? 100 : 1));

const html = read('index.html');
for (const directive of [
  "default-src 'self'",
  "script-src 'self'",
  "connect-src 'self' https://api.github.com",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "worker-src 'self'"
]) if (!html.includes(directive)) problems.push(`index.html CSP missing: ${directive}`);
if (!/<link[^>]+rel="manifest"[^>]+manifest\.webmanifest/i.test(html)) problems.push('index.html missing manifest link');
if (/<script(?![^>]*\bsrc=)[^>]*>/i.test(html)) problems.push('index.html has an inline <script> (CSP blocks it)');
for (const section of ['s-today', 's-money', 's-family', 's-charging', 's-home', 's-supplies', 's-alerts']) {
  if (!html.includes(`id="${section}"`)) problems.push(`index.html missing #${section} deep link`);
}

try {
  const manifest = JSON.parse(read('manifest.webmanifest'));
  if (!manifest.name || !manifest.short_name) problems.push('manifest missing name/short_name');
  if (manifest.start_url == null || manifest.scope == null) problems.push('manifest missing start_url/scope');
  if (!['standalone', 'fullscreen', 'minimal-ui'].includes(manifest.display)) problems.push('manifest display must be standalone-like');
  const sizes = (manifest.icons || []).map(i => i.sizes);
  if (!sizes.includes('192x192') || !sizes.includes('512x512')) problems.push('manifest missing 192/512 icons');
} catch (e) { problems.push('manifest is not valid JSON: ' + e.message); }

const config = read('config.js');
for (const token of ['dataUrl', 'inboxRepo', 'inboxPublicKey', 'inboxKid']) {
  if (!config.includes(token)) problems.push(`config.js missing ${token}`);
}
if (/\bprivateKey\b/.test(config) || /["']d["']\s*:/.test(config)) problems.push('config.js looks like it contains a private key');

try {
  const env = JSON.parse(read('data.enc.json'));
  if (env.v !== 2) problems.push('data.enc.json is not v2');
  if ('kdf' in env || 'salt' in env || 'iter' in env || 'password' in env) problems.push('data.enc.json has a password/KDF field');
  if (!Array.isArray(env.recipients) || !env.recipients.length) problems.push('data.enc.json has no recipients');
  for (const [i, r] of (env.recipients || []).entries()) {
    if (Object.keys(r).sort().join() !== 'epk,iv,kid,salt,wrapped') problems.push(`recipient ${i} has unexpected fields`);
    if (!/^[A-Za-z0-9_-]{16}$/.test(r.kid || '')) problems.push(`recipient ${i} has a bad kid`);
    try {
      const n = b => Buffer.from(String(b || ''), 'base64').length;
      if (n(r.epk) !== 65) problems.push(`recipient ${i} epk is not 65 bytes`);
      if (n(r.salt) !== 16) problems.push(`recipient ${i} salt is not 16 bytes`);
      if (n(r.iv) !== 12) problems.push(`recipient ${i} iv is not 12 bytes`);
      if (n(r.wrapped) !== 48) problems.push(`recipient ${i} wrapped is not 48 bytes`);
    } catch (e) { problems.push(`recipient ${i} has bad base64`); }
  }
  if (Buffer.from(String(env.iv || ''), 'base64').length !== 12) problems.push('data.enc.json iv is not 12 bytes');
  if (Buffer.from(String(env.ct || ''), 'base64').length < 17) problems.push('data.enc.json ciphertext is too short');
} catch (e) { problems.push('data.enc.json is not valid JSON: ' + e.message); }

const sw = read('sw.js');
for (const token of ['CACHE', 'data.enc.json', "addEventListener('push'", "addEventListener('notificationclick'", 'HQDB.putAlert']) {
  if (!sw.includes(token)) problems.push(`sw.js missing ${token}`);
}

const badName = /^(data\.json|box-key.*|inbox-token.*|devices.*\.json|kdf\.json|notify-state\.json|vapid.*|subscriptions.*|.*\.pem|\.env(\..*)?)$/i;
(function walk(dir, rel) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue;
    const r = rel ? rel + '/' + entry.name : entry.name;
    if (entry.isDirectory()) walk(path.join(dir, entry.name), r);
    else if (badName.test(entry.name)) problems.push(`private-looking file in public repo: ${r}`);
  }
})(root, '');

if (problems.length) {
  console.error('PUBLIC SMOKE FAILED:');
  for (const p of [...new Set(problems)]) console.error('  - ' + p);
  process.exit(1);
}
console.log(`PUBLIC SMOKE OK: ${root} (v2 envelope, CSP, manifest, sections, SW, no private files)`);
