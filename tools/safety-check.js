#!/usr/bin/env node
'use strict';
/*
 Pre-commit safety check. Exit 0 = safe, 1 = BLOCKED, 2 = cannot check (fails closed).
   node tools/safety-check.js [repoDir]
 Blocks when:
   - any file that would be committed (staged index content + untracked, non-ignored files) contains a value
     from the private data file longer than 6 characters (case-insensitive; amounts also in 1,23,456.78 style),
   - any file named data.json, devices.json, kdf.json, vapid*, subscriptions*, notify-state.json (or *.pem, .env)
     exists in the repo (outside node_modules), or is staged,
   - any file that would be committed contains the value of $LIFE_HQ_PASSWORD (only if that env var is set;
     the value is never printed),
   - data.enc.json is not a v2 envelope or still has a password/KDF field.
 Exact values in <secrets>/safety-allow.txt (one per line) are ignored, for generic words that are not private.
*/
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const P = require('./paths');

const repo = path.resolve(process.argv[2] || P.REPO);
const git = (...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'buffer', maxBuffer: 64 << 20 });
const fail = (m, c = 1) => { console.error('SAFETY CHECK ' + (c === 1 ? 'BLOCKED' : 'ERROR') + ': ' + m); process.exit(c); };

const BAD_NAME = /^(data\.json|devices.*\.json|kdf\.json|notify-state\.json|vapid.*|subscriptions.*|.*\.pem|\.env(\..*)?)$/i;
const problems = [];

// 1) Forbidden file names anywhere in the working tree (even if ignored), plus anything staged.
(function walk(dir, rel) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === '.git' || e.name === 'node_modules') continue;
    const r = rel ? rel + '/' + e.name : e.name;
    if (e.isDirectory()) walk(path.join(dir, e.name), r);
    else if (BAD_NAME.test(e.name)) problems.push(`forbidden file present: ${r}`);
  }
})(repo, '');

let staged = [], untracked = [];
try {
  staged = git('ls-files', '-z', '--cached').toString('utf8').split('\0').filter(Boolean);
  untracked = git('ls-files', '-z', '--others', '--exclude-standard').toString('utf8').split('\0').filter(Boolean);
} catch (e) { fail('not a git repo or git failed: ' + e.message, 2); }
for (const f of staged.concat(untracked)) if (BAD_NAME.test(path.basename(f))) problems.push(`forbidden file would be committed: ${f}`);

// 2) Private values.
let data;
try { data = JSON.parse(fs.readFileSync(P.DATA, 'utf8')); } catch (e) { fail(`cannot read private data ${P.DATA} (${e.message}); refusing to commit without checking. Set LIFE_HQ_DATA.`, 2); }
let allow = new Set();
try { allow = new Set(fs.readFileSync(P.ALLOW_FILE, 'utf8').split(/\r?\n/).map(s => s.trim().toLowerCase()).filter(Boolean)); } catch (e) { /* optional */ }

const values = new Map(); // lowercased needle -> description
const inr = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 });
(function collect(v, where) {
  if (v == null) return;
  if (Array.isArray(v)) return v.forEach((x, i) => collect(x, `${where}[${i}]`));
  if (typeof v === 'object') return Object.entries(v).forEach(([k, x]) => collect(x, where ? `${where}.${k}` : k));
  const forms = [String(v)];
  if (typeof v === 'number') {
    forms.push(inr.format(v), v.toFixed(2));
    if (/amount/i.test(where)) forms.forEach(f => { if (f.length >= 5) values.set(f.toLowerCase(), where); });
  }
  for (const f of forms) if (f.trim().length > 6 && !allow.has(f.trim().toLowerCase())) values.set(f.toLowerCase(), where);
})(data, '');

// The old v1 password (if still in the environment): never in any committed file. Exact, case-sensitive match.
const PW = process.env.LIFE_HQ_PASSWORD || '';
const pwBuf = PW.length >= 6 ? Buffer.from(PW, 'utf8') : null;

function check(name, buf) {
  const text = buf.toString('utf8').toLowerCase();
  for (const [needle, where] of values) if (text.includes(needle)) problems.push(`${name} contains private value from ${where} (${needle.length} chars)`);
  if (pwBuf && buf.includes(pwBuf)) problems.push(`${name} contains the LIFE_HQ_PASSWORD value (not shown)`);
}
for (const f of staged) {
  let buf;
  try { buf = git('show', ':' + f); } catch (e) { continue; } // deleted in index
  check(f + ' (staged)', buf);
}
for (const f of untracked) {
  try { check(f, fs.readFileSync(path.join(repo, f))); } catch (e) { /* unreadable */ }
}
// Also the working copy of tracked files (catches edits not yet staged).
for (const f of staged) {
  try { check(f, fs.readFileSync(path.join(repo, f))); } catch (e) { /* deleted */ }
}

// 3) The public envelope must be v2 (public-key only): no password-derived recipient, no KDF parameters.
function checkEnvelope(name, buf) {
  let env;
  try { env = JSON.parse(buf.toString('utf8')); } catch (e) { problems.push(`${name} is not valid JSON`); return; }
  if (env.v !== 2 || !Array.isArray(env.recipients) || !env.recipients.length) problems.push(`${name} is not a v2 envelope with recipients (v=${env.v})`);
  if ('kdf' in env || 'salt' in env || 'iter' in env || (env.recipients || []).some(r => r && ('kdf' in r || 'iter' in r || 'password' in r))) problems.push(`${name} contains a password/KDF field; v2 must be public-key only`);
  if ((env.recipients || []).some(r => !r || typeof r !== 'object' || Object.keys(r).sort().join() !== 'epk,iv,kid,salt,wrapped')) problems.push(`${name} has a recipient with unexpected fields (device names must not be published)`);
}
for (const f of staged.concat(untracked)) {
  if (path.basename(f) !== 'data.enc.json') continue;
  if (!untracked.includes(f)) { try { checkEnvelope(f + ' (staged)', git('show', ':' + f)); } catch (e) { /* deleted in index */ } }
  try { checkEnvelope(f, fs.readFileSync(path.join(repo, f))); } catch (e) { /* deleted */ }
}

const uniq = [...new Set(problems)];
if (uniq.length) fail('\n  - ' + uniq.join('\n  - ') + '\nNothing was committed. Remove the leak (or, if a value is generic, add it to ' + P.ALLOW_FILE + ').');
console.log(`SAFETY CHECK OK: ${staged.length + untracked.length} files scanned against ${values.size} private values.`);
