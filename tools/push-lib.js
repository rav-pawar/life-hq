'use strict';
// Web Push helpers: VAPID keys + subscriptions live in the secrets folder (never in the repo).
const fs = require('fs');
const P = require('./paths');

function ensureDir() { if (!fs.existsSync(P.SECRETS)) fs.mkdirSync(P.SECRETS, { recursive: true, mode: 0o700 }); }
function writeJson600(file, obj) {
  ensureDir();
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o600); } catch (e) { /* windows */ }
}
function loadVapid() {
  const v = JSON.parse(fs.readFileSync(P.VAPID_FILE, 'utf8'));
  if (!v.publicKey || !v.privateKey) throw new Error('vapid.json is missing keys');
  v.subject = v.subject || 'mailto:ravi.alerts@example.com';
  return v;
}
function loadSubs() {
  if (!fs.existsSync(P.SUBS_FILE)) return [];
  const txt = fs.readFileSync(P.SUBS_FILE, 'utf8').trim();
  if (!txt) return [];
  const arr = JSON.parse(txt);
  if (!Array.isArray(arr)) throw new Error('subscriptions.json must be a JSON array');
  return arr;
}
const saveSubs = subs => writeJson600(P.SUBS_FILE, subs);
function validateSub(s) {
  if (!s || typeof s !== 'object') return 'not a JSON object';
  if (typeof s.endpoint !== 'string' || !/^https:\/\//.test(s.endpoint)) return 'missing or invalid "endpoint" (must be https URL)';
  if (!s.keys || typeof s.keys.p256dh !== 'string' || typeof s.keys.auth !== 'string') return 'missing "keys.p256dh" / "keys.auth"';
  if (!/^[A-Za-z0-9_-]+=*$/.test(s.keys.p256dh) || !/^[A-Za-z0-9_-]+=*$/.test(s.keys.auth)) return 'keys must be base64url strings';
  return null;
}
function shortEndpoint(ep) { try { const u = new URL(ep); return u.host + '/…' + ep.slice(-10); } catch (e) { return ep.slice(0, 40) + '…'; } }

const MAX_PAYLOAD = 3500;
const TTL = 24 * 60 * 60;
const bytes = s => Buffer.byteLength(s, 'utf8');
function truncStr(s, maxBytes) {
  if (bytes(s) <= maxBytes) return s;
  let out = s;
  while (out.length && bytes(out + '…') > maxBytes) out = out.slice(0, Math.max(0, out.length - Math.max(1, Math.ceil((bytes(out) - maxBytes) / 4))));
  return out + '…';
}
// Builds the payload the service worker expects: {id, type, title, body, items?, ts, url?}, kept <= 3500 bytes.
function buildPayload({ type = 'info', title, body = '', items, url, id, ts = Date.now() }) {
  if (!['urgent', 'summary', 'info'].includes(type)) throw new Error('type must be urgent, summary or info');
  if (!title) throw new Error('title is required');
  const p = { id: id ? String(id) : `${type}-${ts}-${Math.random().toString(36).slice(2, 7)}`, type, title: truncStr(String(title), 200), body: truncStr(String(body || ''), 1500), ts };
  if (items && items.length) p.items = items.map(i => truncStr(typeof i === 'string' ? i : JSON.stringify(i), 400));
  if (url) p.url = String(url);
  let json = JSON.stringify(p);
  if (bytes(json) > MAX_PAYLOAD && p.items) {
    const all = p.items; let n = all.length;
    while (n > 0) { n--; p.items = all.slice(0, n).concat([`…and ${all.length - n} more (truncated)`]); json = JSON.stringify(p); if (bytes(json) <= MAX_PAYLOAD) break; }
  }
  while (bytes(json) > MAX_PAYLOAD && p.body.length > 20) { p.body = truncStr(p.body, Math.floor(bytes(p.body) * 0.8)); json = JSON.stringify(p); }
  if (bytes(json) > MAX_PAYLOAD) throw new Error('payload still too large after truncation');
  return { payload: p, json };
}

// Sends one payload to every subscription. Removes expired ones (404/410).
async function sendToAll(payload, json, log = console.log) {
  const subs = loadSubs();
  if (!subs.length) { log('no subscriptions yet'); return { ok: 0, failed: 0, removed: 0, noSubs: true }; }
  const webpush = require('web-push');
  const vapid = loadVapid();
  webpush.setVapidDetails(vapid.subject, vapid.publicKey, vapid.privateKey);
  const options = { TTL, urgency: payload.type === 'urgent' ? 'high' : 'normal' };
  let ok = 0, failed = 0; const expired = new Set();
  for (const s of subs) {
    const label = shortEndpoint(s.endpoint);
    try {
      const res = await webpush.sendNotification({ endpoint: s.endpoint, keys: s.keys }, json, options);
      ok++; log(`OK      ${label} status=${res.statusCode} type=${payload.type} bytes=${bytes(json)}`);
    } catch (e) {
      const code = e.statusCode;
      if (code === 404 || code === 410) { expired.add(s.endpoint); log(`EXPIRED ${label} status=${code} -> removed`); }
      else { failed++; log(`FAILED  ${label} status=${code || 'n/a'} ${String(e.body || e.message).trim().slice(0, 200)}`); }
    }
  }
  if (expired.size) saveSubs(loadSubs().filter(s => !expired.has(s.endpoint)));
  log(`DONE sent=${ok} failed=${failed} removed=${expired.size} id=${payload.id}`);
  return { ok, failed, removed: expired.size };
}

module.exports = { P, writeJson600, loadVapid, loadSubs, saveSubs, validateSub, shortEndpoint, buildPayload, sendToAll, bytes };
