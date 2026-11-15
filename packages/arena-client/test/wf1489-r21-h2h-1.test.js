// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// #1489 r21-h2h-1: ONE SEAT'S UNSIGNED `void: true` MUST NOT STOP THE PLAYER'S REVEAL. Seven seats; the round's committee certifies the lock set
// shortly after the close. One lying seat answers GET /lock-set with { required: true, void: true } from its first ask. The page must keep waiting
// for the certificate and reveal - otherwise its entry FORFEITS while the honest seats play the round (the opponent takes the stake).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { revealWhenCertified } from '../src/head-to-head.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { lockSetOf, lockSetId, lockSetSignatureId, encodeLockSetCertificate } from '../../arena-protocol/src/lock-set.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const secrets = Array.from({ length: 7 }, (_, i) => b32(0x51 + i));
const committee = secrets.map((s) => toHex(schnorr.getPublicKey(s)));
const CLOSE = 1_800_000_000_000;
const ROUND = b32(0x61), MINE = b32(0x62), THEIRS = b32(0x63);
const verify = (sig, msg, key) => schnorr.verify(sig, msg, key);
const cert = (() => {
  const set = lockSetOf({ roundId: ROUND, entries: [MINE, THEIRS] });
  const sigs = secrets.slice(0, 5).map((sec) => ({ key: schnorr.getPublicKey(sec), atMs: BigInt(CLOSE + 900), sig: schnorr.sign(lockSetSignatureId({ setId: lockSetId(set), atMs: BigInt(CLOSE + 900) }), sec) }))
    .sort((a, b) => (toHex(a.key) < toHex(b.key) ? -1 : 1));
  return toHex(encodeLockSetCertificate({ set, sigs }));
})();
const nodes = Array.from({ length: 7 }, (_, i) => `http://s${i}`);

test('one seat answering void:true does not stop the reveal while the committee certifies', async () => {
  const asked = new Map(), reveals = [];
  const fetcher = async (u, o = {}) => {
    const node = u.slice(0, u.indexOf('/', 7));
    if ((o.method || 'GET') === 'POST') { reveals.push(node); return { ok: true, status: 201, body: null, text: async () => '' }; }
    const i = asked.get(node) || 0; asked.set(node, i + 1);
    // the liar: void from the first ask; the six honest seats: pending on the first ask, certified from the second
    const j = node === 'http://s0' ? { required: true, certificate: null, void: true }
      : i === 0 ? { required: true, certificate: null } : { required: true, certificate: cert, entries: [toHex(MINE), toHex(THEIRS)].sort() };
    return { ok: true, status: 200, body: null, text: async () => JSON.stringify(j) };
  };
  let t = CLOSE + 200;
  const got = await revealWhenCertified({ roundIdHex: toHex(ROUND), entryIdHex: toHex(MINE), move: 1, salt: b32(9), nodes, committee, verify, entryCloseMs: CLOSE,
    fetcher, now: () => (t += 150), sleep: async () => {} });
  assert.notEqual(got.void, true, 'the page gave up as VOID on one seat\'s unsigned word');
  assert.ok(reveals.length >= 6, `the move was revealed to ${reveals.length} seats`);
});
