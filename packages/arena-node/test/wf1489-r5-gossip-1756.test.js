// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 r5 (gossip): ONE SEAT'S FORGED GET /share ANSWER MUST NOT KEEP A LOSER'S STAKE SHUT.
// StakeSecrets.open (stake-secret.js) asks the round's peers one at a time for their share of a stake, sealed to this seat, and stops at the threshold.
// A peer's answer is opened (AES-GCM under an ECDH key the PEER chose: it authenticates nothing about the value) and taken as signer node
// `back.signerNode` - the index the answer itself names - without checking the share against the handout's Feldman commitments (openMyShare does
// that for this seat's own share; a peer's never is). One seat answering a made-up value makes reconstruct() fail ("those shares rebuild something
// that is not the committed preimage"), the honest peers after it are never asked, and the bad share is kept (putHeldShare) and read first on every
// later open. The loser's lock is never claimed and expires back: the winner is not paid. Safe: a share that does not lie on the published
// polynomial counts for nothing, and the next peer is asked.
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

async function setup({ forged }) {
  const secrets = Array.from({ length: 7 }, () => secret());
  const keys = secrets.map((s) => schnorr.getPublicKey(s));
  const preimage = sha256(b32(3));
  const e = secret();
  const dealt = await dealHandout({ preimage, signerNodes: keys, roundId: b32(1), playerPubkey: b32(5), ephemeralSecret: e, ephemeralPubkey: schnorr.getPublicKey(e), coefficients, curve: feldmanGroup });
  assert.equal(dealt.ok, true, dealt.why);
  const handout = dealt.handout;
  const asked = [];
  // EVERY OTHER SEAT'S GET /share, answered as stake-secret.js answer() seals one: its own share, to the asker (seat 0)
  const fetcher = async (u) => {
    const k = Number(new URL(u).hostname.slice(4));
    asked.push(k);
    const mine = await openMyShare(handout, { pubkey: keys[k], secret: secrets[k], curve: feldmanGroup });
    assert.equal(mine.ok, true, mine.why);
    // THE ATTACKER, seat 1: its own index, a made-up value, sealed under an ephemeral key of its own choosing
    const value = forged && k === 1 ? mine.share.value + 1n : mine.share.value;
    const eph = secret();
    const sealed = await sealShare({ value, signerNode: mine.share.signerNode, signerNodePubkey: keys[0], ephemeralSecret: eph, curve: feldmanGroup });
    const raw = encodeShareAnswer({ signerNode: mine.share.signerNode, ephemeralPubkey: schnorr.getPublicKey(eph), sealed });
    return { ok: true, status: 200, arrayBuffer: async () => raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength), text: async () => '' };
  };
  const held = [];
  const round = { pubkey: keys[0], identity: { secret: secrets[0] }, heldShares: () => held.map((h) => h.bytes), putHeldShare: (h) => held.push(h), provenEquivocation: () => false };
  const ss = new StakeSecrets(round, { curve: feldmanGroup, peers: [1, 2, 3, 4, 5, 6].map((k) => `http://seat${k}`), fetcher, random: (n) => new Uint8Array(randomBytes(n)) });
  ss.handoutOf = () => ({ ok: true, entry: { stakeCommitment: sha256(preimage) }, handout });
  return { ss, preimage, asked };
}

test('control: six honest peers - the stake opens to its preimage', async () => {
  const { ss, preimage } = await setup({ forged: false });
  const got = await ss.open({ roundId: b32(1), entryId: b32(7), needed: 5 });
  assert.equal(got.ok, true, got.why);
  assert.equal(toHex(got.preimage), toHex(preimage));
});

test('one seat of seven answering a forged share does not keep the stake shut: five honest shares still open it', async () => {
  const { ss, preimage, asked } = await setup({ forged: true });
  const got = await ss.open({ roundId: b32(1), entryId: b32(7), needed: 5 });
  console.log('  FACTS:', JSON.stringify({ ok: got.ok, why: got.why, asked }));
  assert.equal(got.ok, true, `one forged share kept the loser's stake shut: ${got.why}`);
  assert.equal(toHex(got.preimage), toHex(preimage));
});
