// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// kanban #2984 (audit h2h-r1-1 of 2026-11-18): the #2798 fix gives up on ONE seat's unsigned `void: true` as soon as the page's clock is past close + LOCK_SET_WINDOW_MS (3 s).
// The seats themselves keep taking set signatures (dated inside the window) and assembling the certificate until close + 3 s +
// LOCK_SET_FINAL_AFTER_MS (2 s), and say VOID only from then (lock-set-book.js voidNow / take). A certificate that forms at close + 3.5 s
// (a late signature, a loaded seat - #2861) is played by every honest seat, but the page already stopped on the liar's void and never revealed:
// its entry FORFEITS. Safe behaviour: one seat's unsigned void never ends the wait while a seat may still certify.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { revealWhenCertified } from '../src/head-to-head.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { lockSetOf, lockSetId, lockSetSignatureId, encodeLockSetCertificate, LOCK_SET_WINDOW_MS } from '../../arena-protocol/src/lock-set.js';
import { LOCK_SET_FINAL_AFTER_MS } from '../../arena-node/src/lock-set-book.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const secrets = Array.from({ length: 7 }, (_, i) => b32(0x51 + i));
const committee = secrets.map((s) => toHex(schnorr.getPublicKey(s)));
const CLOSE = 1_800_000_000_000;
const ROUND = b32(0x61), MINE = b32(0x62), THEIRS = b32(0x63);
const verify = (sig, msg, key) => schnorr.verify(sig, msg, key);
// every signature dated inside the window (close + 2.9 s): a certificate the seats take and stand on (lockSetCertificateStands)
const cert = (() => {
  const set = lockSetOf({ roundId: ROUND, entries: [MINE, THEIRS] });
  const at = BigInt(CLOSE + 2900);
  const sigs = secrets.slice(1, 6).map((sec) => ({ key: schnorr.getPublicKey(sec), atMs: at, sig: schnorr.sign(lockSetSignatureId({ setId: lockSetId(set), atMs: at }), sec) }))
    .sort((a, b) => (toHex(a.key) < toHex(b.key) ? -1 : 1));
  return toHex(encodeLockSetCertificate({ set, sigs }));
})();
const nodes = Array.from({ length: 7 }, (_, i) => `http://s${i}`);

test('a certificate the seats still form before their own VOID point (close + 5 s) is revealed to, despite one seat\'s void', async () => {
  const CERT_AT = CLOSE + LOCK_SET_WINDOW_MS + 500;   // close + 3.5 s: before any honest seat says VOID (close + 3 s + 2 s)
  assert.ok(CERT_AT < CLOSE + LOCK_SET_WINDOW_MS + LOCK_SET_FINAL_AFTER_MS, 'the honest seats still take and assemble the set then');
  let t = CLOSE + 200;
  const reveals = [];
  const fetcher = async (u, o = {}) => {
    const node = u.slice(0, u.indexOf('/', 7));
    if ((o.method || 'GET') === 'POST') { reveals.push(node); return { ok: true, status: 201, body: null, text: async () => '' }; }
    // the liar (s0): void from its first answer; the six honest seats: pending (no void - voidNow is false before close + 5 s), certified from close + 3.5 s
    const j = node === 'http://s0' ? { required: true, certificate: null, void: true }
      : t < CERT_AT ? { required: true, certificate: null, void: false } : { required: true, certificate: cert, entries: [toHex(MINE), toHex(THEIRS)].sort(), void: false };
    return { ok: true, status: 200, body: null, text: async () => JSON.stringify(j) };
  };
  const got = await revealWhenCertified({ roundIdHex: toHex(ROUND), entryIdHex: toHex(MINE), move: 1, salt: b32(9), nodes, committee, verify, entryCloseMs: CLOSE,
    fetcher, now: () => (t += 150), sleep: async () => {} });
  assert.notEqual(got.void, true, `the page gave up as VOID at close + ${t - CLOSE} ms on one seat's unsigned void, while the honest seats certified at close + 3.5 s`);
  assert.ok(reveals.length >= 6, `the move was revealed to ${reveals.length} seats`);
});

