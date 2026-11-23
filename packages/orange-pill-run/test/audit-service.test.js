// Audit (service lens), find-only: failing tests for holes in the round service's HTTP door.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { statSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createOpr } from '../server/opr-service.mjs';
import { world, keypair, signIn, at, MIN, stubSim, candles48, fakeLnd, fakeChain } from './server-helpers.mjs';

async function serve(w) {
  const srv = createServer((q, s) => w.opr.handle(q, s));
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const call = async (method, path, { body, kp, admin, headers: extra = {} } = {}) => {
    const raw = body === undefined ? '' : JSON.stringify(body);
    const headers = { 'content-type': 'application/json', ...extra };
    if (kp) headers.authorization = signIn(kp, { path: path.split('?')[0], method, body: raw, createdAt: Math.floor(w.clock.now() / 1000) });
    if (admin) headers['x-arena-admin'] = admin;
    const r = await fetch(base + path, { method, headers, body: method === 'POST' ? raw : undefined });
    return { status: r.status, json: await r.json() };
  };
  return { srv, call };
}

test('AUDIT admin lockout: 30 wrong codes from 6 addresses (one IPv6 /64) lock the owner out of every admin route', async () => {
  const w = world({ start: '2026-11-22T10:00:00Z', cfg: { workerKey: 'wk-secret' } });
  const { srv, call } = await serve(w);
  try {
    // the stranger, through the stage Worker: each request carries its cf-connecting-ip as x-arena-ip under the Worker's key
    for (let n = 1; n <= 6; n++) for (let i = 0; i < 5; i++) {
      await call('GET', '/admin/rounds', { admin: 'guess', headers: { 'x-arena-worker': 'wk-secret', 'x-arena-ip': `2001:db8:1:2::${n}` } });
    }
    // the owner, from their own address, with the RIGHT code
    const owner = await call('GET', '/admin/rounds', { admin: 'letmein', headers: { 'x-arena-worker': 'wk-secret', 'x-arena-ip': '203.0.113.7' } });
    // and on the test host itself (127.0.0.1, as the funnel path /opr arrives too)
    const local = await call('GET', '/admin/rounds', { admin: 'letmein' });
    assert.equal(owner.status, 200, `the owner with the right code got ${owner.status}: ${owner.json.why}`);
    assert.equal(local.status, 200, `local admin with the right code got ${local.status}`);
  } finally { srv.close(); }
});

test('AUDIT admin lockout over the funnel: 5 wrong codes from anyone on the internet lock the shared 127.0.0.1 key', async () => {
  const w = world({ start: '2026-11-22T10:00:00Z', cfg: { workerKey: 'wk-secret' } });
  const { srv, call } = await serve(w);
  try {
    // https://<host>.ts.net/opr/admin/... arrives with remoteAddress 127.0.0.1, no Worker key, and the funnel's X-Forwarded-For (#3284: refused
    // as an admin caller before any count - the faucet reads the same header from the same funnel)
    for (let i = 0; i < 5; i++) {
      const g = await call('GET', '/admin/rounds', { admin: i === 4 ? 'letmein' : 'guess', headers: { 'x-forwarded-for': '198.51.100.66', 'tailscale-funnel-request': '?1' } });
      assert.equal(g.status, 403, `a funnel request is no admin caller (${g.json.why})`);
    }
    const local = await call('GET', '/admin/rounds', { admin: 'letmein' });   // the owner's curl on the test host
    assert.equal(local.status, 200, `the right code on 127.0.0.1 got ${local.status}: ${local.json.why}`);
  } finally { srv.close(); }
});

test('AUDIT storage: fresh keys from one address each store 5 refused 250 KB logs - no per-address cap', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'opr-audit-'));
  const dbPath = join(dir, 'opr.db');
  let t = at('2026-11-22T10:00:00Z');
  const ch = fakeChain();
  const opr = createOpr({ dbPath, now: () => t, sim: stubSim, fetchCandles: async (d) => candles48(d), checkLevel: async () => ({ ok: true, seed: 7, tries: 1, hash: 'h' }),
    invoices: fakeLnd(), chain: ch, s2: null, log: () => {}, cfg: { adminSha: createHash('sha256').update('letmein').digest('hex'), showTest: true, entrySats: 0, workerKey: 'wk' } });
  const w = { opr, clock: { now: () => t } };
  const { srv, call } = await serve(w);
  try {
    const made = await call('POST', '/admin/test-round', { admin: 'letmein', body: { startMs: t + MIN, minutes: 60, chartDay: '2026-11-21' } });
    assert.equal(made.status, 200);
    await opr.tick(); await opr.tick(); ch.confirm(); await opr.tick();
    t += 2 * MIN;
    const before = statSync(dbPath).size + (statSync(dbPath + '-wal', { throwIfNoEntry: false })?.size || 0);
    const junk = 'x'.repeat(250 * 1024);
    const hdr = { 'x-arena-worker': 'wk', 'x-arena-ip': '198.51.100.9' };   // ONE address
    let stored = 0, refused = 0;
    for (let k = 0; k < 20; k++) {
      const kp = keypair();
      for (let i = 0; i < 5; i++) {
        const s = await call('POST', '/attempt', { kp, body: { n: i }, headers: hdr });
        if (s.status !== 200) { assert.match(s.json.why, /this address opened all the attempts/); refused++; continue; }   // #3283: the address cap
        const r = await call('POST', '/submit', { kp, body: { attempt: s.json.attempt, token: s.json.token, log: junk }, headers: hdr });
        assert.equal(r.json.ok, false);
        stored++;
      }
    }
    const rows = opr.db.prepare("SELECT COUNT(*) AS n, SUM(LENGTH(log)) AS b FROM attempts WHERE ip = '198.51.100.9'").get();
    const after = statSync(dbPath).size + (statSync(dbPath + '-wal', { throwIfNoEntry: false })?.size || 0);
    console.log(`one address: ${rows.n} attempts (${refused} refused at /attempt), ${Math.round(rows.b / 1024)} KB of refused logs kept, db grew ${Math.round((after - before) / 1024)} KB`);
    assert.ok(rows.n <= 10, `one address opened ${rows.n} attempts with fresh keys`);
    assert.ok(rows.b < 1024 * 1024, `one address made the service keep ${Math.round(rows.b / 1024)} KB of junk`);
  } finally { srv.close(); opr.close(); }
});

test('AUDIT CPU: N strangers\' refused runs make the bot pass quadratic - GET /admin/runs and the list write block the event loop', async () => {
  const w = world({ start: '2026-11-22T10:00:00Z', cfg: { entrySats: 0 } });
  const opr = w.opr;
  const made = opr.testRound({ startMs: w.clock.now() + MIN, minutes: 60, chartDay: '2026-11-21', maxAttempts: 99 });
  assert.ok(made.ok, made.why);
  await opr.tick(); await opr.tick(); w.chain.confirm(); await opr.tick();
  w.clock.add(2 * MIN);
  // one log of 5,000 presses, the same for everyone (each run refused "too fast" - it is stored all the same)
  const log = { v: stubSim.GAME_VERSION, presses: Array.from({ length: 5000 }, (_, i) => [2 * i, 2 * i + 1]) };
  const N = 600;
  for (let k = 0; k < N; k++) {
    const p = `${String(k).padStart(8, '0')}${'a'.repeat(56)}`;
    const ip = `198.51.${100 + (k >> 8)}.${k & 255}`;   // one address per key: one address opens at most 2 players' attempts (#3283)
    const s = await opr.startAttempt(p, { round: made.round.id, ip });
    assert.ok(s.ok, s.why);
    const r = opr.submit(p, { attempt: s.attempt, token: s.token, log }, { ip });
    assert.equal(r.ok, false);   // too fast
  }
  const { srv, call } = await serve(w);
  try {
    const t0 = performance.now();
    const r = await call('GET', `/admin/runs?round=${made.round.id}`, { admin: 'letmein' });
    const ms = performance.now() - t0;
    console.log(`${N} refused runs: GET /admin/runs took ${Math.round(ms)} ms (status ${r.status})`);
    // the round ends; an hour later the tick writes the lists (botsOf again), then ANY signed-in key saving a Lightning address rebuilds them
    w.clock.set(made.round.endMs + 61 * MIN);
    const t1 = performance.now(); await opr.tick(); const tickMs = performance.now() - t1;
    const kp = keypair();
    const t2 = performance.now(); const ln = await call('POST', '/lnaddress', { kp, body: { address: 'someone@example.com' } }); const lnMs = performance.now() - t2;
    console.log(`list write in the tick ${Math.round(tickMs)} ms; one stranger's POST /lnaddress ${Math.round(lnMs)} ms (status ${ln.status})`);
    assert.ok(ms < 1000 && tickMs < 1000, `${N} strangers' refused runs stall the single-threaded service: admin read ${Math.round(ms)} ms, list write in the tick ${Math.round(tickMs)} ms`);
  } finally { srv.close(); }
});
