// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 r4 census-2 (kanban #1607): ONE PEER SEAT BACKDATES A SIGNAL PAST THE SIGNAL CUTOFF. Before a seat decides a funding or fee proposal's signal it pulls
// GET /funding-items from the network seats (server.js pull) and takes each item's `atMs` - "when this seat first held it" - as the peer states it
// (funding-book.js add heldAtMs: Math.min(now, peer's atMs), and an UPDATE moves an already held item earlier too). Nothing checks that claim, so one
// seat answers `atMs: 0` for a signal signed after the period ended (its own node's, or any late one), and every seat it answers counts it; the
// seats it does not answer (or that decided before) do not: two outcomes for one signal period, for a fee proposal two fee sets in force (P1, P8).
// SAFE: a signal that no honest seat held before the end block's time is not counted, whatever time one peer claims for it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { openStore } from '../src/store.js';
import { createFundingBook } from '../src/funding-book.js';
import { encodeFundingProposal, fundingProposalId, encodeFundingSignal, fundingSignalId } from '../../arena-protocol/src/funding.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const sk = (n) => { const b = new Uint8Array(32); b[0] = 1; b[30] = n >> 8; b[31] = n & 255; return b; };
const pk = (n) => schnorr.getPublicKey(sk(n));
const verify = (s, m, k) => schnorr.verify(s, m, k);
const hexOf = (bytes, id, n) => toHex(Uint8Array.from([...bytes, ...schnorr.sign(id, sk(n))]));
const NODES = Array.from({ length: 100 }, (_, i) => i + 1);
const P = { networkId: new Uint8Array(32).fill(7), author: pk(1), publishedHeight: 156800, amountSats: 250000n, lnurl: 'dev@bitcoin-arena.io', purpose: 'A second relay' };
const proposalHex = () => hexOf(encodeFundingProposal(P), fundingProposalId(P), 1);
const signalHex = (n, atHeight = 156850) => { const s = { proposalId: fundingProposalId(P), node: pk(n), atHeight }; return hexOf(encodeFundingSignal(s), fundingSignalId(s), n); };
const END = 157808;

test('a signal signed after the signal period ended does not count because one peer seat claims it held it at time 0', async () => {
  const clock = { now: 1_000_000 }, state = { tip: 157807 }, endBlock = { at: null };
  const late = { hex: null };
  // THE ATTACKER'S SEAT M: its GET /funding-items answers the late signal with atMs 0 - to seat A only
  const make = (pullFromM) => createFundingBook({ db: openStore(':memory:'), verify, tip: async () => state.tip, now: () => clock.now,
    isBonded: (hex) => NODES.some((n) => toHex(pk(n)) === hex),
    activeAt: async (end) => ({ ok: true, nodes: NODES.map((n) => toHex(pk(n))), fromHeight: end - 432 }),
    endTimeAt: async (h) => (h === END ? endBlock.at : null),
    pull: async () => (pullFromM && late.hex ? [{ kind: 'signal', hex: late.hex, atMs: 0 }] : []) });
  const A = make(true), B = make(false);
  for (const b of [A, B]) { await b.add('proposal', proposalHex()); for (let i = 1; i <= 14; i++) await b.add('signal', signalHex(i + 1)); }
  clock.now += 60_000;
  state.tip = END; endBlock.at = clock.now;                            // the end block is made: 14 of 100 signals, 15 needed
  clock.now += 3600_000;                                               // an hour later the attacker's node signs its signal
  late.hex = signalHex(16);                                            // dated inside the period (its signer picks atHeight)
  state.tip = END + 10;
  const [a] = await A.decide();
  const [b] = await B.decide();
  console.log(`  BACKDATED: seat A (pulled from M) ${a.state} ${a.supporters}; seat B ${b.state} ${b.supporters}; the signal first existed 1 h after the end block`);
  assert.deepEqual([a.state, a.supporters], [b.state, b.supporters], 'one peer\'s claimed atMs split the signal outcome between two honest seats');
  assert.deepEqual([a.state, a.supporters], ['failed', 14], 'a signal made after the end counted');
});
