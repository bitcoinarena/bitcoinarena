// Audit opr round 6-3 finding 1: the per-address attempt cap of #3283 (ipFull, opr-service.mjs:255) counts every attempt any key opened from one
// IPv4 address (ipKey keeps the whole IPv4) against ipAttemptsShare x max_attempts = 10 in a daily round - and an attempt counts from the moment
// it is opened, submitted or not. A stranger behind the same public IPv4 as honest players (one carrier CGNAT address, a cafe or campus Wi-Fi, an
// office) opens 10 attempts from two fresh keys in a few seconds and submits nothing: every other player on that address is refused
// "this address opened all the attempts it may in this round" for the rest of the 24-hour round, before their first run.
// The safe behaviour: a player who has opened no attempt of the round is not refused its first one because of other keys' attempts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createOpr } from '../server/opr-service.mjs';
import { stubSim, candles48 } from './server-helpers.mjs';

test('a stranger behind the same public IPv4 does not keep an honest player out of the daily round', async () => {
  let t = Date.parse('2026-11-23T00:01:00Z');
  const opr = createOpr({ now: () => t, sim: stubSim, fetchCandles: async (d) => candles48(d), checkLevel: async () => ({ ok: true, seed: 7, tries: 1, hash: 'h' }),
    log: () => {}, cfg: { entrySats: 0 } });   // the defaults: free daily rounds, 5 attempts, ipAttemptsShare 2
  await opr.tick(); await opr.tick(); await opr.tick();
  const r = opr.currentRound();
  assert.equal(r.id, '2026-11-23');
  const shared = '198.51.100.23';   // one public IPv4 (as cf-connecting-ip names it) behind which many phones sit
  // the stranger: two fresh keys, five attempts each, opened and never played
  for (const pk of [randomBytes(32).toString('hex'), randomBytes(32).toString('hex')]) {
    for (let k = 0; k < 5; k++) { const s = await opr.startAttempt(pk, { round: r.id, ip: shared }); assert.ok(s.ok, s.why); }
  }
  t += 2 * 60000;
  // an honest player on the same address, its first attempt of the day
  const honest = randomBytes(32).toString('hex');
  const a = await opr.startAttempt(honest, { round: r.id, ip: shared });
  t += 12 * 3600000;
  const later = await opr.startAttempt(randomBytes(32).toString('hex'), { round: r.id, ip: shared });
  assert.ok(a.ok, `an honest player's first attempt is refused because a stranger on its address opened 10 attempts it never played: "${a.why}" (12 h later still: "${later.why}")`);
});
