// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE HEALTH WATCHER (kanban #759): tools/health-watcher.mjs against a fake world. The #757 outage (10-28 ~10:00Z: 120 RPS, 36 Next Block,
// 16 Up/Down rounds in the hour, none seated, 2 of the 9 drawn our live seats) must alert on seating; a test host seat down must be restarted -
// and held at load >= 12 or in the seating minutes; an alert is said again at most once an hour, and "resolved" once the problem is gone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { config, pass, assess, alertsDue, inRestartMinutes, emergencyGrid } from '../tools/health-watcher.mjs';

// 2026-10-28 10:05:50Z: :05 of a quarter - a restart minute
const NOW = Date.UTC(2026, 9, 28, 10, 5, 50);
const K = (i) => String(i).padStart(2, '0').repeat(32);
const RPS = 'aa'.repeat(32), NB = 'bb'.repeat(32), UD = 'cc'.repeat(32);
const GAMES = [{ id: RPS, name: 'rock-paper-scissors' }, { id: NB, name: 'nextblock' }, { id: UD, name: 'btc-updown-15m' }];
const TEST HOST = [31221, 31231, 31241, 31251, 31261, 31271, 31281].map((p) => `http://127.0.0.1:${p}`);
const MAC = [6221, 6231, 6241, 6251, 6261, 6271, 6281].map((p) => `http://192.0.2.226:${p}`);
const SEATKEY = new Map([...TEST HOST, ...MAC].map((b, i) => [b, K(i + 10)]));
// the drawn game committee of every #757 round: 2 of our seats, 7 stopped test nodes
const DRAWN = [K(10), K(17), ...Array.from({ length: 7 }, (_, i) => K(60 + i))];
let n = 0;
const round = (game, { seated = false, open = true, inMin = 5 } = {}) => {
  const start = NOW + inMin * 60000;
  return { id: (++n).toString(16).padStart(8, '0').padEnd(64, 'f'), entryOpen: open, played: true, game: { id: game, name: GAMES.find((g) => g.id === game).name },
    startTimeMs: String(start), entryCloseMs: String(start + 80000),
    committee: { drawn: { game: DRAWN, settlement: DRAWN }, seated: { game: seated, settlement: seated }, drawnCount: { game: 9, settlement: 9 } } };
};
const times = (k, f) => Array.from({ length: k }, (_, i) => f(i));
const OUTAGE = { games: GAMES, rounds: [...times(120, (i) => round(RPS, { inMin: i % 60 })), ...times(36, (i) => round(NB, { inMin: i % 60 })), ...times(4, () => round(UD)),
  ...times(12, () => round(UD, { open: false, inMin: 30 }))] };
const HEALTHY = { games: GAMES, rounds: [...times(10, (i) => round(RPS, { seated: true, inMin: i * 5 })), ...times(4, (i) => round(NB, { seated: true, inMin: i * 15 })), round(UD, { seated: true })] };
const DUTY = { days: [{ period: 'today', covers: '2026-10-28', order: [], apps: ['btc-updown-15m', 'rock-paper-scissors', 'nextblock'].map((name) => ({ name, role: 'primary', state: 'posted', postings: [{}] })) },
  { period: 'next', covers: '2026-10-29', order: [], apps: ['btc-updown-15m', 'rock-paper-scissors', 'nextblock'].map((name) => ({ name, role: 'primary', state: 'posted', postings: [{}] })) }] };

// a fake world: what each door answers, the load, the units; it records restarts, miner C appends and chat posts
function world({ rounds = OUTAGE, load = [3, 3, 3], down = [], at = NOW, duty = DUTY, pending = { tip: 157830, txs: [] }, minerList = [] } = {}) {
  const w = { now: at, load, down: new Set(down), rounds, duty, pending, minerList: new Set(minerList), restarts: [], adds: [], posts: [], nRestarts: {} };
  w.io = {
    now: () => w.now,
    loadavg: async () => w.load,
    topProcs: async () => 'node 90%',
    identity: async (base) => (w.down.has(base) ? { ok: false, why: 'ECONNREFUSED' } : { ok: true, key: SEATKEY.get(base) }),
    get: async (base, path) => {
      if (w.down.has(base)) return { ok: false, why: 'ECONNREFUSED' };
      if (path === '/rounds?next=8') return { ok: true, body: w.rounds };
      if (path === '/duty') return { ok: true, body: w.duty };
      if (path === '/pending') return { ok: true, body: w.pending };
      if (path === '/roles') return { ok: true, body: { nodes: [] } };
      return { ok: false, why: 'HTTP 404' };
    },
    units: async (units) => Object.fromEntries(units.map((u) => [u, { active: 'active', sub: 'running', nRestarts: w.nRestarts[u] || 0 }])),
    restartUnit: async (u) => { w.restarts.push(u); },
    minercCheck: async (txids) => ({ listed: txids.filter((t) => w.minerList.has(t)), missing: txids.filter((t) => !w.minerList.has(t)) }),
    minercAdd: async (txids) => { w.adds.push(txids); for (const t of txids) w.minerList.add(t); },
    post: async (text) => { w.posts.push(text); },
  };
  return w;
}
const CFG = config({ HW_STATE: '/nonexistent/hw.json' }, []);
const passes = async (w, k, st = {}, cfg = CFG) => { let r; for (let i = 0; i < k; i++) { r = await pass(w.io, cfg, st); st = r.state; w.now += 180000; } return { r, st }; };

test('#757: rounds listed, none seated, 2 of 9 drawn live - a seating alert on the second pass, with the numbers and the runbook; no grid posted', async () => {
  const w = world();
  const first = await pass(w.io, CFG, {});
  const seat1 = first.problems.find((p) => p.key === 'seating');
  assert.ok(seat1, 'detected on the first pass');
  assert.equal(seat1.alert, false, 'alerted only once seen twice');
  assert.equal(w.posts.length, 0);
  w.now += 180000;
  const second = await pass(w.io, CFG, first.state);
  assert.equal(w.posts.length, 1);
  const msg = w.posts[0];
  assert.match(msg, /^\[health-watcher\] #757 @owner @a tester PROBLEM: no joinable rounds in the next hour: rock-paper-scissors, nextblock, btc-updown-15m/);
  assert.match(msg, /rock-paper-scissors: no joinable rounds - posted but not seated \(2 of 9 drawn answer\)/);
  assert.match(msg, /listed but not seated: 120 \(2 of 9 drawn answer\)/);
  assert.match(msg, /listed but not seated: 36 /);
  assert.match(msg, /listed but not seated: 16 /);
  assert.match(msg, /live seats among the drawn game committee of the unseated rounds: 2 of 9 \(172 rounds\) \(our 14 answering seats\)/);
  assert.match(msg, /Tried: nothing: an emergency grid is not posted automatically/);
  assert.match(msg, /Needs: an emergency grid .*systemd-run --user --unit=emergency1028-dry-<game> --collect -E DRY=1/s);
  assert.equal(w.restarts.length + w.adds.length, 0, 'nothing "fixed"');
  assert.deepEqual(second.fixes, []);
  await assert.rejects(emergencyGrid(), /not posted automatically/);
});

test('a test host seat down: restarted after two passes, one seat at a time; held at load >= 12 (alerted) and in the seating minutes', async () => {
  const down = TEST HOST[2];
  // load 3, at :05 of the quarter: pass 1 sees it, pass 2 restarts blwp-tn4-node@3
  let w = world({ rounds: HEALTHY, down: [down, MAC[1]] });
  let r = await pass(w.io, CFG, {}); assert.equal(w.restarts.length, 0);
  w.now += 60000;
  r = await pass(w.io, CFG, r.state);
  assert.deepEqual(w.restarts, ['blwp-tn4-node@3.service']);
  const d = r.fixes.find((x) => x.kind === 'restart-seat');
  assert.deepEqual([d.unit, d.allowed], ['blwp-tn4-node@3.service', true]);
  assert.ok(!r.problems.find((p) => p.key === `seat-down:${down}`).alert, 'the restart is the answer: no alert yet');
  // the test host seat is not ours to restart: alerted
  assert.ok(w.posts.some((t) => /seat 192\.168\.1\.226:6231 not answering/.test(t) && /restarted on the test host/.test(t)));
  // the recheck: still down -> "restart did not help", alerted, not restarted again within the hour
  w.now += 120000;
  r = await pass(w.io, CFG, r.state);
  assert.equal(w.restarts.length, 1);
  assert.ok(w.posts.some((t) => /#759 .*seat 127\.0\.0\.1:31241 not answering/.test(t) && /the recheck found it still down/.test(t) && /once per 60 min/.test(t)));

  // load 12.0 (1-min): held and alerted, with the load
  w = world({ rounds: HEALTHY, down: [down], load: [12, 11, 10] });
  r = await pass(w.io, CFG, {}); w.now += 60000; r = await pass(w.io, CFG, r.state);
  assert.equal(w.restarts.length, 0);
  const held = r.fixes.find((x) => x.kind === 'restart-seat');
  assert.equal(held.allowed, false);
  assert.match(held.blocked.join(), /1-min load 12 >= 12/);
  assert.equal(w.posts.length, 1);
  assert.match(w.posts[0], /restart of blwp-tn4-node@3\.service held: 1-min load 12 >= 12/);
  assert.match(w.posts[0], /Needs: the seat restarted by hand when safe: systemctl --user restart blwp-tn4-node@3\.service/);

  // in the seating minutes (:13): held, no alert before 20 min
  w = world({ rounds: HEALTHY, down: [down], at: Date.UTC(2026, 9, 28, 10, 12, 0) });
  r = await pass(w.io, CFG, {}); w.now += 60000; r = await pass(w.io, CFG, r.state);
  assert.equal(w.restarts.length, 0);
  assert.match(r.fixes[0].blocked.join(), /10:13 UTC is not :03-:08 of a quarter/);
  assert.equal(w.posts.length, 0);
  assert.equal(inRestartMinutes(Date.UTC(2026, 9, 28, 10, 3, 0)), true);
  assert.equal(inRestartMinutes(Date.UTC(2026, 9, 28, 10, 9, 0)), false);
  assert.equal(inRestartMinutes(Date.UTC(2026, 9, 28, 10, 59, 0)), false);

  // two seats down at once: only one restarts this pass
  w = world({ rounds: HEALTHY, down: [TEST HOST[0], TEST HOST[1]] });
  r = await pass(w.io, CFG, {}); w.now += 60000; r = await pass(w.io, CFG, r.state);
  assert.equal(w.restarts.length, 1);
  assert.match(r.fixes[1].blocked.join(), /another seat restarts this pass/);
});

test('dedupe: the same problem again only after an hour; resolved once it is gone two passes', async () => {
  const w = world();
  let { st } = await passes(w, 2);
  assert.equal(w.posts.length, 1);
  ({ st } = await passes(w, 19, st));   // 57 min more
  assert.equal(w.posts.filter((t) => /no joinable rounds/.test(t)).length, 1, 'not again within the hour');
  ({ st } = await passes(w, 2, st));    // past the hour
  const again = w.posts.filter((t) => /no joinable rounds/.test(t));
  assert.equal(again.length, 2);
  assert.match(again[1], /STILL \(since 10:0\d UTC\)/);
  // the seats seat the rounds: one pass gone - not resolved yet; the second - resolved, once
  w.rounds = HEALTHY;
  ({ st } = await passes(w, 1, st));
  assert.ok(!w.posts.some((t) => /RESOLVED/.test(t)));
  ({ st } = await passes(w, 3, st));
  const res = w.posts.filter((t) => /RESOLVED/.test(t));
  assert.equal(res.length, 1);
  assert.match(res[0], /^\[health-watcher\] #757 @owner @a tester RESOLVED: no joinable rounds in the next hour: .* \(since 10:0\d UTC, \d+ min\)$/);
  assert.deepEqual(st.alerts, {});
});

test('a post that fails is tried again on the next pass; --dry posts and fixes nothing', async () => {
  const w = world({ down: [TEST HOST[4]] });
  let fail = true; const post = w.io.post; w.io.post = async (t) => { if (fail) throw new Error('chat HTTP 502'); return post(t); };
  let { r, st } = await passes(w, 2);
  assert.ok(r.alerts.every((a) => a.ok === false));
  fail = false;
  ({ r } = await passes(w, 1, st));
  assert.ok(w.posts.some((t) => /no joinable rounds/.test(t)));
  const dry = config({ HW_STATE: '/x/hw.json', HW_DRY: '1' }, []);
  assert.equal(dry.statePath, '/x/hw.dry.json');
  const w2 = world({ down: [TEST HOST[4]] });
  ({ r } = await passes(w2, 2, {}, dry));
  assert.deepEqual([w2.posts.length, w2.restarts.length], [0, 0]);
  assert.ok(r.did.some((x) => x.kind === 'restart-seat' && x.dry));
  assert.ok(r.alerts.some((a) => a.key === 'seating' && a.dry));
});

test('pending txs: old and unlisted - appended to miner C\'s list once, rechecked; listed and stuck two hours - alerted; tip stalled', async () => {
  const T1 = '11'.repeat(32), T2 = '22'.repeat(32);
  const w = world({ rounds: HEALTHY, pending: { tip: 157830, txs: [{ txid: T1, kind: 'grid publication', game: 'nextblock', inMempool: true }, { txid: T2, kind: 'bond', confirmations: 3 }] } });
  let { r, st } = await passes(w, 10);   // 30 min
  assert.deepEqual(w.adds, [[T1]], 'only the unconfirmed one, once');
  ({ r, st } = await passes(w, 5, st));
  assert.equal(w.adds.length, 1);
  assert.equal(st.fixes['minerc-add'].recheck, 'helped');
  ({ r, st } = await passes(w, 26, st)); // past two hours: listed and still unconfirmed, and no block for 90 min
  assert.ok(w.posts.some((t) => /^\[health-watcher\] #759 .*PROBLEM: 1 listed tx\(s\) unconfirmed for \d+ min/.test(t) && /1111111111 grid publication nextblock/.test(t)));
  assert.ok(w.posts.some((t) => /PROBLEM: no new block for \d+ min \(tip 157830\)/.test(t)));
});

test('posting: tomorrow unposted after 18:00Z and today unposted are problems; load above 12 is alerted; a crash-looping seat is alerted', async () => {
  const duty = structuredClone(DUTY);
  duty.days[1].apps[2].state = 'due'; duty.days[1].apps[2].postings = [];
  const w = world({ rounds: HEALTHY, duty, at: Date.UTC(2026, 9, 28, 19, 4, 0), load: [13.1, 14.2, 15.7] });
  const { st } = await passes(w, 2);
  assert.ok(w.posts.some((t) => /PROBLEM: tomorrow \(2026-10-29\) has no posting for nextblock/.test(t) && /primary: due \(0 posting\(s\)\)/.test(t)));
  assert.ok(w.posts.some((t) => /PROBLEM: test host 15-min load 15\.7 > 12/.test(t) && /top: node 90%/.test(t)));
  // before 18:00Z tomorrow's posting is not late yet
  const early = assess({ nowMs: Date.UTC(2026, 9, 28, 12, 4, 0), load: [1, 1, 1], seats: [], units: {}, lists: [HEALTHY], games: GAMES, duty: [duty], pending: [], answering: [], minerc: null }, {}, CFG);
  assert.ok(!early.problems.some((p) => p.key.startsWith('posting:')));
  // NRestarts 12 -> 16 in the hour
  w.nRestarts['blwp-tn4-node@1.service'] = 12;
  let s = st; ({ st: s } = await passes(w, 1, s));
  w.nRestarts['blwp-tn4-node@1.service'] = 16;
  await passes(w, 1, s);
  assert.ok(w.posts.some((t) => /PROBLEM: blwp-tn4-node@1\.service restarting over and over/.test(t) && /NRestarts 12 -> 16/.test(t)));
  assert.equal(alertsDue([], { alerts: {} }, CFG, NOW).length, 0);
});

test('importing the tool does nothing: no read, no timer', async () => {
  const before = process.getActiveResourcesInfo().filter((x) => x === 'Timeout').length;
  await import('../tools/health-watcher.mjs?again');
  assert.equal(process.getActiveResourcesInfo().filter((x) => x === 'Timeout').length, before);
});
