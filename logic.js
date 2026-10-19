/* Life HQ shared logic (browser + Node). Pure functions, no personal data.
   All dates are 'YYYY-MM-DD' strings in IST (Asia/Kolkata, fixed UTC+5:30, no DST). */
(function (g) {
  'use strict';
  const IST_OFFSET_MIN = 330;
  const DAY = 864e5;

  const pad = n => String(n).padStart(2, '0');
  function istParts(ms) {
    const d = new Date(ms + IST_OFFSET_MIN * 60000);
    return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(), wd: d.getUTCDay(), min: d.getUTCHours() * 60 + d.getUTCMinutes() };
  }
  const istDate = ms => { const p = istParts(ms); return `${p.y}-${pad(p.m)}-${pad(p.d)}`; };
  const istMinutes = ms => istParts(ms).min;
  const istWeekday = ms => istParts(ms).wd; // 0 = Sunday
  const ymdToUTC = ymd => { const [y, m, d] = ymd.split('-').map(Number); return Date.UTC(y, m - 1, d); };
  const addDays = (ymd, n) => new Date(ymdToUTC(ymd) + n * DAY).toISOString().slice(0, 10);
  const daysBetween = (a, b) => Math.round((ymdToUTC(b) - ymdToUTC(a)) / DAY); // b - a
  const weekdayOf = ymd => new Date(ymdToUTC(ymd)).getUTCDay();
  const isYMD = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
  function hhmmToMin(s) { const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '')); return m ? (+m[1]) * 60 + (+m[2]) : null; }
  function fmtTime(s) {
    const t = hhmmToMin(s); if (t == null) return String(s || '');
    const h = Math.floor(t / 60), mi = t % 60, h12 = ((h + 11) % 12) + 1;
    return `${h12}:${pad(mi)} ${h < 12 ? 'AM' : 'PM'}`;
  }
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  function fmtDate(ymd) {
    if (!isYMD(ymd)) return 'unknown';
    const [y, m, d] = ymd.split('-').map(Number);
    return `${WD[weekdayOf(ymd)]} ${d} ${MONTHS[m - 1]}`;
  }
  function relDays(n) {
    if (n === 0) return 'today';
    if (n === 1) return 'tomorrow';
    if (n === -1) return 'yesterday';
    return n > 0 ? `in ${n} days` : `${-n} days ago`;
  }

  function settingsOf(data) {
    const s = (data && data.settings) || {};
    const mw = s.maintenanceWeekend || {};
    return {
      cardAlertDays: s.cardAlertDays ?? 5,
      dailyAlertTime: s.dailyAlertTime || '09:00',
      leaveWindowMinutes: s.leaveWindowMinutes ?? 7,
      supplyLowLeadDays: s.supplyLowLeadDays ?? 3,
      mw: { anchorSaturday: mw.anchorSaturday || '2026-01-03', everyDays: mw.everyDays || 14, lookaheadDays: mw.lookaheadDays || 14, alertTime: mw.alertTime || '08:30' }
    };
  }

  // ---- Maintenance weekend (every other Saturday from the anchor) ----
  function nextMaintenanceSaturday(data, today) {
    const { mw } = settingsOf(data);
    const diff = daysBetween(mw.anchorSaturday, today);
    const k = diff <= 0 ? 0 : Math.ceil(diff / mw.everyDays);
    return addDays(mw.anchorSaturday, k * mw.everyDays);
  }
  const isMaintenanceSaturday = (data, today) => nextMaintenanceSaturday(data, today) === today;

  // Local overrides: map key -> record. Records older than data.updatedAt are ignored (already merged),
  // unless the app marked them keep:true (older than the data but not reflected in it yet, so still pending).
  function freshOverride(data, overrides, key) {
    const o = overrides && overrides[key];
    if (!o) return null;
    const base = Date.parse((data && data.updatedAt) || 0) || 0;
    return ((o.at || 0) > base || o.keep) ? o : null;
  }

  function maintenanceTasks(data, overrides, today) {
    const weekend = nextMaintenanceSaturday(data, today);
    const out = [];
    for (const ap of ((data.maintenance || {}).appliances || [])) {
      for (const t of (ap.tasks || [])) {
        const o = freshOverride(data, overrides, 'maint:' + t.id);
        let lastDone = isYMD(t.lastDone) ? t.lastDone : null;
        if (o && isYMD(o.lastDone) && (!lastDone || o.lastDone > lastDone)) lastDone = o.lastDone;
        const nextDue = lastDone ? addDays(lastDone, t.everyDays) : weekend;
        const daysLeft = daysBetween(today, nextDue);
        out.push({ appliance: ap.name, applianceId: ap.id, id: t.id, name: t.name, everyDays: t.everyDays,
          lastDone, unknown: !lastDone, nextDue, daysLeft, overdue: daysLeft < 0, dueToday: daysLeft === 0,
          doneLocally: !!(o && o.lastDone === today) });
      }
    }
    return out.sort((a, b) => a.nextDue.localeCompare(b.nextDue) || a.appliance.localeCompare(b.appliance));
  }

  function maintenanceWeekend(data, overrides, today) {
    const s = settingsOf(data);
    const date = nextMaintenanceSaturday(data, today);
    const until = addDays(date, s.mw.lookaheadDays - 1);
    const tasks = maintenanceTasks(data, overrides, today).filter(t => t.nextDue <= until && !t.doneLocally);
    return { date, until, tasks, isToday: date === today };
  }

  // ---- Money ----
  function moneyItems(data, overrides, today) {
    const s = settingsOf(data);
    const m = data.money || {};
    const rows = [];
    for (const [kind, list] of [['card', m.cards || []], ['bill', m.bills || []]]) {
      for (const c of list) {
        const o = freshOverride(data, overrides, kind + ':' + c.id);
        const status = o && o.status ? o.status : (c.status || 'unpaid');
        const daysLeft = isYMD(c.dueDate) ? daysBetween(today, c.dueDate) : null;
        const unpaid = status !== 'paid';
        rows.push(Object.assign({}, c, { kind, status, daysLeft, paidLocally: !!(o && o.status === 'paid'),
          overdue: unpaid && daysLeft != null && daysLeft < 0,
          urgent: unpaid && daysLeft != null && daysLeft <= s.cardAlertDays }));
      }
    }
    return rows.sort((a, b) => String(a.dueDate).localeCompare(String(b.dueDate)));
  }

  // ---- School ----
  function schoolDay(data, today) {
    const sc = data.school || {};
    const days = sc.days || [1, 2, 3, 4, 5];
    return days.includes(weekdayOf(today)) && !(sc.holidays || []).includes(today);
  }

  // ---- Charging ----
  function chargingDevices(data, overrides, today) {
    const ch = data.charging || {};
    return (ch.devices || []).map(d => {
      const o = overrides && overrides['charge:' + d.id];
      return Object.assign({}, d, { reminderTime: d.reminderTime || ch.defaultReminderTime || '21:30', chargedToday: !!(o && o.date === today) });
    });
  }

  // ---- Supplies ----
  function supplyItems(data, overrides, today) {
    const s = settingsOf(data);
    return (((data.supplies || {}).items) || []).map(it => {
      const o = freshOverride(data, overrides, 'supply:' + it.id);
      let status = it.status || 'ok', lastBought = isYMD(it.lastBought) ? it.lastBought : null;
      if (o) { if (o.status) status = o.status; if (isYMD(o.lastBought)) lastBought = o.lastBought; }
      const lowSoonOn = lastBought && it.intervalDays ? addDays(lastBought, it.intervalDays - s.supplyLowLeadDays) : null;
      const runOutOn = lastBought && it.intervalDays ? addDays(lastBought, it.intervalDays) : null;
      const runningLowSoon = status === 'ok' && !!lowSoonOn && today >= lowSoonOn;
      return Object.assign({}, it, { status, lastBought, lowSoonOn, runOutOn, runningLowSoon, flagged: status !== 'ok' || runningLowSoon });
    });
  }


  // ---- Festivals ----
  const UPCOMING_FESTIVAL_DAYS = 21;

  function festivalList(data) {
    return (((data || {}).festivals || {}).items) || [];
  }

  function festivalDayInfo(fest, today) {
    if (!fest || !isYMD(fest.start) || !isYMD(fest.end) || !isYMD(today)) return null;
    if (today < fest.start || today > fest.end) return null;
    const dayNum = daysBetween(fest.start, today) + 1;
    const totalDays = daysBetween(fest.start, fest.end) + 1;
    const named = (fest.days || []).find(d => d && d.date === today);
    const label = (named && named.label) || `Day ${dayNum}`;
    return {
      fest, dayNum, totalDays, label,
      note: named && named.note ? named.note : null,
      isFirst: today === fest.start,
      isLast: today === fest.end,
      progress: totalDays > 0 ? dayNum / totalDays : 1,
    };
  }

  function festivalTriviaToday(fest, today) {
    if (!fest || !isYMD(today)) return [];
    const info = festivalDayInfo(fest, today);
    if (!info) return [];
    const out = [];
    // Day-specific observables first (days[].observe), then festival trivia.
    const named = (fest.days || []).find(d => d && d.date === today);
    (named && Array.isArray(named.observe) ? named.observe : []).forEach((text, i) => {
      if (typeof text === 'string' && text.trim()) out.push({ id: `${fest.id || 'fest'}-${today}-obs${i}`, text, when: 'day', eveningHint: false });
    });
    for (const t of (fest.trivia || [])) {
      if (!t || !t.text) continue;
      const when = t.when || 'always';
      let show = false;
      if (when === 'always' || when === 'evening') show = true;
      else if (when === 'first') show = info.isFirst;
      else if (when === 'last') show = info.isLast;
      else if (when === 'dates') show = Array.isArray(t.dates) && t.dates.includes(today);
      if (!show) continue;
      out.push({ id: t.id || null, text: t.text, when, eveningHint: when === 'evening' });
    }
    return out;
  }

  function activeFestivals(data, today) {
    return festivalList(data).filter(f => isYMD(f.start) && isYMD(f.end) && today >= f.start && today <= f.end)
      .map(f => festivalDayInfo(f, today)).filter(Boolean)
      .sort((a, b) => a.fest.start.localeCompare(b.fest.start) || a.fest.id.localeCompare(b.fest.id));
  }

  function upcomingFestivals(data, today, withinDays) {
    const lim = withinDays == null ? UPCOMING_FESTIVAL_DAYS : withinDays;
    const until = addDays(today, lim);
    return festivalList(data).filter(f => isYMD(f.start) && f.start > today && f.start <= until)
      .sort((a, b) => a.start.localeCompare(b.start))
      .map(f => ({ fest: f, daysUntil: daysBetween(today, f.start), totalDays: daysBetween(f.start, f.end) + 1 }));
  }

  // ---- Today (dashboard) ----
  function todayItems(data, overrides, nowMs) {
    const today = istDate(nowMs), nowMin = istMinutes(nowMs);
    const s = settingsOf(data);
    const out = [];
    for (const m of moneyItems(data, overrides, today)) {
      if (m.status === 'paid' || m.daysLeft == null) continue;
      if (m.daysLeft <= 0) out.push({ sev: 'urgent', section: 'money', text: `${m.label}: ${m.daysLeft === 0 ? 'due today' : 'overdue by ' + (-m.daysLeft) + ' day' + (m.daysLeft === -1 ? '' : 's')}` });
      else if (m.daysLeft <= s.cardAlertDays) out.push({ sev: 'urgent', section: 'money', text: `${m.label}: due ${relDays(m.daysLeft)} (${fmtDate(m.dueDate)})` });
    }
    if (schoolDay(data, today)) {
      for (const r of ((data.school || {}).runs || [])) {
        const t = hhmmToMin(r.leaveAt);
        const delta = t - nowMin;
        const sev = Math.abs(delta) <= s.leaveWindowMinutes ? 'urgent' : (delta > 0 && delta <= 60 ? 'warn' : (delta < -s.leaveWindowMinutes ? 'past' : 'info'));
        out.push({ sev, section: 'family', text: `${r.label}: leave at ${fmtTime(r.leaveAt)}` + (r.eventAt ? ` (${fmtTime(r.eventAt)})` : '') });
      }
    }
    const pending = chargingDevices(data, overrides, today).filter(d => !d.chargedToday);
    if (pending.length) {
      const due = pending.filter(d => nowMin >= hhmmToMin(d.reminderTime));
      if (due.length) out.push({ sev: 'urgent', section: 'charging', text: 'Charge now: ' + due.map(d => d.name).join(', ') });
      const later = pending.filter(d => nowMin < hhmmToMin(d.reminderTime));
      if (later.length) out.push({ sev: 'info', section: 'charging', text: `Charge tonight (${fmtTime(later[0].reminderTime)}): ` + later.map(d => d.name).join(', ') });
    }
    const tasks = maintenanceTasks(data, overrides, today).filter(t => !t.unknown && t.daysLeft <= 0 && !t.doneLocally);
    for (const t of tasks) out.push({ sev: t.overdue ? 'urgent' : 'warn', section: 'home', text: `${t.appliance}: ${t.name} ${t.overdue ? '(overdue ' + (-t.daysLeft) + 'd)' : '(due today)'}` });
    const wk = maintenanceWeekend(data, overrides, today);
    if (wk.isToday && wk.tasks.length) out.push({ sev: 'urgent', section: 'home', text: `🧰 Maintenance weekend today: ${wk.tasks.length} task${wk.tasks.length === 1 ? '' : 's'}` });
    for (const it of supplyItems(data, overrides, today).filter(i => i.flagged)) {
      out.push({ sev: it.status === 'out' ? 'urgent' : 'warn', section: 'supplies', text: `${it.name}: ${it.status === 'out' ? 'out' : it.status === 'low' ? 'low' : 'running low soon'}` });
    }
    for (const info of activeFestivals(data, today)) {
      const trivia = festivalTriviaToday(info.fest, today);
      const tip = trivia.length ? ' · ' + trivia[0].text : '';
      out.push({ sev: 'info', section: 'festivals', text: `${info.fest.emoji || '🎉'} ${info.fest.name}: ${info.label}${tip}` });
    }
    const rank = { urgent: 0, warn: 1, info: 2, past: 3 };
    return out.sort((a, b) => rank[a.sev] - rank[b.sev]);
  }

  // ---- Push alerts due now (sender side; no local overrides available). Generic text only. ----
  function dueAlerts(data, nowMs) {
    const today = istDate(nowMs), nowMin = istMinutes(nowMs);
    const s = settingsOf(data);
    const alerts = [];
    if (schoolDay(data, today)) {
      for (const r of ((data.school || {}).runs || [])) {
        const t = hhmmToMin(r.leaveAt);
        if (t != null && Math.abs(nowMin - t) <= s.leaveWindowMinutes) {
          alerts.push({ key: 'school:' + r.id, group: 'school', type: 'urgent', title: `Leave now for ${r.label.toLowerCase()}`, body: `Leave by ${fmtTime(r.leaveAt)}` + (r.eventAt ? ` for ${fmtTime(r.eventAt)}` : '') + '.' });
        }
      }
    }
    for (const d of chargingDevices(data, {}, today)) {
      const t = hhmmToMin(d.reminderTime);
      if (t != null && nowMin >= t) alerts.push({ key: 'charge:' + d.id, group: 'charging', type: 'info', item: d.name });
    }
    if (nowMin >= hhmmToMin(s.dailyAlertTime)) {
      for (const m of moneyItems(data, {}, today)) {
        if (m.status === 'paid' || m.daysLeft == null || m.daysLeft > s.cardAlertDays) continue;
        const what = (m.pushLabel || (m.kind === 'card' ? 'Card' : 'Bill')) + (m.kind === 'card' ? ' bill' : '');
        const when = m.daysLeft > 1 ? `due in ${m.daysLeft} days` : m.daysLeft === 1 ? 'due tomorrow' : m.daysLeft === 0 ? 'due today' : `overdue by ${-m.daysLeft} day${m.daysLeft === -1 ? '' : 's'}`;
        alerts.push({ key: m.kind + ':' + m.id, group: 'money', type: 'urgent', title: `${what} ${when}`, body: 'Open Life HQ for details.' });
      }
      for (const it of supplyItems(data, {}, today).filter(i => i.flagged)) {
        alerts.push({ key: 'supply:' + it.id, group: 'supplies', type: 'info', item: `${it.name}${it.status === 'out' ? ' (out)' : it.status === 'low' ? ' (low)' : ''}` });
      }
    }
    if (isMaintenanceSaturday(data, today) && nowMin >= hhmmToMin(s.mw.alertTime) && nowMin < 12 * 60) {
      const wk = maintenanceWeekend(data, {}, today);
      if (wk.tasks.length) alerts.push({ key: 'maint-weekend:' + wk.date, group: 'maintenance', type: 'summary', title: 'Maintenance weekend',
        body: `${wk.tasks.length} home task${wk.tasks.length === 1 ? '' : 's'} due in the next ${s.mw.lookaheadDays} days.`,
        items: wk.tasks.map(t => `${t.appliance}: ${t.name}`) });
    }
    return { today, nowMin, alerts };
  }

  // Refuses text that looks like money amounts or account / card numbers.
  function sensitiveReason(text) {
    const t = String(text || '');
    if (/(₹|\bRs\.?|\bINR)\s*\d/i.test(t)) return 'money amount';
    if (/\d[\d,.\s-]{2,}\d/.test(t.replace(/\b\d{1,2}:\d{2}\b/g, ''))) return 'long number (amount or account number?)';
    if (/\b(ending|xx+|\*{2,})\s*\d{2,}/i.test(t)) return 'account number';
    return null;
  }

  g.LifeLogic = { istDate, istMinutes, istWeekday, addDays, daysBetween, weekdayOf, hhmmToMin, fmtTime, fmtDate, relDays, isYMD,
    settingsOf, nextMaintenanceSaturday, isMaintenanceSaturday, maintenanceTasks, maintenanceWeekend, moneyItems, schoolDay,
    chargingDevices, supplyItems, festivalDayInfo, festivalTriviaToday, activeFestivals, upcomingFestivals,
    todayItems, dueAlerts, sensitiveReason };
  if (typeof module === 'object' && module.exports) module.exports = g.LifeLogic;
})(typeof self !== 'undefined' ? self : globalThis);
