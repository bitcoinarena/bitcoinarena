// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// LEAVE WITHOUT BEING SLASHED: the owner signs Leave; from then the seat takes no new round and serves
// the ones it holds - past their end and objection window, a paying one until its settlement is accepted; custody may go only
// if the federation keeps its threshold without this guardian.
import test from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { leaveStatus, takesRound } from '../src/owner-leave.js';
import { ownerSecretFromSeed, signOwnerRequest } from '../src/owner.js';
import { encodeRoundContract } from '../../arena-protocol/src/contracts.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { joinedWithLock } from './lock-fixture.js';

const NOW = 1_800_000_000_000;
const R = (id, endIn, extra = {}) => ({ id, endMs: NOW + endIn, objectionWindowMs: 600000, assigned: true, paying: false, entries: 0, settlementAccepted: false, ...extra });

test('what a leaving seat still owes: open rounds, objection windows, and a paying round until its settlement is accepted', () => {
  const s = leaveStatus({ nowMs: NOW, leavingAtMs: NOW - 1000, rounds: [
    R('open', 60000), R('objecting', -60000), R('done', -700000),
    R('paid-unsettled', -700000, { paying: true, entries: 2 }), R('paid-settled', -700000, { paying: true, entries: 2, settlementAccepted: true }),
    R('not-mine', 60000, { assigned: false }),
  ] });
  assert.deepEqual(s.rounds.map((r) => [r.id, r.why]).sort(), [['objecting', 'objection'], ['open', 'open'], ['paid-unsettled', 'settlement']]);
  assert.equal(s.owed, 3);
  assert.equal(s.freeAtMs, null, 'not free while a settlement is not accepted');
  assert.equal(s.waitingSettlement, true);
  const t = leaveStatus({ nowMs: NOW, leavingAtMs: NOW, rounds: [R('open', 60000), R('objecting', -60000)] });
  assert.equal(t.freeAtMs, NOW + 60000 + 600000, 'free once the last round\'s objection window is over');
  assert.equal(leaveStatus({ nowMs: NOW, rounds: [] }).freeNow, true);
});

test('custody: a guardian may go only if the federation keeps its threshold without it', () => {
  const keys = (n) => Array.from({ length: n }, (_, i) => 'k' + i);
  assert.equal(leaveStatus({ nowMs: NOW, custody: { guardian: true, keys: keys(7), threshold: 5 } }).custody.allowed, true);
  const no = leaveStatus({ nowMs: NOW, custody: { guardian: true, keys: keys(5), threshold: 5 } }).custody;
  assert.equal(no.allowed, false);
  assert.match(no.why, /keeps 4 of 5, below its threshold 5: it would halt/);
  assert.equal(leaveStatus({ nowMs: NOW, custody: null }).custody.guardian, false);
});

test('a leaving seat takes no round formed after the leave', () => {
  assert.equal(takesRound({ committeeTimeMs: 1000n }, null), true);
  assert.equal(takesRound({ committeeTimeMs: 1000n }, 1000), true);
  assert.equal(takesRound({ committeeTimeMs: 1001n }, 1000), false);
});

test('on a running seat: Leave signed by the owner; a held round still taken, a new one refused; the round it holds is owed; Stay', async () => {
  const seed = new Uint8Array(32).fill(7);
  const secret = ownerSecretFromSeed(seed);
  const pub = toHex(schnorr.getPublicKey(secret));
  const ownerRec = { pubkey: pub, claimedAtMs: 1 };
  const store = { read: () => ownerRec, write: (o) => Object.assign(ownerRec, o, o.leaving ? {} : { leaving: undefined }), writeCode: () => {} };
  const s = await joinedWithLock({ owner: { store } });
  try {
    const base = `http://127.0.0.1:${s.d.port}`;
    const node = (await (await fetch(`${base}/owner`)).json()).node;
    const req = (action) => signOwnerRequest({ node, action, args: {}, secret, sign: (m, k) => schnorr.sign(m, k), pubkeyOf: (k) => schnorr.getPublicKey(k) });
    const post = (path, body) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const other = signOwnerRequest({ node, action: 'leave', args: {}, secret: ownerSecretFromSeed(new Uint8Array(32).fill(9)), sign: (m, k) => schnorr.sign(m, k), pubkeyOf: (k) => schnorr.getPublicKey(k) });
    assert.equal((await post('/owner/leave', other)).status, 403, 'another key cannot make the seat leave');
    const left = await (await post('/owner/leave', req('leave'))).json();
    assert.equal(left.ok, true);
    assert.ok(left.leavingAtMs > 0);
    // the round it holds: posted again (a page's join does), still taken
    assert.notEqual((await fetch(`${base}/round`, { method: 'POST', body: encodeRoundContract(s.c) })).status, 409);
    // a round formed after the leave: refused by name
    // committee time a day from now, after the leave (the fixture's own times are far in the past)
    const shift = BigInt(Date.now()) + 86400000n - s.c.committeeTimeMs;
    const later = { ...s.c, committeeTimeMs: s.c.committeeTimeMs + shift, startTimeMs: s.c.startTimeMs + shift, entryCloseMs: s.c.entryCloseMs + shift };
    const r = await fetch(`${base}/round`, { method: 'POST', body: encodeRoundContract(later) });
    assert.equal(r.status, 409);
    assert.match(await r.text(), /this seat is leaving/);
    const st = await (await fetch(`${base}/owner/leave`)).json();
    assert.equal(st.leaving, true);
    assert.ok(st.owed >= 1, 'the round it holds is owed');
    assert.ok(st.rounds.some((x) => x.id === toHex(s.rid)));
    const stay = await (await post('/owner/stay', req('stay'))).json();
    assert.equal(stay.leavingAtMs, null);
    assert.equal((await (await fetch(`${base}/owner/leave`)).json()).leaving, false);
  } finally { await s.d.close(); }
});
