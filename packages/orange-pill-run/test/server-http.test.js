// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// #3248-#3250, #3256 over HTTP: the NIP-98 sign-in, the admin code with its failed-try limit, the whole path of a test round.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { world, keypair, signIn, logOf, at, MIN } from './server-helpers.mjs';

async function serve(w) {
  const srv = createServer((q, s) => w.opr.handle(q, s));
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const call = async (method, path, { body, kp, admin, sign = true } = {}) => {
    const raw = body === undefined ? '' : JSON.stringify(body);
    const headers = { 'content-type': 'application/json' };
    if (kp && sign) headers.authorization = signIn(kp, { path: path.split('?')[0], method, body: raw, createdAt: Math.floor(w.clock.now() / 1000) });
    if (admin) headers['x-arena-admin'] = admin;
    const r = await fetch(base + path, { method, headers, body: method === 'POST' ? raw : undefined });
    return { status: r.status, json: await r.json() };
  };
  return { srv, call };
}

test('#3248 the sign-in: needed, for this path and body, used once', async () => {
  const w = world({ start: '2026-11-22T10:00:00Z' });
  const { srv, call } = await serve(w);
  try {
    const p = keypair();
    assert.equal((await call('GET', '/me')).status, 401);
    assert.equal((await call('GET', '/me', { kp: p })).json.pubkey, p.pk);
    // a sign-in for another body
    const raw = JSON.stringify({ name: 'alice' });
    const auth = signIn(p, { path: '/name', method: 'POST', body: JSON.stringify({ name: 'mallory' }), createdAt: Math.floor(w.clock.now() / 1000) });
    let r = await fetch(`http://127.0.0.1:${srv.address().port}/name`, { method: 'POST', headers: { authorization: auth }, body: raw });
    assert.equal(r.status, 401);
    const good = signIn(p, { path: '/name', method: 'POST', body: raw, createdAt: Math.floor(w.clock.now() / 1000) });
    r = await fetch(`http://127.0.0.1:${srv.address().port}/name`, { method: 'POST', headers: { authorization: good }, body: raw });
    assert.equal(r.status, 200);
    r = await fetch(`http://127.0.0.1:${srv.address().port}/name`, { method: 'POST', headers: { authorization: good }, body: raw });
    assert.equal((await r.json()).why, 'that sign-in was used already');
    // the worker's /api/opr prefix is the same door
    assert.equal((await call('GET', '/api/opr/me', { kp: p })).status, 401);   // signed for /api/opr/me: the service names /me
  } finally { srv.close(); }
});

test('#3256 #3250 admin: wrong codes counted (5, then 429 also for the right one); a 30-minute test round over HTTP to its payout list', async () => {
  const w = world({ start: '2026-11-22T10:00:00Z' });
  const { srv, call } = await serve(w);
  try {
    const body = { startMs: at('2026-11-22T10:01:00Z'), minutes: 30, chartDay: '2026-11-21', by: 'owner' };
    const made = await call('POST', '/admin/test-round', { admin: 'letmein', body });
    assert.equal(made.status, 200, JSON.stringify(made.json));
    const id = made.json.round.id;
    await w.opr.tick(); await w.opr.tick(); w.chain.confirm(); await w.opr.tick();
    w.clock.set(at('2026-11-22T10:02:00Z'));
    const round = (await call('GET', '/round')).json.round;
    assert.equal(round.id, id); assert.equal(round.test, true); assert.equal(round.phase, 'open'); assert.equal(round.post.confirmed, true); assert.equal(round.post.height, 162700);
    const ps = [keypair(), keypair(), keypair()];
    for (const [i, p] of ps.entries()) {
      w.link(p.pk);
      for (let k = 0; k < 2; k++) {
        const s = await call('POST', '/attempt', { kp: p, body: { round: id } });
        assert.equal(s.status, 200, JSON.stringify(s.json));
        w.lnd.pay(s.json.invoice);
        const c = await call('POST', '/attempt/check', { kp: p, body: { attempt: s.json.attempt } });
        assert.equal(c.json.state, 'started'); assert.equal(c.json.level.gameVersion, 'opr-test-1'); assert.equal(c.json.level.candles.length, 48);
        w.clock.add(30000);
        const sub = await call('POST', '/submit', { kp: p, body: { attempt: s.json.attempt, token: c.json.token, log: logOf(10 + i * 3 + k) } });
        assert.equal(sub.status, 200, JSON.stringify(sub.json));
      }
    }
    const board = (await call('GET', `/board?round=${id}`)).json.board;
    assert.deepEqual(board.map((x) => [x.rank, x.score, x.attempts]), [[1, 170, 2], [2, 140, 2], [3, 110, 2]]);
    assert.ok(board.every((x) => x.player === undefined && x.flags === undefined));   // no keys, no bot signals in public
    for (let i = 0; i < 5; i++) assert.equal((await call('GET', `/admin/lists?round=${id}`, { admin: 'guess' + i })).status, 403);
    assert.equal((await call('GET', `/admin/lists?round=${id}`, { admin: 'letmein' })).status, 429);
    w.clock.add(16 * MIN);
    w.clock.set(at('2026-11-22T10:31:00Z')); await w.opr.tick();
    w.clock.add(61 * MIN); await w.opr.tick();
    const l = (await call('GET', `/admin/lists?round=${id}`, { admin: 'letmein' })).json;
    assert.deepEqual(l.lists.map((x) => [x.kind, x.state, x.sats]), [['pot', 'waiting', 600]]);
    // three keys from one address (127.0.0.1): the third key's runs are under review and held from the list until the admin clears them
    assert.deepEqual(l.lists[0].rows.map((x) => x.sats), [360, 240]);
    const runs = (await call('GET', `/admin/runs?round=${id}`, { admin: 'letmein' })).json.runs;
    const held = runs.filter((x) => x.review === 'pending');
    assert.ok(held.length >= 1 && held.every((x) => x.flags.ipCrowd === 3 && x.player === ps[2].pk));
    for (const h of held) assert.equal((await call('POST', '/admin/review', { admin: 'letmein', body: { attempt: h.attempt, action: 'clear' } })).status, 200);
    const l2 = (await call('GET', `/admin/lists?round=${id}`, { admin: 'letmein' })).json;
    assert.deepEqual(l2.lists[0].rows.map((x) => x.sats), [300, 180, 120]);
    // #3287: an approve names the version the owner reviewed - the version from before the review (2 rows) is refused, the rebuilt one approved
    const stale = await call('POST', '/admin/list', { admin: 'letmein', body: { round: id, kind: 'pot', action: 'approve', by: 'owner', version: l.lists[0].version } });
    assert.equal(stale.status, 409); assert.match(stale.json.why, /changed since you opened it/);
    assert.equal((await call('POST', '/admin/list', { admin: 'letmein', body: { round: id, kind: 'pot', action: 'approve', by: 'owner' } })).status, 409);   // no version
    const ok = await call('POST', '/admin/list', { admin: 'letmein', body: { round: id, kind: 'pot', action: 'approve', by: 'owner', version: l2.lists[0].version } });
    assert.equal(ok.json.list.state, 'approved');
    const pay = (await call('GET', '/admin/payable', { admin: 'letmein' })).json.lists;
    assert.equal(pay[0].approval.by, 'owner');
    const after = (await call('GET', `/board?round=${id}`)).json.board;
    const replay = await call('GET', after[0].replay);
    assert.equal(replay.status, 200); assert.equal(replay.json.level.candles.length, 48);
  } finally { srv.close(); }
});
