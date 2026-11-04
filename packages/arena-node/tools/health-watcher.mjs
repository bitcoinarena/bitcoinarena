#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
/**
 * THE HEALTH WATCHER (kanban #759, 2026-10-28, the owner: "we need a health watcher that reacts to round problems and issues fixes immediately
 * if something doesn't work. If it can't solve the issue it needs to alert the devs on arena chat."). Why: on 10-28 (#757) every seat listed
 * the day's rounds and none was seated - only 0-4 of the 9 drawn per round were live seats, the stopped test nodes still in the census - and
 * nobody noticed until the owner looked.
 *
 * One light pass every HW_INTERVAL_S (180 s): a few GETs on the seats, one `systemctl --user show`, /proc/loadavg; an ssh to miner C only
 * when a pending transaction is old. Each pass:
 *   DETECT  a. per app, the next hour's rounds: none listed / listed but not seated / seated but none open - the health page's own
 *              roundSeating() (src/arena-ui/health/network.js, #758) over the seats' GET /rounds?next=8
 *           b. a seat not answering GET /identity; a seat unit restarting over and over (systemd NRestarts climbing)
 *           c. today or tomorrow with no posting for an app (the seats' GET /duty: the dutyday runners are gone since #702)
 *           d. our pending transactions (GET /pending) old and not on miner C's list, or listed and still unconfirmed; the tip not moving
 *           e. the the test host's 15-min load above HW_LOAD_MAX (12)
 *   FIX     what has a safe runbook, each behind guards and a rate limit, and rechecked on the next pass before it is ever done again:
 *           - a test host seat down two passes: restart that one unit (load1 < 12, :03-:08 of a quarter only - never across a seating,
 *             memory seat-roll-seating-window -, one seat per 10 min, the same seat once per hour)
 *           - old pending txids missing from miner C's list: appended, the miner stopped so its loop restarts it with them (ops/minerc-727.sh)
 *           - a next hour no one can join, or a day without posting: NOT fixed - an emergency grid posted by a machine crashed every seat on
 *             10-25. The alert carries the runbook command; emergencyGrid() is the hook to automate it later.
 *   ALERT   Arena Chat #code, a plain channel message as bot claude, "[health-watcher] #<ticket> @owner ...": what is wrong,
 *           the numbers, what was tried, what is needed. The same problem again at most once an hour while it lasts, and once "resolved".
 *
 *   node tools/health-watcher.mjs [--dry] [--once]       (env HW_DRY=1, HW_ONCE=1; the rest below in CONFIG)
 * --dry prints what it would fix or post and keeps its state apart (<state>.dry.json). Importing this file does nothing.
 */
import { readFileSync, writeFileSync, renameSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { execFile } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { roundSeating, NOW_ROUNDS } from '../../../src/arena-ui/health/network.js';
import { pubsConfig, gatherPubs, assessPubs, pubMemTxs, doResend, doCpfp, doPublicMine, lookScript, parseLook, callsScript, parseCalls, opsPublished, esploraCalls } from './health-watcher-pubs.mjs';

const H = process.env.HOME || '/home/arena';
const range = (host, from, to) => { const out = []; for (let p = from; p <= to; p += 10) out.push(`http://${host}:${p}`); return out; };
const list = (s) => String(s || '').split(/[\s,]+/).filter(Boolean);

// CONFIG: every number the watcher acts on, from the environment
export function config(env = process.env, argv = []) {
  const n = (k, d) => (env[k] != null && env[k] !== '' ? Number(env[k]) : d);
  const testHost = env.HW_HOST_SEATS ? list(env.HW_HOST_SEATS) : range('127.0.0.1', 31221, 31281);
  const mac = env.HW_MAC_SEATS ? list(env.HW_MAC_SEATS) : range('192.0.2.226', 6221, 6281);
  const dry = argv.includes('--dry') || env.HW_DRY === '1';
  const state = env.HW_STATE || `${H}/blwp-testnet4/ops/health-watcher-state.json`;
  return {
    dry, once: argv.includes('--once') || env.HW_ONCE === '1',
    intervalMs: n('HW_INTERVAL_S', 180) * 1000,
    testHost, mac,
    // the seats whose GET /rounds?next=8 is read (0.7 MB each, measured 10-28): two per machine, one after the other
    listSeats: env.HW_LIST_SEATS ? list(env.HW_LIST_SEATS) : [testHost[0], testHost[3], mac[0], mac[3]].filter(Boolean),
    dutySeats: env.HW_DUTY_SEATS ? list(env.HW_DUTY_SEATS) : [testHost[0], mac[0]].filter(Boolean),
    pendingSeats: env.HW_PENDING_SEATS ? list(env.HW_PENDING_SEATS) : [testHost[0], testHost[2]].filter(Boolean),
    // a test host seat's unit: node N listens on 31211 + 10 N (blwp-tn4-node@.service)
    unitOf: (base) => { const m = /:(\d+)$/.exec(base); const p = m ? Number(m[1]) : 0; return testHost.includes(base) && p > 31211 && (p - 31211) % 10 === 0 ? `blwp-tn4-node@${(p - 31211) / 10}.service` : null; },
    statePath: dry ? state.replace(/\.json$/, '') + '.dry.json' : state,
    loadMax: n('HW_LOAD_MAX', 12),
    confirm: n('HW_CONFIRM_PASSES', 2),                 // a problem counts once it is seen on this many passes in a row
    notOpenPasses: n('HW_NOT_OPEN_PASSES', 5),          // "seated, none open" alerts only after this many passes (about 15 min)
    repeatMs: n('HW_REPEAT_MIN', 60) * 60000,           // the same alert again at most this often
    seatDownAlertMs: n('HW_SEAT_DOWN_ALERT_MIN', 20) * 60000,
    restartGapMs: n('HW_RESTART_GAP_MIN', 10) * 60000,  // one seat restart in this long, any seat
    restartSameMs: n('HW_RESTART_SAME_MIN', 60) * 60000,// the same seat at most once in this long
    flapRestarts: n('HW_FLAP_RESTARTS', 3),             // NRestarts climbing by this much in an hour
    pendingAgeMs: n('HW_PENDING_AGE_MIN', 30) * 60000,  // a pending tx this old is checked against miner C's list
    stuckMs: n('HW_STUCK_MIN', 120) * 60000,            // listed and still unconfirmed this long: alert
    tipStallMs: n('HW_TIP_STALL_MIN', 90) * 60000,
    minercGapMs: n('HW_MINERC_GAP_MIN', 15) * 60000,
    tomorrowByHour: n('HW_TOMORROW_BY_HOUR', 18),       // tomorrow unposted after this UTC hour is a problem (rounds need ~4.5 h)
    minerc: { host: env.HW_MINERC_HOST || 'arena@192.0.2.68', dir: env.HW_MINERC_DIR || 'arena-minerC' },
    chat: { url: env.HW_CHAT_URL || 'https://seat.example.com/arenachat/api/channels/1/messages', tokenFile: env.HW_CHAT_TOKEN_FILE || `${H}/.config/blwp/arenachat-token`,
      mention: env.HW_MENTION || '@owner' },
    probeCensus: env.HW_PROBE_CENSUS !== '0',
    pubs: pubsConfig(env, H),                           // f. the round publications on both chains (./health-watcher-pubs.mjs)
  };
}

const hm = (ms) => new Date(Number(ms)).toISOString().slice(11, 16);
const mins = (ms) => Math.round(ms / 60000);
const short = (s) => String(s).replace(/^https?:\/\//, '');
/** :03-:08 of each quarter hour - the only minutes a seat may restart (memory seat-roll-seating-window: the seating runs ~:13 to past :15). */
export const inRestartMinutes = (nowMs) => { const s = Math.floor(Number(nowMs) / 1000) % 900; return s >= 180 && s < 540; };

// ---------------------------------------------------------------- THE READ: every fact of one pass, through `io` (faked in the tests)
export async function gather(io, cfg, state, nowMs) {
  const f = { nowMs, load: await io.loadavg(), seats: [], units: {}, lists: [], games: [], duty: [], pending: [], answering: null, minerc: null };
  // b. every seat's /identity, four at once
  const all = [...cfg.testHost.map((b) => ({ base: b, machine: 'testHost' })), ...cfg.mac.map((b) => ({ base: b, machine: 'mac' }))];
  for (let i = 0; i < all.length; i += 4) {
    await Promise.all(all.slice(i, i + 4).map(async (s) => { const a = await io.identity(s.base); f.seats.push({ ...s, unit: cfg.unitOf(s.base), ok: !!a.ok, key: a.key || null, why: a.why || null }); }));
  }
  f.seats.sort((a, b) => all.findIndex((x) => x.base === a.base) - all.findIndex((x) => x.base === b.base));
  const units = [...new Set(f.seats.map((s) => s.unit).filter(Boolean))];
  f.units = units.length ? await io.units(units) : {};
  // a. the next hour's rounds, from a few seats, one after the other
  for (const b of cfg.listSeats) { const a = await io.get(b, NOW_ROUNDS, 30000); f.lists.push(a.ok ? a.body : null); if (a.ok) for (const g of a.body.games || []) f.games.push(g); }
  // c. who posted each day: the seat that has seen the most postings
  for (const b of cfg.dutySeats) { const a = await io.get(b, '/duty', 15000); if (a.ok) f.duty.push(a.body); }
  // d. our pending transactions and the tip
  for (const b of cfg.pendingSeats) { const a = await io.get(b, '/pending', 20000); if (a.ok) f.pending.push(a.body); }
  // the drawn nodes that answer: our seats' keys, and - only while some app's next hour looks bad - the census nodes' /owner/version
  const ours = f.seats.filter((s) => s.ok && s.key).map((s) => s.key);
  f.answering = [...ours];
  const pre = roundSeating({ games: dedupeGames(f.games), lists: f.lists, nowMs, answering: f.answering });
  if (cfg.probeCensus && [...pre.values()].some((c) => c.c === 'bad')) {
    const kept = state.census && nowMs - state.census.atMs < 15 * 60000 ? state.census : null;
    if (kept) f.answering.push(...kept.answering);
    else {
      const roles = await io.get(cfg.listSeats[0] || cfg.testHost[0], '/roles', 10000);
      const others = roles.ok ? (roles.body.nodes || []).filter((x) => !ours.includes(x.node) && (x.roles || []).includes('game')).slice(0, 40) : [];
      const up = [];
      for (let i = 0; i < others.length; i += 4) {
        await Promise.all(others.slice(i, i + 4).map(async (x) => { const base = String(x.endpoint || '').replace(/^ws(s?):/, 'http$1:').replace(/\/+$/, ''); const a = base ? await io.get(base, '/owner/version', 6000) : { ok: false }; if (a.ok) up.push(x.node); }));
      }
      f.censusProbe = { atMs: nowMs, asked: others.length, answering: up };
      f.answering.push(...up);
    }
  }
  // d. miner C's list, only for the pending txids that are old
  // f. every round publication of ours, on our branch and on the public chain
  if (io.chainLook) {
    const ex = await io.get(cfg.pendingSeats[0] || cfg.testHost[0], '/expected', 20000); f.expected = ex.ok ? [ex.body] : [];
    // the series a publication carries, for the time its rounds are (kanban #1124)
    const se = await io.get(cfg.pendingSeats[0] || cfg.testHost[0], '/series', 20000); f.series = se.ok ? [se.body] : [];
    await gatherPubs(io, cfg.pubs, state, f);
  }
  const memPubs = pubMemTxs(f, state.pubs).map((t) => t.txid);
  const old = [...new Set([...memPubs, ...pendingTxs(f.pending).filter((t) => state.pendingSeen && state.pendingSeen[t.txid] && nowMs - state.pendingSeen[t.txid] >= cfg.pendingAgeMs).map((t) => t.txid)])];
  if (old.length) f.minerc = await io.minercCheck(old);
  if (io.topProcs && f.load[2] > cfg.loadMax) f.top = await io.topProcs();
  return f;
}
const dedupeGames = (gs) => [...new Map(gs.map((g) => [String(g.id).toLowerCase(), g])).values()];
/** The pending transactions worth mining: no confirmation yet, in the mempool. */
export const pendingTxs = (bodies) => [...new Map(bodies.flatMap((b) => (b && b.txs) || []).filter((t) => t && /^[0-9a-f]{64}$/.test(t.txid || '') && !t.confirmations && t.inMempool).map((t) => [t.txid, t])).values()];

// ---------------------------------------------------------------- THE JUDGEMENT: problems and fixes from the facts and the kept state (pure)
// a problem: { key, ticket, title, lines, tried, needs, alert } - alert false: seen, said in the log, not (yet) worth a message
// a fix:     { key, kind: 'restart-seat' | 'minerc-add', unit?, base?, txids?, allowed, blocked: [why] }
export function assess(f, prev, cfg) {
  const nowMs = f.nowMs, st = structuredClone(prev || {});
  for (const k of ['seats', 'restarts', 'fixes', 'pendingSeen', 'streak', 'alerts']) st[k] = st[k] || {};
  const problems = [], fixes = [];
  const seen = new Set();
  const streak = (key, on) => { if (on) { st.streak[key] = (st.streak[key] || 0) + 1; seen.add(key); } return st.streak[key] || 0; };
  const [l1, l5, l15] = f.load;

  // a. THE NEXT HOUR'S ROUNDS (#757/#758)
  const postedToday = postedApps(f.duty, 'today');
  const cells = roundSeating({ games: dedupeGames(f.games), lists: f.lists, nowMs, answering: f.answering, posted: (name) => postedToday.has(name) });
  const bad = [...cells].filter(([, c]) => c.c === 'bad'), notOpen = [...cells].filter(([, c]) => c.c === 'warn' && /none open yet/.test(c.t)), unknown = [...cells].filter(([, c]) => c.t === 'no seat answered');
  if (bad.length) {
    const n = streak('seating', true);
    const counts = appCounts(f.lists, nowMs, f.answering);
    problems.push({ key: 'seating', ticket: '757', title: 'no joinable rounds (next hour)',
      lines: bad.map(([name]) => { const x = counts.get(name);
        return x ? `${appName(name)}: ${x.listed} listed, ${x.seated} seated${x.live ? ` (${x.live} drawn live)` : ''}` : `${appName(name)}: posted, none listed`; }),
      tried: ['nothing (no automatic emergency grid)'], needs: 'emergency grid on a clean census, see #757',
      alert: n >= cfg.confirm });
  } else streak('seating', false);
  if (notOpen.length) {
    const n = streak('not-open', true);
    const counts = appCounts(f.lists, nowMs, f.answering);
    problems.push({ key: 'not-open', ticket: '758', title: 'seated but none open (next hour)',
      lines: notOpen.map(([name]) => { const x = counts.get(name) || {}; return `${appName(name)}: ${x.seated ?? '?'} seated, 0 open`; }), tried: ['nothing (no runbook)'], needs: 'a look at why, see #758', alert: n >= cfg.notOpenPasses });
  }
  if (unknown.length && f.lists.every((x) => !x)) {
    const n = streak('rounds-unread', true);
    problems.push({ key: 'rounds-unread', ticket: '759', title: 'no seat lists rounds', lines: [`asked: ${cfg.listSeats.map(seatName).join(', ')}`], tried: ['nothing'], needs: 'seats checked, see #759', alert: n >= cfg.confirm });
  }
  for (const [name, c] of cells) if (c.c === 'warn' && /not seated/.test(c.t)) problems.push({ key: `partly:${name}`, ticket: '758', title: `${name}: ${c.t}`, lines: [], alert: false });

  // b. SEATS
  let restartPlanned = false;
  for (const s of f.seats) {
    const k = s.base, was = st.seats[k] || {};
    const fixKey = s.unit ? `restart:${s.unit}` : null, fx = fixKey ? st.fixes[fixKey] : null;
    if (s.ok) {
      if (fx && fx.recheck === 'pending') fx.recheck = 'helped';
      st.seats[k] = { okMs: nowMs, key: s.key };
      continue;
    }
    const down = { downSince: was.downSince || nowMs, passes: (was.passes || 0) + 1, okMs: was.okMs, key: was.key };
    st.seats[k] = down;
    if (down.passes < cfg.confirm) continue;
    seen.add(`seat-down:${k}`);
    const u = s.unit ? f.units[s.unit] || {} : null;
    const lines = [`down ${mins(nowMs - down.downSince)} min${s.why ? ` (${String(s.why).slice(0, 40)})` : ''}${u ? `, unit ${u.active || '?'}, ${u.nRestarts ?? '?'} restarts` : ''}`];
    const tried = [];
    let alert = nowMs - down.downSince >= cfg.seatDownAlertMs, needs = '';
    if (!s.unit) { alert = true; needs = 'restart on the test host, see #759'; tried.push('nothing (second-host seat)'); }
    else {
      if (fx && fx.recheck === 'pending') { fx.recheck = 'failed'; }
      if (fx && fx.recheck === 'failed') { tried.push(`restarted ${hm(fx.atMs)} UTC, still down`); alert = true; }
      const blocked = [], held = [];   // blocked: the log's words; held: the alert's
      if (!(l1 < cfg.loadMax)) { blocked.push(`1-min load ${l1} >= ${cfg.loadMax}`); held.push(`load ${l1} >= ${cfg.loadMax}`); }
      if (!inRestartMinutes(nowMs)) { blocked.push(`${hm(nowMs)} UTC is not :03-:08 of a quarter (seating)`); held.push('seating minutes'); }
      if (st.lastSeatRestartMs && nowMs - st.lastSeatRestartMs < cfg.restartGapMs) { blocked.push(`a seat was restarted ${mins(nowMs - st.lastSeatRestartMs)} min ago (one at a time, ${mins(cfg.restartGapMs)} min apart)`); held.push('another seat just restarted'); }
      if (fx && nowMs - fx.atMs < cfg.restartSameMs) { blocked.push(`${s.unit} was restarted ${mins(nowMs - fx.atMs)} min ago (once per ${mins(cfg.restartSameMs)} min)`); held.push('once per hour'); }
      if (u && u.active === 'activating') { blocked.push('systemd is restarting it already (activating)'); held.push('systemd restarting it'); }
      if (restartPlanned) { blocked.push('another seat restarts this pass'); held.push('one per pass'); }
      const allowed = !blocked.length;
      fixes.push({ key: fixKey, kind: 'restart-seat', unit: s.unit, base: k, allowed, blocked });
      if (allowed) restartPlanned = true;
      else {
        tried.push(`restart held (${held.join(', ')})`);
        if (blocked.some((b) => /load|restarting it already|restarted \d+ min ago \(once/.test(b))) alert = true;
      }
      if (allowed) tried.push('restarting it now');
      needs = allowed ? 'nothing yet (recheck next pass)' : 'manual restart when safe, see #759';
    }
    problems.push({ key: `seat-down:${k}`, ticket: '759', title: `${seatName(k)} not answering`, lines, tried, needs, alert });
  }
  // a seat unit restarting by itself over and over (NRestarts climbing)
  for (const [unit, u] of Object.entries(f.units)) {
    const xs = (st.restarts[unit] || []).filter(([t]) => nowMs - t <= 3600000);
    if (u.nRestarts != null) xs.push([nowMs, Number(u.nRestarts)]);
    st.restarts[unit] = xs;
    const ours = Object.values(st.fixes).filter((x) => x.unit === unit && nowMs - x.atMs <= 3600000).length;   // our own restarts do not count
    const climb = xs.length ? xs[xs.length - 1][1] - xs[0][1] - ours : 0;
    if (climb >= cfg.flapRestarts) {
      seen.add(`flapping:${unit}`);
      problems.push({ key: `flapping:${unit}`, ticket: '759', title: `seat ${(/@(\d+)/.exec(unit) || [, unit])[1]} crash-looping`, lines: [`${climb} restarts in ${mins(nowMs - xs[0][0])} min (NRestarts ${xs[0][1]} -> ${xs[xs.length - 1][1]})`],
        tried: ['nothing (a restart does not cure it)'], needs: 'its log read, see #759', alert: true });
    }
  }

  // c. POSTING per day and app (the seats' GET /duty)
  if (!f.duty.length) {
    const n = streak('duty-unread', true);
    problems.push({ key: 'duty-unread', ticket: '759', title: 'no seat answers /duty', lines: [`asked: ${cfg.dutySeats.map(seatName).join(', ')}`], tried: ['nothing'], needs: 'round posters checked, see #759', alert: n >= cfg.confirm });
  } else {
    const hour = new Date(nowMs).getUTCHours();
    for (const day of bestDuty(f.duty).days || []) {
      const byApp = new Map();
      for (const a of day.apps || []) { if (!byApp.has(a.name)) byApp.set(a.name, []); byApp.get(a.name).push(a); }
      for (const [name, roles] of byApp) {
        const posted = roles.some((r) => r.state === 'posted' || r.state === 'in mempool');
        const missed = roles.some((r) => r.state === 'missed');
        const late = day.period === 'today' ? !posted : !posted && (missed || hour >= cfg.tomorrowByHour);
        const key = `posting:${day.covers}:${name}`;
        if (!late) { streak(key, false); continue; }
        const n = streak(key, true);
        problems.push({ key, ticket: '759', title: `no posting ${day.period === 'today' ? 'today' : 'tomorrow'} (${day.covers.slice(5)}): ${appName(name)}`,
          lines: [roles.map((r) => `${r.role} ${r.state}`).join(', ')],
          tried: ['nothing (no automatic emergency grid)'], needs: `emergency grid for ${day.covers.slice(5)}, see #757`, alert: n >= cfg.confirm });
      }
    }
  }

  // d. PENDING TRANSACTIONS AND MINER C
  // f. the round publications first: their mempool ones join the pending txs for miner C
  if (f.chains) assessPubs(f, st, cfg.pubs, problems, fixes, nowMs);
  const txs = [...new Map([...pendingTxs(f.pending), ...pubMemTxs(f, st.pubs)].map((t) => [t.txid, t])).values()], now = new Set(txs.map((t) => t.txid));
  for (const t of txs) if (!st.pendingSeen[t.txid]) st.pendingSeen[t.txid] = nowMs;
  for (const id of Object.keys(st.pendingSeen)) if (!now.has(id)) delete st.pendingSeen[id];
  if (f.minerc === null && txs.some((t) => nowMs - st.pendingSeen[t.txid] >= cfg.pendingAgeMs)) {
    const n = streak('minerc-unreachable', true);
    problems.push({ key: 'minerc-unreachable', ticket: '759', title: 'miner C unreachable', lines: [`${txs.length} pending tx(s) wait`], tried: ['ssh'], needs: 'second machine checked, see #759', alert: n >= cfg.confirm });
  }
  if (f.minerc) {
    const missing = f.minerc.missing || [], fx = st.fixes['minerc-add'];
    if (missing.length) {
      seen.add('pending-unlisted');
      const again = fx && fx.recheck === 'pending' && missing.some((t) => (fx.txids || []).includes(t));
      if (fx && fx.recheck === 'pending') fx.recheck = again ? 'failed' : 'helped';
      const blocked = [];
      if (fx && nowMs - fx.atMs < cfg.minercGapMs) blocked.push(`miner C's list was changed ${mins(nowMs - fx.atMs)} min ago (once per ${mins(cfg.minercGapMs)} min)`);
      if (again) blocked.push('the last append did not keep them on the list');
      fixes.push({ key: 'minerc-add', kind: 'minerc-add', txids: missing, allowed: !blocked.length, blocked });
      problems.push({ key: 'pending-unlisted', ticket: '759', title: `${missing.length} pending tx(s) not on miner C's list`, lines: txLines(txs.filter((t) => missing.includes(t.txid)), st, nowMs),
        tried: again ? ['added to the list, still missing'] : blocked.length ? ['append held (once per 15 min)'] : ['adding them to the list'],
        needs: again ? 'miner C checked, see #759' : 'nothing yet', alert: !!again });
    } else if (fx && fx.recheck === 'pending') fx.recheck = 'helped';
    const stuck = txs.filter((t) => (f.minerc.listed || []).includes(t.txid) && nowMs - st.pendingSeen[t.txid] >= cfg.stuckMs);
    if (stuck.length) {
      seen.add('pending-stuck');
      problems.push({ key: 'pending-stuck', ticket: '759', title: `${stuck.length} listed tx(s) unconfirmed for ${mins(Math.max(...stuck.map((t) => nowMs - st.pendingSeen[t.txid])))} min`,
        lines: txLines(stuck, st, nowMs), tried: ['nothing (already on miner C\'s list)'], needs: 'miner C checked, see #759', alert: true });
    }
  }
  const tip = tipOf(f.pending);
  if (tip != null) {
    if (!st.tip || st.tip.height !== tip) st.tip = { height: tip, sinceMs: nowMs };
    else if (nowMs - st.tip.sinceMs >= cfg.tipStallMs) {
      seen.add('tip-stalled');
      problems.push({ key: 'tip-stalled', ticket: '759', title: `no new block for ${mins(nowMs - st.tip.sinceMs)} min (tip ${tip})`, lines: [`tip ${tip} since ${hm(st.tip.sinceMs)} UTC`],
        tried: ['nothing'], needs: 'miner C checked, see #759', alert: true });
    }
  }

  // e. LOAD
  if (l15 > cfg.loadMax) {
    const n = streak('load', true);
    problems.push({ key: 'load', ticket: '759', title: `test host load ${l15} (15 min) > ${cfg.loadMax}`, plain: f.top ? [`top: ${f.top}`] : [],
      tried: ['nothing (no safe automatic cut)'], needs: 'heavy jobs stopped or moved, see #759', alert: n >= cfg.confirm });
  } else streak('load', false);

  // problems that ended: their streak cleared
  for (const k of Object.keys(st.streak)) if (!seen.has(k)) delete st.streak[k];
  return { state: st, problems, fixes, cells };
}

const tipOf = (bodies) => { const t = bodies.map((b) => Number(b && b.tip)).filter((x) => x > 0); return t.length ? Math.max(...t) : null; };
const bestDuty = (bodies) => bodies.slice().sort((a, b) => count(b) - count(a))[0] || { days: [] };
const count = (d) => (d.days || []).reduce((s, x) => s + (x.apps || []).reduce((y, a) => y + (a.postings || []).length, 0), 0);
/** The apps with a posting (posted or in the mempool) for the day of `period` ('today' | 'next'). */
export function postedApps(duty, period) {
  const out = new Set();
  for (const day of bestDuty(duty).days || []) if (day.period === period) for (const a of day.apps || []) if (a.state === 'posted' || a.state === 'in mempool') out.add(a.name);
  return out;
}

const APPS = { 'rock-paper-scissors': 'RPS', nextblock: 'Next Block', 'btc-updown-15m': 'Up/Down' };
/** An app's short name for the chat. */
export const appName = (name) => APPS[name] || name;
/** A seat by its number, as the operators say it: test host port 31211 + 10 N is "seat N", macOS port 6211 + 10 N "second-host seat N". */
export const seatName = (base) => { const p = Number((/:(\d+)(\/|$)/.exec(String(base)) || [])[1]) || 0;
  return p > 31211 && (p - 31211) % 10 === 0 && p < 31300 ? `seat ${(p - 31211) / 10}` : p > 6211 && (p - 6211) % 10 === 0 && p < 6300 ? `second-host seat ${(p - 6211) / 10}` : short(base); };
const txLines = (ts, st, nowMs) => { const xs = ts.slice(0, 3).map((t) => `${t.txid.slice(0, 8)} ${t.kind || '?'}${t.game ? ` ${appName(t.game)}` : ''}, ${mins(nowMs - st.pendingSeen[t.txid])} min`);
  if (ts.length > 3) xs.push(`and ${ts.length - 3} more`); return xs; };
/** Per app, the next hour's rounds counted once each: listed, seated, and how many of an unseated round's drawn game committee answer ("lo-hi/N"). */
export function appCounts(lists, nowMs, answering = []) {
  const live = new Set((answering || []).map((k) => String(k).toLowerCase().slice(0, 16)));
  const byId = new Map(), names = new Map();
  for (const body of lists) {
    for (const g of (body && body.games) || []) names.set(String(g.id).toLowerCase().slice(0, 16), g.name);
    for (const r of (body && body.rounds) || []) {
      if (!r || !r.id || r.played === false || !(Number(r.entryCloseMs) > nowMs && Number(r.startTimeMs) <= nowMs + 3600000)) continue;
      const c = r.committee || {}, seated = !!(c.seated && c.seated.game && c.seated.settlement), w = byId.get(r.id);
      const drawn = c.drawn && Array.isArray(c.drawn.game) ? c.drawn.game : Array.isArray(c.game) ? c.game : [];
      const name = names.get(String(r.game && r.game.id).toLowerCase().slice(0, 16)) || (r.game && r.game.name) || '?';
      if (!w) byId.set(r.id, { name, seated, drawn }); else { w.seated = w.seated || seated; if (!w.drawn.length) w.drawn = drawn; }
    }
  }
  const out = new Map();
  for (const r of byId.values()) {
    const x = out.get(r.name) || { listed: 0, seated: 0, ups: [], of: 0 };
    x.listed++; if (r.seated) x.seated++;
    else if (r.drawn.length) { x.ups.push(r.drawn.filter((k) => live.has(String(k).toLowerCase().slice(0, 16))).length); x.of = Math.max(x.of, r.drawn.length); }
    out.set(r.name, x);
  }
  for (const x of out.values()) { const lo = Math.min(...x.ups), hi = Math.max(...x.ups); x.live = x.ups.length ? `${lo === hi ? lo : `${lo}-${hi}`}/${x.of}` : null; delete x.ups; }
  return out;
}

/** The runbook line for an emergency grid (memory emergency-day-post; the last day's tool is ops/emergency-1028.sh). */
export function emergencyRunbook(nowMs, day = new Date(nowMs).toISOString().slice(0, 10)) {
  const md = day.slice(5, 7) + day.slice(8, 10);
  return `The tool for ${day} is ~/blwp-testnet4/ops/emergency-${md}.sh (if missing, a copy of the last one, emergency-1028.sh, with END = the next day 00:00Z, GRID_MIN_CENSUS = a census `
    + `without the stopped nodes, GRID_EXPECT_GAME = the ids the seats list). Per game a DRY run first: systemd-run --user --unit=emergency${md}-dry-<game> --collect -E DRY=1 /bin/bash `
    + `~/blwp-testnet4/ops/emergency-${md}.sh <game>, and without DRY once it passes. Never Next Block via PAID_NB90_GRID with the runner's built-in core.`;
}
/** THE HOOK to automate the emergency grid later (kanban #759: "do NOT post emergency grids automatically yet"). Not called. */
export async function emergencyGrid() { throw new Error('emergency grids are not posted automatically yet (kanban #759); post them by the runbook'); }

// ---------------------------------------------------------------- ALERTS: new, again after an hour, resolved
export function alertsDue(problems, st, cfg, nowMs) {
  const out = [], live = new Set();
  for (const p of problems) {
    if (!p.alert) continue;
    live.add(p.key);
    const a = st.alerts[p.key];
    if (!a) { out.push({ key: p.key, kind: 'new', text: alertText(p, cfg, null) }); continue; }
    a.absent = 0;
    if (nowMs - a.lastMs >= cfg.repeatMs) out.push({ key: p.key, kind: 'again', text: alertText(p, cfg, a) });
  }
  // resolved once the problem is gone two passes in a row (no flapping)
  for (const [key, a] of Object.entries(st.alerts)) {
    if (live.has(key)) continue;
    if (problems.some((p) => p.key === key)) { a.absent = 0; continue; }   // still seen, not worth an alert now: not resolved either
    a.absent = (a.absent || 0) + 1;
    if (a.absent >= 2) out.push({ key, kind: 'resolved', text: `[health-watcher] #${a.ticket} ${cfg.chat.mention} RESOLVED: ${a.title} (since ${hm(a.firstMs)} UTC, ${mins(nowMs - a.firstMs)} min)` });
  }
  return out;
}
// SHORT AND SCANNABLE (the owner on the first live alerts, 2026-10-28: "Übersichtlichere Ausgabe, weniger wall of text"): a head line, one
// "•" line per app or item, one "Tried:" and one "Needs:" line of a few words - the runbooks stay on the card; STILL is the head line alone
export function alertText(p, cfg, was) {
  const head = `[health-watcher] #${p.ticket} ${cfg.chat.mention} ${was ? `STILL (since ${hm(was.firstMs)} UTC)` : 'PROBLEM'}: ${p.title}`;
  if (was) return head;
  return [head, ...(p.lines || []).map((l) => `• ${l}`), ...(p.plain || []), `Tried: ${(p.tried || []).join('; ') || 'nothing'}`, `Needs: ${p.needs || '-'}`].join('\n');
}
/** The kept state after an alert was posted (only then: a failed post is tried again next pass). */
export function markAlerted(st, a, problems, nowMs) {
  if (a.kind === 'resolved') { delete st.alerts[a.key]; return; }
  const p = problems.find((x) => x.key === a.key);
  st.alerts[a.key] = { ...(st.alerts[a.key] || { firstMs: nowMs }), lastMs: nowMs, title: p.title, ticket: p.ticket, absent: 0 };
}

// ---------------------------------------------------------------- ONE PASS
export async function pass(io, cfg, prev) {
  const nowMs = io.now();
  const f = await gather(io, cfg, prev || {}, nowMs);
  const { state, problems, fixes } = assess(f, prev || {}, cfg);
  if (f.censusProbe) state.census = { atMs: f.censusProbe.atMs, answering: f.censusProbe.answering };
  const did = [];
  for (const x of fixes.filter((y) => y.allowed)) {
    if (cfg.dry) { did.push({ ...x, dry: true, why: x.kind === 'cpfp' ? (await doCpfp(io, state, cfg.pubs, x.txid, nowMs, { plan: true }).catch((e) => ({ text: e.message }))).text : null }); continue; }
    try {
      let ok = true, why = null;
      if (x.kind === 'restart-seat') { await io.restartUnit(x.unit); state.lastSeatRestartMs = nowMs; }
      else if (x.kind === 'minerc-add') await io.minercAdd(x.txids);
      else if (x.kind === 'resend') why = await doResend(io, state, x, nowMs);
      else if (x.kind === 'cpfp') ({ ok, text: why } = await doCpfp(io, state, cfg.pubs, x.txid, nowMs));
      else if (x.kind === 'public-mine') why = String(await doPublicMine(io, cfg.pubs, x.txids)).trim().split('\n').pop();
      state.fixes[x.key] = { kind: x.kind, unit: x.unit, txids: x.txids, atMs: nowMs, recheck: 'pending' };
      did.push({ ...x, ok, why });
    } catch (e) { did.push({ ...x, ok: false, why: e.message }); problems.push({ key: `fix-failed:${x.key}`, ticket: '759', title: `the fix ${x.kind} ${x.unit || ''} failed`, lines: [e.message], tried: [x.kind], needs: 'a hand', alert: true }); }
  }
  const alerts = alertsDue(problems, state, cfg, nowMs), posted = [];
  for (const a of alerts) {
    if (cfg.dry) { posted.push({ ...a, dry: true }); markAlerted(state, a, problems, nowMs); continue; }
    try { await io.post(a.text); markAlerted(state, a, problems, nowMs); posted.push({ ...a, ok: true }); } catch (e) { posted.push({ ...a, ok: false, why: e.message }); }
  }
  state.lastPassMs = nowMs;
  return { state, facts: f, problems, fixes, did, alerts: posted };
}

// ---------------------------------------------------------------- THE REAL WORLD
const run = (cmd, args, { timeout = 30000, input } = {}) => new Promise((ok, no) => {
  const c = execFile(cmd, args, { timeout, maxBuffer: 4 << 20 }, (e, out, err) => (e ? no(new Error(`${cmd} ${args[0] || ''}: ${String(err || e.message).trim().slice(0, 300)}`)) : ok(String(out))));
  if (input != null) { c.stdin.end(input); }
});
export function realIo(cfg) {
  // a chain's bitcoin-cli in a bash script: ours here, the public chain's over one ssh to the test host (its login shell is zsh: bash -s)
  // (kanban #1124: the ssh bitcoind is the public chain's second source only, and never longer than HW_PUBLIC_SSH_S)
  const onChain = (chain, script, timeout = 120000) => (chain === 'public'
    ? run('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', cfg.pubs.publicHost, 'bash -s'], { timeout: Math.min(timeout, cfg.pubs.publicSshMs), input: script })
    : run('bash', ['-s'], { timeout, input: script }));
  const cliOf = (chain) => (chain === 'public' ? cfg.pubs.publicCli : cfg.pubs.oursCli.join(' '));
  const get = async (base, path, ms = 10000) => {
    try {
      const r = await fetch(base + path, { signal: AbortSignal.timeout(ms) });
      if (!r.ok) return { ok: false, why: `HTTP ${r.status}` };
      return { ok: true, body: await r.json() };
    } catch (e) { return { ok: false, why: e.name === 'TimeoutError' ? `no answer in ${ms / 1000} s` : e.message }; }
  };
  // the public chain by Esplora (kanban #1124): each base in turn, HW_ESPLORA_MS each; a base that failed steps back for 10 min.
  // { ok, status (0: no answer), text, base }
  const benched = new Map();
  const publicHttp = async (method, path, body) => {
    const bases = cfg.pubs.esplora.slice().sort((a, b) => (benched.get(a) || 0) - (benched.get(b) || 0));
    let last = { ok: false, status: 0, text: 'no Esplora base' };
    for (const base of bases) {
      try {
        const r = await fetch(base + path, { method, body, headers: body != null ? { 'content-type': 'text/plain' } : undefined, signal: AbortSignal.timeout(cfg.pubs.esploraMs) });
        const text = await r.text();
        if (r.status >= 500 || r.status === 429) { benched.set(base, Date.now() + 600000); last = { ok: false, status: r.status, text, base }; continue; }
        if ((benched.get(base) || 0) < Date.now()) benched.delete(base);
        return { ok: r.ok, status: r.status, text, base };
      } catch (e) { benched.set(base, Date.now() + 600000); last = { ok: false, status: 0, text: e.name === 'TimeoutError' ? `${base}: no answer in ${cfg.pubs.esploraMs / 1000} s` : `${base}: ${e.message}`, base }; }
    }
    return last;
  };
  const ssh = (cmd, input) => run('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', cfg.minerc.host, cmd], { timeout: 60000, input });
  return {
    now: () => Date.now(),
    loadavg: async () => readFileSync('/proc/loadavg', 'utf8').split(' ').slice(0, 3).map(Number),
    topProcs: async () => { try { return topLine(await run('ps', ['-eo', 'pcpu,args', '--sort=-pcpu', '--no-headers'])); } catch { return null; } },
    get,
    identity: async (base) => {
      try {
        const r = await fetch(base + '/identity', { signal: AbortSignal.timeout(8000) });
        if (!r.ok) return { ok: false, why: `HTTP ${r.status}` };
        const b = Buffer.from(await r.arrayBuffer());
        if (b.length === 32) return { ok: true, key: b.toString('hex') };
        try { const j = JSON.parse(b.toString()); return { ok: true, key: j.node || j.key || null }; } catch { return { ok: true, key: null }; }
      } catch (e) { return { ok: false, why: e.name === 'TimeoutError' ? 'no answer in 8 s' : e.message }; }
    },
    units: async (units) => {
      const out = {};
      try {
        const txt = await run('systemctl', ['--user', 'show', ...units, '-p', 'Id', '-p', 'ActiveState', '-p', 'SubState', '-p', 'NRestarts']);
        for (const block of txt.split(/\n\n+/)) {
          const m = Object.fromEntries(block.split('\n').filter(Boolean).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
          if (m.Id) out[m.Id] = { active: m.ActiveState, sub: m.SubState, nRestarts: m.NRestarts != null ? Number(m.NRestarts) : null };
        }
      } catch { /* not known this pass */ }
      return out;
    },
    restartUnit: (unit) => run('systemctl', ['--user', 'restart', unit], { timeout: 120000 }),
    // which txids miner C lists: one ssh, the txids on stdin; null when the second machine does not answer
    minercCheck: async (txids) => {
      try {
        const out = await ssh(`cd ~/${cfg.minerc.dir} && while read t; do grep -qx "$t" watch-pending.txt && echo "L $t" || echo "M $t"; done`, txids.join('\n') + '\n');
        const rows = out.split('\n').map((l) => l.split(' ')).filter((x) => x.length === 2 && /^[0-9a-f]{64}$/.test(x[1]));
        return { listed: rows.filter((x) => x[0] === 'L').map((x) => x[1]), missing: rows.filter((x) => x[0] === 'M').map((x) => x[1]) };
      } catch { return null; }
    },
    // as ops/pending-to-minerc.sh / minerc-727.sh: a backup, the txids appended once each, then the miner stopped - loop-c.sh starts it again with the list
    chainLook: async (chain, opts) => parseLook(await onChain(chain, lookScript(cliOf(chain), opts), 300000)),
    publicHttp: cfg.pubs.esplora.length ? publicHttp : undefined,
    chainCalls: async (chain, calls) => {
      if (!calls.length) return [];
      if (chain === 'public' && cfg.pubs.esplora.length) {
        try { return await esploraCalls(publicHttp, calls); } catch (e) { if (!cfg.pubs.publicSsh) return calls.map(() => ({ ok: false, out: '', err: e.message })); }
      }
      return parseCalls(await onChain(chain, callsScript(cliOf(chain), calls)), calls.length);
    },
    run: (cmd, args, timeout) => run(cmd, args, { timeout }),
    // the ops grids of the last HW_PUB_SOURCE_H: ~/blwp-testnet4/emergency-*.log
    opsPublished: async () => {
      const out = [];
      try {
        for (const n of readdirSync(cfg.pubs.opsDir)) {
          if (!/^emergency-.*\.log$/.test(n)) continue;
          const path = `${cfg.pubs.opsDir}/${n}`;
          if (Date.now() - statSync(path).mtimeMs > cfg.pubs.sourceMs) continue;
          out.push(...opsPublished(readFileSync(path, 'utf8')));
        }
      } catch { /* none */ }
      return out;
    },
    minercAdd: async (txids) => {
      await ssh(`cd ~/${cfg.minerc.dir} && cp watch-pending.txt watch-pending.txt.pre-hw && while read t; do grep -qx "$t" watch-pending.txt || echo "$t" >> watch-pending.txt; done && (pkill -f "node miner-lean-c.mjs" || true)`, txids.join('\n') + '\n');
    },
    // a PLAIN channel message as bot claude: no thread_id, no reply_to (memory arena-chat-mandatory)
    post: async (text) => {
      const token = readFileSync(cfg.chat.tokenFile, 'utf8').trim();
      const r = await fetch(cfg.chat.url, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ text }), signal: AbortSignal.timeout(15000) });
      if (!r.ok) throw new Error(`chat HTTP ${r.status}`);
    },
  };
}

/** `ps -eo pcpu,args` as "seat 6 70%, seat 1 68%, bitcoind 51%": a seat by its port, anything else by its program's name. */
export function topLine(ps, k = 4) {
  return ps.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, k).map((l) => {
    const [pct, ...args] = l.split(/\s+/), a = args.join(' ');
    const seat = /src\/main\.js (\d+)/.exec(a);
    const prog = String(args[0] || '?').replace(/^\[|\]$/g, '').split('/').pop();
    const script = prog === 'node' ? (/\S+\.m?js/.exec(a) || [''])[0].split('/').pop() : '';
    return `${seat ? seatName(`x:${seat[1]}`) : script ? `node ${script}` : prog} ${Math.round(Number(pct))}%`;
  }).join(', ');
}

export function loadState(path) { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return {}; } }
export function saveState(path, st) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path + '.tmp', JSON.stringify(st, null, 1)); renameSync(path + '.tmp', path); }

/** What a pass did, for the log: one JSON line, and in --dry each alert written out. */
export function report(r, cfg) {
  const out = [JSON.stringify({ hw: 'pass', at: new Date(r.facts.nowMs).toISOString(), dry: cfg.dry, load: r.facts.load,
    seats: `${r.facts.seats.filter((s) => s.ok).length}/${r.facts.seats.length}`, lists: `${r.facts.lists.filter(Boolean).length}/${r.facts.lists.length}`,
    problems: r.problems.map((p) => `${p.alert ? '!' : '-'} ${p.key}: ${p.title}`),
    fixes: r.fixes.map((x) => `${x.allowed ? (cfg.dry ? 'would' : 'do') : 'held'} ${x.kind} ${x.unit || (x.txid ? x.txid.slice(0, 8) : `${x.chain ? `${x.chain} ` : ''}${(x.txids || []).length} txid(s)`)}${x.blocked.length ? ` (${x.blocked.join('; ')})` : ''}`),
    did: r.did.map((x) => `${x.kind} ${x.unit || x.chain || (x.txid || '').slice(0, 8)}${x.txids ? ` ${x.txids.map((t) => t.slice(0, 8)).join(',')}` : ''}${x.dry ? ' (dry)' : x.ok ? ' ok' : ' FAILED'}${x.why ? `: ${x.why}` : ''}`),
    alerts: r.alerts.map((a) => `${a.kind} ${a.key}${a.dry ? ' (dry: not posted)' : a.ok ? ' posted' : ` NOT POSTED ${a.why}`}`) })];
  if (cfg.dry) {
    for (const p of r.problems) out.push(`--- detected ${p.key}${p.alert ? '' : ' (no alert yet)'}\n${alertText(p, cfg, null)}`);
    for (const a of r.alerts) out.push(`--- would post (${a.kind}):\n${a.text}`);
  }
  return out.join('\n');
}

async function main() {
  const cfg = config(process.env, process.argv.slice(2)), io = realIo(cfg);
  for (;;) {
    const t0 = Date.now();
    try {
      const r = await pass(io, cfg, loadState(cfg.statePath));
      saveState(cfg.statePath, r.state);
      console.log(report(r, cfg));
    } catch (e) { console.log(JSON.stringify({ hw: 'pass failed', at: new Date().toISOString(), why: e.stack || e.message })); }
    if (cfg.once) break;
    await new Promise((ok) => setTimeout(ok, Math.max(30000, cfg.intervalMs - (Date.now() - t0))));
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
