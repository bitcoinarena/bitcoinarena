// Audit opr round 7-3 finding 2 (gap in #3333 / #3353): the X lookup the service runs on (opr-server.mjs: bounty-verify.js xByName with its
// default gap = spaced(3000)) serves ONE call per 3 s from an unbounded FIFO: every POST /x takes the next free 3-s slot, however far ahead.
// The service's own caps let far more in than that: 15 lookups per minute per caller address (an IPv6 /64), 150 per minute for all callers -
// and a key with any attempt in a round still listing (a free attempt costs nothing) is not held by the 150 at all (opr-service.mjs:542).
// So one stranger address with 15 fresh keys queues 45 s of X calls in one second, and three such addresses grow the queue faster than it
// drains, without end. Every honest POST /x waits behind it - its link is saved, with linked_ms of its own late save, after its first run -
// and the clock's tick waits too: at list time it awaits recheckRound (opr-service.mjs:978), so no round closes, no list is written, no daily
// round is made while the queue lasts.
// The safe behaviour: a stranger's burst of POST /x within the per-caller cap does not hold an honest X check or the tick for tens of seconds.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createOpr } from '../server/opr-service.mjs';
import { xByName, spaced } from '../../arena-node/src/bounty-verify.js';
import { stubSim, candles48, logOf } from './server-helpers.mjs';

test("a stranger's burst of POST /x within its caller cap does not hold an honest X check and the tick behind the X queue", async () => {
  let t = Date.parse('2026-11-23T20:00:00Z');
  // X itself answers at once; only the service's own spacing (the production default, spaced(3000)) is in the way
  const ids = new Map();
  const fetchFn = async (url) => { const name = new URL(url).searchParams.get('target_screen_name'); if (!ids.has(name)) ids.set(name, String(1000 + ids.size));
    return { status: 200, json: async () => ({ relationship: { target: { id_str: ids.get(name), screen_name: name, following: true } } }) }; };
  const xLookup = xByName({ session: async () => ({ ct0: 'c', cookie: 'auth_token=a; ct0=c' }), fetchFn, gap: spaced(3000) });
  const opr = createOpr({ now: () => t, sim: stubSim, fetchCandles: async (d) => candles48(d), checkLevel: async () => ({ ok: true, seed: 7, tries: 1, hash: 'h' }),
    xLookup, lnCheck: async (a) => ({ ok: true, address: a }), log: () => {}, cfg: { entrySats: 0 } });
  // the daily round of 2026-11-23 (the follow rule is on: it ends after followSince)
  t = Date.parse('2026-11-23T00:01:00Z'); await opr.tick(); await opr.tick(); await opr.tick();
  const r = opr.currentRound();
  t = Date.parse('2026-11-23T20:00:00Z');
  // an honest player who linked X earlier and played: the round's leader
  const hon = randomBytes(32).toString('hex');
  opr.db.prepare('INSERT INTO x_links (pubkey, user_id, username, linked_ms, checked_ms, follows, follows_ms) VALUES (?, ?, ?, ?, ?, 1, ?)').run(hon, '42', 'honest_one', t - 1000, t - 1000, t - 1000);
  await opr.saveLnAddress(hon, 'honest@walletofsatoshi.com');
  const a = await opr.startAttempt(hon, { round: r.id, ip: '192.0.2.44' }); assert.ok(a.ok, a.why);
  t += 70000; assert.ok(opr.submit(hon, { attempt: a.attempt, token: a.token, log: logOf(20) }, {}).ok);
  // round over, its grace hour over: the next tick closes it and, before writing its lists, asks X again about its best linked keys (#3534)
  t = r.end_ms + 61 * 60000;
  // ONE stranger address (one IPv6 /64), 15 fresh keys, one POST /x each: inside the per-caller cap of 15 a minute
  const ip = '2001:db8:1:2::77';
  const strangers = [];
  for (let i = 0; i < 15; i++) strangers.push(opr.saveX(randomBytes(32).toString('hex'), `stranger_${i}`, { ip }));
  await new Promise((ok) => setTimeout(ok, 50));
  // now an honest newcomer checks his X, and the service's clock ticks
  const s0 = performance.now();
  const newcomer = opr.saveX(randomBytes(32).toString('hex'), 'newcomer', { ip: '198.51.100.20' }).then((x) => ({ x, ms: performance.now() - s0 }));
  const ticked = opr.tick().then(() => ({ ms: performance.now() - s0 }));
  const LIMIT = 15000;
  const race = (p) => Promise.race([p, new Promise((ok) => setTimeout(() => ok({ ms: Infinity }), LIMIT))]);
  const [nc, tk] = await Promise.all([race(newcomer), race(ticked)]);
  const listed = opr.roundRow(r.id).state;
  console.log(`after one stranger address's 15 POST /x: the honest X check took ${nc.ms === Infinity ? `> ${LIMIT / 1000} s` : `${(nc.ms / 1000).toFixed(1)} s`}, the tick ${tk.ms === Infinity ? `> ${LIMIT / 1000} s` : `${(tk.ms / 1000).toFixed(1)} s`}; round ${r.id} is '${listed}' (lists ${opr.listsOf(r.id).length})`);
  try {
    assert.ok(tk.ms < LIMIT, `the tick waited more than ${LIMIT / 1000} s behind a stranger's 15 queued X lookups: round ${r.id} still '${listed}', no payout list written, no round closed or made meanwhile`);
    assert.ok(nc.ms < LIMIT, `an honest POST /x waited more than ${LIMIT / 1000} s behind a stranger's 15 queued X lookups`);
  } finally { await Promise.allSettled([...strangers, newcomer, ticked]); }
});
