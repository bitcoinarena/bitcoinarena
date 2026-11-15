// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 r5 (gossip): ONE SEAT'S GET /share ANSWER IS READ UP TO ITS SIZE, NOT WHOLE.
// StakeSecrets.open (stake-secret.js) asks the round's peers for their sealed share of a loser's stake - an answer of SEALED_ANSWER_BYTES - and
// reads each with `got.arrayBuffer()` (a refusal with `got.text()`), bounded only in time (SHARE_ASK_MS, 15 s), never in bytes - the #1550 /
// #2113 / #2084 / #2541 rule every other peer read of the settlement, the forfeit and the DKG keeps. One committee seat answering hundreds of MB
// inside the 15 s (a local link moves ~100 MB in under half a second) is buffered whole by every honest seat that opens a stake, on every open.
// Safe: an answer is read at most a few KiB; past that the peer counts as one that refused, and the honest peers still open the stake.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { schnorr } from '@noble/curves/secp256k1.js';
import { feldmanGroup } from '../src/curve.js';
import { StakeSecrets, encodeShareAnswer } from '../src/stake-secret.js';
import { dealHandout, openMyShare } from '../../arena-protocol/src/handout.js';
import { sealShare } from '../../arena-protocol/src/seal.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const secret = () => new Uint8Array(randomBytes(32));
const coefficients = [1n, 2n, 3n, 4n].map((n) => n * 0x1234567890abcdefn + 7n);
const CHUNK = 64 * 1024, TOTAL = 64 * 1024 * 1024;

test('a seat answering GET /share with 64 MiB is not read whole: the stake still opens from the honest seats', async () => {
  const secrets = Array.from({ length: 7 }, () => secret());
  const keys = secrets.map((s) => schnorr.getPublicKey(s));
  const preimage = sha256(b32(3));
  const e = secret();
  const dealt = await dealHandout({ preimage, signerNodes: keys, roundId: b32(1), playerPubkey: b32(5), ephemeralSecret: e, ephemeralPubkey: schnorr.getPublicKey(e), coefficients, curve: feldmanGroup });
  assert.equal(dealt.ok, true, dealt.why);
  const handout = dealt.handout;
  let pulled = 0;
  const fetcher = async (u, o = {}) => {
    const k = Number(new URL(u).hostname.slice(4));
    if (k === 1) {
      // THE ATTACKER, seat 1: 200 and 64 MiB of junk, as fast as it is read
      const body = new ReadableStream({
        pull(ctl) { if (pulled >= TOTAL) { ctl.close(); return; } pulled += CHUNK; ctl.enqueue(new Uint8Array(CHUNK)); },
      });
      return new Response(body, { status: 200, signal: o.signal });
    }
    const mine = await openMyShare(handout, { pubkey: keys[k], secret: secrets[k], curve: feldmanGroup });
    const eph = secret();
    const sealed = await sealShare({ value: mine.share.value, signerNode: mine.share.signerNode, signerNodePubkey: keys[0], ephemeralSecret: eph, curve: feldmanGroup });
    return new Response(encodeShareAnswer({ signerNode: mine.share.signerNode, ephemeralPubkey: schnorr.getPublicKey(eph), sealed }), { status: 200 });
  };
  const held = [];
  const round = { pubkey: keys[0], identity: { secret: secrets[0] }, heldShares: () => held.map((h) => h.bytes), putHeldShare: (h) => held.push(h), provenEquivocation: () => false };
  const ss = new StakeSecrets(round, { curve: feldmanGroup, peers: [1, 2, 3, 4, 5, 6].map((k) => `http://seat${k}`), fetcher, random: (n) => new Uint8Array(randomBytes(n)) });
  ss.handoutOf = () => ({ ok: true, entry: { stakeCommitment: sha256(preimage) }, handout });
  const got = await ss.open({ roundId: b32(1), entryId: b32(7), needed: 5 });
  console.log('  FACTS:', JSON.stringify({ ok: got.ok, pulledBytes: pulled, why: got.why }));
  assert.equal(got.ok, true, got.why);
  assert.equal(toHex(got.preimage), toHex(preimage));
  assert.ok(pulled < 1024 * 1024, `one seat's /share answer was read ${pulled} bytes deep (a sealed share is ~100 bytes): read whole, not up to a cap`);
});
