// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// KANBAN #1410 (audit 5 #1399): a signal period's cutoff was "when this seat first saw the end" - a seat restarting or catching up decided hours later and
// counted every signal held before then, including ones after the end; a live seat excluded them: two outcomes for one period. Now the cutoff is the end
// block's own header time, the same on every seat.
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
const signalHex = (n) => { const s = { proposalId: fundingProposalId(P), node: pk(n), atHeight: 156850 }; return hexOf(encodeFundingSignal(s), fundingSignalId(s), n); };
const END = 157808;

async function run({ shared }) {
  const clock = { now: 1_000_000 }, state = { tip: 157807 }, books = {};
  const endBlockMs = { at: null };
  const make = (other) => createFundingBook({ db: openStore(':memory:'), verify, tip: async () => state.tip, now: () => clock.now,
    isBonded: (hex) => NODES.some((n) => toHex(pk(n)) === hex),
    activeAt: async (end) => ({ ok: true, nodes: NODES.map((n) => toHex(pk(n))), fromHeight: end - 432 }),
    pull: async (pid) => other.flatMap((o) => books[o].itemsOf(pid)),
    ...(shared ? { endTimeAt: async (h) => (h === END ? endBlockMs.at : null) } : {}) });
  books.A = make(['B', 'C']); books.B = make(['A', 'C']); books.C = make(['A', 'B']);
  for (const b of Object.values(books)) { await b.add('proposal', proposalHex()); for (let i = 1; i <= 14; i++) await b.add('signal', signalHex(i + 1)); }
  clock.now += 60_000;
  state.tip = END; endBlockMs.at = clock.now;                         // the end block, made now
  await books.A.decide(); await books.B.decide();                     // the live seats see the end; seat C is down
  clock.now += 1_000;
  await books.B.add('signal', signalHex(16));                         // the 15th signal, AFTER the end, at seat B only
  state.tip = END + 5;
  const [a] = await books.A.decide();
  clock.now += 3 * 3600_000;                                          // seat C comes back three hours later and catches up
  state.tip = END + 30;
  const [c] = await books.C.decide();
  return { A: [a.state, a.supporters], C: [c.state, c.supporters] };
}

test('#1410 a seat deciding hours late counts the same signals as a live one: the end block\'s time is the cutoff', async () => {
  const before = await run({ shared: false }), after = await run({ shared: true });
  console.log(`  MEASURED #1410: own first-seen clock: live A ${before.A.join(' ')}, late C ${before.C.join(' ')}; end block time: live A ${after.A.join(' ')}, late C ${after.C.join(' ')}`);
  assert.notDeepEqual(before.A, before.C, 'the old rule did not split (the test does not show the fault)');
  assert.deepEqual(after.A, after.C, 'two outcomes for one period');
  assert.deepEqual(after.C, ['failed', 14]);
});
