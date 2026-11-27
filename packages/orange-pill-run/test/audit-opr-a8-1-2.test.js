// Audit opr a8-1-2 (gap in #3354 / #3591): the kept public answers of GET /board, /round and /rounds are served again only while SQLite's
// total_changes() is unchanged (opr-service.mjs:1232 stamp). Every valid NIP-98 sign-in writes a row (auth_seen, seenAuth) before any route runs,
// and keys are free: a stranger who sends one signed GET /me from a fresh key before each unsigned GET /board moves the store state every time,
// so every GET /board rebuilds the whole board (every scored run parsed, an X/first-run/move/bot-list read per row) on the one thread, as before #3354.
// The safe behaviour: a stranger's own sign-ins (which change nothing on the board) do not make the public reads rebuild the board.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { createOpr } from '../server/opr-service.mjs';
import { stubSim, candles48, logOf, keypair, signIn } from './server-helpers.mjs';

test('a stranger\'s free sign-ins between unsigned public reads do not make every GET /board rebuild the board', async () => {
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
    let me = 0;
    for (let i = 0; i < 20; i++) {
      const kp = keypair();   // a fresh key: free
      const x = await fetch(base + '/me', { headers: { authorization: signIn(kp, { path: '/me', method: 'GET', createdAt: Math.floor(t / 1000) }) } });
      if (x.status === 200) me++; await x.json();
      await get('/board');   // the clock stands still: one second; the board itself unchanged
    }
    const ms = (performance.now() - t0) / 20, junk = builds;
    console.log(`same query x5: ${same} board builds; signed GET /me + GET /board x20 (${me} sign-ins taken): ${junk} board builds, ${ms.toFixed(0)} ms per pair at 1,000 players x 5 runs`);
    assert.equal(same, 0, 'the kept answer serves the same query');
    assert.equal(me, 20);
    assert.ok(junk <= 2, `20 unsigned GET /board, each after a stranger's signed GET /me from a fresh key, rebuilt the board ${junk} times (${ms.toFixed(0)} ms each pair on the one thread) - each sign-in's auth_seen row moves total_changes()`);
  } finally { srv.close(); }
});

test('#3737 keeps #3354: a write the board reads (a board player\'s new name, sent signed) shows at once, in the same second', async () => {
  const t = Date.parse('2026-11-23T00:01:00Z');
  let clock = t;
  const opr = createOpr({ now: () => clock, sim: stubSim, fetchCandles: async (d) => candles48(d), checkLevel: async () => ({ ok: true, seed: 7, tries: 1, hash: 'h' }),
    log: () => {}, cfg: { entrySats: 0 } });
  await opr.tick(); await opr.tick(); await opr.tick();
  const r = opr.currentRound(), kp = keypair();
  const s = await opr.startAttempt(kp.pk, { round: r.id, ip: '192.0.2.9' }); assert.ok(s.ok, s.why);
  clock += 70000;
  assert.ok(opr.submit(kp.pk, { attempt: s.attempt, token: s.token, log: logOf(20) }, {}).ok);
  const srv = createServer((q, res) => opr.handle(q, res));
  await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    const board = async () => (await (await fetch(base + '/board')).json()).board;
    assert.equal((await board()).length, 1);
    const body = JSON.stringify({ name: 'Fresh Name' });
    const x = await fetch(base + '/name', { method: 'POST', body, headers: { 'content-type': 'application/json', authorization: signIn(kp, { path: '/name', method: 'POST', body, createdAt: Math.floor(clock / 1000) }) } });
    assert.equal(x.status, 200, JSON.stringify(await x.json()));
    assert.equal((await board())[0].name, 'Fresh Name', 'the kept board is not served after a write it reads');
  } finally { srv.close(); }
});
