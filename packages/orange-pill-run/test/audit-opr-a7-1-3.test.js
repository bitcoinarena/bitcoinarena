// Audit opr a7-1-3: gap in the #3354 fix. GET /board, /round and /rounds are now served from kept answers, but GET /replay/<attempt> - also
// unsigned, the id taken from any board row - runs boardOf(round) on every request (every scored run of the round parsed, a players read per
// board row) just to see whether the run is a board row's best. A stranger repeating one public replay URL holds the one-thread service.
// The safe behaviour: a public replay read costs a bounded few milliseconds, whatever the round holds.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { createOpr } from '../server/opr-service.mjs';
import { stubSim, candles48, logOf } from './server-helpers.mjs';

test('one unsigned GET /replay/<id> of a board row holds the service for a time that grows with the round\'s runs', async () => {
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
    const rows = (await (await fetch(base + '/board')).json()).board;
    const rp = rows[rows.length - 1].replay;
    await timed(rp);   // warm-up
    const board = await timed('/board'), replay = await timed(rp);
    console.log(`1,000 players x 5 runs: GET /board ${board.toFixed(1)} ms (kept), GET ${rp.slice(0, 16)}... ${replay.toFixed(1)} ms (unsigned, uncached)`);
    assert.ok(replay < 25, `an unsigned GET /replay holds the one-thread service: ${replay.toFixed(0)} ms per request at 1,000 players (GET /board: ${board.toFixed(1)} ms) - a few requests a second from a stranger stall every start and submit`);
  } finally { srv.close(); }
});
