// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 a44 refute 8 (re-check of #1607): A SIGNAL HELD BY ONE HONEST SEAT BEFORE THE END NOW SPLITS THE OUTCOME. A signer posts its signal
// to seat X only, just before the end block's time (the end block dated ahead of the clocks, #1426, so its time is known in advance); X holds it
// before the cutoff and counts it, its hand-on reaches Y and Z after the cutoff. Y pulls: X's honest claim (before), Z's (after) - one seat, below
// PEER_CLAIM_SEATS - so Y does not count it. Before #1607 every seat took X's time and agreed; now X passes and Y fails: two outcomes for one period.
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

test('a signal one honest seat held before the end gets one outcome at every seat', async () => {
  const clock = { now: 1_000_000 }, state = { tip: 157807 }, endBlock = { at: null };
  const seats = {};
  const make = (self) => createFundingBook({ db: openStore(':memory:'), verify, tip: async () => state.tip, now: () => clock.now,
    isBonded: (hex) => NODES.some((n) => toHex(pk(n)) === hex),
    activeAt: async (end) => ({ ok: true, nodes: NODES.map((n) => toHex(pk(n))), fromHeight: end - 432 }),
    endTimeAt: async (h) => (h === END ? endBlock.at : null),
    // server.js pull: every other seat's GET /funding-items (itemsOf: its own receipt time), tagged with the seat
    pull: async (pid) => Object.entries(seats).filter(([k]) => k !== self).flatMap(([k, b]) => b.itemsOf(pid).map((x) => ({ kind: x.kind, hex: x.hex, atMs: Number(x.atMs), seat: `https://${k}.example` }))) });
  seats.x = make('x'); seats.y = make('y'); seats.z = make('z');
  for (const b of Object.values(seats)) { await b.add('proposal', proposalHex()); for (let i = 1; i <= 14; i++) await b.add('signal', signalHex(i + 1)); }
  clock.now += 60_000;
  endBlock.at = clock.now + 1000;                                      // the end block, dated 1 s ahead
  state.tip = END;
  await seats.x.add('signal', signalHex(16));                          // the 15th signal, at seat X, 1 s before the end block's time
  clock.now += 1500;                                                   // X's hand-on reaches Y and Z half a second after it
  await seats.y.add('signal', signalHex(16)); await seats.z.add('signal', signalHex(16));
  clock.now += 3600_000; state.tip = END + 10;
  const out = {};
  for (const k of ['x', 'y', 'z']) { const [o] = await seats[k].decide(); out[k] = [o.state, o.supporters]; }
  console.log(`  ONE HONEST HOLDER: X ${out.x.join(' ')}; Y ${out.y.join(' ')}; Z ${out.z.join(' ')}`);
  assert.deepEqual(out.y, out.x, 'seat X and seat Y decided the same signal period differently');
  assert.deepEqual(out.z, out.x, 'seat X and seat Z decided the same signal period differently');
});
