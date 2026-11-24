// Audit opr round 7-2 finding 1 (#3374 bypass): the #3374 fix lets a key's FIRST attempt of a round count only the address's PLAYED attempts
// (state 'scored' or 'rejected', opr-service.mjs:290). But "played" costs the stranger nothing: a submit of a malformed log right after the
// attempt opened is 'rejected' at once (nothing stored, no game time waited). A stranger behind the same public IPv4 as honest players (carrier
// CGNAT, cafe/campus Wi-Fi) opens 10 attempts from two free keys and sends one junk submit for each - a few seconds - and every other player on
// that address is refused "this address opened all the attempts it may in this round" before its first run, for the whole 24-hour round.
// The safe behaviour: a player who has opened no attempt of the round is not refused its first one because of other keys' throw-away attempts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createOpr } from '../server/opr-service.mjs';
import { stubSim, candles48 } from './server-helpers.mjs';

test('a stranger behind the same public IPv4 who "plays" 10 junk submits does not keep an honest player out of the daily round', async () => {
  let t = Date.parse('2026-11-23T00:01:00Z');
  const opr = createOpr({ now: () => t, sim: stubSim, fetchCandles: async (d) => candles48(d), checkLevel: async () => ({ ok: true, seed: 7, tries: 1, hash: 'h' }),
    log: () => {}, cfg: { entrySats: 0 } });   // the defaults: free daily rounds, 5 attempts, ipAttemptsShare 2
  await opr.tick(); await opr.tick(); await opr.tick();
  const r = opr.currentRound();
  assert.equal(r.id, '2026-11-23');
  const shared = '198.51.100.23';
  const refusals = [];
  for (const pk of [randomBytes(32).toString('hex'), randomBytes(32).toString('hex')]) {
    for (let k = 0; k < 5; k++) {
      const s = await opr.startAttempt(pk, { round: r.id, ip: shared }); assert.ok(s.ok, s.why);
      // one junk submit, at once: refused as malformed, state 'rejected', no log kept
      const out = await opr.submitChecked(pk, { attempt: s.attempt, token: s.token, log: 'x' }, { ip: shared });
      assert.equal(out.ok, false); refusals.push(out.why);
    }
  }
  assert.equal(opr.db.prepare("SELECT COUNT(*) AS n FROM attempts WHERE round = ? AND state = 'rejected' AND log IS NULL").get(r.id).n, 10, 'ten throw-away refusals, nothing stored');
  t += 2 * 60000;
  const honest = randomBytes(32).toString('hex');
  const a = await opr.startAttempt(honest, { round: r.id, ip: shared });
  t += 12 * 3600000;
  const later = await opr.startAttempt(randomBytes(32).toString('hex'), { round: r.id, ip: shared });
  assert.ok(a.ok && later.ok, `an honest player's first attempt is refused because a stranger on its address sent 10 junk submits (${refusals[0]}): "${a.why}" (12 h later still: "${later.why}")`);
});
