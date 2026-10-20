/* Life HQ page logic: device enrollment + decryption (v2, per-device keys), dashboard sections, push setup, alert history. */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const cfg = self.LIFE_HQ_CONFIG || {};
  const L = self.LifeLogic;
  const supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  let reg = null;
  // Version of this page's code; must equal CACHE in sw.js (bump both together). A different live sw.js = new code.
  const APP_VERSION = 'life-hq-v17';

  // In-memory only. Plaintext data is never written to storage.
  const st = { env: null, device: null, data: null, overrides: {}, flashId: null, noData: false, lastSync: 0, offline: false, lastCheck: 0 };

  // Optional ?now=2026-01-03T08:45:00+05:30 to preview another time (testing only; no effect on data).
  const nowParam = new URLSearchParams(location.search).get('now');
  const nowMs = () => (nowParam && Date.parse(nowParam)) || Date.now();

  const istFmt = new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true });
  const fmtIST = ms => istFmt.format(new Date(ms)) + ' IST';
  const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 });

  function banner(msg) { const b = $('banner'); b.textContent = msg || ''; b.classList.toggle('hidden', !msg); }
  function status(msg) { $('status').textContent = msg || ''; }

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function safeLink(url) {
    try { const u = new URL(url, location.href); return (u.protocol === 'https:' || u.protocol === 'http:') ? u.href : null; } catch (e) { return null; }
  }
  function btn(label, cls, onClick) {
    const b = el('button', 'btn small ' + (cls || ''), label);
    b.addEventListener('click', async () => { b.disabled = true; try { await onClick(); } finally { b.disabled = false; } });
    return b;
  }
  function pill(text, cls) { return el('span', 'pill ' + (cls || ''), text); }

  // ================= Device key / enrollment / decrypt =================
  // The device key pair {privateKey (non-extractable), publicKey, publicJwk, kid} lives in IndexedDB meta 'deviceKey'.
  // There is no password: the device can decrypt only if the published data lists its kid as a recipient.
  const NOT_ENROLLED = 'This device isn\u2019t enrolled yet \u2014 paste the enrollment code to your assistant';

  // Network-first, never a stale copy: no-store + a cache-busting query (GitHub Pages sends max-age=600).
  // Offline, the service worker answers from its cache and marks the response with X-Life-HQ-Offline: 1.
  async function loadEnvelope() {
    try {
      const u = new URL(cfg.dataUrl || './data.enc.json', location.href);
      u.searchParams.set('t', Date.now().toString(36));
      const res = await fetch(u.href, { cache: 'no-store' });
      st.offline = res.headers.get('X-Life-HQ-Offline') === '1';
      if (!res.ok) return null;
      const env = await res.json();
      if (!st.offline) { st.lastSync = Date.now(); HQDB.setMeta('lastSync', st.lastSync).catch(() => {}); }
      return env;
    } catch (e) { st.offline = true; return null; }
    finally { updateSyncInfo(); }
  }
  const envFp = env => (env && typeof env === 'object') ? [env.v, env.iv, env.ct].join('|') : '';

  async function loadDevice() {
    const d = await HQDB.getMeta('deviceKey').catch(() => null);
    return d && d.privateKey && d.publicJwk && d.kid ? d : null;
  }
  async function createDevice() {
    const d = await LifeCrypto.createDeviceKey();
    await HQDB.setMeta('deviceKey', d);
    persistStorage();
    return d;
  }

  async function enrollCode() {
    if (!st.device) return '';
    const sub = await currentSub().catch(() => null);
    return JSON.stringify({ lifeHqEnroll: 2, deviceName: ($('deviceName').value || '').trim(), devicePublicKey: st.device.publicJwk,
      kid: st.device.kid, pushSubscription: sub ? (sub.toJSON ? sub.toJSON() : sub) : null });
  }
  async function refreshEnroll() {
    const has = !!st.device;
    $('enrollBox').classList.toggle('hidden', !has);
    $('newKeyBtn').classList.toggle('hidden', has);
    $('lockBtn').classList.toggle('hidden', !has);
    $('forgetBtn').classList.toggle('hidden', !has);
    $('deviceKid').textContent = has ? st.device.kid : '';
    const code = await enrollCode();
    $('enrollJson').value = code;
    if (!$('subBox').classList.contains('hidden')) $('subJson').value = code;
  }

  function showLock(msg) {
    flushNoteDeletes(); noteEdit = null; ideaEdit = null; wiki.hash = null; // a delete waiting on its Undo toast is still queued
    st.data = null;
    $('dash').classList.add('hidden');
    $('tabs').classList.add('hidden');
    for (const id of ['todayList', 'calendarBox', 'todoBox', 'todoSection', 'notesList', 'ideasList', 'wikiBox', 'moneyList', 'noticeList', 'familyList', 'chargingList', 'weekendBox', 'homeList', 'suppliesList', 'urgentList', 'summaryList', 'infoList']) $(id).replaceChildren();
    $('noteInput').value = '';
    $('ideaTitle').value = ''; $('ideaDetails').value = ''; ideaDraft.title = ideaDraft.details = '';
    $('syncJson').value = '';
    $('lock').classList.remove('hidden');
    $('lockMsg').textContent = msg || '';
    $('noDataBtn').classList.remove('hidden');
    document.body.dataset.view = 'enroll'; // state marker (also used by the headless end-to-end test)
    return refreshEnroll();
  }

  async function openDashboard() {
    $('lock').classList.add('hidden');
    $('dash').classList.remove('hidden');
    $('tabs').classList.remove('hidden');
    refreshEnroll();
    await renderAll();
    if (st.flashId) { await renderAlerts(st.flashId); st.flashId = null; }
    else if (location.hash.startsWith('#s-')) scrollToSection(location.hash.slice(1), false); // deep link: the section exists only now
    updateActivePill();
    document.body.dataset.view = 'dashboard';
  }

  // Returns '' on success (st.data set), else the message for the enroll screen.
  async function tryDecrypt() {
    st.data = null;
    if (!st.device) return 'This device has no key yet. Tap \u201cCreate this device\u2019s key\u201d, then send the code to your assistant.';
    if (!st.env) return 'No encrypted data published yet. ' + NOT_ENROLLED + '.';
    try {
      st.data = await LifeCrypto.decryptForDevice(st.env, st.device);
      st.noData = false;
      await provisionToken().catch(e => console.error('sync provisioning failed', e));
      persistStorage();
      return '';
    } catch (e) {
      if (e.code === 'FORMAT_V1') return 'The data format was upgraded (no more password). ' + NOT_ENROLLED + '.';
      if (e.code === 'NOT_RECIPIENT') return NOT_ENROLLED + '.';
      if (e.code === 'DECRYPT_FAILED') { console.error('decrypt failed', e.cause || e); return '\u26a0\ufe0f The published data could not be decrypted (corrupted or tampered). Nothing was shown. Ask your assistant to publish again.'; }
      return '\u26a0\ufe0f ' + e.message;
    }
  }

  async function unlockFlow() {
    st.env = await loadEnvelope();
    const msg = await tryDecrypt();
    if (!msg) { await openDashboard(); return true; }
    await showLock(msg);
    return false;
  }

  async function forgetDevice() {
    if (!confirm('Lock and forget this device?\n\nThis deletes this device\u2019s private key. The data can then no longer be opened here until you create a new key, send the new enrollment code to your assistant and they publish again.')) return;
    st.data = null; st.noData = false; st.device = null;
    await HQDB.delMeta('deviceKey').catch(() => {});
    $('settings').classList.add('hidden');
    $('subBox').classList.add('hidden');
    showLock('Locked. This device\u2019s key was deleted; re-enrolling is needed to open the data here.');
  }

  async function newKey() {
    $('newKeyBtn').disabled = true;
    try { st.device = await createDevice(); await unlockFlow(); }
    catch (e) { showLock('\u26a0\ufe0f Could not create a device key: ' + e.message); }
    finally { $('newKeyBtn').disabled = false; }
  }

  // Ask Chrome not to evict IndexedDB (device key, local taps, alert history).
  async function persistStorage() {
    try { if (navigator.storage && navigator.storage.persist && !(await navigator.storage.persisted())) await navigator.storage.persist(); } catch (e) { /* best effort */ }
  }

  // ================= Local overrides =================
  // Taps live in IndexedDB ('local' store) until the published data reflects them, so they survive reloads and
  // auto-refreshes. A tap newer than data.updatedAt is pending. A tap older than data.updatedAt (i.e. the data was
  // republished after it) is cleared if the data already shows it (merge-changes applied it), otherwise it is
  // kept as pending (keep:true) and still exported in "Changes to sync".
  function reflected(key, v, d) {
    const i = key.indexOf(':'), kind = key.slice(0, i), id = key.slice(i + 1);
    const find = list => (list || []).find(x => x && x.id === id);
    if (kind === 'maint') { const t = find(((d.maintenance || {}).appliances || []).flatMap(a => a.tasks || [])); return !t || (!!t.lastDone && !!v.lastDone && t.lastDone >= v.lastDone); }
    if (kind === 'charge') { const c = find((d.charging || {}).devices); return !c || (!!c.lastCharged && !!v.date && c.lastCharged >= v.date); }
    if (kind === 'supply') { const s = find((d.supplies || {}).items); return !s || ((s.status || 'ok') === v.status && (!v.lastBought || (!!s.lastBought && s.lastBought >= v.lastBought))); }
    if (kind === 'card' || kind === 'bill') { const m = find((d.money || {})[kind === 'card' ? 'cards' : 'bills']); return !m || (m.status || 'unpaid') === v.status; }
    if (kind === 'notice') { const n = find((d.notices || {}).items); return !n || (n.status === 'done' ? 'done' : 'open') === v.status; }
    if (kind === 'todo') { const t = find((d.todos || {}).items); return !t || !!t.done === !!v.done; }
    if (kind === 'tododis') { const t = find((d.todos || {}).items); return !t || !!t.dismissed === !!v.dismissed; }
    if (kind === 'noticedis') { const n = find((d.notices || {}).items); return !n || (n.status === 'dismissed') === !!v.dismissed; }
    if (kind === 'note') {
      // Applied = the box has the note (add) or a tombstone for it (add or delete): a delete is never cleared before it lands.
      const notes = d.notes || {}, gone = (notes.deleted || []).includes(id);
      if (v.op === 'edit') { const n = find(notes.items); return gone || (!!n && n.text === v.text); }
      return v.op === 'delete' ? gone : (gone || !!find(notes.items));
    }
    if (kind === 'idea' || kind === 'ideast') {
      // Applied = the box has it (add / edit / status) or a tombstone (any op): a delete is never cleared before it lands.
      const ideas = d.ideas || {}, gone = (ideas.deleted || []).includes(id), it = find(ideas.items);
      if (kind === 'ideast') return gone || !it || it.status === v.status;
      if (v.op === 'delete') return gone;
      if (v.op === 'edit') return gone || !it || (it.title === v.title && (it.details || '') === (v.details || '') && (it.priority || null) === (v.priority || null));
      return gone || !!it;
    }
    return true; // unknown kind: nothing to sync
  }
  async function loadOverrides() {
    const all = await HQDB.getLocalAll().catch(() => ({}));
    if (st.data) {
      const base = Date.parse(st.data.updatedAt || 0) || 0;
      for (const [k, v] of Object.entries(all)) {
        if (!v || (v.at || 0) > base) continue;
        if (reflected(k, v, st.data)) { delete all[k]; await HQDB.delLocal(k).catch(() => {}); await markApplied(k); }
        else all[k] = Object.assign({}, v, { keep: true });
      }
    }
    st.overrides = all;
  }
  async function setLocal(key, val) { await HQDB.setLocal(key, Object.assign({ at: Date.now() }, val)); await renderPreserving(); scheduleSync(); }
  async function delLocal(key) { await HQDB.delLocal(key); await forgetSent(key); await renderPreserving(); }

  // [{ key, v, change }] for every pending tap (key = IndexedDB 'local' key, v.at = tap time).
  function pendingEntries() {
    const base = Date.parse((st.data && st.data.updatedAt) || 0) || 0;
    const out = [];
    for (const [k, v] of Object.entries(st.overrides)) {
      if (!v || ((v.at || 0) <= base && !v.keep)) continue;
      const [kind, id] = [k.slice(0, k.indexOf(':')), k.slice(k.indexOf(':') + 1)];
      const at = new Date(v.at).toISOString();
      let change = null;
      if (kind === 'maint') change = { type: 'maintenance.done', id, date: v.lastDone, at };
      else if (kind === 'charge') change = { type: 'charging.charged', id, date: v.date, at };
      else if (kind === 'supply') change = Object.assign({ type: 'supply.update', id, status: v.status, at }, v.lastBought ? { lastBought: v.lastBought } : {});
      else if (kind === 'card' || kind === 'bill') change = { type: kind + '.status', id, status: v.status, date: v.date, at };
      else if (kind === 'notice') change = { type: 'notice.status', id, status: v.status, date: v.date, at };
      else if (kind === 'todo') change = { type: v.done ? 'todo.done' : 'todo.undone', id, at };
      else if (kind === 'tododis') change = { type: v.dismissed ? 'todo.dismiss' : 'todo.restore', id, at };
      else if (kind === 'noticedis') change = { type: v.dismissed ? 'notice.dismiss' : 'notice.restore', id, at };
      else if (kind === 'note') change = v.op === 'delete' ? { type: 'note.delete', id, at } : v.op === 'edit' ? { type: 'note.edit', id, text: v.text, at } : { type: 'note.add', id, text: v.text, createdAt: v.createdAt, at };
      else if (kind === 'idea') change = v.op === 'delete' ? { type: 'idea.delete', id, at }
        : v.op === 'edit' ? { type: 'idea.edit', id, title: v.title, details: v.details || '', priority: v.priority || null, at }
        : { type: 'idea.add', id, title: v.title, details: v.details || '', status: v.status || 'new', priority: v.priority || null, createdAt: v.createdAt, at };
      else if (kind === 'ideast') change = { type: 'idea.status', id, status: v.status, at };
      if (change) out.push({ key: k, v, change });
    }
    return out.sort((a, b) => a.change.at.localeCompare(b.change.at));
  }
  const pendingChanges = () => pendingEntries().map(e => e.change);

  // ================= Sync back (device -> box) =================
  // Pending taps are encrypted to the box key (config.js inboxPublicKey) and posted as an issue (ciphertext only) to
  // the private inbox repo, using a per-device fine-grained token (Issues: read/write on that repo only). The box
  // (tools/inbox.js) merges + republishes; the auto-refresh then sees them reflected and clears them ("applied").
  // Per tap status: queued (not sent yet / changed since) -> sent -> applied (cleared). Copy/paste stays as fallback.
  const INBOX_API = 'https://api.github.com/repos/' + (cfg.inboxRepo || 'rav-pawar/life-hq-inbox');
  const sync = { timer: 0, busy: false, token: undefined, sent: {}, applied: { n: 0, at: 0 }, lastError: '', lastOk: 0, lastTry: 0, failures: 0 };
  const syncReady = () => !!(cfg.inboxPublicKey && cfg.inboxPublicKey.x);
  async function loadSyncState() {
    sync.sent = (await HQDB.getMeta('syncSent').catch(() => null)) || {};
    const a = await HQDB.getMeta('syncApplied').catch(() => null); if (a) sync.applied = a;
  }
  const saveSent = () => HQDB.setMeta('syncSent', sync.sent).catch(() => {});
  async function markApplied(key) {
    if (!sync.sent[key]) return;
    delete sync.sent[key]; await saveSent();
    sync.applied = { n: (Date.now() - sync.applied.at < 15 * 60000 ? sync.applied.n : 0) + 1, at: Date.now() };
    HQDB.setMeta('syncApplied', sync.applied).catch(() => {});
    sync.justApplied = (sync.justApplied || 0) + 1;
  }
  async function forgetSent(key) { if (sync.sent[key]) { delete sync.sent[key]; await saveSent(); } }

  async function getToken() {
    if (sync.token !== undefined) return sync.token;
    try {
      const key = await HQDB.getMeta('syncTokenKey'), sealed = await HQDB.getMeta('syncToken');
      sync.token = key && sealed ? await LifeCrypto.unseal(key, sealed) : null;
    } catch (e) { sync.token = null; }
    return sync.token;
  }
  // Token source: 'auto' (delivered inside this device's encrypted data, payload.sync.inboxToken) or 'manual' (pasted
  // in Settings; overrides auto). Remove in Settings turns auto-provisioning off on this device ('syncAutoOff').
  sync.source = null; sync.autoOff = false;
  async function loadTokenMeta() {
    sync.source = (await HQDB.getMeta('syncTokenSource').catch(() => null)) || null;
    sync.autoOff = !!(await HQDB.getMeta('syncAutoOff').catch(() => false));
  }
  const autoToken = () => { const s = st.data && st.data.sync; return s && typeof s.inboxToken === 'string' && /^(github_pat_|ghp_)[A-Za-z0-9_]{20,}$/.test(s.inboxToken) ? s.inboxToken : null; };
  // Called after every successful decrypt.
  async function provisionToken() {
    if (!st.data || sync.autoOff) return;
    const t = autoToken(), cur = await getToken();
    if (sync.source === 'manual' && cur) return;                       // manual token wins
    if (t && t !== cur) { await saveToken(t, 'auto'); sync.lastError = ''; scheduleSync(1000); }
    else if (!t && cur && sync.source === 'auto') await removeToken();  // box stopped delivering it: revoke locally
  }
  async function saveToken(t, source) {
    let key = await HQDB.getMeta('syncTokenKey').catch(() => null);
    if (!key) { key = await LifeCrypto.newSealKey(); await HQDB.setMeta('syncTokenKey', key); }
    await HQDB.setMeta('syncToken', await LifeCrypto.seal(key, t));
    await HQDB.setMeta('syncTokenSource', source || 'manual');
    sync.token = t; sync.source = source || 'manual';
  }
  async function removeToken() { for (const k of ['syncToken', 'syncTokenKey', 'syncTokenSource']) await HQDB.delMeta(k).catch(() => {}); sync.token = null; sync.source = null; }
  async function setAutoOff(v) { sync.autoOff = !!v; await HQDB.setMeta('syncAutoOff', !!v).catch(() => {}); }
  function ghFetch(method, path, token, body) {
    return fetch(INBOX_API + path, { method, cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer',
      headers: Object.assign({ Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
        body ? { 'Content-Type': 'application/json' } : {}),
      body: body ? JSON.stringify(body) : undefined });
  }
  const httpMsg = s => s === 401 ? 'token rejected or expired (401): create a new one in Settings'
    : s === 403 ? 'token lacks permission (403): it needs Issues: Read and write on rav-pawar/life-hq-inbox'
    : s === 404 ? 'inbox repo not visible to this token (404): select rav-pawar/life-hq-inbox when creating it' : 'GitHub error ' + s;

  async function renderSyncState() {
    const token = await getToken();
    const queued = pendingEntries().filter(e => !(sync.sent[e.key] && sync.sent[e.key].at === e.v.at)).length;
    let t;
    if (!syncReady()) t = 'Automatic sync is not configured in this build; use Copy changes.';
    else if (!token) t = sync.autoOff ? 'Automatic sync is off on this device (⚙️ Settings → Use automatic sync), or use Copy changes.' : 'Automatic sync is not connected yet (it connects with the next data update), or use Copy changes.';
    else if (sync.lastError) t = '⚠️ Sync failed: ' + sync.lastError + (queued ? ' · will retry' : '');
    else if (queued) t = navigator.onLine ? `Sending ${queued} change${queued === 1 ? '' : 's'} shortly…` : `Offline: ${queued} queued, will send when back online`;
    else t = sync.lastOk ? 'Automatic sync on · last sent ' + hm(sync.lastOk) + ' IST' : 'Automatic sync on';
    $('syncState').textContent = t;
    $('tokenState').textContent = token ? (sync.source === 'auto' ? 'connected automatically ✓' : 'connected (manual token) ✓')
      : sync.autoOff ? 'off on this device' : 'not connected yet';
    $('tokenForm').classList.toggle('hidden', !!token);
    $('removeTokenBtn').classList.toggle('hidden', !token);
    $('autoSyncBtn').classList.toggle('hidden', !(sync.autoOff || (sync.source === 'manual' && token)));
    $('testSyncBtn').disabled = !token || !syncReady();
  }
  function scheduleSync(delay) {
    clearTimeout(sync.timer);
    sync.timer = setTimeout(() => syncNow().catch(e => console.error('sync failed', e)), delay == null ? 5000 : delay); // debounce taps
  }
  // Sends the queued taps (or an empty test payload). Returns the issue number, or 0.
  async function syncNow(opts) {
    opts = opts || {};
    if (sync.busy || !st.device || !syncReady()) return 0;
    const token = await getToken();
    if (!token || (!st.data && !opts.test)) return 0;
    const entries = opts.test ? [] : pendingEntries().filter(e => !(sync.sent[e.key] && sync.sent[e.key].at === e.v.at));
    if (!opts.test && !entries.length) return 0;
    if (!navigator.onLine) { renderSyncState(); return 0; }
    sync.busy = true; sync.lastTry = Date.now();
    try {
      const payload = { lifeHqChanges: 1, exportedAt: new Date().toISOString(), baseUpdatedAt: (st.data && st.data.updatedAt) || null, changes: entries.map(e => e.change) };
      if (opts.test) payload.test = true;
      const env = await LifeCrypto.encryptForBox(payload, cfg.inboxPublicKey, st.device);
      const res = await ghFetch('POST', '/issues', token, { title: `lhq-changes ${st.device.kid} ${payload.exportedAt}`, body: JSON.stringify(env) });
      if (res.status !== 201) { sync.lastError = httpMsg(res.status); sync.failures++; return 0; }
      const issue = (await res.json().catch(() => ({}))).number || 0;
      for (const e of entries) sync.sent[e.key] = { at: e.v.at, sentAt: Date.now(), issue };
      if (entries.length) await saveSent();
      sync.lastError = ''; sync.failures = 0; sync.lastOk = Date.now();
      return issue || -1;
    } catch (e) {
      sync.lastError = navigator.onLine ? 'network error (' + e.message + ')' : 'offline'; sync.failures++;
      return 0;
    } finally {
      sync.busy = false;
      if (st.data) renderSync(); else renderSyncState();
      if (sync.lastError && !opts.test) scheduleSync(Math.min(10 * 60000, 30000 * 2 ** Math.min(sync.failures, 5))); // backoff retry
    }
  }
  function wireSync() {
    $('saveTokenBtn').addEventListener('click', async () => {
      const t = $('tokenInput').value.trim();
      if (!/^(github_pat_|ghp_|gho_)[A-Za-z0-9_]{20,}$/.test(t)) { $('syncStatus').textContent = 'That does not look like a GitHub token (it starts with github_pat_).'; return; }
      $('syncStatus').textContent = 'Checking the token…';
      let ok = false;
      try { const r = await ghFetch('GET', '', t); ok = r.ok; if (!ok) $('syncStatus').textContent = '⚠️ ' + httpMsg(r.status) + '. Not saved.'; }
      catch (e) { $('syncStatus').textContent = '⚠️ Could not reach GitHub (' + e.message + '). Not saved.'; }
      if (!ok) return;
      await saveToken(t, 'manual'); await setAutoOff(false); $('tokenInput').value = '';
      sync.lastError = '';
      $('syncStatus').textContent = 'Token saved ✓ (encrypted on this device). Tap Test sync to check end to end.';
      if (st.data) renderSync(); else renderSyncState();
      scheduleSync(500);
    });
    $('removeTokenBtn').addEventListener('click', async () => {
      if (!confirm('Turn off automatic sync on this device? The token is deleted here and will not be re-provisioned until you tap \u201cUse automatic sync\u201d.')) return;
      await removeToken(); await setAutoOff(true);
      $('syncStatus').textContent = 'Automatic sync turned off on this device. Changes stay here until you copy them or turn sync back on.';
      if (st.data) renderSync(); else renderSyncState();
    });
    $('autoSyncBtn').addEventListener('click', async () => {
      await setAutoOff(false);
      if (sync.source === 'manual') await removeToken(); // back to the token delivered with the data
      await provisionToken();
      $('syncStatus').textContent = (await getToken()) ? 'Automatic sync on ✓' : 'Automatic sync on; it connects with the next data update.';
      if (st.data) renderSync(); else renderSyncState();
    });
    $('testSyncBtn').addEventListener('click', async () => {
      $('syncStatus').textContent = 'Sending an encrypted test…';
      const n = await syncNow({ test: true });
      $('syncStatus').textContent = n ? `✓ Test sync sent${n > 0 ? ' (issue #' + n + ')' : ''}. Your assistant's box will mark it applied on its next inbox run.` : '⚠️ Test sync failed: ' + (sync.lastError || 'not ready');
    });
    addEventListener('online', () => scheduleSync(1000));
  }

  // ================= Auto-refresh =================
  const hm = ms => new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(ms));
  function updateSyncInfo() {
    const t = st.lastSync ? 'Last synced ' + hm(st.lastSync) + ' IST' : '';
    const txt = st.offline ? ('Offline' + (t ? ' \u00b7 ' + t : ' \u00b7 showing saved data')) : t;
    for (const id of ['syncInfo', 'syncInfoSettings']) { const e = $(id); if (e) e.textContent = (st.data || st.noData) ? txt : ''; }
  }
  let toastTimer = 0;
  function toast(msg, warn) {
    const t = $('toast'); t.textContent = msg; t.classList.toggle('warn', !!warn); t.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 3500);
  }
  // Keep the section at the top of the viewport where it was across a re-render (so scroll and active pill stay put).
  function scrollAnchor() {
    const off = headerOffset();
    for (const s of document.querySelectorAll('#dash > .sec')) {
      if (s.offsetParent === null) continue;
      const r = s.getBoundingClientRect();
      if (r.bottom > off) return { id: s.id, top: r.top, y: window.scrollY };
    }
    return null;
  }
  function restoreAnchor(a) {
    if (!a || a.y < 1 || nav.lockId) return;
    const s = $(a.id); if (!s) return;
    const d = s.getBoundingClientRect().top - a.top;
    if (Math.abs(d) >= 1) window.scrollBy(0, d);
  }
  async function renderPreserving() {
    upd.lastRender = Date.now();
    const a = scrollAnchor();
    await renderAll();
    restoreAnchor(a);
    updateActivePill();
  }
  // ================= Updates: check often, apply only when the user is idle =================
  // Every ~2.5 min while visible (and on visible / focus / online) we check for new encrypted data and for new app code.
  // Nothing re-renders or reloads while you are using the page: a pending update shows the "Update available" pill in
  // the header (tap = apply now) and is applied automatically after 10 s without interaction, while the page is visible,
  // no text field is focused and neither Settings nor a confirm dialog is open.
  // Data updates re-render in place (scroll position kept); code updates activate the new service worker and reload once.
  const IDLE_MS = 10000, CHECK_MS = 150000, TICK_MS = 60000;
  const upd = { env: null, rejected: '', alerts: false, tick: false, code: false, codeVersion: '', codeAuto: true,
    lastActivity: Date.now(), lastRender: Date.now(), lastCodeCheck: 0, timer: 0, applying: false, reloading: false, dialogs: 0, hadController: false };

  // Fetch data.enc.json; a changed ciphertext becomes a pending update (applied by the idle gate, never immediately).
  let refreshing = null, trailing = 0;
  function refreshData(reason, force) {
    if (refreshing) return refreshing;
    const wait = 3000 - (Date.now() - st.lastCheck);
    if (!force && wait > 0) { // just checked: run one trailing check instead of dropping this trigger
      if (!trailing) trailing = setTimeout(() => { trailing = 0; refreshData(reason, true); }, wait);
      return Promise.resolve(false);
    }
    refreshing = checkData(reason).catch(e => { console.error('refresh failed', e); return false; }).finally(() => { refreshing = null; st.lastCheck = Date.now(); });
    return refreshing;
  }
  async function checkData(reason) {
    if (!st.device) return false;
    const env = await loadEnvelope();
    const fp = envFp(env);
    if (!env || fp === envFp(st.env) || fp === upd.rejected) {
      if (env && fp === envFp(st.env)) upd.env = null; // published copy is what we show (again)
      // Unchanged / offline: still refresh time-dependent text ("leave in 20 min") now and then, when idle.
      if (st.data && Date.now() - upd.lastRender >= TICK_MS) upd.tick = true;
      scheduleApply();
      return false;
    }
    upd.env = env;
    document.body.dataset.pending = 'data'; // marker for the headless test
    scheduleApply();
    return true;
  }
  // Decrypt + render a new envelope (called only via applyPending).
  async function applyData(env) {
    const prev = st.data, prevEnv = st.env, noData = st.noData;
    st.env = env;
    const msg = await tryDecrypt();
    if (msg) {
      if (prev || !noData) { await showLock(msg); return false; } // removed / tampered: show nothing, as on a reload
      st.env = prevEnv; upd.rejected = envFp(env); return false; // "alerts only" mode: stay there, don't offer it again
    }
    if (!prev) { await openDashboard(); toast('Updated just now'); return true; }
    await renderPreserving();
    const nApplied = sync.justApplied || 0; sync.justApplied = 0;
    if (nApplied) toast(`Updated · ${nApplied} change${nApplied === 1 ? '' : 's'} applied`);
    else if (prev.updatedAt !== st.data.updatedAt || envFp(prevEnv) !== envFp(env)) toast('Updated just now');
    document.body.dataset.refreshed = String(Date.now()); // marker for the headless test
    return true;
  }

  // New app code: ask the browser to re-check sw.js (bypassing the HTTP cache: updateViaCache 'none'), look for an
  // installing / waiting worker, and compare the live sw.js version (no-store + cache-busting query, so neither the
  // GitHub CDN nor the HTTP cache can hide it) with the version of the code running in this page.
  async function checkCode(force) {
    if (!reg || upd.reloading) return;
    if (!force && Date.now() - upd.lastCodeCheck < 30000) return;
    upd.lastCodeCheck = Date.now();
    try { await reg.update(); } catch (e) { /* offline */ }
    watchWorker(reg.installing); if (reg.waiting) markCode('');
    try {
      const res = await fetch('./sw.js?t=' + Date.now().toString(36), { cache: 'no-store' });
      const m = res.ok && /const CACHE = '([^']+)'/.exec(await res.text());
      if (m && m[1] !== APP_VERSION) markCode(m[1]);
    } catch (e) { /* offline */ }
  }
  function watchWorker(w) {
    if (!w || w.lhqWatched) return;
    w.lhqWatched = true;
    // Only an update of an already-controlled page counts (the very first install has nothing old to replace).
    w.addEventListener('statechange', () => { if (upd.hadController && (w.state === 'installed' || w.state === 'activated')) markCode(''); });
  }
  function markCode(version) {
    if (!upd.code) console.info('Life HQ: new app version available', version || '(service worker)');
    upd.code = true;
    if (version) upd.codeVersion = version;
    // Loop guard: if we already reloaded for this version and the page is still old, wait for a tap instead.
    try { if (version && sessionStorage.getItem('lhqReloadedFor') === version) upd.codeAuto = false; } catch (e) { /* ignore */ }
    document.body.dataset.pending = 'code';
    scheduleApply();
  }
  async function applyCode() {
    if (upd.reloading) return;
    upd.reloading = true;
    try { sessionStorage.setItem('lhqReloadedFor', upd.codeVersion || 'sw'); } catch (e) { /* ignore */ }
    try {
      if (reg && !reg.waiting && !reg.installing && upd.codeVersion) await reg.update().catch(() => {});
      const w = reg && (reg.waiting || reg.installing);
      if (w) {
        // Let the new worker take over (it normally does by itself: skipWaiting), then reload once.
        const took = new Promise(r => { navigator.serviceWorker.addEventListener('controllerchange', r, { once: true }); setTimeout(r, 5000); });
        const kick = () => { if (w.state === 'installed') w.postMessage({ kind: 'SKIP_WAITING' }); };
        kick(); w.addEventListener('statechange', kick);
        if (w.state !== 'activated') await took;
      }
    } catch (e) { console.error('update failed', e); }
    location.reload();
  }

  // ---- Idle gate ----
  function userBusy() {
    if (document.hidden) return 'hidden';
    if (Date.now() - upd.lastActivity < IDLE_MS) return 'active';
    const a = document.activeElement;
    if (a && (a.isContentEditable || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT' ||
      (a.tagName === 'INPUT' && !/^(checkbox|radio|button|submit|reset|range|color|file|image)$/i.test(a.type)))) return 'typing';
    if (!$('settings').classList.contains('hidden')) return 'settings';
    if (upd.dialogs) return 'dialog';
    if (noteUndo.size || ideaUndo.size) return 'undo';
    if (ideaEdit || noteEdit) return 'editing';
    if (nav.lockId) return 'scrolling';
    return '';
  }
  const hasPending = () => !!(upd.env || upd.alerts || upd.code);
  function syncPill() {
    const p = $('updPill'); if (!p) return;
    p.classList.toggle('hidden', !hasPending() || upd.reloading);
    if (!hasPending()) delete document.body.dataset.pending;
  }
  function scheduleApply() {
    syncPill();
    const need = hasPending() || upd.tick;
    if (need && !upd.timer) upd.timer = setInterval(() => { if (!userBusy()) applyPending(false); }, 1000);
    else if (!need && upd.timer) { clearInterval(upd.timer); upd.timer = 0; }
  }
  async function applyPending(manual) {
    if (upd.applying || upd.reloading) return;
    upd.applying = true;
    try {
      if (upd.code && (manual || upd.codeAuto)) { await applyCode(); return; } // the reload brings the new data too
      const env = upd.env, alerts = upd.alerts, tick = upd.tick;
      upd.env = null; upd.alerts = false; upd.tick = false;
      if (env) await applyData(env);
      else if ((alerts || tick) && (st.data || st.noData)) await renderPreserving();
    } catch (e) { console.error('applying update failed', e); }
    finally { upd.applying = false; if (!upd.reloading) scheduleApply(); }
  }
  function checkAll(reason, force) {
    if (document.hidden) return;
    refreshData(reason, force);
    checkCode(force);
  }
  function wireUpdates() {
    for (const t of ['pointerdown', 'keydown', 'scroll', 'wheel', 'touchstart', 'input']) {
      addEventListener(t, () => { upd.lastActivity = Date.now(); }, { passive: true, capture: true });
    }
    // Native confirm() blocks the page; count it as "dialog open" and as activity when it closes.
    const nativeConfirm = window.confirm.bind(window);
    window.confirm = msg => { upd.dialogs++; try { return nativeConfirm(msg); } finally { upd.dialogs--; upd.lastActivity = Date.now(); } };
    $('updPill').addEventListener('click', () => applyPending(true));
    document.addEventListener('visibilitychange', () => checkAll('visible'));
    addEventListener('focus', () => checkAll('focus'));
    addEventListener('pageshow', ev => { if (ev.persisted) checkAll('pageshow', true); });
    addEventListener('online', () => checkAll('online', true));
    setInterval(() => checkAll('poll', true), CHECK_MS);
  }

  // ================= Render: sections =================
  function row(cls, title, sub, right) {
    const c = el('div', 'item ' + (cls || ''));
    const top = el('div', 'row');
    const left = el('div', 'grow');
    left.appendChild(el('p', 'title', title));
    if (sub) (Array.isArray(sub) ? sub : [sub]).filter(Boolean).forEach(s => left.appendChild(el('p', 'sub', s)));
    top.appendChild(left);
    if (right) { const r = el('div', 'right'); (Array.isArray(right) ? right : [right]).filter(Boolean).forEach(x => r.appendChild(x)); top.appendChild(r); }
    c.appendChild(top);
    return c;
  }
  const sevCls = { urgent: 'urgent', warn: 'warn', info: '', past: 'past' };

  // Expanded/collapsed state of details rows, remembered for this browser session (sessionStorage, ids only).
  const OPEN_KEY = 'lhqOpen';
  let openSet = null;
  function getOpen() { if (!openSet) { try { openSet = new Set(JSON.parse(sessionStorage.getItem(OPEN_KEY) || '[]')); } catch (e) { openSet = new Set(); } } return openSet; }
  // persist: keep the state across sessions in localStorage (v16: to-do lists), else sessionStorage for this session.
  const OPEN_KEY_LOCAL = 'lhqOpenLocal';
  let openLocal = null;
  function getOpenLocal() { if (!openLocal) { try { openLocal = new Set(JSON.parse(localStorage.getItem(OPEN_KEY_LOCAL) || '[]')); } catch (e) { openLocal = new Set(); } } return openLocal; }
  function remember(det, key, defOpen, persist) {
    const set = persist ? getOpenLocal() : getOpen();
    det.open = set.has(key) ? true : set.has('!' + key) ? false : !!defOpen;
    det.dataset.key = key;
    det.addEventListener('toggle', () => {
      set.delete(key); set.delete('!' + key);
      if (det.open !== !!defOpen) set.add(det.open ? key : '!' + key);
      try { (persist ? localStorage : sessionStorage).setItem(persist ? OPEN_KEY_LOCAL : OPEN_KEY, JSON.stringify([...set].slice(-200))); } catch (e) { /* ignore */ }
    });
    return det;
  }
  function extLink(label, url, cls) {
    const href = url && safeLink(url); if (!href) return null;
    const a = el('a', cls || 'link', label); a.href = href; a.target = '_blank'; a.rel = 'noopener noreferrer'; return a;
  }
  // "more ▸": extra details from the email behind an item (details.lines / links / source). Collapsed by default.
  function moreDetails(d, key, skip) {
    if (!d || typeof d !== 'object') return null;
    const lines = (Array.isArray(d.lines) ? d.lines : []).filter(l => l && l.label && l.value != null && String(l.value) !== '' && !(skip && skip.test(String(l.label))));
    const links = (Array.isArray(d.links) ? d.links : []).map(l => l && extLink(String(l.label || 'Open') + ' ↗', l.url, 'chip-link')).filter(Boolean);
    const src = d.source && typeof d.source === 'object' ? d.source : null;
    if (!lines.length && !links.length && !src) return null;
    const det = remember(el('details', 'more'), 'more:' + key);
    const sum = el('summary', 'more-sum'); sum.append(el('span', null, 'more'), el('span', 'chev', '▸'));
    det.appendChild(sum);
    if (lines.length) {
      const dl = el('dl', 'kv');
      lines.forEach(l => { dl.append(el('dt', null, String(l.label)), el('dd', null, String(l.value))); });
      det.appendChild(dl);
    }
    if (links.length) { const r = el('div', 'chip-row'); links.forEach(a => r.appendChild(a)); det.appendChild(r); }
    if (src) {
      const p = el('p', 'muted small src');
      const when = src.date ? L.fmtDate(String(src.date).slice(0, 10)) : '';
      p.textContent = '📧 ' + [src.from, src.subject ? `“${src.subject}”` : '', when].filter(Boolean).join(' · ');
      const a = extLink('Open email ↗', src.url); if (a) { p.appendChild(document.createTextNode(' · ')); p.appendChild(a); }
      det.appendChild(p);
    }
    return det;
  }
  // "12:30–2:30 PM" (one AM/PM when both ends share it), else "11:30 AM–1:00 PM".
  function timeRange(a, b) {
    const A = L.fmtTime(a); if (!b || L.hhmmToMin(b) == null) return A;
    const B = L.fmtTime(b), ma = A.slice(-2), mb = B.slice(-2);
    return ma === mb ? A.slice(0, -3) + '–' + B : A + '–' + B;
  }
  const dayName = (today, ymd) => { const n = L.daysBetween(today, ymd); return n === 0 ? 'Today' : n === 1 ? 'Tomorrow' : L.fmtDate(ymd); };

  function renderToday(now, today) {
    $('todayDate').textContent = L.fmtDate(today) + ' · ' + L.fmtTime(`${Math.floor(L.istMinutes(now) / 60)}:${String(L.istMinutes(now) % 60).padStart(2, '0')}`) + ' IST';
    const items = L.todayItems(st.data, st.overrides, now);
    const list = items.map(i => {
      if (i.section === 'festivals' && i.lines && i.lines.length) return festivalTip(i, today);
      const c = row(sevCls[i.sev], (i.sev === 'urgent' ? '🚨 ' : '') + i.text);
      c.classList.add('compact'); c.addEventListener('click', () => $('s-' + i.section).scrollIntoView({ behavior: 'smooth' }));
      return c;
    });
    // Long day: urgent, warning and pinned rows (no school) plus the collapsed festival tip always show; other info rows
    // fill up to TODAY_SHOW and the rest fold under "N more today" (only when that hides 2 or more).
    const pinned = i => i.sev === 'urgent' || i.sev === 'warn' || i.pin || i.section === 'festivals';
    let room = Math.max(0, TODAY_SHOW - items.filter(pinned).length);
    const foldIdx = items.map((i, k) => (pinned(i) || room-- > 0) ? -1 : k).filter(k => k >= 0);
    if (foldIdx.length >= 2) {
      const rest = foldIdx.map(k => list[k]);
      for (const k of foldIdx.reverse()) list.splice(k, 1);
      const det = remember(el('details', 'more-rows'), 'today-more');
      const s = el('summary', null); s.append(el('span', null, `${rest.length} more today`), el('span', 'chev', '›'));
      const inner = el('div', 'list'); inner.append(...rest);
      det.append(s, inner);
      list.push(det);
    }
    $('todayList').replaceChildren(...(list.length ? list : [el('p', 'empty', 'Nothing due today. 🎉')]));
    renderCalendar(now, today);
    renderTodos(today);
  }

  const TODAY_SHOW = 5, TODO_SHOW = 5;
  // Festival tip in Today: title + one-line teaser, all of today's lines on tap (open state kept for the session).
  function festivalTip(i, today) {
    const det = remember(el('details', 'item compact fest-tip'), 'fest-tip:' + (i.festId || 'f') + ':' + today);
    const s = el('summary');
    const left = el('div', 'grow');
    left.append(el('p', 'title', i.text), el('p', 'sub teaser', i.lines[0]));
    s.append(left, el('span', 'tip-count muted small', i.lines.length > 1 ? `${i.lines.length} tips` : 'tip'), el('span', 'chev', '›'));
    const ul = el('ul', 'fest-lines');
    for (const t of i.lines) ul.appendChild(el('li', null, t));
    const go = el('button', 'btn small ghost', 'Festivals ›'); go.type = 'button';
    go.addEventListener('click', () => $('s-festivals').scrollIntoView({ behavior: 'smooth' }));
    det.append(s, ul, go);
    return det;
  }

  // Calendar: today + next 2 days. More than 3 events: collapsed under a one-line summary.
  function renderCalendar(now, today) {
    const evs = L.calendarEvents(st.data, today, 3);
    const box = $('calendarBox');
    if (!evs.length) { box.replaceChildren(); box.classList.add('hidden'); return; }
    box.classList.remove('hidden');
    const nowMin = L.istMinutes(now);
    const body = el('div', 'cal-days');
    let lastDay = null, ul = null;
    for (const e of evs) {
      if (e.date !== lastDay) { lastDay = e.date; body.appendChild(el('p', 'cal-day', dayName(today, e.date))); ul = el('ul', 'cal-list'); body.appendChild(ul); }
      const past = e.date === today && !e.allDay && L.hhmmToMin(e.end || e.start) != null && L.hhmmToMin(e.end || e.start) < nowMin;
      const li = el('li', past ? 'past' : null);
      li.appendChild(el('span', 'cal-time', e.allDay ? 'All day' : timeRange(e.start, e.end)));
      const what = el('span', 'cal-what', e.title);
      li.appendChild(what);
      const meta = [e.location, e.calendar].filter(Boolean).join(' · ');
      if (meta) li.appendChild(el('span', 'cal-meta', meta));
      const a = extLink('↗', e.link, 'cal-link'); if (a) { a.setAttribute('aria-label', 'Open in Google Calendar'); li.appendChild(a); }
      ul.appendChild(li);
    }
    const todayN = evs.filter(e => e.dayOffset === 0).length;
    const later = evs.length - todayN;
    const head = `📆 Calendar · ${todayN ? todayN + ' today' : 'no events today'}${later ? ` · ${later} more by ${L.fmtDate(L.addDays(today, 2)).split(' ')[0]}` : ''}`;
    if (evs.length > 3) {
      const det = remember(el('details', 'card-lite cal'), 'cal');
      const s = el('summary'); s.append(el('span', 'block-title', head), el('span', 'chev', '›'));
      det.append(s, body);
      box.replaceChildren(det);
    } else {
      const c = el('div', 'card-lite cal'); c.append(el('p', 'block-title', head), body);
      box.replaceChildren(c);
    }
  }

  // ---- To-dos (v15) ----
  // Google Tasks items are READ-ONLY here (shown with an "open in Google Tasks" link); Life HQ's own to-dos from email
  // (source 'email': card dues, society maintenance, electricity …) have a tick that queues todo:<id> through the inbox
  // (todo.done / todo.undone; the box only updates its data, never Google). Optimistic like notes.
  const dueTxt = t => t.overdue ? (t.daysLeft === -1 ? 'overdue · yesterday' : `overdue · ${-t.daysLeft} days`) : t.daysLeft === 0 ? 'today' : t.daysLeft === 1 ? 'tomorrow' : L.fmtDate(t.due);
  function reconnectNote(v, short) {
    if (!v.authExpired) return null;
    const since = v.authExpiredAt ? ` (since ${fmtIST(Date.parse(v.authExpiredAt))})` : '';
    return el('p', 'todo-warn small', short ? '⚠️ Google Tasks needs re-connecting: showing the last synced list.'
      : `⚠️ Google Tasks needs re-connecting${since}. Showing the last synced list; ask your assistant to reconnect it.`);
  }
  async function tickTodo(t, checked) {
    const key = 'todo:' + t.id;
    const item = ((st.data.todos || {}).items || []).find(x => x && x.id === t.id);
    const base = !!(item && item.done);
    // Back to the published state before anything left this device: just drop the tap. Already sent: send the reverse.
    if (checked === base && !sync.sent[key]) await delLocal(key);
    else await setLocal(key, { done: checked });
    toast(checked ? 'Marked done · syncing' : 'Reopened · syncing');
  }
  // v16: Dismiss / Restore (email to-dos: tododis:<id>; email notices: noticedis:<id>). Optimistic; back to the
  // published state before anything was sent just drops the tap.
  async function setDismiss(kind, id, base, dismissed, label) {
    const key = kind + ':' + id;
    if (dismissed === base && !sync.sent[key]) await delLocal(key); else await setLocal(key, { dismissed });
    toast((dismissed ? 'Dismissed' : 'Restored') + (label ? ': ' + label.slice(0, 40) : '') + ' · syncing');
  }
  const todoBaseDismissed = id => !!((((st.data || {}).todos || {}).items || []).find(x => x && x.id === id) || {}).dismissed;
  const noticeBaseDismissed = id => (((((st.data || {}).notices || {}).items || []).find(x => x && x.id === id)) || {}).status === 'dismissed';
  // Row: [tick or dot] [title + small meta/notes] [due pill, sync pill, link]
  let todoSeq = 0;
  function todoLi(t, opts) {
    const x = el('li', 'todo-item' + (t.done ? ' done' : '') + (t.sub ? ' sub' : ''));
    const mid = el('div', 'todo-main');
    const title = el(t.tickable ? 'label' : 'span', 'todo-title', t.title);
    if (t.tickable) {
      const cb = el('input', 'todo-cb'); cb.type = 'checkbox'; cb.checked = t.done; cb.id = 'tdc-' + (++todoSeq);
      cb.setAttribute('aria-label', (t.done ? 'Reopen: ' : 'Mark done: ') + t.title);
      cb.addEventListener('change', () => tickTodo(t, cb.checked));
      title.htmlFor = cb.id;
      x.appendChild(cb);
    } else { const d = el('span', 'todo-dot', t.done ? '✓' : t.sub ? '↳' : '○'); d.setAttribute('aria-hidden', 'true'); x.appendChild(d); }
    mid.appendChild(title);
    const meta = [opts && opts.showList ? (t.source === 'email' ? 'Bills & dues' : t.list || 'Google Tasks') : null, !(opts && opts.compact) ? t.notes : null].filter(Boolean);
    if (meta.length) mid.appendChild(el('span', 'todo-notes', meta.join(' · ')));
    x.appendChild(mid);
    const r = el('div', 'todo-right');
    if (!t.done && t.due) r.appendChild(pill(dueTxt(t), t.overdue ? 'red' : t.daysLeft <= 1 ? 'amber' : 'blue'));
    if (t.doneLocally) r.appendChild(pill(sync.sent['todo:' + t.id] ? 'sent' : 'queued', sync.sent['todo:' + t.id] ? 'blue' : 'amber'));
    else if (t.dismissedLocally) r.appendChild(pill(sync.sent['tododis:' + t.id] ? 'sent' : 'queued', sync.sent['tododis:' + t.id] ? 'blue' : 'amber'));
    const a = extLink('↗', t.link, 'cal-link');
    if (a) { const gt = t.source === 'google-tasks'; a.setAttribute('aria-label', gt ? 'Open in Google Tasks: ' + t.title : 'Open link: ' + t.title); a.title = gt ? 'Open in Google Tasks' : 'Open'; r.appendChild(a); }
    if (opts && opts.dismiss && t.tickable) {
      const b = btn(t.dismissed ? 'Restore' : 'Dismiss', 'ghost small', () => setDismiss('tododis', t.id, todoBaseDismissed(t.id), !t.dismissed, t.title));
      b.setAttribute('aria-label', (t.dismissed ? 'Restore: ' : 'Dismiss: ') + t.title); r.appendChild(b);
    }
    if (r.childNodes.length) x.appendChild(r);
    return x;
  }
  // Today: open to-dos due today or overdue (all sources); hidden when there are none (unless Google needs reconnecting).
  function renderTodos(today) {
    const v = L.todoView(st.data, st.overrides, today), items = v.today;
    const box = $('todoBox');
    const warn = reconnectNote(v, true), up = v.upcoming || [];
    if (!items.length && !warn && !up.length) { box.replaceChildren(); box.classList.add('hidden'); return; }
    box.classList.remove('hidden');
    const c = el('div', 'card-lite todo');
    const head = el('div', 'todo-head');
    const od = items.filter(t => t.overdue).length;
    head.appendChild(el('p', 'block-title', items.length ? `✅ To-do · ${items.length - od ? (items.length - od) + ' due today' : ''}${od && items.length - od ? ' · ' : ''}${od ? od + ' overdue' : ''}` : '✅ To-do · nothing due today'));
    const go = el('button', 'btn small ghost', 'All to-dos ›'); go.type = 'button';
    go.addEventListener('click', () => scrollToSection('s-todos', true));
    head.appendChild(go); c.appendChild(head);
    if (warn) c.appendChild(warn);
    const ul = el('ul', 'todo-list');
    const shown = items.length > TODO_SHOW + 1 ? TODO_SHOW : items.length;
    for (const t of items.slice(0, shown)) ul.appendChild(todoLi(t, { showList: true, compact: true }));
    if (items.length) c.appendChild(ul);
    if (items.length > shown) {
      const det = remember(el('details', 'more-rows'), 'todo-more');
      const s = el('summary'); s.append(el('span', null, `${items.length - shown} more`), el('span', 'chev', '›'));
      const ul2 = el('ul', 'todo-list');
      for (const t of items.slice(shown)) ul2.appendChild(todoLi(t, { showList: true, compact: true }));
      det.append(s, ul2); c.appendChild(det);
    }
    // Coming up in the next few days (one muted line, like the calendar's "more by" hint).
    if (up.length) {
      const days = L.settingsOf(st.data).todoUpcomingDays;
      const names = up.slice(0, 3).map(t => `${t.title} (${t.daysLeft === 1 ? 'tomorrow' : L.fmtDate(t.due).split(' ')[0]})`).join(' · ');
      c.appendChild(el('p', 'todo-upcoming muted small', `Upcoming in ${days} days: ${names}${up.length > 3 ? ` · +${up.length - 3} more` : ''}`));
    }
    box.replaceChildren(c);
  }
  // To-do section: one card per group (Bills & dues from email first, then each Google Tasks list). Long lists show
  // TODO_SHOW rows and fold the rest; recently done ones fold under "Done (n)".
  function renderTodoSection(today) {
    const v = L.todoView(st.data, st.overrides, today);
    $('todoCount').textContent = String(v.openCount);
    const out = [];
    const warn = reconnectNote(v); if (warn) out.push(warn);
    for (const g of v.groups) {
      // v16: Bills & dues (email) and the primary Google list ('Tasks') are open; other lists are one collapsed row
      // (name + open count) that opens on tap; the open/closed state is kept on this device.
      const collapsible = g.source === 'google-tasks' && !g.primary;
      const c = collapsible ? remember(el('details', 'card-lite todo-group todo-fold'), 'todo-list:' + g.key, false, true) : el('div', 'card-lite todo-group');
      const titleTxt = `${g.source === 'email' ? '📧' : '🗂️'} ${g.title} · ${g.open.length ? g.open.length + ' open' : 'nothing open'}`;
      if (collapsible) {
        const s = el('summary'); s.append(el('span', 'block-title', titleTxt), el('span', 'chev', '›'));
        c.appendChild(s);
      } else {
        const head = el('div', 'todo-head');
        head.append(el('p', 'block-title', titleTxt), el('span', 'muted small', g.source === 'email' ? 'from email · tick when done' : 'Google Tasks · read-only'));
        c.appendChild(head);
      }
      const body = collapsible ? el('div', 'todo-fold-body') : c;
      if (collapsible) { body.appendChild(el('p', 'muted small todo-ro', 'Google Tasks · read-only')); c.appendChild(body); }
      const rowOpts = { dismiss: g.source === 'email' };
      if (g.open.length) {
        const ul = el('ul', 'todo-list');
        const shown = g.open.length > TODO_SHOW + 1 ? TODO_SHOW : g.open.length;
        for (const t of g.open.slice(0, shown)) ul.appendChild(todoLi(t, rowOpts));
        body.appendChild(ul);
        if (g.open.length > shown) {
          const det = remember(el('details', 'more-rows'), 'todo-more:' + g.key);
          const s = el('summary'); s.append(el('span', null, `${g.open.length - shown} more`), el('span', 'chev', '›'));
          const ul2 = el('ul', 'todo-list'); for (const t of g.open.slice(shown)) ul2.appendChild(todoLi(t, rowOpts));
          det.append(s, ul2); body.appendChild(det);
        }
      }
      for (const [list, label, key, opts] of [[g.done, 'Done', 'todo-done:', { compact: true }], [g.dismissed || [], 'Dismissed', 'todo-dis:', { compact: true, dismiss: true }]]) {
        if (!list.length) continue;
        const det = remember(el('details', 'more-rows'), key + g.key);
        const s = el('summary'); s.append(el('span', 'muted', `${label} (${list.length})`), el('span', 'chev', '›'));
        const ul2 = el('ul', 'todo-list'); for (const t of list) ul2.appendChild(todoLi(t, opts));
        det.append(s, ul2); body.appendChild(det);
      }
      out.push(c);
    }
    if (!v.groups.length) out.push(el('p', 'empty', 'No to-dos yet.'));
    $('todoSection').replaceChildren(...out);
  }

  // Notes to self: queued locally as note:<id> taps, synced through the inbox, published encrypted to every device.
  // Edit is inline (note.edit); delete hides the note at once and only queues note.delete after the ~6 s Undo toast.
  const noteUndo = new Map(); // id -> { note, timer }
  let noteEdit = null;        // { id, text, focus, sel }: the open inline editor, kept across re-renders
  const UNDO_MS = 6000;
  function renderNotes() {
    const notes = L.noteItems(st.data, st.overrides).filter(n => !noteUndo.has(n.id));
    $('noteCount').textContent = String(notes.length);
    if (noteEdit && !notes.some(n => n.id === noteEdit.id)) noteEdit = null;
    const out = notes.map(n => {
      const c = el('div', 'item note-item');
      c.dataset.id = n.id;
      const when = n.createdAt && Date.parse(n.createdAt) ? fmtIST(Date.parse(n.createdAt)) : '';
      const m = el('p', 'sub', when);
      if (n.pending) { m.appendChild(document.createTextNode(when ? ' · ' : '')); m.appendChild(pill(sync.sent['note:' + n.id] ? 'sent' : 'queued', sync.sent['note:' + n.id] ? 'blue' : 'amber')); }
      if (noteEdit && noteEdit.id === n.id) { c.classList.add('editing'); c.append(noteEditor(n), m); return c; }
      const top = el('div', 'row');
      const left = el('div', 'grow');
      left.appendChild(el('p', 'note-text', n.text));
      left.appendChild(m);
      top.appendChild(left);
      const edit = btn('Edit', 'ghost', () => { noteEdit = { id: n.id, text: n.text, focus: true }; renderNotes(); });
      edit.setAttribute('aria-label', 'Edit note: ' + n.text.slice(0, 40));
      const del = btn('Delete', 'ghost', () => deleteNote(n));
      del.setAttribute('aria-label', 'Delete note: ' + n.text.slice(0, 40));
      const r = el('div', 'right note-btns'); r.append(edit, del); top.appendChild(r);
      c.appendChild(top);
      return c;
    });
    $('notesList').replaceChildren(...(out.length ? out : [el('p', 'empty', 'No notes yet.')]));
    const ta = document.querySelector('#notesList textarea');
    if (ta && noteEdit && noteEdit.focus) {
      ta.focus();
      const [a, b] = noteEdit.sel || [ta.value.length, ta.value.length];
      try { ta.setSelectionRange(a, b); } catch (e) { /* ignore */ }
    }
    updateNoteCounter();
  }
  function noteEditor(n) {
    const box = el('div', 'note-edit');
    const ta = el('textarea', 'note-edit-input');
    ta.value = noteEdit.text; ta.rows = Math.min(8, Math.max(2, noteEdit.text.split('\n').length + 1));
    ta.maxLength = L.NOTE_MAX * 2; ta.setAttribute('aria-label', 'Edit note');
    const count = el('span', 'note-counter muted small');
    const save = el('button', 'btn small primary', 'Save'), cancel = el('button', 'btn small ghost', 'Cancel');
    save.type = cancel.type = 'button';
    const upd8 = () => {
      const v = ta.value, clean = L.cleanNoteText(v);
      count.textContent = `${v.length}/${L.NOTE_MAX}`;
      count.classList.toggle('red-text', v.length > L.NOTE_MAX);
      save.disabled = !clean || v.length > L.NOTE_MAX || clean === n.text;
    };
    const track = () => { noteEdit.text = ta.value; noteEdit.sel = [ta.selectionStart, ta.selectionEnd]; };
    ta.addEventListener('input', () => { track(); upd8(); });
    ta.addEventListener('select', track); ta.addEventListener('keyup', track); ta.addEventListener('click', track);
    ta.addEventListener('focus', () => { if (noteEdit) noteEdit.focus = true; });
    ta.addEventListener('blur', () => { if (noteEdit) noteEdit.focus = false; });
    ta.addEventListener('keydown', ev => {
      if (ev.key === 'Escape') { ev.preventDefault(); cancelEdit(); }
      else if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); if (!save.disabled) saveEdit(n); }
    });
    save.addEventListener('click', () => saveEdit(n));
    cancel.addEventListener('click', cancelEdit);
    const bar = el('div', 'note-edit-bar'); bar.append(count, cancel, save);
    box.append(ta, bar);
    upd8();
    return box;
  }
  function cancelEdit() {
    const id = noteEdit && noteEdit.id; noteEdit = null; renderNotes();
    const b = id && document.querySelector(`#notesList .note-item[data-id="${id}"] .note-btns button`); if (b) b.focus();
  }
  async function saveEdit(n) {
    const text = L.cleanNoteText(noteEdit ? noteEdit.text : '');
    if (!text) { toast(`Notes are 1–${L.NOTE_MAX} characters`, true); return; }
    const id = n.id, key = 'note:' + id, v = st.overrides[key];
    noteEdit = null;
    if (text === n.text) { renderNotes(); return; }
    // Still only on this device (queued add, not sent): rewrite the add. Otherwise queue an edit for every device.
    if (v && v.op === 'add' && !sync.sent[key]) await setLocal(key, { op: 'add', text, createdAt: v.createdAt });
    else await setLocal(key, { op: 'edit', text, createdAt: n.createdAt || (v && v.createdAt) || null });
    const b = document.querySelector(`#notesList .note-item[data-id="${id}"] .note-btns button`); if (b) b.focus({ preventScroll: true });
    toast('Note updated · syncing to your other devices');
  }
  function updateNoteCounter() {
    const v = $('noteInput').value, n = v.trim().length;
    $('noteCounter').textContent = `${v.length}/${L.NOTE_MAX}`;
    $('noteCounter').classList.toggle('red-text', v.length > L.NOTE_MAX);
    $('addNoteBtn').disabled = !n || v.length > L.NOTE_MAX;
  }
  function newNoteId() {
    const r = new Uint8Array(6); crypto.getRandomValues(r);
    return 'n-' + Date.now().toString(36) + Array.from(r, b => (b % 36).toString(36)).join('');
  }
  async function addNote() {
    const text = L.cleanNoteText($('noteInput').value);
    if (!text) { toast(`Notes are 1–${L.NOTE_MAX} characters`, true); return; }
    $('noteInput').value = '';
    await setLocal('note:' + newNoteId(), { op: 'add', text, createdAt: new Date().toISOString() });
    toast('Note saved · syncing to your other devices');
  }
  // Delete: hide now, show "Deleted · Undo" for ~6 s, then queue. A newer delete commits the older one at once.
  function deleteNote(n) {
    commitAllDeletes();
    if (noteEdit && noteEdit.id === n.id) noteEdit = null;
    noteUndo.set(n.id, { note: n, timer: setTimeout(() => commitDelete(n.id), UNDO_MS) });
    renderNotes();
    showUndo('Note deleted');
  }
  async function commitDelete(id) {
    const u = noteUndo.get(id); if (!u) return;
    clearTimeout(u.timer); noteUndo.delete(id);
    if (!noteUndo.size && !ideaUndo.size) hideUndo();
    const key = 'note:' + id, v = st.overrides[key];
    // Never left this device (queued add, not sent): just drop it. Otherwise queue a delete for every device.
    if (u.note.pending && v && v.op === 'add' && !sync.sent[key]) await delLocal(key);
    else await setLocal(key, { op: 'delete' });
  }
  function undoDelete() {
    const ids = [...noteUndo.keys()];
    for (const id of ids) clearTimeout(noteUndo.get(id).timer);
    noteUndo.clear(); if (!ideaUndo.size) hideUndo(); renderNotes();
    const b = ids.length && document.querySelector(`#notesList .note-item[data-id="${ids[ids.length - 1]}"] .note-btns button`);
    if (b) b.focus();
    toast('Note restored');
  }
  function showUndo(msg) {
    const bar = $('undoBar');
    $('undoMsg').textContent = msg || 'Deleted';
    bar.classList.remove('hidden');
    bar.style.setProperty('--undo-ms', UNDO_MS + 'ms');
    bar.classList.remove('run'); void bar.offsetWidth; bar.classList.add('run');
    $('undoBtn').focus({ preventScroll: true });
  }
  function hideUndo() {
    const bar = $('undoBar'); bar.classList.add('hidden'); bar.classList.remove('run');
    if (document.activeElement === $('undoBtn')) { const f = $('noteInput'); if (f && f.offsetParent) f.focus({ preventScroll: true }); }
  }
  // Leaving the page while the toast is up commits the delete (it was the user's intent).
  function flushNoteDeletes() { commitAllDeletes(); }

  // ================= Ideas (v17) =================
  // Feature ideas, synced like notes: idea:<id> taps (op add / edit / delete) and ideast:<id> (status). Optimistic:
  // shown at once with "queued" / "sent"; a delete hides the idea and waits ~6 s on the shared Undo toast.
  const ideaUndo = new Map(); // id -> { idea, timer }
  let ideaEdit = null;        // { id, title, details, priority }
  const ideaDraft = { title: '', details: '', priority: '' };
  const IDEA_PILL = { 'new': '', planned: 'amber', 'in-progress': 'blue', done: 'green', dropped: 'muted-pill' };
  const ymdOf = iso => (iso && Date.parse(iso)) ? L.istDate(Date.parse(iso)) : null;
  const shortDate = iso => { const y = ymdOf(iso); return y ? L.fmtDate(y) : ''; };
  function prioritySelect(value, label) {
    const s = el('select', 'idea-select');
    s.setAttribute('aria-label', label);
    for (const [v, t] of [['', 'No priority'], ['high', 'High'], ['medium', 'Medium'], ['low', 'Low']]) { const o = el('option', '', t); o.value = v; s.appendChild(o); }
    s.value = value || '';
    return s;
  }
  function statusSelect(value, label) {
    const s = el('select', 'idea-select');
    s.setAttribute('aria-label', label);
    for (const v of L.IDEA_STATUSES) { const o = el('option', '', L.IDEA_STATUS_LABEL[v]); o.value = v; s.appendChild(o); }
    s.value = value;
    return s;
  }
  function ideaSyncPill(id) {
    const keys = ['idea:' + id, 'ideast:' + id].filter(k => st.overrides[k]);
    if (!keys.length) return null;
    const sent = keys.every(k => sync.sent[k] && sync.sent[k].at === st.overrides[k].at);
    return pill(sent ? 'sent' : 'queued', sent ? 'blue' : 'amber');
  }
  function ideaCard(it) {
    const c = el('div', 'item idea-item' + (it.status === 'done' || it.status === 'dropped' ? ' idea-closed' : ''));
    c.dataset.id = it.id;
    if (ideaEdit && ideaEdit.id === it.id) { c.classList.add('editing'); c.appendChild(ideaEditor(it)); return c; }
    const head = el('div', 'idea-head');
    head.appendChild(el('p', 'title idea-title', it.title));
    const pills = el('div', 'idea-pills');
    pills.appendChild(pill(L.IDEA_STATUS_LABEL[it.status], 'idea-st ' + (IDEA_PILL[it.status] || '')));
    if (it.priority) pills.appendChild(pill(it.priority[0].toUpperCase() + it.priority.slice(1), 'idea-pri pri-' + it.priority));
    const sp = ideaSyncPill(it.id); if (sp) pills.appendChild(sp);
    head.appendChild(pills);
    c.appendChild(head);
    if (it.details) {
      if (it.details.length > 220) {
        const det = el('details', 'more idea-more');
        const sum = el('summary', 'more-sum'); sum.append(el('span', 'idea-teaser', it.details.slice(0, 160).replace(/\s+\S*$/, '') + '…'), el('span', 'chev', '›'));
        det.append(sum, el('p', 'idea-details', it.details));
        remember(det, 'idea:' + it.id, false);
        c.appendChild(det);
      } else c.appendChild(el('p', 'idea-details', it.details));
    }
    const created = shortDate(it.createdAt), updated = shortDate(it.updatedAt);
    const meta = [created ? 'Added ' + created : '', updated && updated !== created ? 'updated ' + updated : ''].filter(Boolean).join(' · ');
    const bar = el('div', 'idea-bar');
    bar.appendChild(el('span', 'sub idea-meta', meta));
    const ctl = el('div', 'idea-ctl');
    const ss = statusSelect(it.status, 'Status of idea: ' + it.title.slice(0, 40));
    ss.addEventListener('change', () => setIdeaStatus(it, ss.value));
    const edit = btn('Edit', 'ghost', () => { ideaEdit = { id: it.id, title: it.title, details: it.details, priority: it.priority || '' }; renderIdeas(); focusIdeaEditor(); });
    edit.setAttribute('aria-label', 'Edit idea: ' + it.title.slice(0, 40));
    const del = btn('Delete', 'ghost', () => deleteIdea(it));
    del.setAttribute('aria-label', 'Delete idea: ' + it.title.slice(0, 40));
    ctl.append(ss, edit, del);
    bar.appendChild(ctl);
    c.appendChild(bar);
    return c;
  }
  function ideaFields(state, prefix) {
    const t = el('input', 'idea-input'); t.type = 'text'; t.maxLength = L.IDEA_TITLE_MAX * 2; t.value = state.title;
    t.placeholder = 'Idea title'; t.setAttribute('aria-label', prefix + ' title'); t.autocomplete = 'off';
    const d = el('textarea', 'idea-text'); d.rows = 3; d.maxLength = L.IDEA_DETAILS_MAX * 2; d.value = state.details;
    d.placeholder = 'Details (optional)'; d.setAttribute('aria-label', prefix + ' details');
    const p = prioritySelect(state.priority, prefix + ' priority');
    const count = el('span', 'muted small idea-counter');
    t.addEventListener('input', () => { state.title = t.value; }); d.addEventListener('input', () => { state.details = d.value; });
    p.addEventListener('change', () => { state.priority = p.value; });
    return { t, d, p, count };
  }
  function ideaValid(state) {
    const title = L.cleanIdeaTitle(state.title), details = L.cleanIdeaDetails(state.details);
    if (!title) return { err: `Titles are 1–${L.IDEA_TITLE_MAX} characters` };
    if (details === null) return { err: `Details are up to ${L.IDEA_DETAILS_MAX} characters` };
    return { title, details, priority: L.IDEA_PRIORITIES.includes(state.priority) ? state.priority : null };
  }
  function ideaEditor(it) {
    const box = el('div', 'idea-edit');
    const f = ideaFields(ideaEdit, 'Edit idea');
    const save = el('button', 'btn small primary', 'Save'), cancel = el('button', 'btn small ghost', 'Cancel');
    save.type = cancel.type = 'button';
    const upd8 = () => {
      const v = ideaValid(ideaEdit);
      f.count.textContent = `${ideaEdit.title.trim().length}/${L.IDEA_TITLE_MAX} · ${ideaEdit.details.length}/${L.IDEA_DETAILS_MAX}`;
      save.disabled = !!v.err || (v.title === it.title && v.details === it.details && v.priority === (it.priority || null));
    };
    for (const x of [f.t, f.d]) x.addEventListener('input', upd8);
    f.p.addEventListener('change', upd8);
    const keys = ev => {
      if (ev.key === 'Escape') { ev.preventDefault(); cancelIdeaEdit(); }
      else if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey || ev.target === f.t)) { ev.preventDefault(); if (!save.disabled) saveIdeaEdit(it); }
    };
    f.t.addEventListener('keydown', keys); f.d.addEventListener('keydown', keys);
    save.addEventListener('click', () => saveIdeaEdit(it));
    cancel.addEventListener('click', cancelIdeaEdit);
    const bar = el('div', 'idea-edit-bar'); bar.append(f.p, f.count, cancel, save);
    box.append(f.t, f.d, bar);
    upd8();
    return box;
  }
  function focusIdeaEditor() { const t = document.querySelector('#ideasList .idea-edit .idea-input'); if (t) { t.focus(); t.setSelectionRange(t.value.length, t.value.length); } }
  function focusIdea(id) { const b = id && document.querySelector(`#ideasList .idea-item[data-id="${id}"] .idea-ctl button`); if (b) b.focus({ preventScroll: true }); }
  function cancelIdeaEdit() { const id = ideaEdit && ideaEdit.id; ideaEdit = null; renderIdeas(); focusIdea(id); }
  async function saveIdeaEdit(it) {
    const v = ideaValid(ideaEdit || {});
    if (v.err) { toast(v.err, true); return; }
    const id = it.id, key = 'idea:' + id, cur = st.overrides[key];
    ideaEdit = null;
    if (v.title === it.title && v.details === it.details && v.priority === (it.priority || null)) { renderIdeas(); return; }
    // Still only on this device (queued add, not sent): rewrite the add. Otherwise queue an edit for every device.
    if (cur && cur.op === 'add' && !sync.sent[key]) await setLocal(key, Object.assign(bareTap(cur), v));
    else await setLocal(key, Object.assign({ op: 'edit' }, v));
    focusIdea(id);
    toast('Idea updated · syncing to your other devices');
  }
  async function setIdeaStatus(it, status) {
    if (!L.IDEA_STATUSES.includes(status) || status === it.status) return;
    const key = 'idea:' + it.id, cur = st.overrides[key];
    if (cur && cur.op === 'add' && !sync.sent[key]) await setLocal(key, Object.assign(bareTap(cur), { status }));
    else await setLocal('ideast:' + it.id, { status });
    focusIdea(it.id);
    toast(`${L.IDEA_STATUS_LABEL[status]} · syncing to your other devices`);
  }
  function bareTap(v) { const o = Object.assign({}, v); delete o.at; delete o.keep; return o; }
  function newIdeaId() {
    const r = new Uint8Array(6); crypto.getRandomValues(r);
    return 'i-' + Date.now().toString(36) + Array.from(r, b => (b % 36).toString(36)).join('');
  }
  async function addIdea() {
    const v = ideaValid(ideaDraft);
    if (v.err) { toast(v.err, true); return; }
    await setLocal('idea:' + newIdeaId(), Object.assign({ op: 'add', status: 'new', createdAt: new Date().toISOString() }, v));
    ideaDraft.title = ideaDraft.details = ideaDraft.priority = '';
    $('ideaTitle').value = ''; $('ideaDetails').value = ''; $('ideaPriority').value = '';
    updateIdeaForm();
    toast('Idea added · syncing to your other devices');
  }
  function updateIdeaForm() {
    const t = $('ideaTitle').value, d = $('ideaDetails').value;
    ideaDraft.title = t; ideaDraft.details = d; ideaDraft.priority = $('ideaPriority').value;
    $('ideaCounter').textContent = `${t.trim().length}/${L.IDEA_TITLE_MAX}`;
    const bad = t.trim().length > L.IDEA_TITLE_MAX || d.length > L.IDEA_DETAILS_MAX;
    $('ideaCounter').classList.toggle('red-text', bad);
    $('addIdeaBtn').disabled = !t.trim() || bad;
  }
  function deleteIdea(it) {
    commitAllDeletes();
    if (ideaEdit && ideaEdit.id === it.id) ideaEdit = null;
    ideaUndo.set(it.id, { idea: it, timer: setTimeout(() => commitIdeaDelete(it.id), UNDO_MS) });
    renderIdeas();
    showUndo('Idea deleted');
  }
  async function commitIdeaDelete(id) {
    const u = ideaUndo.get(id); if (!u) return;
    clearTimeout(u.timer); ideaUndo.delete(id);
    if (!noteUndo.size && !ideaUndo.size) hideUndo();
    const key = 'idea:' + id, v = st.overrides[key];
    await delLocal('ideast:' + id).catch(() => {});
    if (u.idea.pending && v && v.op === 'add' && !sync.sent[key]) await delLocal(key);
    else await setLocal(key, { op: 'delete' });
  }
  function renderIdeas() {
    const items = L.ideaItems(st.data, st.overrides).filter(i => !ideaUndo.has(i.id));
    if (ideaEdit && !items.some(i => i.id === ideaEdit.id)) ideaEdit = null;
    const open = items.filter(i => i.status !== 'done' && i.status !== 'dropped'), closed = items.filter(i => !open.includes(i));
    $('ideaCount').textContent = String(open.length);
    const out = open.map(ideaCard);
    if (!open.length) out.push(el('p', 'empty', items.length ? 'No open ideas.' : 'No ideas yet. Add the first one above.'));
    if (closed.length) {
      const det = el('details', 'more-rows idea-closed-group');
      const sum = el('summary'); sum.append(el('span', 'muted', `Done & dropped (${closed.length})`), el('span', 'chev', '›'));
      det.appendChild(sum);
      const box = el('div', 'list'); closed.forEach(i => box.appendChild(ideaCard(i))); det.appendChild(box);
      remember(det, 'ideas-closed', false);
      out.push(det);
    }
    $('ideasList').replaceChildren(...out);
  }

  // Shared Undo toast (notes + ideas): one pending delete at a time; a newer delete commits the older one.
  function commitAllDeletes() { for (const id of [...noteUndo.keys()]) commitDelete(id); for (const id of [...ideaUndo.keys()]) commitIdeaDelete(id); }
  function undoAny() {
    if (ideaUndo.size) {
      const ids = [...ideaUndo.keys()];
      for (const id of ids) clearTimeout(ideaUndo.get(id).timer);
      ideaUndo.clear();
      if (!noteUndo.size) hideUndo();
      renderIdeas(); focusIdea(ids[ids.length - 1]); toast('Idea restored');
    }
    if (noteUndo.size) undoDelete();
  }

  // ================= Wiki (v17) =================
  // The packed wiki (gzip + base64 inside the encrypted data) is inflated with the browser's DecompressionStream,
  // re-validated by L.wikiSanitize and built with DOM calls only (textContent; links https or in-page; diagrams are
  // SVG data: images, so nothing in them can run). Rebuilt only when the wiki changes, so open sections stay open.
  const wiki = { hash: null, busy: false };
  async function inflateWiki(b64) {
    const bin = atob(b64), u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    const stream = new Blob([u8]).stream().pipeThrough(new DecompressionStream('gzip'));
    return JSON.parse(await new Response(stream).text());
  }
  function wikiInline(parent, nodes) {
    for (const n of nodes) {
      if (typeof n === 'string') parent.appendChild(document.createTextNode(n));
      else if (n.t === 'b') parent.appendChild(el('strong', '', n.c));
      else if (n.t === 'i') parent.appendChild(el('em', '', n.c));
      else if (n.t === 'code') parent.appendChild(el('code', 'wiki-code', n.c));
      else if (n.t === 'a' && n.href[0] === '#') { const a = el('a', 'link', n.c); a.href = n.href; a.addEventListener('click', ev => { ev.preventDefault(); openWikiSection(n.href.slice(1)); }); parent.appendChild(a); }
      else if (n.t === 'a') { const a = extLink(n.c, n.href); parent.appendChild(a || document.createTextNode(n.c)); }
    }
    return parent;
  }
  function wikiBlock(b, figs) {
    if (b.t === 'p') return wikiInline(el('p', 'wiki-p'), b.c);
    if (b.t === 'quote') return wikiInline(el('blockquote', 'wiki-quote'), b.c);
    if (b.t === 'h') return wikiInline(el(b.l === 3 ? 'h4' : 'h5', 'wiki-h' + b.l), b.c);
    if (b.t === 'hr') return el('hr', 'wiki-hr');
    if (b.t === 'code') { const pre = el('pre', 'wiki-pre'); pre.appendChild(el('code', '', b.text)); pre.tabIndex = 0; return pre; }
    if (b.t === 'ul' || b.t === 'ol') {
      const list = el(b.t, 'wiki-list');
      for (const it of b.items) {
        const li = wikiInline(el('li'), it.c);
        if (it.sub && it.sub.length) { const sub = el('ul', 'wiki-list'); it.sub.forEach(s => sub.appendChild(wikiInline(el('li'), s.c))); li.appendChild(sub); }
        list.appendChild(li);
      }
      return list;
    }
    if (b.t === 'table') {
      const wrap = el('div', 'wiki-table'); wrap.tabIndex = 0; wrap.setAttribute('role', 'region'); wrap.setAttribute('aria-label', 'Table');
      const t = el('table'), th = el('thead'), tr = el('tr');
      b.head.forEach(c => tr.appendChild(wikiInline(el('th'), c))); th.appendChild(tr); t.appendChild(th);
      const tb = el('tbody');
      b.rows.forEach(r => { const row = el('tr'); r.forEach(c => row.appendChild(wikiInline(el('td'), c))); tb.appendChild(row); });
      t.appendChild(tb); wrap.appendChild(t);
      return wrap;
    }
    if (b.t === 'fig') {
      const f = figs[b.f]; if (!f) return null;
      const fig = el('figure', 'wiki-fig');
      const scroll = el('div', 'wiki-fig-scroll'); scroll.tabIndex = 0; scroll.setAttribute('role', 'region'); scroll.setAttribute('aria-label', b.alt);
      const img = el('img'); img.src = f.src; img.alt = b.alt; img.width = f.w; img.height = f.h; img.loading = 'lazy'; img.decoding = 'async';
      scroll.appendChild(img); fig.appendChild(scroll);
      const zoom = el('button', 'btn small ghost wiki-zoom', '⤢ Full size'); zoom.type = 'button';
      zoom.addEventListener('click', () => { const z = fig.classList.toggle('zoom'); zoom.textContent = z ? '⤡ Fit width' : '⤢ Full size'; zoom.setAttribute('aria-pressed', String(z)); });
      zoom.setAttribute('aria-pressed', 'false');
      const cap = el('figcaption', 'muted small'); cap.append(el('span', '', b.alt), zoom);
      fig.appendChild(cap);
      return fig;
    }
    return null;
  }
  function openWikiSection(id) {
    const det = document.getElementById('w-' + id); if (!det) return;
    det.open = true;
    const reduce = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
    det.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
    const s = det.querySelector('summary'); if (s) s.focus({ preventScroll: true });
  }
  async function renderWiki() {
    const packed = L.wikiPacked(st.data);
    const box = $('wikiBox');
    if (!packed) { wiki.hash = null; $('wikiBuilt').textContent = ''; box.replaceChildren(el('p', 'empty', 'No wiki in the data yet.')); return; }
    if (wiki.hash === packed.hash || wiki.busy) return;
    wiki.busy = true;
    try {
      if (typeof DecompressionStream === 'undefined') throw new Error('this browser cannot unpack the wiki (needs a recent Chrome)');
      const doc = L.wikiSanitize(await inflateWiki(packed.doc));
      if (!doc) throw new Error('the wiki data is not valid');
      $('wikiBuilt').textContent = packed.builtAt ? 'Updated ' + fmtIST(Date.parse(packed.builtAt)) : '';
      const out = [];
      doc.intro.forEach(b => { const n = wikiBlock(b, doc.figs); if (n) out.push(n); });
      const toc = el('details', 'card-lite wiki-toc');
      const ts = el('summary'); ts.append(el('span', 'title', `Contents (${doc.sections.length})`), el('span', 'chev', '›')); toc.appendChild(ts);
      const ol = el('ol', 'wiki-toc-list');
      for (const s of doc.sections) {
        const a = el('a', 'link', s.title); a.href = '#' + s.id;
        a.addEventListener('click', ev => { ev.preventDefault(); openWikiSection(s.id); });
        const li = el('li'); li.appendChild(a); ol.appendChild(li);
      }
      toc.appendChild(ol); remember(toc, 'wiki-toc', true, true); out.push(toc);
      for (const s of doc.sections) {
        const det = el('details', 'wiki-sec'); det.id = 'w-' + s.id;
        const sum = el('summary'); sum.append(el('h3', 'wiki-title', s.title), el('span', 'chev', '›')); det.appendChild(sum);
        const body = el('div', 'wiki-body'); det.appendChild(body);
        let built = false;
        const build = () => { if (built) return; built = true; s.blocks.forEach(b => { const n = wikiBlock(b, doc.figs); if (n) body.appendChild(n); }); };
        det.addEventListener('toggle', () => { if (det.open) build(); });
        remember(det, 'wiki:' + s.id, false, true);
        if (det.open) build();
        out.push(det);
      }
      box.replaceChildren(...out);
      wiki.hash = packed.hash;
    } catch (e) {
      console.error('wiki', e);
      box.replaceChildren(el('p', 'empty', '⚠️ The wiki could not be shown: ' + e.message));
    } finally { wiki.busy = false; }
  }

  function renderMoney(today) {
    const rows = L.moneyItems(st.data, st.overrides, today);
    const out = rows.map(m => {
      const paid = m.status === 'paid';
      const when = m.daysLeft == null ? 'no due date' : (m.overdue ? `overdue by ${-m.daysLeft} day${m.daysLeft === -1 ? '' : 's'}` : 'due ' + L.relDays(m.daysLeft));
      const title = (m.urgent && !paid ? '🚨 ' : '') + m.label + (m.last4 ? ' ••' + m.last4 : '');
      const amount = typeof m.amount === 'number' ? inr.format(m.amount) : (m.amount || '');
      const c = row(paid ? 'past' : (m.urgent ? 'urgent' : ''), title, [`${amount} · ${L.fmtDate(m.dueDate)} (${when})`],
        [pill(paid ? 'paid' : 'unpaid', paid ? 'green' : (m.urgent ? 'red' : '')),
         m.paidLocally ? btn('Undo', 'ghost', () => delLocal(m.kind + ':' + m.id))
           : (!paid ? btn('Mark paid', 'done', () => setLocal(m.kind + ':' + m.id, { status: 'paid', date: today })) : null)]);
      // The row already shows amount + due date: don't repeat them under "more".
      const more = moreDetails(m.details, m.kind + ':' + m.id, /^(total( amount)? due|amount( due)?|due (by|date))$/i); if (more) c.appendChild(more);
      return c;
    });
    $('moneyList').replaceChildren(...(out.length ? out : [el('p', 'empty', 'No cards or bills.')]));
    renderNotices(today);
  }

  // From email: payment links, toll tag, returns, refunds … (open first; done ones folded away).
  const noticeWhen = n => n.daysLeft == null ? null : n.overdue ? `overdue by ${-n.daysLeft} day${n.daysLeft === -1 ? '' : 's'}` : n.daysLeft === 0 ? 'today' : L.relDays(n.daysLeft);
  function noticeRow(n, today) {
    const open = n.status === 'open';
    const sub = [n.summary || null, n.dueDate ? `${n.dueLabel || 'Due'} ${L.fmtDate(n.dueDate)}${open ? ' (' + noticeWhen(n) + ')' : ''}` : null];
    const c = row(!open ? 'past' : n.overdue || n.sev === 'urgent' ? 'urgent' : n.sev === 'warn' ? 'warn' : '', `${n.icon || '📬'} ${n.title}`, sub,
      [pill(!open ? 'done' : n.overdue ? 'overdue' : n.pill || (n.sev === 'info' ? 'info' : 'to do'), !open ? 'green' : n.overdue || n.sev === 'urgent' ? 'red' : n.sev === 'warn' ? 'amber' : 'blue'),
       n.dismissed ? btn('Restore', 'ghost', () => setDismiss('noticedis', n.id, noticeBaseDismissed(n.id), false, n.title))
         : n.doneLocally ? btn('Undo', 'ghost', () => delLocal('notice:' + n.id))
         : open ? btn('Done ✓', 'done', () => setLocal('notice:' + n.id, { status: 'done', date: today })) : null,
       open ? btn('Dismiss', 'ghost', () => setDismiss('noticedis', n.id, noticeBaseDismissed(n.id), true, n.title)) : null,
       n.dismissedLocally ? pill(sync.sent['noticedis:' + n.id] ? 'sent' : 'queued', sync.sent['noticedis:' + n.id] ? 'blue' : 'amber') : null]);
    const more = moreDetails(n.details, 'notice:' + n.id); if (more) c.appendChild(more);
    return c;
  }
  function renderNotices(today) {
    const items = L.noticeItems(st.data, st.overrides, today);
    const box = $('noticeList');
    $('noticeHead').classList.toggle('hidden', !items.length);
    const open = items.filter(n => n.status === 'open'), done = items.filter(n => n.status !== 'open' && !n.dismissed), dis = items.filter(n => n.dismissed);
    const out = open.map(n => noticeRow(n, today));
    for (const [list, label, key] of [[done, 'Done', 'notices-done'], [dis, 'Dismissed', 'notices-dismissed']]) {
      if (!list.length) continue;
      const det = remember(el('details', 'old-group'), key);
      const s = el('summary'); s.append(el('span', 'muted small', `${label} (${list.length})`), el('span', 'chev', '›'));
      const l = el('div', 'list'); list.forEach(n => l.appendChild(noticeRow(n, today)));
      det.append(s, l); out.push(det);
    }
    box.replaceChildren(...out);
  }

  function renderFamily(now, today) {
    const sc = st.data.school || {};
    const isDay = L.schoolDay(st.data, today);
    const nowMin = L.istMinutes(now);
    const win = L.settingsOf(st.data).leaveWindowMinutes;
    const days = (sc.days || [1, 2, 3, 4, 5]).map(d => ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d]);
    const daysTxt = days.length === 5 && days[0] === 'Mon' ? 'Monday to Friday' : days.join(', ');
    if (!isDay) {
      // Holiday / weekend: no drop-off / pick-up cards, just when school is next.
      const why = L.noSchoolReason(st.data, today);
      const out = [el('p', 'muted small', `🥳 No school today: ${why ? why.name : 'Holiday'}`)];
      const next = L.nextSchoolDay(st.data, today);
      const runs = sc.runs || [];
      if (next && runs.length) {
        const c = row('next-school', `📅 Next school day: ${L.fmtDate(next)} (${L.relDays(L.daysBetween(today, next))})`,
          runs.map(r => `${r.label}: leave at ${L.fmtTime(r.leaveAt)}` + (r.eventAt ? ` (${L.fmtTime(r.eventAt)})` : '')));
        out.push(c);
      }
      appendHolidays(out, sc, today, daysTxt);
      $('familyList').replaceChildren(...out);
      return;
    }
    const out = [el('p', 'muted small', '✅ School day today · ' + daysTxt)];
    for (const r of (sc.runs || [])) {
      const delta = L.hhmmToMin(r.leaveAt) - nowMin;
      const urgent = isDay && Math.abs(delta) <= win;
      const done = isDay && delta < -win;
      const sub = `Leave at ${L.fmtTime(r.leaveAt)}` + (r.eventAt ? ` · ${r.label.toLowerCase().includes('pick') ? 'pick-up' : 'event'} at ${L.fmtTime(r.eventAt)}` : '');
      out.push(row(urgent ? 'urgent' : (done ? 'past' : (isDay && delta > 0 && delta <= 60 ? 'warn' : '')), (urgent ? '🚨 Leave now: ' : '') + r.label, sub,
        isDay ? pill(done ? 'done' : (delta > 0 ? 'in ' + (delta >= 60 ? Math.floor(delta / 60) + 'h ' : '') + (delta % 60) + 'm' : 'now'), urgent ? 'red' : '') : null));
    }
    appendHolidays(out, sc, today);
    $('familyList').replaceChildren(...out);
  }
  function appendHolidays(out, sc, today, daysTxt) {
    const upcoming = L.holidayDates(st.data).filter(h => h > today).sort().slice(0, 5);
    const parts = [];
    if (daysTxt) parts.push('School days: ' + daysTxt);
    if (upcoming.length) parts.push('Holidays: ' + upcoming.map(L.fmtDate).join(', '));
    if (parts.length) out.push(el('p', 'muted small', parts.join(' · ')));
  }

  function renderCharging(now, today) {
    const nowMin = L.istMinutes(now);
    const out = L.chargingDevices(st.data, st.overrides, today).map(d => {
      const due = !d.chargedToday && nowMin >= L.hhmmToMin(d.reminderTime);
      return row(d.chargedToday ? 'past' : (due ? 'urgent' : ''), `${d.icon || '🔋'} ${d.name}`, `Reminder ${L.fmtTime(d.reminderTime)} daily`,
        d.chargedToday ? [pill('✓ charged', 'green'), d.chargedLocally ? btn('Undo', 'ghost', () => delLocal('charge:' + d.id)) : null]
          : btn('Charged ✓', 'done', () => setLocal('charge:' + d.id, { date: today })));
    });
    $('chargingList').replaceChildren(...out);
  }

  // Home maintenance: one summary card, then one collapsible row per appliance (collapsed by default).
  const MAINT_PILL = { overdue: ['overdue', 'red'], due: ['due', 'amber'], upcoming: ['upcoming', 'blue'], done: ['done', 'green'], never: ['never logged', 'grey'] };
  function maintPill(status, n, label) { const [t, c] = MAINT_PILL[status]; return pill(n != null ? `${n} ${label || t}` : t, c); }
  function renderHome(today) {
    const ov = L.maintenanceOverview(st.data, st.overrides, today);
    const box = el('div', 'card weekend' + (ov.isToday && ov.dueCount ? ' urgent' : ''));
    const c = ov.counts;
    box.appendChild(el('h3', null, `${ov.isToday && ov.dueCount ? '🚨 ' : '🗓️ '}Maintenance weekend ${L.fmtDate(ov.date)} (${L.relDays(ov.daysUntil)})`));
    box.appendChild(el('p', 'weekend-line', `${ov.dueCount} due · ${c.done} done · ${c.upcoming} upcoming`));
    // Breakdown of the "due" number only (done / upcoming are already in the line above).
    const chips = el('div', 'chip-row');
    for (const [s, label] of [['overdue'], ['due', 'due by Sat'], ['never']]) if (c[s]) chips.appendChild(maintPill(s, c[s], label));
    if (chips.childNodes.length) box.appendChild(chips);
    box.appendChild(el('p', 'muted small', `Every other Saturday · ${ov.total} tasks on ${ov.appliances.length} appliances`));
    $('weekendBox').replaceChildren(box);

    const out = ov.appliances.map(ap => {
      const det = remember(el('details', 'appl'), 'appl:' + ap.id);
      const s = el('summary', 'appl-sum');
      s.appendChild(el('span', 'appl-icon', ap.icon));
      const name = el('span', 'appl-name'); name.append(el('span', 'appl-title', ap.name), el('span', 'appl-count', `${ap.tasks.length} task${ap.tasks.length === 1 ? '' : 's'}`));
      s.appendChild(name);
      const worst = ap.counts[ap.status];
      s.appendChild(maintPill(ap.status, ap.tasks.length ? worst : null));
      s.appendChild(el('span', 'chev', '›'));
      det.appendChild(s);
      const list = el('div', 'list appl-tasks');
      ap.tasks.forEach(t => {
        const when = t.unknown ? 'next maintenance weekend' : t.overdue ? `overdue ${-t.daysLeft}d` : L.relDays(t.daysLeft);
        const sub = [`Every ${t.everyDays} days · ${t.lastDone ? 'last done ' + L.fmtDate(t.lastDone) : 'not logged yet'}`, `Next: ${L.fmtDate(t.nextDue)} (${when})`];
        list.appendChild(row('task ' + (t.status === 'done' ? 'past' : t.status === 'overdue' ? 'urgent' : ''), t.name, sub,
          [maintPill(t.status), t.doneLocally ? btn('Undo', 'ghost', () => delLocal('maint:' + t.id))
            : btn('Done today', 'done', () => setLocal('maint:' + t.id, { lastDone: today }))]));
      });
      det.appendChild(list);
      return det;
    });
    $('homeList').replaceChildren(...(out.length ? out : [el('p', 'empty', 'No appliances tracked.')]));
  }

  function renderFestivals(today) {
    const active = L.activeFestivals(st.data, today);
    const upcoming = L.upcomingFestivals(st.data, today);
    const out = [];
    for (const info of active) {
      const f = info.fest;
      const card = el('div', 'item fest-card active');
      card.appendChild(el('p', 'fest-title', `${f.emoji || '🎉'} ${f.name}`));
      const dayLine = info.totalDays > 1
        ? `${info.label} · Day ${info.dayNum} of ${info.totalDays}`
        : info.label;
      const note = info.note ? ` · ${info.note}` : '';
      card.appendChild(el('p', 'fest-meta', dayLine + note));
      const bar = el('div', 'fest-progress');
      const fill = el('span');
      fill.style.width = Math.round(info.progress * 100) + '%';
      bar.appendChild(fill);
      card.appendChild(bar);
      const trivia = L.festivalTriviaToday(f, today);
      if (trivia.length) {
        const ul = el('ul', 'fest-trivia');
        trivia.forEach(tr => {
          const li = el('li', null, tr.text);
          if (tr.eveningHint && !/evening/i.test(tr.text)) { // no "(after evening)" when the text already says so
            li.appendChild(document.createTextNode(' '));
            li.appendChild(el('span', 'hint', '(after evening)'));
          }
          ul.appendChild(li);
        });
        card.appendChild(ul);
      } else {
        card.appendChild(el('p', 'muted small', 'No local trivia for today.'));
      }
      out.push(card);
    }
    for (const u of upcoming) {
      const f = u.fest;
      const card = el('div', 'item fest-card compact');
      card.appendChild(el('p', 'fest-title', `${f.emoji || '🎉'} ${f.name}`));
      card.appendChild(el('p', 'fest-meta',
        `Starts ${L.fmtDate(f.start)} (${L.relDays(u.daysUntil)}) · ${u.totalDays} day${u.totalDays === 1 ? '' : 's'} through ${L.fmtDate(f.end)}`));
      out.push(card);
    }
    if (!out.length) out.push(el('p', 'empty', 'No active or upcoming festivals in the next 3 weeks.'));
    $('festivalsList').replaceChildren(...out);
  }

  function renderSupplies(today) {
    const items = L.supplyItems(st.data, st.overrides, today);
    const out = items.map(it => {
      const sub = [`${it.quantity || ''}${it.quantity ? ' · ' : ''}${it.store || ''} · every ~${it.intervalDays} days${it.intervalEstimated ? ' (est.)' : ''}`,
        `Last bought ${it.lastBought ? L.fmtDate(it.lastBought) : 'unknown'}` + (it.lowSoonOn ? ` · low around ${L.fmtDate(it.lowSoonOn)}` : '')];
      const c = row(it.status === 'out' ? 'urgent' : (it.flagged ? 'warn' : ''), (it.status === 'out' ? '🚨 ' : '') + it.name, sub,
        pill(it.status === 'ok' ? (it.runningLowSoon ? 'running low soon' : 'ok') : it.status, it.status === 'out' ? 'red' : (it.flagged ? 'amber' : 'green')));
      const actions = el('div', 'row-btns');
      if (it.status !== 'low') actions.appendChild(btn('Low', '', () => setLocal('supply:' + it.id, { status: 'low' })));
      if (it.status !== 'out') actions.appendChild(btn('Out', '', () => setLocal('supply:' + it.id, { status: 'out' })));
      actions.appendChild(btn('Bought ✓', 'done', () => setLocal('supply:' + it.id, { status: 'ok', lastBought: today })));
      if (st.overrides['supply:' + it.id]) actions.appendChild(btn('Undo', 'ghost', () => delLocal('supply:' + it.id)));
      const href = it.link && safeLink(it.link);
      if (href) { const a = el('a', 'link', 'Open in ' + (it.store || 'store') + ' ↗'); a.href = href; a.target = '_blank'; a.rel = 'noopener noreferrer'; actions.appendChild(a); }
      c.appendChild(actions);
      return c;
    });
    $('suppliesList').replaceChildren(...(out.length ? out : [el('p', 'empty', 'No supplies tracked.')]));
  }

  function changeLabel(c) {
    const d = st.data || {}, find = list => (list || []).find(x => x && x.id === c.id) || {};
    if (c.type === 'maintenance.done') { const t = find(((d.maintenance || {}).appliances || []).flatMap(a => a.tasks || [])); return `Done: ${t.name || c.id}`; }
    if (c.type === 'charging.charged') return `Charged: ${find((d.charging || {}).devices).name || c.id}`;
    if (c.type === 'notice.status') return `${c.status === 'done' ? 'Done' : 'Reopened'}: ${find((d.notices || {}).items).title || c.id}`;
    if (c.type === 'todo.dismiss' || c.type === 'todo.restore') return `${c.type === 'todo.dismiss' ? 'Dismiss' : 'Restore'}: ${find((d.todos || {}).items).title || c.id}`;
    if (c.type === 'notice.dismiss' || c.type === 'notice.restore') return `${c.type === 'notice.dismiss' ? 'Dismiss' : 'Restore'}: ${find((d.notices || {}).items).title || c.id}`;
    if (c.type === 'todo.done' || c.type === 'todo.undone') return `${c.type === 'todo.done' ? 'Done' : 'Reopened'}: ${find((d.todos || {}).items).title || c.id}`;
    if (c.type === 'note.add') return 'Note: ' + (String(c.text || '').length > 40 ? String(c.text).slice(0, 40) + '…' : c.text);
    if (c.type === 'note.edit') return 'Edit note: ' + (String(c.text || '').length > 40 ? String(c.text).slice(0, 40) + '…' : c.text);
    if (c.type === 'note.delete') return 'Delete note: ' + ((find((d.notes || {}).items).text || c.id).slice(0, 40));
    if (/^idea\./.test(c.type)) {
      const t = c.title || find((d.ideas || {}).items).title || c.id, short = String(t).length > 40 ? String(t).slice(0, 40) + '…' : t;
      return c.type === 'idea.add' ? 'Idea: ' + short : c.type === 'idea.edit' ? 'Edit idea: ' + short
        : c.type === 'idea.delete' ? 'Delete idea: ' + short : `Idea ${L.IDEA_STATUS_LABEL[c.status] || c.status}: ${short}`;
    }
    if (c.type === 'supply.update') return `${c.lastBought ? 'Bought' : c.status === 'out' ? 'Out' : c.status === 'low' ? 'Low' : 'OK'}: ${find((d.supplies || {}).items).name || c.id}`;
    const m = find((d.money || {})[c.type === 'card.status' ? 'cards' : 'bills']);
    return `${c.status === 'paid' ? 'Paid' : 'Unpaid'}: ${m.label || m.pushLabel || c.id}`;
  }
  function renderSync() {
    const entries = pendingEntries(), changes = entries.map(e => e.change);
    $('syncList').replaceChildren(...entries.map(e => {
      const s = sync.sent[e.key], sent = s && s.at === e.v.at;
      const li = el('li'); li.append(el('span', '', changeLabel(e.change)), pill(sent ? 'sent' : 'queued', sent ? 'blue' : 'amber'));
      if (sent) li.title = 'Sent ' + fmtIST(s.sentAt) + (s.issue ? ' (#' + s.issue + ')' : '') + '; waiting for your assistant to apply it';
      return li;
    }));
    const ap = sync.applied;
    $('syncApplied').classList.toggle('hidden', !(ap.n && Date.now() - ap.at < 15 * 60000));
    $('syncApplied').textContent = ap.n ? `✓ ${ap.n} change${ap.n === 1 ? '' : 's'} applied ${hm(ap.at)} IST` : '';
    renderSyncState();
    $('syncCount').textContent = String(changes.length);
    $('syncJson').value = changes.length
      ? JSON.stringify({ lifeHqChanges: 1, exportedAt: new Date().toISOString(), baseUpdatedAt: st.data.updatedAt || null, changes })
      : '';
    $('syncJson').placeholder = 'No local changes yet.';
    $('dataInfo').textContent = `Data version ${st.data.schemaVersion || '?'} · updated ${st.data.updatedAt ? fmtIST(Date.parse(st.data.updatedAt)) : 'unknown'}`;
  }

  async function renderAll() {
    upd.lastRender = Date.now();
    await loadOverrides();
    if (st.data) {
      const now = nowMs(), today = L.istDate(now);
      const parts = [() => renderToday(now, today), () => renderTodoSection(today), renderNotes, renderIdeas, () => renderMoney(today), () => renderFamily(now, today), () => renderFestivals(today),
        () => renderCharging(now, today), () => renderHome(today), () => renderSupplies(today), renderSync, () => { renderWiki(); }];
      for (const p of parts) { try { p(); } catch (e) { console.error(e); banner('⚠️ Some data could not be shown: ' + e.message); } }
    }
    $('s-today').classList.toggle('hidden', !st.data);
    for (const id of ['s-todos', 's-notes', 's-ideas', 's-wiki', 's-money', 's-family', 's-festivals', 's-charging', 's-home', 's-supplies', 's-sync']) $(id).classList.toggle('hidden', !st.data);
    await renderAlerts();
    updateSyncInfo();
  }

  // ================= Alerts history (push) =================
  function actionBtn(label, cls, id, newStatus) { return btn(label, cls, async () => { await HQDB.setStatus(id, newStatus); renderAlerts(); }); }
  function metaRow(a, b) {
    const m = el('div', 'meta');
    const left = el('div', 'meta-left');
    left.appendChild(el('span', 'ts', fmtIST(a.ts || a.receivedAt)));
    const href = a.url && safeLink(a.url);
    if (href) { left.appendChild(document.createTextNode(' · ')); const l = el('a', 'link', 'Open link'); l.href = href; l.target = '_blank'; l.rel = 'noopener noreferrer'; left.appendChild(l); }
    m.appendChild(left);
    const list = (Array.isArray(b) ? b : [b]).filter(Boolean);
    if (list.length) { const r = el('div', 'meta-btns'); list.forEach(x => r.appendChild(x)); m.appendChild(r); }
    return m;
  }
  function urgentCard(a, old) {
    const c = el('div', 'item urgent' + (old ? ' old' : '')); c.id = 'a-' + a.id;
    c.appendChild(el('p', 'title', a.title.includes('🚨') ? a.title : '🚨 ' + a.title));
    if (a.body) c.appendChild(el('p', 'body', a.body));
    if (a.items && a.items.length) { const ul = el('ul'); a.items.forEach(i => ul.appendChild(el('li', null, i))); c.appendChild(ul); }
    c.appendChild(metaRow(a, [actionBtn('✓ Mark done', 'done', a.id, 'done'), actionBtn('Dismiss', '', a.id, 'dismissed')]));
    return c;
  }
  function summaryCard(a, openFirst, old) {
    const c = el('div', 'item' + (old ? ' old' : '')); c.id = 'a-' + a.id;
    const d = el('details'); if (openFirst) d.open = true;
    const s = el('summary');
    s.appendChild(el('span', 'chev', '›'));
    s.appendChild(el('p', 'title', (a.type === 'summary' && !a.title.includes('📋') ? '📋 ' : '') + a.title));
    if (a.body) s.appendChild(el('p', 'body', a.body));
    d.appendChild(s);
    if (a.items && a.items.length) { const ul = el('ul'); a.items.forEach(i => ul.appendChild(el('li', null, i))); d.appendChild(ul); }
    else d.appendChild(el('p', 'muted small', 'No items.'));
    c.appendChild(d);
    c.appendChild(metaRow(a, actionBtn('Dismiss', '', a.id, 'dismissed')));
    return c;
  }
  // An alert from before today's IST midnight is "old": it moves to the collapsed Older group and is not counted
  // as urgent (header count + app badge). Dismiss / Mark done set the alert's status in IndexedDB (alerts store);
  // alert history is per device and is not part of the sync-back queue.
  const alertDay = a => L.istDate(a.ts || a.receivedAt || 0);
  async function oldPendingAlerts() {
    const today = L.istDate(nowMs());
    return (await HQDB.getAll().catch(() => [])).filter(a => a.status === 'pending' && alertDay(a) < today);
  }
  async function renderAlerts(flashId) {
    const today = L.istDate(nowMs());
    const all = (await HQDB.getAll().catch(() => [])).sort((x, y) => (y.ts || 0) - (x.ts || 0));
    const pending = all.filter(a => a.status === 'pending');
    const fresh = pending.filter(a => alertDay(a) >= today), old = pending.filter(a => alertDay(a) < today);
    const urgent = fresh.filter(a => a.type === 'urgent');
    if (navigator.setAppBadge) { try { urgent.length ? navigator.setAppBadge(urgent.length) : navigator.clearAppBadge(); } catch (e) { /* ignore */ } }
    if (!st.data && !st.noData) return; // locked: keep history off screen
    const summaries = fresh.filter(a => a.type === 'summary');
    const info = fresh.filter(a => a.type === 'info');
    $('urgentList').replaceChildren(...urgent.map(urgentCard));
    $('urgentCount').textContent = String(urgent.length);
    $('urgentEmpty').classList.toggle('hidden', urgent.length > 0);
    $('summaryList').replaceChildren(...summaries.map((a, i) => summaryCard(a, i === 0)));
    $('summaryEmpty').classList.toggle('hidden', summaries.length > 0);
    $('infoList').replaceChildren(...info.map(a => summaryCard(a, false)));
    $('infoSection').classList.toggle('hidden', info.length === 0);
    $('oldList').replaceChildren(...old.map(a => a.type === 'urgent' ? urgentCard(a, true) : summaryCard(a, false, true)));
    $('oldCount').textContent = String(old.length);
    $('oldSummary').textContent = `Show ${old.length} older alert${old.length === 1 ? '' : 's'} (before today)`;
    $('oldSection').classList.toggle('hidden', old.length === 0);
    if (flashId) {
      const node = document.getElementById('a-' + flashId);
      if (node && node.closest('#oldDetails')) $('oldDetails').open = true;
      if (node) { node.classList.add('flash'); const det = node.querySelector('details'); if (det) det.open = true; node.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
    }
  }
  async function dismissAllOld() {
    const old = await oldPendingAlerts();
    if (!old.length) { renderAlerts(); return; }
    if (!confirm(`Dismiss ${old.length} alert${old.length === 1 ? '' : 's'} from before today?`)) return;
    for (const a of old) await HQDB.setStatus(a.id, 'dismissed').catch(() => {});
    toast(`Dismissed ${old.length} old alert${old.length === 1 ? '' : 's'}`);
    renderAlerts();
  }
  async function clearOld() {
    if (!confirm('Remove done/dismissed alerts and anything older than 14 days? Pending urgent items are kept.')) return;
    const n = await HQDB.clearOld(14);
    status(`Cleared ${n} item${n === 1 ? '' : 's'}.`);
    renderAlerts();
  }

  // ================= Push setup / subscription =================
  function urlB64ToUint8Array(b64) {
    const p = '='.repeat((4 - (b64.length % 4)) % 4);
    const s = atob((b64 + p).replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(s, c => c.charCodeAt(0));
  }
  function sameKey(sub, b64) {
    const k = sub.options && sub.options.applicationServerKey;
    if (!k) return true;
    const a = new Uint8Array(k), b = urlB64ToUint8Array(b64);
    return a.length === b.length && a.every((v, i) => v === b[i]);
  }
  async function registerSW() {
    if (!('serviceWorker' in navigator)) return null;
    // updateViaCache:'none': sw.js and its imports always bypass the HTTP cache (GitHub Pages max-age=600) on update checks.
    const hadController = upd.hadController = !!navigator.serviceWorker.controller;
    reg = await navigator.serviceWorker.register('./sw.js', { scope: './', updateViaCache: 'none' });
    // A new worker takes control (skipWaiting + clients.claim): mark the code update as pending; the idle gate
    // reloads once (no reload while you are using the page).
    navigator.serviceWorker.addEventListener('controllerchange', () => { if (hadController) markCode(''); });
    reg.addEventListener('updatefound', () => watchWorker(reg.installing));
    watchWorker(reg.installing);
    if (reg.waiting && hadController) markCode('');
    await navigator.serviceWorker.ready;
    return reg;
  }
  async function currentSub() { if (!reg || !('pushManager' in reg)) return null; return reg.pushManager.getSubscription(); }
  async function showSub() {
    $('subJson').value = st.device ? await enrollCode() : '';
    if (!st.device) { banner('This device has no key. Tap “Create this device’s key” first.'); return; }
    $('subBox').classList.remove('hidden');
    $('subBox').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  async function enable() {
    try {
      if (!supported) throw new Error('Push is not supported in this browser. Use Chrome on Android.');
      if (!cfg.vapidPublicKey) throw new Error('Missing VAPID public key in config.js');
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') throw new Error('Notifications were not allowed. Enable them in site settings and try again.');
      if (!reg) await registerSW();
      let sub = await currentSub();
      if (sub && !sameKey(sub, cfg.vapidPublicKey)) { await sub.unsubscribe(); sub = null; }
      if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToUint8Array(cfg.vapidPublicKey) });
      await HQDB.setMeta('subChanged', null);
      banner('');
      await refreshSetup();
      await refreshEnroll();
      await showSub();
    } catch (e) { banner('⚠️ ' + e.message); }
  }
  async function refreshSetup() {
    const sub = await currentSub().catch(() => null);
    const granted = 'Notification' in window && Notification.permission === 'granted';
    const keyOk = !sub || sameKey(sub, cfg.vapidPublicKey || '');
    $('setup').classList.toggle('hidden', !!(sub && granted && keyOk));
    if (sub && !keyOk) banner('🔑 The app key changed. Tap "Enable notifications" and paste the new enrollment code to your assistant.');
    if (!supported) banner('⚠️ This browser does not support push notifications. Open in Chrome on Android.');
    else if (Notification.permission === 'denied') banner('⚠️ Notifications are blocked. Allow them in Chrome site settings, then tap Enable.');
    const changed = await HQDB.getMeta('subChanged').catch(() => null);
    if (changed && sub) banner('🔄 Your push subscription changed. Open ⚙️ → "Show my enrollment code again" and paste it to your assistant.');
    status(sub ? 'Subscribed ✓  Permission: ' + Notification.permission : 'Not subscribed yet.');
  }
  async function copyText(ta, button, idle, okText) {
    let ok = false;
    try { await navigator.clipboard.writeText(ta.value); ok = true; } catch (e) { ta.focus(); ta.select(); try { ok = document.execCommand('copy'); } catch (e2) { ok = false; } }
    button.textContent = ok ? okText : 'Select the text above and copy it';
    setTimeout(() => { button.textContent = idle; }, 3000);
    return ok;
  }
  async function copySub() {
    const ok = await copyText($('subJson'), $('copyBtn'), '📋 Copy', '✅ Copied! Paste it to your assistant');
    if (ok) HQDB.setMeta('subChanged', null).then(refreshSetup);
  }
  async function testPush() {
    if (Notification.permission !== 'granted') { banner('⚠️ Enable notifications first.'); return; }
    const sw = (reg && reg.active) || navigator.serviceWorker.controller;
    if (!sw) { banner('Service worker not active yet, try again in a moment.'); return; }
    sw.postMessage({ kind: 'test-push', payload: { id: 'test-' + Date.now(), type: 'urgent', title: 'Test alert', body: 'This is how an urgent alert looks. Tap "Mark done" to clear it.', ts: Date.now() } });
    status('Test sent locally.');
  }

  // ================= Wiring =================
  // ---- Section navigation: header pills scroll to their section (offset by the sticky header via CSS
  // scroll-margin-top) and the pill of the section in view is highlighted.
  const nav = { links: [], lockId: null, lockTimer: 0, raf: 0 };
  function headerOffset() { const h = document.querySelector('.topbar'); return (h ? h.getBoundingClientRect().height : 0) + 16; }
  function setActivePill(id) {
    for (const a of nav.links) {
      const on = a.getAttribute('href') === '#' + id;
      a.classList.toggle('active', on);
      if (on) a.setAttribute('aria-current', 'location'); else a.removeAttribute('aria-current');
      if (on) {
        // Keep the active pill visible inside the horizontally scrolling pill row (without moving the page).
        const bar = $('tabs'), l = a.offsetLeft - bar.offsetLeft, r = l + a.offsetWidth;
        if (l < bar.scrollLeft + 8 || r > bar.scrollLeft + bar.clientWidth - 8) bar.scrollTo({ left: l - (bar.clientWidth - a.offsetWidth) / 2, behavior: 'smooth' });
      }
    }
  }
  function updateActivePill() {
    nav.raf = 0;
    if ($('dash').classList.contains('hidden') || !nav.links.length) return;
    if (nav.lockId) { setActivePill(nav.lockId); return; }
    const off = headerOffset() + 8;
    let cur = null;
    for (const a of nav.links) {
      const sec = $(a.getAttribute('href').slice(1));
      if (sec && sec.offsetParent !== null && sec.getBoundingClientRect().top <= off) cur = sec.id;
    }
    setActivePill(cur || nav.links[0].getAttribute('href').slice(1));
  }
  function scrollToSection(id, smooth) {
    const sec = $(id);
    if (!sec || $('dash').classList.contains('hidden')) return;
    const reduce = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
    // Hold the clicked pill active while the smooth scroll runs (a short last section may never reach the top).
    nav.lockId = id; clearTimeout(nav.lockTimer);
    setActivePill(id);
    sec.scrollIntoView({ behavior: smooth && !reduce ? 'smooth' : 'auto', block: 'start' });
    nav.lockTimer = setTimeout(() => { nav.lockId = null; }, smooth ? 900 : 50);
  }
  function wireNav() {
    nav.links = Array.from(document.querySelectorAll('#tabs a[href^="#s-"]'));
    for (const a of nav.links) {
      a.addEventListener('click', ev => {
        ev.preventDefault();
        const id = a.getAttribute('href').slice(1);
        history.replaceState(null, '', location.pathname + location.search + '#' + id);
        scrollToSection(id, true);
      });
    }
    const brand = document.querySelector('.topbar .brand');
    if (brand) brand.addEventListener('click', ev => {
      ev.preventDefault();
      if (location.hash) history.replaceState(null, '', location.pathname + location.search);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
    // Manual scrolling (wheel / touch / keys) releases the click lock straight away.
    for (const t of ['wheel', 'touchstart', 'keydown']) addEventListener(t, () => { if (nav.lockId) { nav.lockId = null; clearTimeout(nav.lockTimer); } }, { passive: true });
    addEventListener('scroll', () => { if (!nav.raf) nav.raf = requestAnimationFrame(updateActivePill); }, { passive: true });
    addEventListener('resize', () => { if (!nav.raf) nav.raf = requestAnimationFrame(updateActivePill); }, { passive: true });
    addEventListener('hashchange', () => { if (location.hash.startsWith('#s-')) scrollToSection(location.hash.slice(1), false); });
    // v17: 12 pills. When they do not fit, the row scrolls sideways: fade only the edge(s) with more pills, and let a
    // mouse wheel scroll it horizontally (no horizontal wheel on most mice).
    const bar = $('tabs');
    const fade = () => {
      const max = bar.scrollWidth - bar.clientWidth;
      bar.classList.toggle('fade-l', max > 2 && bar.scrollLeft > 2);
      bar.classList.toggle('fade-r', max > 2 && bar.scrollLeft < max - 2);
    };
    bar.addEventListener('scroll', fade, { passive: true });
    addEventListener('resize', fade, { passive: true });
    bar.addEventListener('wheel', ev => {
      if (bar.scrollWidth <= bar.clientWidth + 2 || Math.abs(ev.deltaX) > Math.abs(ev.deltaY)) return;
      ev.preventDefault(); bar.scrollBy({ left: ev.deltaY, behavior: 'auto' });
    }, { passive: false });
    nav.fade = fade;
    if ('ResizeObserver' in window) new ResizeObserver(fade).observe(bar);
  }

  function wire() {
    wireNav();
    wireSync();
    $('lockBtn').addEventListener('click', forgetDevice);
    $('forgetBtn').addEventListener('click', forgetDevice);
    $('newKeyBtn').addEventListener('click', newKey);
    $('retryBtn').addEventListener('click', () => unlockFlow());
    $('copyEnrollBtn').addEventListener('click', () => copyText($('enrollJson'), $('copyEnrollBtn'), '📋 Copy', '✅ Copied! Paste it to your assistant'));
    $('deviceName').addEventListener('input', async () => { await HQDB.setMeta('deviceName', $('deviceName').value.slice(0, 40)).catch(() => {}); refreshEnroll(); });
    $('noDataBtn').addEventListener('click', () => { st.noData = true; openDashboard(); });
    $('enableBtn').addEventListener('click', enable);
    $('enableBtn2').addEventListener('click', enable);
    $('copyBtn').addEventListener('click', copySub);
    $('copySyncBtn').addEventListener('click', () => copyText($('syncJson'), $('copySyncBtn'), '📋 Copy changes', '✅ Copied! Paste it to your assistant'));
    $('hideSubBtn').addEventListener('click', () => $('subBox').classList.add('hidden'));
    $('menuBtn').addEventListener('click', () => { const open = $('settings').classList.toggle('hidden') === false; $('menuBtn').setAttribute('aria-expanded', String(open)); });
    $('showSubBtn').addEventListener('click', async () => {
      const sub = await currentSub().catch(() => null);
      await showSub();
      if (!sub) { banner('No push subscription yet: the code has only the device key. Tap "Enable notifications" to add it.'); $('setup').classList.remove('hidden'); }
    });
    $('testBtn').addEventListener('click', testPush);
    $('clearBtn').addEventListener('click', clearOld);
    $('clearBtn2').addEventListener('click', clearOld);
    $('dismissOldBtn').addEventListener('click', dismissAllOld);
    $('noteInput').addEventListener('input', updateNoteCounter);
    $('noteInput').addEventListener('keydown', ev => { if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); if (!$('addNoteBtn').disabled) addNote(); } });
    $('addNoteBtn').addEventListener('click', addNote);
    for (const id of ['ideaTitle', 'ideaDetails']) $(id).addEventListener('input', updateIdeaForm);
    $('ideaPriority').addEventListener('change', updateIdeaForm);
    $('ideaTitle').addEventListener('keydown', ev => { if (ev.key === 'Enter') { ev.preventDefault(); if (!$('addIdeaBtn').disabled) addIdea(); } });
    $('ideaDetails').addEventListener('keydown', ev => { if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); if (!$('addIdeaBtn').disabled) addIdea(); } });
    $('addIdeaBtn').addEventListener('click', addIdea);
    $('undoBtn').addEventListener('click', undoAny);
    window.addEventListener('pagehide', flushNoteDeletes);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushNoteDeletes(); });
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.addEventListener('message', ev => {
        const d = ev.data || {};
        if (d.kind === 'focus-alert') {
          // You tapped the notification: show it now (explicit action), with any new data.
          if (st.data || st.noData) renderAlerts(d.id); else st.flashId = d.id;
          refreshData('push', true).then(async () => { const e = upd.env; if (e) { upd.env = null; await applyData(e).catch(console.error); scheduleApply(); } });
        } else if (d.kind === 'alert' || d.kind === 'refresh-data') {
          // A push arrived while the page is open: the new alert / data waits for the idle gate.
          if (d.kind === 'alert') { upd.alerts = true; scheduleApply(); }
          refreshData('push', true); // a push usually means new data
        } else if (d.kind === 'sub-changed') { refreshSetup(); refreshEnroll(); }
      });
    }
    // No auto-lock and no prompt: an enrolled device opens the data directly until 🔒 Lock / Forget this device.
    // Update checks (data + code) and the idle gate: see wireUpdates().
    // (Also picks up "maybe the assistant has published for this device meanwhile" on the enroll screen.)
    wireUpdates();
    setInterval(() => { if (sync.lastError && Date.now() - sync.lastTry > 60000) scheduleSync(0); }, 60000);
  }

  async function init() {
    wire();
    try { await registerSW(); } catch (e) { banner('⚠️ Could not start service worker: ' + e.message); }
    await refreshSetup().catch(() => {});
    st.flashId = location.hash && !location.hash.startsWith('#s-') ? decodeURIComponent(location.hash.slice(1)) : null;
    if (st.flashId) history.replaceState(null, '', location.pathname + location.search);
    await HQDB.delMeta('rememberedKey').catch(() => {}); // v1 leftover (password-derived key), no longer used
    $('deviceName').value = (await HQDB.getMeta('deviceName').catch(() => null)) || '';
    st.lastSync = (await HQDB.getMeta('lastSync').catch(() => 0)) || 0;
    await loadSyncState();
    await loadTokenMeta();
    st.device = await loadDevice();
    if (!st.device) {
      // First run: create this device's key pair automatically.
      try { st.device = await createDevice(); } catch (e) { banner('⚠️ Could not create a device key: ' + e.message); }
    }
    await unlockFlow();
    st.lastCheck = Date.now();
    checkCode(true); // a tab opened from a stale cached shell finds the new version right away
    renderSyncState().catch(() => {});
    scheduleSync(3000); // anything queued from last time (e.g. tapped while offline)
  }

  init();
})();
