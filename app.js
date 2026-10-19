/* Life HQ page logic: device enrollment + decryption (v2, per-device keys), dashboard sections, push setup, alert history. */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const cfg = self.LIFE_HQ_CONFIG || {};
  const L = self.LifeLogic;
  const supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  let reg = null;

  // In-memory only. Plaintext data is never written to storage.
  const st = { env: null, device: null, data: null, overrides: {}, flashId: null, noData: false };

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

  async function loadEnvelope() {
    try {
      const res = await fetch(cfg.dataUrl || './data.enc.json', { cache: 'no-store' });
      if (!res.ok) return null;
      return await res.json();
    } catch (e) { return null; }
  }

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
    st.data = null;
    $('dash').classList.add('hidden');
    $('tabs').classList.add('hidden');
    for (const id of ['todayList', 'moneyList', 'familyList', 'chargingList', 'weekendBox', 'homeList', 'suppliesList', 'urgentList', 'summaryList', 'infoList']) $(id).replaceChildren();
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
  async function loadOverrides() { st.overrides = await HQDB.getLocalAll().catch(() => ({})); }
  async function setLocal(key, val) { await HQDB.setLocal(key, Object.assign({ at: Date.now() }, val)); await renderAll(); }
  async function delLocal(key) { await HQDB.delLocal(key); await renderAll(); }

  function pendingChanges() {
    const base = Date.parse((st.data && st.data.updatedAt) || 0) || 0;
    const changes = [];
    for (const [k, v] of Object.entries(st.overrides)) {
      if (!v || (v.at || 0) <= base) continue;
      const [kind, id] = [k.slice(0, k.indexOf(':')), k.slice(k.indexOf(':') + 1)];
      const at = new Date(v.at).toISOString();
      if (kind === 'maint') changes.push({ type: 'maintenance.done', id, date: v.lastDone, at });
      else if (kind === 'charge') changes.push({ type: 'charging.charged', id, date: v.date, at });
      else if (kind === 'supply') changes.push(Object.assign({ type: 'supply.update', id, status: v.status, at }, v.lastBought ? { lastBought: v.lastBought } : {}));
      else if (kind === 'card' || kind === 'bill') changes.push({ type: kind + '.status', id, status: v.status, date: v.date, at });
    }
    return changes.sort((a, b) => a.at.localeCompare(b.at));
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

  function renderToday(now, today) {
    $('todayDate').textContent = L.fmtDate(today) + ' · ' + L.fmtTime(`${Math.floor(L.istMinutes(now) / 60)}:${String(L.istMinutes(now) % 60).padStart(2, '0')}`) + ' IST';
    const items = L.todayItems(st.data, st.overrides, now);
    const list = items.map(i => {
      const c = row(sevCls[i.sev], (i.sev === 'urgent' ? '🚨 ' : '') + i.text);
      c.classList.add('compact'); c.addEventListener('click', () => $('s-' + i.section).scrollIntoView({ behavior: 'smooth' }));
      return c;
    });
    $('todayList').replaceChildren(...(list.length ? list : [el('p', 'empty', 'Nothing due today. 🎉')]));
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
      return c;
    });
    $('moneyList').replaceChildren(...(out.length ? out : [el('p', 'empty', 'No cards or bills.')]));
  }

  function renderFamily(now, today) {
    const sc = st.data.school || {};
    const isDay = L.schoolDay(st.data, today);
    const nowMin = L.istMinutes(now);
    const win = L.settingsOf(st.data).leaveWindowMinutes;
    const days = (sc.days || [1, 2, 3, 4, 5]).map(d => ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d]);
    const out = [el('p', 'muted small', (isDay ? '✅ School day today' : '😴 No school today') + ' · ' + (days.length === 5 && days[0] === 'Mon' ? 'Monday to Friday' : days.join(', ')))];
    for (const r of (sc.runs || [])) {
      const delta = L.hhmmToMin(r.leaveAt) - nowMin;
      const urgent = isDay && Math.abs(delta) <= win;
      const done = isDay && delta < -win;
      const sub = `Leave at ${L.fmtTime(r.leaveAt)}` + (r.eventAt ? ` · ${r.label.toLowerCase().includes('pick') ? 'pick-up' : 'event'} at ${L.fmtTime(r.eventAt)}` : '');
      out.push(row(urgent ? 'urgent' : (done ? 'past' : (isDay && delta > 0 && delta <= 60 ? 'warn' : '')), (urgent ? '🚨 Leave now: ' : '') + r.label, sub,
        isDay ? pill(done ? 'done' : (delta > 0 ? 'in ' + (delta >= 60 ? Math.floor(delta / 60) + 'h ' : '') + (delta % 60) + 'm' : 'now'), urgent ? 'red' : '') : null));
    }
    const upcoming = (sc.holidays || []).filter(h => h >= today).slice(0, 5);
    if (upcoming.length) out.push(el('p', 'muted small', 'Holidays: ' + upcoming.map(L.fmtDate).join(', ')));
    $('familyList').replaceChildren(...out);
  }

  function renderCharging(now, today) {
    const nowMin = L.istMinutes(now);
    const out = L.chargingDevices(st.data, st.overrides, today).map(d => {
      const due = !d.chargedToday && nowMin >= L.hhmmToMin(d.reminderTime);
      return row(d.chargedToday ? 'past' : (due ? 'urgent' : ''), `${d.icon || '🔋'} ${d.name}`, `Reminder ${L.fmtTime(d.reminderTime)} daily`,
        d.chargedToday ? [pill('✓ charged', 'green'), btn('Undo', 'ghost', () => delLocal('charge:' + d.id))]
          : btn('Charged ✓', 'done', () => setLocal('charge:' + d.id, { date: today })));
    });
    $('chargingList').replaceChildren(...out);
  }

  function renderHome(today) {
    const wk = L.maintenanceWeekend(st.data, st.overrides, today);
    const box = el('div', 'card weekend' + (wk.isToday ? ' urgent' : ''));
    const d = L.daysBetween(today, wk.date);
    box.appendChild(el('h3', null, `${wk.isToday ? '🚨 ' : ''}🗓️ Maintenance weekend: ${L.fmtDate(wk.date)} (${L.relDays(d)})`));
    box.appendChild(el('p', 'muted small', `Every other Saturday. ${wk.tasks.length} task${wk.tasks.length === 1 ? '' : 's'} due by ${L.fmtDate(wk.until)}:`));
    const ul = el('ul', 'tasks');
    wk.tasks.forEach(t => ul.appendChild(el('li', t.overdue ? 'red' : null, `${t.appliance}: ${t.name}` + (t.unknown ? ' (never logged)' : ` (${t.overdue ? 'overdue' : 'due ' + L.fmtDate(t.nextDue)})`))));
    if (!wk.tasks.length) ul.appendChild(el('li', null, 'Nothing due. 🎉'));
    box.appendChild(ul);
    $('weekendBox').replaceChildren(box);

    const tasks = L.maintenanceTasks(st.data, st.overrides, today);
    const groups = new Map();
    tasks.forEach(t => { if (!groups.has(t.appliance)) groups.set(t.appliance, []); groups.get(t.appliance).push(t); });
    const order = ((st.data.maintenance || {}).appliances || []).map(a => a.name);
    const out = [];
    for (const name of order) {
      const list = groups.get(name) || [];
      const g = el('div', 'group');
      g.appendChild(el('h3', null, name));
      list.forEach(t => {
        const sub = [`Every ${t.everyDays} days · last done ${t.lastDone ? L.fmtDate(t.lastDone) : 'unknown'}`,
          `Next: ${L.fmtDate(t.nextDue)} (${t.unknown ? 'next maintenance weekend' : (t.overdue ? 'overdue ' + (-t.daysLeft) + 'd' : L.relDays(t.daysLeft))})`];
        g.appendChild(row(t.doneLocally ? 'past' : (t.overdue ? 'urgent' : (t.daysLeft <= 0 ? 'warn' : '')), (t.overdue && !t.doneLocally ? '🚨 ' : '') + t.name, sub,
          t.doneLocally ? [pill('✓ done today', 'green'), btn('Undo', 'ghost', () => delLocal('maint:' + t.id))]
            : btn('Done today', 'done', () => setLocal('maint:' + t.id, { lastDone: today }))));
      });
      out.push(g);
    }
    $('homeList').replaceChildren(...out);
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

  function renderSync() {
    const changes = pendingChanges();
    $('syncCount').textContent = String(changes.length);
    $('syncJson').value = changes.length
      ? JSON.stringify({ lifeHqChanges: 1, exportedAt: new Date().toISOString(), baseUpdatedAt: st.data.updatedAt || null, changes })
      : '';
    $('syncJson').placeholder = 'No local changes yet.';
    $('dataInfo').textContent = `Data version ${st.data.schemaVersion || '?'} · updated ${st.data.updatedAt ? fmtIST(Date.parse(st.data.updatedAt)) : 'unknown'}`;
  }

  async function renderAll() {
    await loadOverrides();
    if (st.data) {
      const now = nowMs(), today = L.istDate(now);
      const parts = [() => renderToday(now, today), () => renderMoney(today), () => renderFamily(now, today), () => renderCharging(now, today),
        () => renderHome(today), () => renderSupplies(today), renderSync];
      for (const p of parts) { try { p(); } catch (e) { console.error(e); banner('⚠️ Some data could not be shown: ' + e.message); } }
    }
    $('s-today').classList.toggle('hidden', !st.data);
    for (const id of ['s-money', 's-family', 's-charging', 's-home', 's-supplies', 's-sync']) $(id).classList.toggle('hidden', !st.data);
    await renderAlerts();
  }

  // ================= Alerts history (push) =================
  function actionBtn(label, cls, id, newStatus) { return btn(label, cls, async () => { await HQDB.setStatus(id, newStatus); renderAlerts(); }); }
  function metaRow(a, b) {
    const m = el('div', 'meta');
    const left = el('div');
    left.appendChild(el('span', 'ts', fmtIST(a.ts || a.receivedAt)));
    const href = a.url && safeLink(a.url);
    if (href) { left.appendChild(document.createTextNode(' · ')); const l = el('a', 'link', 'Open link'); l.href = href; l.target = '_blank'; l.rel = 'noopener noreferrer'; left.appendChild(l); }
    m.appendChild(left);
    if (b) m.appendChild(b);
    return m;
  }
  function urgentCard(a) {
    const c = el('div', 'item urgent'); c.id = 'a-' + a.id;
    c.appendChild(el('p', 'title', a.title.includes('🚨') ? a.title : '🚨 ' + a.title));
    if (a.body) c.appendChild(el('p', 'body', a.body));
    if (a.items && a.items.length) { const ul = el('ul'); a.items.forEach(i => ul.appendChild(el('li', null, i))); c.appendChild(ul); }
    c.appendChild(metaRow(a, actionBtn('✓ Mark done', 'done', a.id, 'done')));
    return c;
  }
  function summaryCard(a, openFirst) {
    const c = el('div', 'item'); c.id = 'a-' + a.id;
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
  async function renderAlerts(flashId) {
    const all = (await HQDB.getAll().catch(() => [])).sort((x, y) => (y.ts || 0) - (x.ts || 0));
    const urgent = all.filter(a => a.type === 'urgent' && a.status === 'pending');
    if (navigator.setAppBadge) { try { urgent.length ? navigator.setAppBadge(urgent.length) : navigator.clearAppBadge(); } catch (e) { /* ignore */ } }
    if (!st.data && !st.noData) return; // locked: keep history off screen
    const summaries = all.filter(a => a.type === 'summary' && a.status === 'pending');
    const info = all.filter(a => a.type === 'info' && a.status === 'pending');
    $('urgentList').replaceChildren(...urgent.map(urgentCard));
    $('urgentCount').textContent = String(urgent.length);
    $('urgentEmpty').classList.toggle('hidden', urgent.length > 0);
    $('summaryList').replaceChildren(...summaries.map((a, i) => summaryCard(a, i === 0)));
    $('summaryEmpty').classList.toggle('hidden', summaries.length > 0);
    $('infoList').replaceChildren(...info.map(a => summaryCard(a, false)));
    $('infoSection').classList.toggle('hidden', info.length === 0);
    if (flashId) {
      const node = document.getElementById('a-' + flashId);
      if (node) { node.classList.add('flash'); const det = node.querySelector('details'); if (det) det.open = true; node.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
    }
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
    reg = await navigator.serviceWorker.register('./sw.js', { scope: './' });
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
  function wire() {
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
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.addEventListener('message', ev => {
        const d = ev.data || {};
        if (d.kind === 'alert' || d.kind === 'focus-alert') { const id = d.kind === 'alert' ? d.alert && d.alert.id : d.id; if (st.data || st.noData) renderAlerts(id); else st.flashId = id; }
        else if (d.kind === 'sub-changed') { refreshSetup(); refreshEnroll(); }
      });
    }
    // No auto-lock and no prompt: an enrolled device opens the data directly until 🔒 Lock / Forget this device.
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) return;
      if (st.data || st.noData) renderAll();
      else if (st.device) unlockFlow(); // maybe the assistant has published for this device meanwhile
    });
    setInterval(() => { if (st.data && !document.hidden) renderAll(); }, 60000);
  }

  async function init() {
    wire();
    try { await registerSW(); } catch (e) { banner('⚠️ Could not start service worker: ' + e.message); }
    await refreshSetup().catch(() => {});
    st.flashId = location.hash && !location.hash.startsWith('#s-') ? decodeURIComponent(location.hash.slice(1)) : null;
    if (st.flashId) history.replaceState(null, '', location.pathname + location.search);
    await HQDB.delMeta('rememberedKey').catch(() => {}); // v1 leftover (password-derived key), no longer used
    $('deviceName').value = (await HQDB.getMeta('deviceName').catch(() => null)) || '';
    st.device = await loadDevice();
    if (!st.device) {
      // First run: create this device's key pair automatically.
      try { st.device = await createDevice(); } catch (e) { banner('⚠️ Could not create a device key: ' + e.message); }
    }
    await unlockFlow();
  }

  init();
})();
