#!/usr/bin/env node
'use strict';
/*
 Life HQ push sender.
   node tools/notify.js due-check [--dry-run] [--now 2026-01-03T08:45:00+05:30]
       Reads the private data file, works out what is due now (IST) and sends GENERIC pushes (no amounts,
       no account numbers). Dedupes per item per day via <secrets>/notify-state.json. LIFE_HQ_NOW also sets the clock.
       Run it every 5-10 minutes (school leave reminders fire within +/-7 minutes of the leave time).
   node tools/notify.js --type urgent|summary|info --title "..." [--body "..."] [--items '[..]' | --items-file f]
       [--url ...] [--id ...] [--dry-run] [--allow-sensitive]
       Direct send. Refuses text that looks like an amount or account number unless --allow-sensitive.
   node tools/notify.js add-sub '<subscription json>'      (same as tools/add-sub.js)
 Exit codes: 0 ok / nothing to send, 1 every send failed or error, 2 bad arguments.
*/
const fs = require('fs');
const L = require('../logic.js');
const { P, writeJson600, buildPayload, sendToAll, bytes } = require('./push-lib');

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const eq = a.indexOf('=');
    if (eq > 0) { out[a.slice(2, eq)] = a.slice(eq + 1); continue; }
    const key = a.slice(2), next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true; else { out[key] = next; i++; }
  }
  return out;
}
const die = (m, c = 2) => { console.error('ERROR: ' + m); process.exit(c); };
const istStamp = ms => new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' }).format(new Date(ms)) + ' IST';

function assertGeneric(p) {
  for (const t of [p.title, p.body, ...(p.items || [])]) {
    const r = L.sensitiveReason(t);
    if (r) return `"${t}" looks like it contains a ${r}`;
  }
  return null;
}

// ---------- due-check ----------
function loadState() { try { return JSON.parse(fs.readFileSync(P.STATE_FILE, 'utf8')); } catch (e) { return { sent: {} }; } }
function saveState(state, today) {
  const cutoff = L.addDays(today, -14);
  for (const k of Object.keys(state.sent)) if (k.slice(0, 10) < cutoff) delete state.sent[k];
  writeJson600(P.STATE_FILE, state);
}

function groupToPayloads(alerts, today) {
  const out = [];
  const charging = alerts.filter(a => a.group === 'charging');
  const supplies = alerts.filter(a => a.group === 'supplies');
  for (const a of alerts.filter(a => a.group !== 'charging' && a.group !== 'supplies')) {
    out.push({ keys: [a.key], p: { id: `due-${today}-${a.key}`, type: a.type, title: a.title, body: a.body, items: a.items } });
  }
  if (charging.length) out.push({ keys: charging.map(a => a.key), p: { id: `due-${today}-charging-${charging.map(a => a.key).join('+')}`, type: 'info',
    title: '🔌 Charging reminder', body: 'Time to charge: ' + charging.map(a => a.item).join(', ') + '.', items: charging.map(a => a.item) } });
  if (supplies.length) out.push({ keys: supplies.map(a => a.key), p: { id: `due-${today}-supplies-${supplies.map(a => a.key).join('+')}`, type: 'info',
    title: `🛒 Running low soon (${supplies.length})`, body: supplies.map(a => a.item).join(', ') + '. Nothing is ordered without asking you.', items: supplies.map(a => a.item) } });
  return out;
}

async function dueCheck(args) {
  const nowArg = args.now && args.now !== true ? args.now : process.env.LIFE_HQ_NOW;
  const nowMs = nowArg ? Date.parse(nowArg) : Date.now();
  if (!Number.isFinite(nowMs)) die('bad --now / LIFE_HQ_NOW (use ISO, e.g. 2026-01-03T08:45:00+05:30)');
  const dry = !!args['dry-run'];
  let data;
  try { data = JSON.parse(fs.readFileSync(P.DATA, 'utf8')); } catch (e) { die(`cannot read ${P.DATA}: ${e.message}`, 1); }
  const { today, alerts } = L.dueAlerts(data, nowMs);
  const state = loadState();
  state.sent = state.sent || {};
  console.log(`due-check at ${istStamp(nowMs)}${dry ? ' (DRY RUN)' : ''}: ${alerts.length} candidate item(s)`);
  const fresh = alerts.filter(a => {
    const k = `${today}|${a.key}`;
    if (state.sent[k]) { console.log(`SKIP    ${a.key} (already sent today at ${istStamp(Date.parse(state.sent[k]))})`); return false; }
    return true;
  });
  let anyFail = false, sentAny = false;
  for (const { keys, p } of groupToPayloads(fresh, today)) {
    const bad = assertGeneric(p);
    if (bad) { console.error(`REFUSED ${p.id}: ${bad}`); anyFail = true; continue; }
    const { payload, json } = buildPayload(Object.assign({ ts: nowMs }, p));
    if (dry) { console.log(`WOULD SEND [${payload.type}] ${payload.title} | ${payload.body}${payload.items ? ' | items: ' + payload.items.join('; ') : ''}  (${bytes(json)} bytes, id=${payload.id})`); continue; }
    const r = await sendToAll(payload, json);
    if (r.ok > 0) { for (const k of keys) state.sent[`${today}|${k}`] = new Date().toISOString(); sentAny = true; }
    else if (!r.noSubs) anyFail = true;
  }
  if (!fresh.length) console.log('nothing new to send');
  if (!dry && sentAny) saveState(state, today);
  return anyFail && !sentAny ? 1 : 0;
}

// ---------- direct send ----------
async function direct(args) {
  let items;
  if (args['items-file']) { try { items = JSON.parse(fs.readFileSync(args['items-file'], 'utf8')); } catch (e) { die('cannot read --items-file: ' + e.message); } }
  else if (args.items) { try { items = JSON.parse(args.items); } catch (e) { die('--items must be a JSON array of strings: ' + e.message); } }
  if (items !== undefined && !Array.isArray(items)) die('items must be a JSON array');
  const str = v => (v && v !== true ? String(v) : undefined);
  if (!str(args.title)) die('--title is required');
  let built;
  try { built = buildPayload({ type: str(args.type) || 'info', title: str(args.title), body: str(args.body), items, url: str(args.url), id: str(args.id) }); } catch (e) { die(e.message); }
  const bad = assertGeneric(built.payload);
  if (bad && !args['allow-sensitive']) die(`${bad}. The phone lock screen shows push text: keep amounts and account numbers inside the encrypted dashboard (or pass --allow-sensitive).`);
  if (args['dry-run']) { console.log(`DRY RUN payload (${bytes(built.json)} bytes):`); console.log(built.json); return 0; }
  const r = await sendToAll(built.payload, built.json);
  return r.failed && !r.ok ? 1 : 0;
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === 'add-sub') return require('./add-sub').addSub(argv.slice(1).join(' '));
  const args = parseArgs(argv);
  if (args.help || args.h || (!argv.length)) { console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0].split('/*')[1]); return argv.length ? 0 : 2; }
  if (args._[0] === 'due-check') return dueCheck(args);
  if (args._.length) die('unknown command ' + args._[0]);
  return direct(args);
}
main().then(code => process.exit(code), e => { console.error('ERROR: ' + (e && e.message || e)); process.exit(1); });
