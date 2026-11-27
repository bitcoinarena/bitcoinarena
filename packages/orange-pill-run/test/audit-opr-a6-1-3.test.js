// Audit opr round 6-1 finding 3: GET /board and GET /rounds need no sign-in and are not cached (the Worker says "nothing is cached"), yet
// each one rebuilds the whole board on the one thread: every scored run of the round parsed (runsOf), a players read per board row (nameOf),
// and for /board a second board plus an X read, a first-run read and a bot-list read per player (xOf); /rounds does the board of each of the
// last 30 rounds. A stranger repeating a cheap unsigned GET stalls every start and submit. The safe behaviour: a public read costs a bounded
// few milliseconds, whatever the round holds.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { createOpr } from '../server/opr-service.mjs';
import { stubSim, candles48, logOf } from './server-helpers.mjs';

test('one unsigned GET /board or GET /rounds holds the service for a time that grows with the round\'s runs', async () => {
  let t = Date.parse('2026-11-23T00:01:00Z');
  const opr = createOpr({ now: () => t, sim: stubSim, fetchCandles: async (d) => candles48(d), checkLevel: async () => ({ ok: true, seed: 7, tries: 1, hash: 'h' }),
    log: () => {}, cfg: { entrySats: 0, ipAttemptsShare: 1e9, showTest: true } });
  await opr.tick(); await opr.tick(); await opr.tick();
  const r = opr.currentRound();
  // 1,000 players with their own X link (as POST /x leaves it; written directly to skip the X check's minute limits), 5 runs each
  const linkX = opr.db.prepare('INSERT INTO x_links (pubkey, user_id, username, linked_ms, checked_ms) VALUES (?, ?, ?, ?, ?)');
  const open = [];
  for (let i = 0; i < 1000; i++) {
    const pk = randomBytes(32).toString('hex');
    linkX.run(pk, `u${i}`, `user${i}`, t - 1000, t);
    for (let k = 0; k < 5; k++) { const s = await opr.startAttempt(pk, { round: r.id, ip: `10.${i >> 8}.${i & 255}.${k}` }); assert.ok(s.ok, s.why); open.push([pk, s, i]); }
  }
  t += 70000;
  for (const [pk, s, i] of open) assert.ok(opr.submit(pk, { attempt: s.attempt, token: s.token, log: logOf(12 + (i % 40)) }, {}).ok);
  const srv = createServer((q, s) => opr.handle(q, s));
  await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    const timed = async (path) => { let ms = 0; for (let i = 0; i < 5; i++) { const t0 = performance.now(); const x = await fetch(base + path); assert.equal(x.status, 200); await x.json(); ms += performance.now() - t0; } return ms / 5; };
    await timed('/round');   // warm-up
    const board = await timed('/board'), rounds = await timed('/rounds');
    console.log(`1,000 players x 5 runs: GET /board ${board.toFixed(0)} ms, GET /rounds ${rounds.toFixed(0)} ms (unsigned, uncached)`);
    assert.ok(board < 25 && rounds < 25, `an unsigned GET holds the one-thread service: /board ${board.toFixed(0)} ms, /rounds ${rounds.toFixed(0)} ms per request at 1,000 players - a few requests a second from a stranger stall every start and submit`);
  } finally { srv.close(); }
});
