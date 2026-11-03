// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE SIGNED HISTORY, READ BY A SEAT (kanban #1093 part 2, ruling #1106): running totals per federation, carried into the next range; a session
// that does not verify is never counted; the first session where redemptions pass issues raises the alarm, and deposits stop.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createReserveAudit } from '../src/reserve-audit.js';
import { createReserveAlarms } from '../src/reserve-alarms.js';

const FED = 'ab'.repeat(32);
// a federation's history as the tool would read it: per session [issued, redeemed, pegOutTxid?]; the fake tool sums from carry, as briefed
function fakeTool(history, { unverified = new Set() } = {}) {
  const calls = [];
  const run = async (args) => {
    const a = Object.fromEntries(args.reduce((acc, x, i) => (x.startsWith('--') ? [...acc, [x.slice(2), args[i + 1]]] : acc), []));
    calls.push(a);
    const from = Number(a.from), to = Math.min(history.length - 1, from + Number(a['max-sessions']) - 1);
    let iss = BigInt(a['carry-issued-msat']), red = BigInt(a['carry-redeemed-msat']), first = null; const bad = [], pegs = [];
    for (let s = from; s <= to; s++) {
      if (unverified.has(s)) { bad.push(s); continue; }
      iss += BigInt(history[s][0]); red += BigInt(history[s][1]); if (history[s][2]) pegs.push(history[s][2]);
      if (first === null && red > iss) first = s;
    }
    return { mode: 'session-audit', federation: FED, sessions: Math.max(0, to - from + 1), lastSession: Math.max(from - 1, to), unverified: bad,
      cumulativeIssuedMsat: String(iss), cumulativeRedeemedMsat: String(red), firstInflationSession: first, pegOutTxids: pegs };
  };
  return { run, calls };
}
const book = () => { const kept = new Map(); return { load: (f) => kept.get(f) || null, save: (f, r) => kept.set(f, r), kept }; };

test('an honest history: totals carried from range to range, no alarm', async () => {
  const history = Array.from({ length: 450 }, (_, i) => [1000, i % 3 === 0 ? 900 : 0, i === 7 ? 'cc'.repeat(32) : null]);
  const t = fakeTool(history), b = book(), alarms = createReserveAlarms();
  const audit = createReserveAudit({ federations: async () => [{ federation: FED, dataDir: '/c' }], run: t.run, load: b.load, save: b.save, alarms, perPass: 200 });
  for (let i = 0; i < 3; i++) await audit.pass();
  const r = b.kept.get(FED);
  assert.deepEqual([r.lastSession, r.issuedMsat, r.redeemedMsat, r.pegOutTxids], [449, '450000', String(150 * 900), ['cc'.repeat(32)]]);
  assert.deepEqual(t.calls.map((c) => [c.from, c['carry-issued-msat']]), [['0', '0'], ['200', '200000'], ['400', '400000']], 'each range starts where the last stopped, carrying its totals');
  assert.equal(alarms.of(FED), null);
  assert.equal((await audit.pass())[0].sessions, 0, 'nothing new: no session asked that does not exist');
});

test('inflation across ranges: the carried totals catch it, the alarm names its session and deposits stop', async () => {
  const history = Array.from({ length: 300 }, () => [1000, 1000]);
  history[250] = [0, 5000];                 // e-cash redeemed that was never issued: minted outside consensus
  const t = fakeTool(history), b = book(), alarms = createReserveAlarms();
  const audit = createReserveAudit({ federations: async () => [{ federation: FED, dataDir: '/c' }], run: t.run, load: b.load, save: b.save, alarms, perPass: 200, height: async () => 158900 });
  assert.equal((await audit.pass())[0].alarm, undefined, 'the first 200 sessions are honest');
  const second = (await audit.pass())[0];
  assert.deepEqual([second.alarm, second.session], [true, 250]);
  assert.deepEqual([alarms.of(FED).kind, alarms.of(FED).session, alarms.of(FED).height], ['inflation', 250, 158900]);
});

test('a session that does not verify is never counted: the totals stop before it and it is asked again', async () => {
  const history = Array.from({ length: 50 }, () => [1000, 0]);
  const bad = new Set([20]);
  const t = fakeTool(history, { unverified: bad }), b = book(), alarms = createReserveAlarms();
  const audit = createReserveAudit({ federations: async () => [{ federation: FED, dataDir: '/c' }], run: t.run, load: b.load, save: b.save, alarms, perPass: 200 });
  const first = (await audit.pass())[0];
  assert.match(first.why, /session 20 does not verify/);
  assert.equal(b.kept.get(FED), undefined, 'nothing kept from a range with an unverified session');
  bad.clear();
  await audit.pass();
  assert.deepEqual([b.kept.get(FED).lastSession, b.kept.get(FED).issuedMsat], [49, '50000']);
});
