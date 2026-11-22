// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 a44 refute 8 (re-check of #1607): TWO colluding peer seats still backdate a late signal. PEER_CLAIM_SEATS is 2, so two seats
// (two bonds, one operator) that answer GET /funding-items with atMs 0 for a signal signed an hour after the end block - to chosen seats only -
// flip the outcome there: seat A (pulled from M1 and M2) passes, seat B fails. Two outcomes for one period, as before the fix.
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

test('two colluding peer seats claiming atMs 0 do not backdate a signal signed after the end', async () => {
  const clock = { now: 1_000_000 }, state = { tip: 157807 }, endBlock = { at: null };
  const late = { hex: null };
  const make = (pullFromM) => createFundingBook({ db: openStore(':memory:'), verify, tip: async () => state.tip, now: () => clock.now,
    isBonded: (hex) => NODES.some((n) => toHex(pk(n)) === hex),
    activeAt: async (end) => ({ ok: true, nodes: NODES.map((n) => toHex(pk(n))), fromHeight: end - 432 }),
    endTimeAt: async (h) => (h === END ? endBlock.at : null),
    // server.js pull tags each item with the seat it came from
    pull: async () => (pullFromM && late.hex ? [{ kind: 'signal', hex: late.hex, atMs: 0, seat: 'https://m1.example' }, { kind: 'signal', hex: late.hex, atMs: 0, seat: 'https://m2.example' }] : []) });
  const A = make(true), B = make(false);
  for (const b of [A, B]) { await b.add('proposal', proposalHex()); for (let i = 1; i <= 14; i++) await b.add('signal', signalHex(i + 1)); }
  clock.now += 60_000;
  state.tip = END; endBlock.at = clock.now;
  clock.now += 3600_000;
  late.hex = signalHex(16);
  state.tip = END + 10;
  const [a] = await A.decide();
  const [b] = await B.decide();
  console.log(`  TWO SEATS: seat A (pulled from M1, M2) ${a.state} ${a.supporters}; seat B ${b.state} ${b.supporters}`);
  assert.deepEqual([a.state, a.supporters], [b.state, b.supporters], 'two colluding peers split the signal outcome');
  assert.deepEqual([a.state, a.supporters], ['failed', 14], 'a signal made after the end counted');
});
