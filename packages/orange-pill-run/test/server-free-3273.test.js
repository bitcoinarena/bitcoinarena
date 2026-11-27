// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// #3273 the free round (owner 2026-11-22): entry 0 - a run starts at once with no invoice and lnd never asked, 5 a day, scored at submit,
// no pot, only the bounty list (2,500 real sats), the chain post carries entry 0. A paid round made earlier keeps its paid path.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { world, openRound, paidAttempt, keypair, signIn, logOf, MIN } from './server-helpers.mjs';
import { DEFAULTS } from '../server/opr-service.mjs';
import { decodeRoundPost } from '../server/opr-chain.mjs';

/** A world on the service's own default entry, with an lnd that fails the test if it is called at all. */
function freeWorld(o = {}) {
  const w = world({ start: '2026-11-23T01:00:00Z', ...o, cfg: { entrySats: DEFAULTS.entrySats, ...(o.cfg || {}) } });
  w.lndCalls = 0;
  w.lnd.create = async () => { w.lndCalls++; throw new Error('lnd called for a free round'); };
  w.lnd.lookup = async () => { w.lndCalls++; throw new Error('lnd called for a free round'); };
  return w;
}
const endRound = async (w, r) => { w.clock.set(r.end_ms); await w.opr.tick(); w.clock.add(60 * MIN); await w.opr.tick(); };

test('#3273 the default entry is 0: a free attempt starts at once, no invoice, lnd never called', async () => {
  assert.equal(DEFAULTS.entrySats, 0);
  const w = freeWorld(); const r = await openRound(w);
  assert.equal(r.entry_sats, 0);
  const p = keypair();
  const s = await w.opr.startAttempt(p.pk, { round: r.id });
  assert.equal(s.ok, true, s.why);
  assert.equal(s.state, 'started'); assert.equal(s.free, true); assert.equal(s.paid, true);
  assert.equal(s.invoice, undefined); assert.match(s.token, /^[0-9a-f]{64}$/); assert.equal(s.level.round, r.id);
  const c = await w.opr.checkAttempt(p.pk, s.attempt);
  assert.equal(c.state, 'started'); assert.equal(c.token, s.token);
  await w.opr.tick();
  assert.equal(w.lndCalls, 0);
  const pr = w.opr.publicRound(r);
  assert.equal(pr.entrySats, 0); assert.equal(pr.free, true); assert.equal(pr.potSats, 0); assert.equal(pr.bountySats, 2500);
});

test('#3273 five free attempts a day, the 6th refused; a test round keeps its own limit', async () => {
  const w = freeWorld(); const r = await openRound(w);
  const p = keypair();
  for (let i = 0; i < 5; i++) assert.equal((await w.opr.startAttempt(p.pk, { round: r.id })).ok, true);
  const sixth = await w.opr.startAttempt(p.pk, { round: r.id });
  assert.equal(sixth.ok, false); assert.match(sixth.why, /all 5 attempts/);
  const t = freeWorld({ start: '2026-11-22T10:00:00Z' });
  const made = t.opr.testRound({ minutes: 30, chartDay: '2026-11-20', maxAttempts: 2 });
  assert.equal(made.ok, true, made.why); assert.equal(made.round.entrySats, 0);
  const tr = await openRound(t, made.round.id);
  for (let i = 0; i < 2; i++) assert.equal((await t.opr.startAttempt(p.pk, { round: tr.id })).ok, true);
  assert.equal((await t.opr.startAttempt(p.pk, { round: tr.id })).ok, false);
  assert.equal(w.lndCalls + t.lndCalls, 0);
});

test('#3273 a free run is on the board at submit; no pot; at the end only the bounty list', async () => {
  const w = freeWorld(); const r = await openRound(w);
  const a = keypair(), b = keypair();
  w.link(a.pk); w.link(b.pk);
  assert.equal((await w.opr.saveLnAddress(a.pk, 'alice@walletofsatoshi.com')).ok, true);
  assert.equal((await w.opr.saveLnAddress(b.pk, 'bob@walletofsatoshi.com')).ok, true);
  for (const [kp, n] of [[a, 20], [b, 30]]) {
    const s = await w.opr.startAttempt(kp.pk, { round: r.id }); w.clock.add(60000);
    const out = await w.opr.submitChecked(kp.pk, { attempt: s.attempt, token: s.token, log: logOf(n) });
    assert.equal(out.ok, true, out.why); assert.equal(out.state, 'scored'); assert.equal(out.paid, true);
  }
  const board = w.opr.publicBoard(r.id);
  assert.deepEqual(board.map((x) => [x.player, x.score, x.attempts]), [[b.pk, 300, 1], [a.pk, 200, 1]]);
  assert.equal(w.opr.potOf(r.id), 0);
  await endRound(w, r);
  const lists = w.opr.listsOf(r.id);
  assert.deepEqual(lists.map((l) => l.kind), ['bounty']);
  assert.deepEqual(lists[0].rows.map((x) => [x.player, x.sats, x.lnAddress]), [[b.pk, 2500, 'bob@walletofsatoshi.com']]);
  assert.equal(lists[0].state, 'waiting');
  assert.ok(w.alerts.some((x) => /free round, no pot; bounty: 1\. user\d+ 2500 sat/.test(x)), w.alerts.join('\n'));
  assert.equal(w.opr.decideList({ round: r.id, kind: 'bounty', action: 'approve', by: 'owner', version: (w.opr.listsOf(r.id).find((l) => l.kind === 'bounty') || {}).version }).ok, true);
  assert.deepEqual(w.opr.payable().map((l) => [l.kind, l.sats]), [['bounty', 2500]]);
  assert.equal(w.lndCalls, 0);
});

test('#3273 the chain post of a free round carries entry 0 (same format)', async () => {
  const w = freeWorld(); await openRound(w);
  assert.equal(w.chain.posts.length, 1);
  const d = decodeRoundPost(Buffer.from(w.chain.posts[0].hex, 'hex'));
  assert.equal(d.entrySats, 0); assert.equal(d.attempts, 5); assert.deepEqual(d.split, [50, 30, 20]);
});

test('#3273 a paid round made before (entry 100) keeps the paid path, and a free round takes no carry', async () => {
  const w = world({ start: '2026-11-23T01:00:00Z' });   // the helpers' paid default
  const r = await openRound(w);
  assert.equal(r.entry_sats, 100);
  const p = keypair();
  const s = await w.opr.startAttempt(p.pk, { round: r.id });
  assert.equal(s.state, 'pending-entry'); assert.match(s.invoice, /^lntb100n1/);
  const a = await paidAttempt(w, keypair().pk, r.id);
  assert.equal(a.state, 'started');
  assert.equal(w.opr.potOf(r.id), 100);
});

test('#3273 over HTTP: POST /attempt on a free round answers started with a token, /submit scores it', async () => {
  const w = freeWorld();
  await openRound(w);
  const srv = createServer((q, s) => w.opr.handle(q, s));
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const call = async (method, path, body) => {
    const raw = body === undefined ? '' : JSON.stringify(body);
    const authorization = signIn(kp, { path, method, body: raw, createdAt: Math.floor(w.clock.now() / 1000) });
    const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', authorization }, body: method === 'POST' ? raw : undefined });
    return { status: r.status, json: await r.json() };
  };
  const kp = keypair();
  try {
    const round = await (await fetch(`${base}/round`)).json();
    assert.equal(round.round.entrySats, 0); assert.equal(round.round.potSats, 0);
    const s = await call('POST', '/attempt', {});
    assert.equal(s.status, 200); assert.equal(s.json.state, 'started'); assert.equal(s.json.invoice, undefined);
    w.clock.add(60000);
    const sub = await call('POST', '/submit', { attempt: s.json.attempt, token: s.json.token, log: logOf(12) });
    assert.equal(sub.status, 200); assert.equal(sub.json.state, 'scored');
    const me = await call('GET', '/me');
    assert.equal(me.json.used, 1); assert.equal(me.json.attempts[0].state, 'scored'); assert.equal(me.json.attempts[0].paid, true);
    const board = await (await fetch(`${base}/board`)).json();
    assert.equal(board.board[0].score, 120);
    assert.equal(w.lndCalls, 0);
  } finally { srv.close(); }
});
