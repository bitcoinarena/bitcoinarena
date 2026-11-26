// Audit opr a8-2-3 (gap in #3590): for a key's FIRST attempt of a round, the #3590 fix counts only the address's KEPT runs - scored ones and
// refusals that stored their log (KEPT, opr-service.mjs:316). A wrong-game-version refusal stores its log (reject keepLog, opr-service.mjs:532)
// and is answered at once, with no game time waited. A stranger behind a shared public IPv4 (CGNAT, cafe/campus Wi-Fi) opens 10 attempts from
// two free keys and sends a tiny log { v: 'x', presses: [] } for each - a few seconds, 20 bytes kept per run - and every other player on that
// address is refused "this address opened all the attempts it may in this round" before its first run, for the whole 24-hour round.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createOpr } from '../server/opr-service.mjs';
import { stubSim, candles48 } from './server-helpers.mjs';

test('a stranger on a shared IPv4 who sends 10 instant wrong-version logs does not keep an honest player out of the daily round', async () => {
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
      // at once, no game time: a well-formed log of another game version - refused, its 20-byte log kept
      const out = await opr.submitChecked(pk, { attempt: s.attempt, token: s.token, log: { v: 'x', presses: [] } }, { ip: shared });
      assert.equal(out.ok, false); refusals.push(out.why);
    }
  }
  const kept = opr.db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(log_bytes), 0) AS b FROM attempts WHERE round = ? AND state = 'rejected' AND log IS NOT NULL").get(r.id);
  t += 2 * 60000;
  const honest = randomBytes(32).toString('hex');
  const a = await opr.startAttempt(honest, { round: r.id, ip: shared });
  t += 12 * 3600000;
  const later = await opr.startAttempt(randomBytes(32).toString('hex'), { round: r.id, ip: shared });
  assert.ok(a.ok && later.ok, `an honest player's first attempt is refused because a stranger on its address sent 10 instant wrong-version logs (${refusals[0]}; ${kept.n} kept, ${kept.b} bytes): "${a.why}" (12 h later still: "${later.why}")`);
});
