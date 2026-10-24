/* Health page (v21) for Life HQ.
 * Rendering only. All content comes from data.health.plan (encrypted); this file is public,
 * so it must never contain plan text, notes or anything personal.
 *
 * app.js calls LifeHealth.render(root, ctx) with:
 *   data, today, date, overrides, log, items, editable,
 *   tick(item, checked), saveDay(patch), setDate(iso), onBack(), toast(text)
 */
(function () {
  'use strict';

  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };
  const clear = n => { while (n.firstChild) n.removeChild(n.firstChild); return n; };
  const draft = {}; // unsaved form values per date, so a re-render never eats what you typed
  const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);

  // The one place that turns form values into a health.day patch. Exported so a Node test can
  // feed the exact same output to the merge validator (tools/test-contract.js in the private repo).
  // Empty input clears a field only when it had a value before; otherwise it is left alone.
  function buildDayPatch(values, initial) {
    const v = values || {};
    const base = initial || {};
    const patch = {};
    const num = (raw, key, dec) => {
      const s = String(raw == null ? '' : raw).trim();
      if (s === '') {
        if (base[key] != null) patch[key] = null;
        return;
      }
      const n = Number(s);
      if (!Number.isFinite(n)) return;
      patch[key] = dec ? Math.round(n * 10) / 10 : Math.round(n);
    };
    num(v.pain, 'pain', false);
    num(v.mood, 'mood', false);
    num(v.weight, 'weight', true);
    num(v.waist, 'waist', true);
    num(v.bpSys, 'bpSys', false);
    num(v.bpDia, 'bpDia', false);
    const note = String(v.note == null ? '' : v.note).trim();
    if (note) patch.note = note;
    else if (base.note) patch.note = null;
    return patch;
  }

  const DAYNAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function dateLabel(iso, today) {
    const [y, m, d] = iso.split('-').map(Number);
    const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
    const nice = `${DAYNAMES[wd]} ${d} ${MONTHS[m - 1]}`;
    if (iso === today) return `Today · ${nice}`;
    return `Yesterday · ${nice}`;
  }

  // ---------- small pieces ----------
  function card(title, opts) {
    const c = el('section', 'hcard');
    const head = el('div', 'hcard-head');
    head.appendChild(el('h2', null, title));
    if (opts && opts.tag) head.appendChild(el('span', 'htag', opts.tag));
    c.appendChild(head);
    if (opts && opts.lead) c.appendChild(el('p', 'hlead', opts.lead));
    return c;
  }

  function bar(value, max) {
    const wrap = el('div', 'hbar');
    const fill = el('i');
    fill.style.width = `${Math.max(0, Math.min(100, pct(value, max)))}%`;
    wrap.appendChild(fill);
    return wrap;
  }

  function tickRow(item, ctx) {
    const row = el('li', 'hrow' + (item.done ? ' done' : ''));
    const cb = el('input', 'hcb');
    cb.type = 'checkbox';
    cb.checked = !!item.done;
    cb.id = 'h-' + item.id;
    cb.setAttribute('aria-label', (item.done ? 'Reopen: ' : 'Mark done: ') + item.title);
    cb.addEventListener('change', () => ctx.tick(item, cb.checked));
    const lab = el('label', 'hrow-main');
    lab.htmlFor = cb.id;
    const line = el('span', 'hrow-title');
    if (item.time) line.appendChild(el('span', 'htime', item.time));
    line.appendChild(el('span', null, item.title));
    lab.appendChild(line);
    if (item.detail) lab.appendChild(el('small', 'hdetail', item.detail));
    row.appendChild(cb);
    row.appendChild(lab);
    return row;
  }

  function moveDetails(def) {
    const d = el('details', 'hmove');
    const s = el('summary');
    s.appendChild(el('span', 'hmove-name', def.name));
    s.appendChild(el('span', 'hmove-dose', def.dose || ''));
    d.appendChild(s);
    const body = el('div', 'hmove-body');
    if (Array.isArray(def.how)) {
      body.appendChild(el('p', 'hmove-h', 'How'));
      const ol = el('ol', 'hlist');
      for (const h of def.how) ol.appendChild(el('li', null, h));
      body.appendChild(ol);
    }
    if (def.feel) {
      body.appendChild(el('p', 'hmove-h', 'You should feel'));
      body.appendChild(el('p', null, def.feel));
    }
    if (Array.isArray(def.wrong) && def.wrong.length) {
      body.appendChild(el('p', 'hmove-h', 'Wrong if'));
      const ul = el('ul', 'hlist warn');
      for (const w of def.wrong) ul.appendChild(el('li', null, w));
      body.appendChild(ul);
    }
    d.appendChild(body);
    return d;
  }

  // ---------- the page ----------
  function render(root, ctx) {
    clear(root);
    const p = (ctx.data && ctx.data.health && ctx.data.health.plan) || null;
    if (!p) {
      root.appendChild(el('p', 'empty', 'No health plan in the data yet.'));
      return;
    }
    const prog = ctx.progress;
    const items = ctx.items || [];
    const doneN = items.filter(i => i.done).length;
    const log = ctx.log || {};
    const ui = p.ui || {};
    const painLabel = ui.painLabel || 'Pain';
    const painRange = ui.painRange || '';
    const painTitle = painRange ? `${painLabel} ${painRange}` : painLabel;
    const floorToggle = ui.floorToggle || 'Floor';
    const strengthToggle = ui.strengthToggle || 'Strength';
    const resetLabel = ui.resetLabel || 'Reset';
    const floorKeywords = (Array.isArray(ui.floorKeywords) ? ui.floorKeywords : [])
      .filter(k => typeof k === 'string' && k.trim());
    const isFloorItem = title => {
      const s = String(title || '').toLowerCase();
      return floorKeywords.some(k => s.includes(k.toLowerCase()));
    };

    // top bar: back + date stepper
    const top = el('div', 'htop');
    const back = el('button', 'btn ghost small', '← Dashboard');
    back.type = 'button';
    back.addEventListener('click', () => ctx.onBack());
    top.appendChild(back);

    const nav = el('div', 'hdate');
    const prev = el('button', 'btn ghost small', '◀');
    prev.type = 'button';
    prev.setAttribute('aria-label', 'Previous day');
    prev.disabled = !ctx.canPrev;
    prev.addEventListener('click', () => ctx.setDate(ctx.prevDate));
    const label = el('span', 'hdate-text', dateLabel(ctx.date, ctx.today));
    const next = el('button', 'btn ghost small', '▶');
    next.type = 'button';
    next.setAttribute('aria-label', 'Next day');
    next.disabled = ctx.date === ctx.today;
    next.addEventListener('click', () => ctx.setDate(ctx.nextDate));
    nav.append(prev, label, next);
    top.appendChild(nav);
    root.appendChild(top);

    // header card
    const head = el('section', 'hhead');
    if (prog) {
      head.appendChild(el('p', 'hkicker', `Phase ${prog.phase.id ? prog.phase.id.slice(1) : ''} · ${prog.phase.name}`));
      head.appendChild(el('h2', 'htitle', prog.phase.summary || prog.phase.name));
      const meta = el('p', 'hmeta');
      meta.textContent = prog.total ? `Day ${prog.day} of ${prog.total} · ${prog.phase.goal || ''}` : (prog.phase.goal || '');
      head.appendChild(meta);
      head.appendChild(bar(prog.day, prog.total || prog.day));
    } else {
      head.appendChild(el('h2', 'htitle', p.title || 'Health'));
      head.appendChild(el('p', 'hmeta', 'No phase covers this date.'));
    }
    root.appendChild(head);

    // stat tiles
    const tiles = el('div', 'htiles');
    const tile = (k, v, s) => {
      const t = el('div', 'htile');
      t.appendChild(el('div', 'hk', k));
      t.appendChild(el('div', 'hv', v));
      t.appendChild(el('div', 'hs', s));
      return t;
    };
    tiles.appendChild(tile('Today', `${doneN} / ${items.length}`, doneN === items.length && items.length ? 'all done' : 'ticked so far'));
    tiles.appendChild(tile('Day', prog ? `${prog.day}` : '—', prog && prog.total ? `of ${prog.total}` : ''));
    tiles.appendChild(tile(painLabel, log.pain != null ? `${log.pain}` : '—', log.pain != null ? 'out of 10' : 'not logged'));
    root.appendChild(tiles);

    // last 7 days: makes a missed day visible instead of letting it disappear
    if (ctx.strip && ctx.strip.length) {
      const c = card('Last 7 days', { tag: 'missed days show here' });
      const row = el('div', 'hstrip');
      for (const s of ctx.strip) {
        const canOpen = ctx.isEditable ? ctx.isEditable(s.date) : false;
        const cell = el('button', 'hcell ' + s.state + (s.date === ctx.today ? ' today' : '') + (canOpen ? '' : ' ro'));
        cell.type = 'button';
        cell.setAttribute('aria-label', `${s.date}: ${s.state}${s.total ? `, ${s.done} of ${s.total} done` : ''}`);
        cell.title = s.total ? `${s.done} of ${s.total} done` : s.state;
        cell.appendChild(el('span', 'hcell-dow', s.label));
        cell.appendChild(el('span', 'hcell-num', String(Number(s.date.slice(8)))));
        cell.appendChild(el('span', 'hcell-frac', s.total ? `${s.done}/${s.total}` : '·'));
        if (canOpen) cell.addEventListener('click', () => ctx.setDate(s.date));
        row.appendChild(cell);
      }
      c.appendChild(row);
      const logged = ctx.strip.filter(s => s.state !== 'future' && s.state !== 'empty');
      const floorDays = logged.filter(s => s.floor).length;
      const missed = logged.filter(s => s.state === 'missed').length;
      c.appendChild(el('p', 'hfoot', logged.length
        ? `Floor done on ${floorDays} of the last ${logged.length} days${missed ? ` · ${missed} missed` : ''}.`
        : 'No actions logged yet.'));
      root.appendChild(c);
    }

    // today's action
    const act = card('Today', { tag: ctx.date === ctx.today ? 'live' : 'yesterday' });
    if (items.length) {
      const ul = el('ul', 'hlist-rows');
      for (const it of items) ul.appendChild(tickRow(it, ctx));
      act.appendChild(ul);
      const matched = items.filter(i => isFloorItem(i.title));
      const floorDone = log.floor === true ? true
        : log.floor === false ? false
        : (matched.length > 0 && matched.every(i => i.done));
      const foot = el('p', 'hfoot');
      foot.textContent = floorDone
        ? (ui.floorDone || '')
        : (ui.floorOpen || '');
      act.appendChild(foot);
    } else {
      act.appendChild(el('p', 'empty', 'No actions dated for this day.'));
    }
    root.appendChild(act);

    // anything dismissed for this day: visible and restorable here, so nothing can vanish silently
    if (ctx.dismissed && ctx.dismissed.length) {
      const c = card('Dismissed', { tag: `${ctx.dismissed.length}` });
      c.appendChild(el('p', 'hlead', 'Hidden from today, but still part of the plan. Restore to bring it back.'));
      const ul = el('ul', 'hlist-rows');
      for (const t of ctx.dismissed) {
        const li = el('li', 'hrow');
        const main = el('div', 'hrow-main');
        const line = el('span', 'hrow-title');
        if (t.time) line.appendChild(el('span', 'htime', t.time));
        line.appendChild(el('span', null, t.title));
        main.appendChild(line);
        li.appendChild(main);
        const btn = el('button', 'btn ghost small', 'Restore');
        btn.type = 'button';
        btn.addEventListener('click', () => ctx.restore(t.id));
        li.appendChild(btn);
        ul.appendChild(li);
      }
      c.appendChild(ul);
      root.appendChild(c);
    }

    // quick log
    if (ctx.editable) {
      const lg = card('Log this day', { tag: 'syncs' });
      lg.appendChild(el('p', 'hlead', 'Only today and yesterday can be edited. Everything here syncs.'));
      const form = el('div', 'hform');
      const d = draft[ctx.date] || {};
      const pick = k => (k in d ? d[k] : (log[k] != null ? log[k] : ''));
      const bind = (node, key) => {
        node.addEventListener('input', () => {
          draft[ctx.date] = Object.assign({}, draft[ctx.date], { [key]: node.value });
        });
      };

      const field = (labelText, node, hint) => {
        const f = el('label', 'hfield');
        f.appendChild(el('span', 'hfield-label', labelText));
        f.appendChild(node);
        if (hint) f.appendChild(el('span', 'hfield-hint', hint));
        return f;
      };
      const num = (key, min, max, step) => {
        const i = el('input', 'hinput');
        i.type = 'number'; i.min = min; i.max = max; i.step = step || '1';
        i.inputMode = 'decimal';
        const v = pick(key);
        if (v !== '' && v != null) i.value = v;
        bind(i, key);
        return i;
      };

      const flags = el('div', 'hflags');
      const toggle = (key, label) => {
        const w = el('label', 'htoggle');
        const cb = el('input');
        cb.type = 'checkbox';
        cb.checked = log[key] === true;
        cb.addEventListener('change', () => ctx.saveDay({ [key]: cb.checked }));
        w.append(cb, el('span', null, label));
        return w;
      };
      flags.appendChild(toggle('floor', floorToggle));
      flags.appendChild(toggle('strength', strengthToggle));
      const flagsField = field('Done today', flags);
      flagsField.classList.add('hfield-wide');
      form.appendChild(flagsField);

      const pain = num('pain', 0, 10, 1);
      const mood = num('mood', 1, 5, 1);
      const weight = num('weight', 30, 250, 0.1);
      const waist = num('waist', 40, 200, 0.1);
      const sys = num('bpSys', 70, 250, 1);
      const dia = num('bpDia', 40, 150, 1);
      const note = el('textarea', 'htext');
      note.rows = 3;
      note.maxLength = 500;
      note.placeholder = 'How did the day go? Anything worth remembering.';
      const draftNote = pick('note');
      if (draftNote) note.value = draftNote;
      bind(note, 'note');

      form.appendChild(field(painTitle, pain));
      form.appendChild(field('Mood (1–5)', mood));
      form.appendChild(field('Weight (kg)', weight));
      form.appendChild(field('Waist (cm)', waist));
      form.appendChild(field('Blood pressure', (() => {
        const row = el('div', 'hbp');
        row.append(sys, el('span', 'hbpslash', '/'), dia);
        return row;
      })(), 'Two readings, seated 5 minutes'));
      const noteField = field('Note', note);
      noteField.classList.add('hfield-wide');
      form.appendChild(noteField);

      const save = el('button', 'btn primary', 'Save this day');
      save.type = 'button';
      save.addEventListener('click', () => {
        const patch = buildDayPatch({
          pain: pain.value, mood: mood.value, weight: weight.value, waist: waist.value,
          bpSys: sys.value, bpDia: dia.value, note: note.value
        }, ctx.log || {});
        if (!Object.keys(patch).length) { ctx.toast('Nothing to save'); return; }
        ctx.saveDay(patch);
        delete draft[ctx.date];
        save.textContent = 'Saved · syncing';
        save.disabled = true;
        setTimeout(() => { save.textContent = 'Save this day'; save.disabled = false; }, 2500);
      });
      const actions = el('div', 'hform-actions');
      actions.appendChild(save);
      if (ctx.queued) actions.appendChild(el('span', 'hqueued', 'Queued to sync'));
      form.appendChild(actions);
      lg.appendChild(form);
      root.appendChild(lg);
    } else {
      const ro = card('Log', { tag: 'read only' });
      const rows = [
        [painLabel, log.pain != null ? `${log.pain} / 10` : '—'],
        ['Mood', log.mood != null ? `${log.mood} / 5` : '—'],
        ['Weight', log.weight != null ? `${log.weight} kg` : '—'],
        ['Waist', log.waist != null ? `${log.waist} cm` : '—'],
        ['Blood pressure', log.bpSys && log.bpDia ? `${log.bpSys}/${log.bpDia}` : '—'],
        ['Note', log.note || '—']
      ];
      const dl = el('dl', 'hlog');
      for (const [k, v] of rows) { dl.appendChild(el('dt', null, k)); dl.appendChild(el('dd', null, v)); }
      ro.appendChild(dl);
      root.appendChild(ro);
    }

    // neck work: grouped in the plan data, never by hardcoded id
    const resetMoves = (p.library || []).filter(x => x.group === 'neck');
    if (resetMoves.length) {
      const c = card(resetLabel, { tag: '7 min · daily', lead: ui.resetLead || '' });
      for (const m of resetMoves) c.appendChild(moveDetails(m));
      root.appendChild(c);
    }

    // loading work
    const str = (p.library || []).filter(x => !resetMoves.includes(x));
    if (str.length) {
      const c = card('Loading moves', { tag: '2 to 3 a week', lead: ui.loadingLead || '' });
      for (const m of str) c.appendChild(moveDetails(m));
      root.appendChild(c);
    }

    // weekly template
    const tpl = (p.weekTemplates || []).find(t => prog && t.phaseId === prog.phase.id) || (p.weekTemplates || [])[0];
    if (tpl) {
      const c = card('A normal week');
      const table = el('table', 'htable');
      const thead = el('thead');
      const hr = el('tr');
      hr.appendChild(el('th'));
      for (const d of ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']) hr.appendChild(el('th', null, d));
      thead.appendChild(hr);
      table.appendChild(thead);
      const tb = el('tbody');
      for (const row of tpl.rows || []) {
        const tr = el('tr');
        tr.appendChild(el('td', null, row[0]));
        for (let i = 1; i < 8; i++) {
          const v = row[i] || '';
          tr.appendChild(el('td', v === '✓' ? 'y' : v === '—' ? 'n' : null, v));
        }
        tb.appendChild(tr);
      }
      table.appendChild(tb);
      c.appendChild(table);
      if (tpl.note) c.appendChild(el('p', 'hfoot', tpl.note));
      root.appendChild(c);
    }

    // plan cards from data (carrying, pain relief)
    for (const cdef of (p.cards || [])) {
      const c = card(cdef.title, { lead: cdef.lead });
      const ol = el('ol', 'hlist');
      for (const line of cdef.items || []) ol.appendChild(el('li', null, line));
      c.appendChild(ol);
      root.appendChild(c);
    }

    // rules
    if ((p.rules || []).length) {
      const c = card('The rules that make it survive');
      const ol = el('ol', 'hlist');
      for (const r of p.rules) ol.appendChild(el('li', null, r));
      c.appendChild(ol);
      root.appendChild(c);
    }

    // roadmap
    if ((p.phases || []).length) {
      const c = card('Roadmap');
      const wrap = el('div', 'hphases');
      for (const ph of p.phases) {
        const d = el('div', 'hphase' + (prog && ph.id === prog.phase.id ? ' on' : ''));
        d.appendChild(el('b', null, `${ph.name}`));
        d.appendChild(el('span', null, ph.start + (ph.end ? ` → ${ph.end}` : ' →')));
        wrap.appendChild(d);
      }
      c.appendChild(wrap);
      c.appendChild(el('p', 'hfoot', ui.roadmapNote || ''));
      root.appendChild(c);
    }

    // red flags
    if (p.redFlags) {
      const c = card('Red flags');
      const urgent = el('div', 'hcallout danger');
      urgent.appendChild(el('b', null, 'Urgent: '));
      urgent.appendChild(document.createTextNode((p.redFlags.urgent || []).join(' ')));
      c.appendChild(urgent);
      const appt = el('div', 'hcallout');
      appt.appendChild(el('b', null, 'Book an appointment: '));
      appt.appendChild(document.createTextNode((p.redFlags.appointment || []).join(' ')));
      c.appendChild(appt);
      root.appendChild(c);
    }
  }

  const G = typeof window !== 'undefined' ? window : globalThis;
  G.LifeHealth = { render, buildDayPatch };
  if (typeof module === 'object' && module.exports) module.exports = { buildDayPatch };
})();
