// Audit opr round 8-3 finding 1 (gap in #3598, brings back #3374): the #3598 fix refuses a key's FIRST attempt once the caller's address holds
// ipUnplayedShare x share (10 x 10 = 100 in a daily round) attempts that keep nothing (opr-service.mjs:322). Keys are free and an attempt that is
// never sent costs nothing, so a stranger behind a shared public IPv4 (CGNAT, cafe/campus Wi-Fi) opens one attempt from each of 100 fresh keys -
// 100 POST /attempt, under a second - and every other player on that address is refused "this address opened all the attempts it may in this
// round" before its first run, for the rest of the 24-hour round: the #3374 lockout, now with 100 requests instead of 10.
// The safe behaviour: a player who opened no attempt of the round is not refused its first one because of other keys' throw-away attempts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createOpr } from '../server/opr-service.mjs';
import { stubSim, candles48 } from './server-helpers.mjs';

test("a stranger's 100 never-played first attempts from fresh keys on a shared IPv4 do not keep an honest player out of the daily round", async () => {
  let t = Date.parse('2026-11-23T00:01:00Z');
  const opr = createOpr({ now: () => t, sim: stubSim, fetchCandles: async (d) => candles48(d), checkLevel: async () => ({ ok: true, seed: 7, tries: 1, hash: 'h' }),
    log: () => {}, cfg: { entrySats: 0 } });   // the defaults: free daily rounds, 5 attempts, ipAttemptsShare 2, ipUnplayedShare 10
  await opr.tick(); await opr.tick(); await opr.tick();
  const r = opr.currentRound();
  assert.equal(r.id, '2026-11-23');
  const shared = '198.51.100.23';
  const t0 = process.hrtime.bigint();
  let opened = 0;
  for (let k = 0; k < 100; k++) {
    const s = await opr.startAttempt(randomBytes(32).toString('hex'), { round: r.id, ip: shared });
    if (s.ok) opened++;
  }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.equal(opened, 100, 'the stranger opened one attempt on each of 100 fresh keys');
  t += 2 * 60000;
  const honest = randomBytes(32).toString('hex');
  const a = await opr.startAttempt(honest, { round: r.id, ip: shared });
  t += 12 * 3600000;
  const later = await opr.startAttempt(randomBytes(32).toString('hex'), { round: r.id, ip: shared });
  assert.ok(a.ok && later.ok, `an honest player's first attempt is refused after a stranger opened 100 never-played attempts from fresh keys on its address (${Math.round(ms)} ms): "${a.why}" (12 h later still: "${later.why}")`);
});
