// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 a44 refute 8 skeptic 2 (re-check of #1607 / #2131): ONE SEAT STILL BACKDATES AT A SEAT THAT HELD THE SIGNAL. X held the 15th signal
// 1 s before the end block's time, Y half a second after it (honest): X B = 1, L = 1, Y not own - failed 14 at both. Seat M (one bond) answers X only with
// atMs 0: X B = 2, L = 1 - counted, passed 15; Y still failed 14. One seat, not two, makes two outcomes for one period.
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
const S16 = signalHex(16);   // signed once (schnorr signs with fresh aux randomness)
// a network of honest seats; `lie(self, k, items)` lets one seat (M) change what it answers to the seat `self`; `down(self, k)` a peer that does not answer
const network = ({ lie = null, down = () => false } = {}) => {
  const clock = { now: 1_000_000 }, state = { tip: 157807 }, endBlock = { at: null }, seats = {};
  const make = (self) => createFundingBook({ db: openStore(':memory:'), verify, tip: async () => state.tip, now: () => clock.now,
    isBonded: (hex) => NODES.some((n) => toHex(pk(n)) === hex),
    activeAt: async (end) => ({ ok: true, nodes: NODES.map((n) => toHex(pk(n))), fromHeight: end - 432 }),
    endTimeAt: async (h) => (h === END ? endBlock.at : null),
    pull: async (pid) => Object.entries(seats).filter(([k]) => k !== self && !down(self, k)).flatMap(([k, b]) => {
      let items = b.itemsOf(pid).map((x) => ({ kind: x.kind, hex: x.hex, atMs: Number(x.atMs) }));
      if (lie) items = lie(self, k, items);
      return items.map((x) => ({ ...x, seat: `https://${k}.example` }));
    }) });
  return { clock, state, endBlock, seats, make };
};
const decideAll = async (net, order) => { const out = {}; for (const k of order) { const [o] = await net.seats[k].decide(); out[k] = [o.state, o.supporters]; } return out; };


test('one peer seat claiming atMs 0 to a seat that held the signal does not split the outcome', async () => {
  const lie = (self, k, items) => (k === 'm' && self === 'x' ? items.map((x) => (x.hex === S16 ? { ...x, atMs: 0 } : x)) : items);
  const net = network({ lie }); const { clock, state, endBlock, seats, make } = net;
  seats.x = make('x'); seats.y = make('y'); seats.m = make('m');
  for (const b of Object.values(seats)) { await b.add('proposal', proposalHex()); for (let i = 1; i <= 14; i++) await b.add('signal', signalHex(i + 1)); }
  clock.now += 60_000; endBlock.at = clock.now + 1000; state.tip = END;
  await seats.x.add('signal', S16);
  clock.now += 1500; await seats.y.add('signal', S16);
  clock.now += 3600_000; await seats.m.add('signal', S16); state.tip = END + 10;
  const out = await decideAll(net, ['x', 'y']);
  console.log(`  ONE SEAT BACKDATES: X ${out.x.join(' ')}; Y ${out.y.join(' ')}`);
  assert.deepEqual(out.x, out.y, 'seat M alone flipped the outcome at seat X');
  assert.deepEqual(out.x, ['failed', 14], 'a signal one seat held 1 s before the end and the others after counted');
});
