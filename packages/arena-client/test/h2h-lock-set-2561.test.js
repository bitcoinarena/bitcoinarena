// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE PAGE REVEALS ONLY ONCE THE LOCK SET IS CERTIFIED (protocol 28, kanban #2561, ruling #2116 (b)): not by its own clock, not by one seat's
// word (#1598's lying partner on GET /time), not on a certificate that does not stand against the round's seats.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { revealWhenCertified } from '../src/head-to-head.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { lockSetOf, lockSetId, lockSetSignatureId, encodeLockSetCertificate } from '../../arena-protocol/src/lock-set.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const secrets = Array.from({ length: 7 }, (_, i) => b32(0x51 + i));
const keys = secrets.map((s) => schnorr.getPublicKey(s));
const committee = keys.map(toHex);
const CLOSE = 1_800_000_000_000;
const ROUND = b32(0x61), MINE = b32(0x62), THEIRS = b32(0x63), LATE = b32(0x64);
const verify = (sig, msg, key) => schnorr.verify(sig, msg, key);
const certOf = (entries, signers = secrets) => {
  const set = lockSetOf({ roundId: ROUND, entries });
  const sigs = signers.slice(0, 5).map((sec) => ({ key: schnorr.getPublicKey(sec), atMs: BigInt(CLOSE + 900), sig: schnorr.sign(lockSetSignatureId({ setId: lockSetId(set), atMs: BigInt(CLOSE + 900) }), sec) }))
    .sort((a, b) => (toHex(a.key) < toHex(b.key) ? -1 : 1));
  return toHex(encodeLockSetCertificate({ set, sigs }));
};
const nodes = ['http://s0', 'http://s1', 'http://s2'];
// a fetcher: GET /lock-set answers `sets(node, i)` on its i-th ask; POST /reveal is recorded
function seats(sets) {
  const asked = new Map(), reveals = [];
  const fetcher = async (u, o = {}) => {
    const node = u.slice(0, u.indexOf('/', 7));
    if ((o.method || 'GET') === 'POST') { reveals.push(node); return { ok: true, status: 201, body: null, text: async () => '' }; }
    const i = asked.get(node) || 0; asked.set(node, i + 1);
    const j = sets(node, i);
    return { ok: !!j, status: j ? 200 : 503, body: null, text: async () => JSON.stringify(j || {}) };
  };
  return { fetcher, reveals };
}
const go = (f, o = {}) => revealWhenCertified({ roundIdHex: toHex(ROUND), entryIdHex: toHex(MINE), move: 1, salt: b32(9), nodes, committee, verify, entryCloseMs: CLOSE,
  fetcher: f.fetcher, now: o.now || (() => CLOSE + 500), sleep: async () => {}, ...o });

test('a round below protocol 28 is revealed at once, as before', async () => {
  const f = seats(() => ({ required: false }));
  const got = await go(f);
  assert.equal(f.reveals.length, 3);
  assert.equal(got.certified, null);
});

test('no reveal while the set is not certified; a seat serving a certificate the committee did not sign is not believed; VOID past the window', async () => {
  let t = CLOSE + 100;
  const stranger = Array.from({ length: 5 }, (_, i) => b32(0x71 + i));
  // seat 0 lies: a "certificate" signed by five keys outside the round's committee, naming the attacker's late entry
  const f = seats((node) => (node === 'http://s0' ? { required: true, certificate: certOf([MINE, LATE], stranger), entries: [toHex(MINE), toHex(LATE)].sort() } : { required: true, certificate: null }));
  const got = await go(f, { now: () => (t += 400) });
  assert.equal(f.reveals.length, 0, 'revealed on a certificate that does not stand');
  assert.equal(got.void, true);
});

test('without the committee known, one lying seat alone does not open the reveal; two seats agreeing do', async () => {
  const lie = seats((node) => (node === 'http://s0' ? { required: true, certificate: 'ab', entries: [toHex(MINE)] } : { required: true, certificate: null }));
  let t = CLOSE;
  const one = await go(lie, { committee: null, now: () => (t += 1000) });
  assert.equal(lie.reveals.length, 0);
  assert.equal(one.void, true);
  const two = seats((node) => (node !== 'http://s2' ? { required: true, certificate: 'ab', entries: [toHex(MINE), toHex(THEIRS)] } : null));
  const got = await go(two, { committee: null });
  assert.equal(two.reveals.length, 3);
  assert.ok(got.certified);
});

test('a certificate signed by the round\'s seats opens the reveal - after it, not before; an entry outside it is not revealed', async () => {
  const good = certOf([MINE, THEIRS]);
  const f = seats((node, i) => (i < 3 ? { required: true, certificate: null } : { required: true, certificate: good }));
  const got = await go(f);
  assert.equal(f.reveals.length, 3);
  assert.deepEqual(got.certified.entries, [toHex(MINE), toHex(THEIRS)].sort());
  const out = seats(() => ({ required: true, certificate: certOf([THEIRS, LATE]) }));
  const not = await go(out);
  assert.equal(out.reveals.length, 0);
  assert.equal(not.notCertified, true);
});
