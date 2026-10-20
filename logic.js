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
      todoPrimaryList: typeof s.todoPrimaryList === 'string' && s.todoPrimaryList ? s.todoPrimaryList : 'Tasks', // v16: the Google list in Today / push
      todoUpcomingDays: s.todoUpcomingDays ?? 5,
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
        const doneLocally = !!(o && o.lastDone === today);
        // status: done (tapped today, or done since the previous maintenance weekend and not due again by the coming one),
        // never (no lastDone), overdue, due (by the coming maintenance weekend), upcoming (later).
        const status = doneLocally ? 'done' : !lastDone ? 'never' : daysLeft < 0 ? 'overdue' : nextDue <= weekend ? 'due'
          : lastDone >= addDays(weekend, -settingsOf(data).mw.everyDays) ? 'done' : 'upcoming';
        out.push({ appliance: ap.name, applianceId: ap.id, id: t.id, name: t.name, everyDays: t.everyDays,
          lastDone, unknown: !lastDone, nextDue, daysLeft, overdue: daysLeft < 0, dueToday: daysLeft === 0,
          doneLocally, status });
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

  // Maintenance overview for the Home section: summary counts + one entry per appliance (worst status first in pill).
  const MAINT_STATUS_ORDER = ['overdue', 'due', 'never', 'upcoming', 'done'];
  const APPLIANCE_ICONS = [
    [/air ?purifier/i, '🌬️'], [/dish ?washer/i, '🍽️'], [/fridge|refrigerator/i, '🧊'], [/chim|\bhob\b|stove/i, '🔥'],
    [/vacuum|mop/i, '🧹'], [/\bac\b|air ?condition/i, '❄️'], [/washing|washer|dryer/i, '🧺'], [/water ?purifier|\bro\b|filter jug/i, '💧'],
    [/geyser|water heater/i, '🚿'], [/microwave|oven|otg/i, '♨️'], [/\btv\b|television/i, '📺'], [/fan\b/i, '🌀'],
    [/inverter|ups|battery/i, '🔋'], [/car\b|bike|scooter|vehicle/i, '🚗'], [/plant|garden/i, '🪴'], [/smoke|alarm|detector/i, '🚨']
  ];
  function applianceIcon(ap) {
    if (ap && typeof ap.icon === 'string' && ap.icon.trim()) return ap.icon.trim();
    const s = `${(ap && ap.name) || ''} ${(ap && ap.id) || ''}`.replace(/-/g, ' ');
    for (const [re, icon] of APPLIANCE_ICONS) if (re.test(s)) return icon;
    return '🔧';
  }
  function maintenanceOverview(data, overrides, today) {
    const date = nextMaintenanceSaturday(data, today);
    const tasks = maintenanceTasks(data, overrides, today);
    const count = list => { const c = { overdue: 0, due: 0, never: 0, upcoming: 0, done: 0 }; list.forEach(t => { c[t.status]++; }); return c; };
    const rank = t => MAINT_STATUS_ORDER.indexOf(t.status);
    const appliances = ((data.maintenance || {}).appliances || []).map(ap => {
      const list = tasks.filter(t => t.applianceId === ap.id).sort((a, b) => rank(a) - rank(b) || a.nextDue.localeCompare(b.nextDue));
      const counts = count(list);
      return { id: ap.id, name: ap.name, icon: applianceIcon(ap), tasks: list, counts,
        status: list.length ? MAINT_STATUS_ORDER.find(s => counts[s] > 0) : 'done' };
    });
    const counts = count(tasks);
    return { date, isToday: date === today, daysUntil: daysBetween(today, date), total: tasks.length, counts,
      dueCount: counts.overdue + counts.due + counts.never, appliances };
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
  // school.holidays: 'YYYY-MM-DD' strings, or { date: 'YYYY-MM-DD', name: 'Founders Day' } objects (name optional).
  function holidayEntry(data, ymd) {
    for (const h of (((data || {}).school || {}).holidays || [])) {
      if (h === ymd) return { date: ymd, name: null };
      if (h && typeof h === 'object' && h.date === ymd) return { date: ymd, name: h.name ? String(h.name) : null };
    }
    return null;
  }
  const holidayDates = data => ((((data || {}).school || {}).holidays) || []).map(h => typeof h === 'string' ? h : (h && h.date)).filter(isYMD);
  const schoolDays = data => (((data || {}).school || {}).days) || [1, 2, 3, 4, 5];
  function schoolDay(data, today) {
    return schoolDays(data).includes(weekdayOf(today)) && !holidayEntry(data, today);
  }
  // Why there is no school on `today` (null on a school day): { kind: 'holiday' | 'weekend' | 'off', name }.
  // A holiday without a name borrows the festival day label for that date.
  function noSchoolReason(data, today) {
    if (schoolDay(data, today)) return null;
    const h = holidayEntry(data, today);
    if (h) {
      let name = h.name;
      if (!name) {
        for (const f of festivalList(data)) {
          const named = (f.days || []).find(d => d && d.date === today && d.label);
          if (named) { name = named.label; break; }
        }
      }
      return { kind: 'holiday', name: name || 'Holiday' };
    }
    const wd = weekdayOf(today);
    return wd === 0 || wd === 6 ? { kind: 'weekend', name: 'Weekend' } : { kind: 'off', name: 'No school day' };
  }
  function nextSchoolDay(data, today, maxDays) {
    for (let i = 1; i <= (maxDays || 60); i++) { const d = addDays(today, i); if (schoolDay(data, d)) return d; }
    return null;
  }

  // ---- Charging ----
  function chargingDevices(data, overrides, today) {
    const ch = data.charging || {};
    return (ch.devices || []).map(d => {
      // Charged today = a tap on this device today, or a synced lastCharged (merged from any device) of today (IST).
      const o = overrides && overrides['charge:' + d.id];
      const chargedLocally = !!(o && o.date === today);
      const chargedSynced = d.lastCharged === today;
      return Object.assign({}, d, { reminderTime: d.reminderTime || ch.defaultReminderTime || '21:30',
        chargedToday: chargedLocally || chargedSynced, chargedLocally, chargedSynced });
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

  // ---- Email notices (payment links, toll tag, returns, refunds …), filled by the morning routine from Gmail ----
  function noticeItems(data, overrides, today) {
    return ((((data || {}).notices) || {}).items || []).filter(n => n && n.id && n.title).map(n => {
      const o = freshOverride(data, overrides, 'notice:' + n.id);
      // v16: dismissed (by you: noticedis:<id> tap -> notice.dismiss, dismissedBy 'user'; or closed by the morning
      // routine, e.g. superseded) is shown under "Dismissed (n)" with Restore, counts as done and is never pushed.
      const od = freshOverride(data, overrides, 'noticedis:' + n.id);
      const dismissed = od && typeof od.dismissed === 'boolean' ? od.dismissed : n.status === 'dismissed';
      const status = dismissed ? 'done' : o && o.status ? o.status : (n.status === 'done' ? 'done' : 'open');
      const daysLeft = isYMD(n.dueDate) ? daysBetween(today, n.dueDate) : null;
      const sev = ['urgent', 'warn', 'info'].includes(n.sev) ? n.sev : 'info';
      return Object.assign({}, n, { status, sev, daysLeft, doneLocally: !!(o && o.status === 'done'), dismissed, dismissedLocally: !!od,
        overdue: status === 'open' && daysLeft != null && daysLeft < 0 });
    }).sort((a, b) => (a.status === 'done') - (b.status === 'done') || String(a.dueDate || '9999').localeCompare(String(b.dueDate || '9999')) || String(a.date || '').localeCompare(String(b.date || '')));
  }

  // ---- Calendar (today + next days; filled by the morning routine from Google Calendar) ----
  // All-day events that only repeat an active festival day (e.g. a public-holiday calendar entry) are dropped.
  function calendarEvents(data, today, days) {
    const until = addDays(today, (days || 3) - 1);
    const festLabels = d => activeFestivals(data, d).map(i => `${i.fest.name} ${i.label}`.toLowerCase());
    return ((((data || {}).calendar) || {}).events || []).filter(e => e && e.title && isYMD(e.date) && e.date >= today && e.date <= until)
      .filter(e => !(e.allDay && festLabels(e.date).some(l => l.includes(String(e.title).toLowerCase()))))
      .map(e => Object.assign({}, e, { allDay: !!e.allDay || hhmmToMin(e.start) == null, dayOffset: daysBetween(today, e.date) }))
      .sort((a, b) => a.date.localeCompare(b.date) || (a.allDay === b.allDay ? 0 : a.allDay ? -1 : 1) || String(a.start || '').localeCompare(String(b.start || '')));
  }

  // ---- To-dos (v15): Google Tasks (source 'google-tasks', READ-ONLY, filled by tools/gtasks.js) + Life HQ's own
  // to-dos from email (source 'email', tickable: todo:<id> taps sync as todo.done / todo.undone, data only) ----
  const TODO_ID_RE = /^todo-[a-z0-9][a-z0-9-]{2,80}$/;
  const EMAIL_DONE_DAYS = 14;   // done email to-dos stay visible (folded) this long after doneOn
  const todoTickable = t => !!t && t.source === 'email' && TODO_ID_RE.test(String(t.id || ''));
  // Applies this device's pending ticks (email to-dos only) and adds daysLeft / overdue / tickable / doneLocally.
  function todoAll(data, overrides, today) {
    return ((((data || {}).todos) || {}).items || []).filter(t => t && t.id && t.title).map(t => {
      const tick = todoTickable(t), v = tick ? (overrides || {})['todo:' + t.id] : null, vd = tick ? (overrides || {})['tododis:' + t.id] : null;
      const done = v && typeof v.done === 'boolean' ? v.done : !!t.done;
      const dismissed = vd && typeof vd.dismissed === 'boolean' ? vd.dismissed : tick && !!t.dismissed;   // v16: email to-dos only
      const daysLeft = isYMD(t.due) ? daysBetween(today, t.due) : null;
      return Object.assign({}, t, { done, dismissed, tickable: tick, doneLocally: !!v && v.done !== !!t.done, dismissedLocally: !!vd && vd.dismissed !== !!t.dismissed,
        daysLeft, overdue: !done && !dismissed && daysLeft != null && daysLeft < 0 });
    });
  }
  const byDue = (a, b) => String(a.due || '9999').localeCompare(String(b.due || '9999'));
  // Open items (all sources), due first. Accepts (data, today) too (v13 signature).
  function todoItems(data, overrides, today) {
    if (typeof overrides === 'string') { today = overrides; overrides = {}; }
    return todoAll(data, overrides, today).filter(t => !t.done && !t.dismissed).sort((a, b) => byDue(a, b) || String(a.title).localeCompare(String(b.title)));
  }
  // Dashboard view: today = open items due today or overdue; groups = Life HQ (email) first, then each Google list in
  // Google's order. In a group: open due-dated first (by date), then the rest in source order (Google position,
  // subtasks after their parent); done = recently completed (Google: last ~2 days; email: doneOn within 14 days).
  function todoView(data, overrides, today) {
    const todos = (data || {}).todos || {};
    const all = todoAll(data, overrides, today);
    const primary = settingsOf(data).todoPrimaryList.toLowerCase();
    const isPrimary = t => t.source === 'google-tasks' && String(t.list || '').toLowerCase() === primary;
    const idx = new Map(all.map((t, i) => [t.id, i]));
    const groups = [];
    const email = all.filter(t => t.source === 'email');
    const recentDone = t => !t.doneOn || !isYMD(t.doneOn) || daysBetween(t.doneOn, today) <= EMAIL_DONE_DAYS;
    const order = (a, b) => (a.due ? 0 : 1) - (b.due ? 0 : 1) || byDue(a, b) || idx.get(a.id) - idx.get(b.id);
    if (email.length) groups.push({ key: 'email', title: 'Bills & dues', source: 'email', tickable: true,
      open: email.filter(t => !t.done && !t.dismissed).sort(order),
      done: email.filter(t => t.done && !t.dismissed && recentDone(t)).sort((a, b) => String(b.doneOn || '').localeCompare(String(a.doneOn || ''))),
      dismissed: email.filter(t => t.dismissed) });
    const g = all.filter(t => t.source === 'google-tasks');
    const lists = Array.isArray(todos.lists) && todos.lists.length ? todos.lists.filter(l => l && l.id)
      : [...new Set(g.map(t => t.listId))].map(id => ({ id, title: (g.find(t => t.listId === id) || {}).list }));
    for (const l of lists) {
      const its = g.filter(t => t.listId === l.id);
      // Subtasks follow their parent; a due-dated parent pulls its subtasks up with it.
      const top = its.filter(t => !t.parent || !its.some(p => p.id === t.parent));
      const kids = p => its.filter(t => t.parent === p.id);
      const openTop = top.filter(t => !t.done).sort(order);
      const open = openTop.flatMap(p => [p, ...kids(p).filter(k => !k.done).map(k => Object.assign({}, k, { sub: true }))]);
      for (const t of its) if (!t.done && !open.some(o => o.id === t.id)) open.push(Object.assign({}, t, { sub: true })); // open child of a done parent
      groups.push({ key: 'gt:' + l.id, title: l.title || 'Tasks', source: 'google-tasks', tickable: false, open, done: its.filter(t => t.done), dismissed: [],
        primary: String(l.title || '').toLowerCase() === primary });
    }
    // Today (v16): open email to-dos + the primary Google list ('Tasks') only; due today / overdue, plus the next N days.
    const inToday = t => !t.done && !t.dismissed && t.daysLeft != null && (t.source === 'email' || isPrimary(t));
    const sortDue = (a, b) => byDue(a, b) || String(a.title).localeCompare(String(b.title));
    const todayList = all.filter(t => inToday(t) && t.daysLeft <= 0).sort(sortDue);
    const upcoming = all.filter(t => inToday(t) && t.daysLeft > 0 && t.daysLeft <= settingsOf(data).todoUpcomingDays).sort(sortDue);
    return { today: todayList, upcoming, groups, openCount: all.filter(t => !t.done && !t.dismissed).length,
      authExpired: !!todos.authExpired, authExpiredAt: todos.authExpiredAt || null, fetchedAt: todos.fetchedAt || null };
  }

  // ---- Notes to self (synced through the inbox as note.add / note.delete) ----
  const NOTE_MAX = 500;
  const NOTE_ID_RE = /^n-[a-z0-9]{6,40}$/;
  function cleanNoteText(t) {
    if (typeof t !== 'string') return null;
    const s = t.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, '').trim();
    return s && s.length <= NOTE_MAX ? s : null;
  }
  // Data notes + this device's pending adds, minus pending deletes. Newest first.
  function noteItems(data, overrides) {
    const out = new Map();
    for (const n of ((((data || {}).notes) || {}).items || [])) if (n && NOTE_ID_RE.test(n.id) && typeof n.text === 'string') out.set(n.id, Object.assign({}, n, { pending: false }));
    for (const [k, v] of Object.entries(overrides || {})) {
      if (!k.startsWith('note:') || !v) continue;
      const id = k.slice(5);
      const gone = ((((data || {}).notes) || {}).deleted || []).includes(id);
      if (v.op === 'add' && !out.has(id) && !gone) out.set(id, { id, text: v.text, createdAt: v.createdAt, pending: true });
      else if (v.op === 'edit' && !gone && typeof v.text === 'string') {
        const cur = out.get(id);
        // An edit of a note whose add is still on its way keeps createdAt so it stays visible until both land.
        if (cur) out.set(id, Object.assign({}, cur, { text: v.text, pending: cur.text !== v.text || cur.pending }));
        else if (v.createdAt) out.set(id, { id, text: v.text, createdAt: v.createdAt, pending: true });
      }
      else if (v.op === 'delete') out.delete(id);
    }
    return [...out.values()].sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
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

  // Drop a lead-in that only repeats the day label: label "Day A · Day B", text "Day B · Day A: people …"
  // -> "People …". Compares the '·' / '/' separated parts, case-insensitive, in any order.
  function dedupeLead(label, text) {
    const t = String(text || ''), m = /^([^:—–]{2,80})[:—–]\s*/.exec(t);
    if (!label || !m) return t;
    const parts = x => x.split(/[·/|,]/).map(p => p.trim().toLowerCase()).filter(Boolean);
    const lab = new Set(parts(String(label))), lead = parts(m[1]);
    if (!lead.length || !lead.every(p => lab.has(p))) return t;
    const rest = t.slice(m[0].length);
    return rest ? rest.charAt(0).toUpperCase() + rest.slice(1) : t;
  }

  function festivalTriviaToday(fest, today) {
    if (!fest || !isYMD(today)) return [];
    const info = festivalDayInfo(fest, today);
    if (!info) return [];
    const out = [];
    // Day-specific observables first (days[].observe), then festival trivia.
    const named = (fest.days || []).find(d => d && d.date === today);
    (named && Array.isArray(named.observe) ? named.observe : []).forEach((text, i) => {
      if (typeof text === 'string' && text.trim()) out.push({ id: `${fest.id || 'fest'}-${today}-obs${i}`, text: dedupeLead(named.label, text), when: 'day', eveningHint: false });
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
    const noSchool = noSchoolReason(data, today);
    if (noSchool && noSchool.kind === 'holiday' && schoolDays(data).includes(weekdayOf(today)) && ((data.school || {}).runs || []).length) {
      // The festival line below already names the day: don't repeat its label here.
      const isFestLabel = activeFestivals(data, today).some(i => i.label === noSchool.name);
      out.push({ sev: 'info', section: 'family', pin: true, text: isFestLabel ? '🥳 No school today (festival holiday)' : `🥳 No school today: ${noSchool.name}` });
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
    for (const n of noticeItems(data, overrides, today)) {
      if (n.status !== 'open' || n.sev === 'info' && !n.overdue) continue;
      if (n.daysLeft != null && n.daysLeft > 1) continue;
      const when = n.daysLeft == null ? '' : n.daysLeft < 0 ? ` · overdue by ${-n.daysLeft} day${n.daysLeft === -1 ? '' : 's'}` : n.daysLeft === 0 ? ' · today' : ' · tomorrow';
      const sev = n.overdue || n.daysLeft === 0 ? 'urgent' : 'warn';
      out.push({ sev, section: 'money', text: `${sev === 'urgent' ? '' : (n.icon || '📬') + ' '}${n.title}${when}` }); // urgent rows get 🚨 only
    }
    for (const info of activeFestivals(data, today)) {
      // All of today's lines go in `lines` (the app shows them collapsed under a one-line teaser).
      const lines = festivalTriviaToday(info.fest, today).map(t => dedupeLead(info.label, t.text)).filter(Boolean);
      out.push({ sev: 'info', section: 'festivals', text: `${info.fest.emoji || '🎉'} ${info.fest.name}: ${info.label}`, festId: info.fest.id || null, lines });
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
          const sp = schoolRunPush(data, r);
          alerts.push({ key: 'school:' + r.id, group: 'school', type: 'urgent', title: sp.title, body: sp.body });
        }
      }
    }
    for (const d of chargingDevices(data, {}, today).filter(x => !x.chargedToday)) {
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
    // Notices from email: one push on the day they fall due (dueDate, or date when there is no dueDate).
    if (nowMin >= hhmmToMin(s.dailyAlertTime)) {
      for (const n of noticeItems(data, {}, today)) {
        if (n.status !== 'open') continue; // done or dismissed
        const day = isYMD(n.dueDate) ? n.dueDate : (isYMD(n.date) ? n.date : null);
        if (day !== today) continue;
        alerts.push({ key: 'notice:' + n.id, group: 'notices', type: n.sev === 'urgent' ? 'urgent' : 'info', title: noticePushTitle(n), body: 'Open Life HQ for details.' });
      }
    }
    // v16: dated Google tasks of the primary list ('Tasks') push once on their due date (generic, sanitized text).
    if (nowMin >= hhmmToMin(s.dailyAlertTime)) {
      for (const t of todoView(data, {}, today).today) {
        if (t.source !== 'google-tasks' || t.daysLeft !== 0) continue;
        alerts.push({ key: 'todo:' + t.id, group: 'todos', type: 'info', title: '✅ To-do due today', body: pushSafeText(t.title) || 'Open Life HQ for details.' });
      }
    }
    return { today, nowMin, alerts };
  }

  // v16: lock-screen-safe short text from a free-text title: drops email addresses, amounts, card / account
  // numbers and every token with a digit; null when nothing safe is left. At most `max` (60) characters.
  function pushSafeText(text, max) {
    max = max || 60;
    let t = String(text || '')
      .replace(/\S+@\S+/g, ' ')
      .replace(/(₹|\bRs\.?|\bINR)\s*[\d,.]*/gi, ' ')
      .replace(/\b(ending( in)?|a\/c( no\.?)?|acct\.?|account (no\.?|number)|card (no\.?|number)|xx+|last ?4)\b/gi, ' ')
      .replace(/\S*\d\S*/g, ' ')
      .replace(/[*#@₹]+/g, ' ')
      .replace(/\s+/g, ' ').replace(/\(\s*\)|\[\s*\]/g, ' ').replace(/\s+/g, ' ')
      .replace(/^[\s·|,:;.\-–—/]+|[\s·|,:;\-–—/(]+$/g, '').trim();
    if (!t) return null;
    if (t.length > max) { t = t.slice(0, max - 1); const sp = t.lastIndexOf(' '); if (sp > max / 2) t = t.slice(0, sp); t = t.replace(/[\s·|,:;.\-–—/(]+$/, '') + '…'; }
    return sensitiveReason(t) || /[@\d]/.test(t) ? null : t;
  }

  // v16: school leave push text (shared by due-check and `notify.js school-run <id>`). The title comes from the run's
  // own label (data.school.runs[].label) and the school name from data.school.name: no personal text in this file.
  function schoolRunPush(data, run) {
    const school = ((data || {}).school || {}).name || 'school';
    const label = String((run || {}).label || '').trim().toLowerCase() || 'school';
    const what = String((run || {}).id || '') + ' ' + label;
    const leave = fmtTime(run.leaveAt), ev = run.eventAt ? fmtTime(run.eventAt) : null;
    const title = `🚨 Leave now for ${label}`;
    if (/pick/i.test(what)) return { kind: 'pick', idPrefix: 'school-pick', title, body: ev ? `Leave by ${leave} for the ${ev} pick-up` : `Leave by ${leave} for the pick-up` };
    if (/drop/i.test(what)) return { kind: 'drop', idPrefix: 'school-drop', title, body: `Leave by ${leave} to reach ${school} on time` };
    return { kind: 'other', idPrefix: 'school-' + String(run.id || 'run').replace(/[^a-z0-9-]/gi, '').slice(0, 30), title, body: `Leave by ${leave}` + (ev ? ` for ${ev}` : '') };
  }


  // Lock-screen-safe push title for a notice. notice.pushTitle (generic text set by the morning routine) wins if it
  // passes the sensitive-text check and has no email address; otherwise a generic line by kind.
  function noticePushTitle(n) {
    const own = typeof n.pushTitle === 'string' ? n.pushTitle.trim() : '';
    if (own && own.length <= 60 && !sensitiveReason(own) && !/@/.test(own)) return own;
    const k = String(n.kind || '') + ' ' + String(n.pill || '');
    if (/return|pick/i.test(k)) return '📦 Return pickup today';
    if (/refund/i.test(k)) return '💸 Refund due today';
    if (/pay|bill|card/i.test(k)) return '💳 Payment due today';
    if (/tag|toll|top/i.test(k)) return '🚗 Toll tag: top up today';
    if (/deliver|order|ship/i.test(k)) return '📦 Delivery today';
    return '📬 Reminder for today';
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
    settingsOf, nextMaintenanceSaturday, isMaintenanceSaturday, maintenanceTasks, maintenanceWeekend, maintenanceOverview, applianceIcon, moneyItems,
    noticeItems, calendarEvents, todoItems, todoView, todoTickable, TODO_ID_RE, noteItems, cleanNoteText, NOTE_MAX, NOTE_ID_RE, dedupeLead, schoolDay, holidayEntry, holidayDates, noSchoolReason, nextSchoolDay,
    chargingDevices, supplyItems, festivalDayInfo, festivalTriviaToday, activeFestivals, upcomingFestivals,
    todayItems, dueAlerts, noticePushTitle, sensitiveReason, pushSafeText, schoolRunPush };
  if (typeof module === 'object' && module.exports) module.exports = g.LifeLogic;
})(typeof self !== 'undefined' ? self : globalThis);
