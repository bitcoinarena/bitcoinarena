// Audit opr round 7-2 finding 2 (gap in #3354): the kept public answers of GET /board, /round and /rounds are keyed by the whole query text
// (opr-service.mjs:1117 k = `${path}?${url.searchParams}`), and the site Worker passes any query on (worker.js: `${path}${url.search}`). A
// stranger who adds a junk parameter that changes with every request (/board?z=1, ?z=2, ... or /rounds?z=N, which rebuilds the boards of the
// last 30 rounds) misses the kept answer every time: each unsigned GET rebuilds the whole board again on the one thread, as before #3354.
// The safe behaviour: within one second and one store state, public reads of the same round are built once, whatever junk the query carries.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { createOpr } from '../server/opr-service.mjs';
import { stubSim, candles48, logOf } from './server-helpers.mjs';

test('a junk query parameter per request does not make every unsigned public read rebuild the board', async () => {
  let t = Date.parse('2026-11-23T00:01:00Z');
  const opr = createOpr({ now: () => t, sim: stubSim, fetchCandles: async (d) => candles48(d), checkLevel: async () => ({ ok: true, seed: 7, tries: 1, hash: 'h' }),
    log: () => {}, cfg: { entrySats: 0, ipAttemptsShare: 1e9 } });
  await opr.tick(); await opr.tick(); await opr.tick();
  const r = opr.currentRound();
  const linkX = opr.db.prepare('INSERT INTO x_links (pubkey, user_id, username, linked_ms, checked_ms, follows) VALUES (?, ?, ?, ?, ?, 1)');
  const open = [];
  for (let i = 0; i < 1000; i++) {
    const pk = randomBytes(32).toString('hex');
    linkX.run(pk, `u${i}`, `user${i}`, t - 1000, t);
    for (let k = 0; k < 5; k++) { const s = await opr.startAttempt(pk, { round: r.id, ip: `10.${i >> 8}.${i & 255}.${k}` }); assert.ok(s.ok, s.why); open.push([pk, s, i]); }
  }
  t += 70000;
  for (const [pk, s, i] of open) assert.ok(opr.submit(pk, { attempt: s.attempt, token: s.token, log: logOf(12 + (i % 40)) }, {}).ok);
  // count the board rebuilds: runsOf's read of every scored run of a round
  let builds = 0;
  const prep = opr.db.prepare.bind(opr.db);
  opr.db.prepare = (sql) => { if (sql.startsWith("SELECT * FROM attempts WHERE round = ? AND state = 'scored'")) builds++; return prep(sql); };
  const srv = createServer((q, s) => opr.handle(q, s));
  await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    const get = async (p) => { const x = await fetch(base + p); assert.equal(x.status, 200); await x.json(); };
    await get('/board'); builds = 0;
    for (let i = 0; i < 5; i++) await get('/board');   // the same query: kept (#3354)
    const same = builds; builds = 0;
    const t0 = performance.now();
    for (let i = 0; i < 20; i++) await get(`/board?z=${i}`);   // the clock stands still: one second, one store state
    const ms = (performance.now() - t0) / 20, junk = builds;
    console.log(`same query x5: ${same} board builds; junk query x20: ${junk} board builds, ${ms.toFixed(0)} ms per request at 1,000 players x 5 runs`);
    assert.equal(same, 0, 'the kept answer serves the same query');
    assert.ok(junk <= 2, `20 unsigned GET /board with a changing junk parameter rebuilt the board ${junk} times (${ms.toFixed(0)} ms each on the one thread) - the #3354 kept answer is keyed by the query text`);
  } finally { srv.close(); }
});
