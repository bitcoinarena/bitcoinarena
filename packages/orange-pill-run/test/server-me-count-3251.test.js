// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// #3251: GET /me counts every run the player opened in the round - right after POST /attempt and after POST /submit - and two sign-ins of the
// same second are two sign-ins once each carries its own nonce (without one, the second GET /me of a second was refused: "used already").
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { schnorr } from '../../arena-node/node_modules/@noble/curves/secp256k1.js';
import { eventId } from '../../arena-node/src/nostr-relay.js';
import { world, keypair, logOf, at, BASE, MIN } from './server-helpers.mjs';

function sign(kp, { path, method, body, createdAt, nonce }) {
  const tags = [['u', BASE + path], ['method', method]];
  if (method === 'POST') tags.push(['payload', createHash('sha256').update(body).digest('hex')]);
  if (nonce) tags.push(['nonce', nonce]);
  const e = { pubkey: kp.pk, created_at: createdAt, kind: 27235, tags, content: '' };
  e.id = eventId(e); e.sig = Buffer.from(schnorr.sign(Buffer.from(e.id, 'hex'), kp.sk)).toString('hex');
  return `Nostr ${Buffer.from(JSON.stringify(e)).toString('base64')}`;
}

test('#3251 GET /me: 0, then 1 right after POST /attempt, still 1 after POST /submit, 2 after the second run; same-second reads with nonces', async () => {
  const w = world({ start: '2026-11-22T10:00:00Z' });
  const made = w.opr.testRound({ startMs: at('2026-11-22T10:00:00Z'), minutes: 60, chartDay: '2026-11-21', by: 'owner', maxAttempts: 99 });
  assert.equal(made.ok, true, made.why);
  await w.opr.tick(); await w.opr.tick(); w.chain.confirm(); await w.opr.tick();
  const id = made.round.id, p = keypair();
  const srv = createServer((q, s) => w.opr.handle(q, s)); await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const call = async (method, path, body, nonce = randomBytes(12).toString('hex')) => { const raw = body === undefined ? '' : JSON.stringify(body);
    const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', authorization: sign(p, { path: path.split('?')[0], method, body: raw, createdAt: Math.floor(w.clock.now() / 1000), nonce }) }, body: method === 'POST' ? raw : undefined });
    return { status: r.status, json: await r.json() }; };
  const me = () => call('GET', `/me?round=${id}`);
  try {
    let m = await me(); assert.equal(m.status, 200); assert.equal(m.json.used, 0); assert.equal(m.json.maxAttempts, 99);
    const a = await call('POST', '/attempt', { round: id }); assert.equal(a.status, 200, a.json.why);
    m = await me(); assert.equal(m.json.used, 1); assert.equal(m.json.attempts[0].state, 'pending-entry');   // the entry not paid yet: it counts
    // the same second, again: a second sign-in with its own nonce is taken
    const m2 = await me(); assert.equal(m2.status, 200); assert.equal(m2.json.used, 1);
    // without a nonce, the second same-second read is the same event - and refused, as before (replay protection stays)
    assert.equal((await call('GET', `/me?round=${id}`, undefined, null)).status, 200);
    const dup = await call('GET', `/me?round=${id}`, undefined, null); assert.equal(dup.status, 401); assert.equal(dup.json.why, 'that sign-in was used already');
    w.lnd.pay(a.json.invoice);
    w.clock.add(MIN);
    const s = await call('POST', '/submit', { attempt: a.json.attempt, token: a.json.token, round: id, log: logOf(3) }); assert.equal(s.status, 200, s.json.why);
    m = await me(); assert.equal(m.json.used, 1); assert.equal(m.json.attempts[0].state, 'scored');
    const b = await call('POST', '/attempt', { round: id }); assert.equal(b.status, 200, b.json.why);
    m = await me(); assert.equal(m.json.used, 2);
  } finally { srv.close(); }
});
