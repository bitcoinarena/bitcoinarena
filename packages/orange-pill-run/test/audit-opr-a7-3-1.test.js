// Audit opr round 7-3 finding 1 (gap in #3374 / bypass of #3283's per-address cap): since #3374 a key's FIRST attempt of a round counts only
// the address's played attempts (opr-service.mjs:290, 328-329). Keys are free, so one address that never submits opens one attempt per fresh
// key without any bound: every POST /attempt is a new 'started' row of the round. ipFull itself walks all of that address's rows of the round
// on every call, and the per-submit ipCrowd count (COUNT(DISTINCT player) ... AND ip = ?, no index on ip) and the board's attempts count read
// every row of the round - so the stranger's free rows make each honest request of the round slower, without limit.
// The safe behaviour: one address cannot open attempts without bound in a round (the #3283 cap holds for never-played attempts too).
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createOpr } from '../server/opr-service.mjs';
import { stubSim, candles48 } from './server-helpers.mjs';

test('one address cannot open never-played attempts from fresh keys without bound (#3283 cap, #3374 first-attempt rule)', async () => {
  let t = Date.parse('2026-11-23T00:01:00Z');
  const opr = createOpr({ now: () => t, sim: stubSim, fetchCandles: async (d) => candles48(d), checkLevel: async () => ({ ok: true, seed: 7, tries: 1, hash: 'h' }),
    log: () => {}, cfg: { entrySats: 0 } });
  await opr.tick(); await opr.tick(); await opr.tick();
  const r = opr.currentRound();
  assert.equal(r.max_attempts, 5);
  const ip = '198.51.100.9';   // one public IPv4 (one ip_key)
  const N = 20000;
  let opened = 0;
  const t0 = performance.now();
  let lastMs = 0;
  for (let i = 0; i < N; i++) {
    const pk = randomBytes(32).toString('hex');
    const s0 = performance.now();
    const s = await opr.startAttempt(pk, { round: r.id, ip });
    if (i >= N - 200) lastMs += performance.now() - s0;
    if (s.ok) opened++;
  }
  const allMs = performance.now() - t0;
  // an honest player elsewhere: one attempt and its submit, timed
  const hon = randomBytes(32).toString('hex');
  const a = await opr.startAttempt(hon, { round: r.id, ip: '192.0.2.44' });
  assert.ok(a.ok, a.why);
  t += 70000;
  const s1 = performance.now();
  const sub = opr.submit(hon, { attempt: a.attempt, token: a.token, log: { v: stubSim.GAME_VERSION, presses: [[1, 5], [10, 15]] } }, { ip: '192.0.2.44' });
  const subMs = performance.now() - s1;
  assert.ok(sub.ok, sub.why);
  const rows = opr.db.prepare('SELECT COUNT(*) AS n FROM attempts WHERE round = ? AND ip_key = ?').get(r.id, ip).n;
  console.log(`one IPv4 opened ${opened} of ${N} never-played attempts (${rows} rows) in ${(allMs / 1000).toFixed(1)} s; its last 200 POST /attempt cost ${(lastMs / 200).toFixed(2)} ms each on the one thread; an honest submit elsewhere then cost ${subMs.toFixed(1)} ms`);
  const most = 2 * r.max_attempts * 10;   // generous: ten players' worth of first attempts from one address
  assert.ok(opened <= most, `one address opened ${opened} attempts in one daily round from fresh keys it never played (cap of #3283: ${2 * r.max_attempts}) - the #3374 first-attempt rule counts only played attempts, so the rows grow without bound`);
});
