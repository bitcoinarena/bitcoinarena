// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// KANBAN #1175: A PASSED PROPOSAL'S PART COUNT IS THE SAME ON EVERY SEAT. It was fixed from the reserve rows each seat held at its
// first ask; two seats with different rows fixed different counts, named different part ids, and the coordinator's plan was "no
// passed vote" at its peers. Now the count follows the proposal's own amount; a row the old rule fixed is set right while no part is
// payable yet; a cancellation is kept once and never moves.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { openStore } from '../src/store.js';
import * as book from '../src/funding-book.js';
import { encodeFundingProposal, fundingProposalId, encodeFundingSignal, fundingSignalId, FUNDING_SCHEDULES } from '../../arena-protocol/src/funding.js';
import { encodeVote, voteMessage, CHOICE } from '../../arena-protocol/src/ballot.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const { createFundingBook, trancheIdOf } = book;
const verify = (s, m, k) => schnorr.verify(s, m, k);
const sk = (n) => { const b = new Uint8Array(32); b[0] = 4; b[31] = n; return b; };
const pk = (n) => schnorr.getPublicKey(sk(n));
const hexOf = (bytes, id, n) => toHex(Uint8Array.from([...bytes, ...schnorr.sign(id, sk(n))]));
const P = { networkId: new Uint8Array(32).fill(7), author: pk(42), publishedHeight: 100, amountSats: 1000n, lnurl: 'anyone@example.org', purpose: 'A faucet' };
const ID = fundingProposalId(P), IDH = toHex(ID);
const bond = (n, sats) => ({ pubkey: pk(n), outpoint: `${n.toString(16).padStart(2, '0').repeat(32)}:0`, bondSats: BigInt(sats), height: 50, maturity: 100000 });
const vote = (n, choice) => ({ payload: encodeVote({ proposalId: ID, choice, signature: schnorr.sign(voteMessage(ID, choice), sk(n)) }), txid: 'aa'.repeat(32) });

function seat(db = openStore(':memory:')) {
  const chain = { tip: 100, blocks: new Map(), bonds: [bond(10, 3000), bond(11, 7000)] };
  const at = (h) => chain.blocks.get(h) || (chain.blocks.set(h, { hash: `${h}`.padStart(64, '0'), votes: [] }), chain.blocks.get(h));
  const voteChain = { tipHeight: async () => chain.tip, blockHashAt: async (h) => (h <= chain.tip ? at(h).hash : null),
    votesAt: async (h) => at(h).votes.map((v) => ({ ...v, height: h })), censusAt: async () => chain.bonds.map((b) => ({ ...b })) };
  const b = createFundingBook({ db, verify, schedule: FUNDING_SCHEDULES.short, tip: async () => chain.tip, isBonded: () => true,
    activeAt: async (end) => ({ ok: true, nodes: [toHex(pk(2))], fromHeight: end - 432 }), voteChain, seasonedNodes: async () => [toHex(pk(2))] });
  return { b, chain, at, db };
}
async function passed(w) {
  await w.b.add('proposal', hexOf(encodeFundingProposal(P), ID, 42));
  const s = { proposalId: ID, node: pk(2), atHeight: 100 };
  await w.b.add('signal', hexOf(encodeFundingSignal(s), fundingSignalId(s), 2));
  w.chain.tip = 101; await w.b.decide(); w.chain.tip = 101 + FUNDING_SCHEDULES.short.decideDepth - 1; await w.b.decide();   // decided decideDepth deep (kanban #1279)
  w.at(101).votes.push(vote(10, CHOICE.YES), vote(11, CHOICE.YES));
}
const roundTo = async (w, tip) => { w.chain.tip = tip; for (let i = 0; i < 4; i++) await w.b.voteRound(); };

test('#1175: two seats holding different reserve rows name the same part ids', async () => {
  const a = seat(), b = seat();
  await passed(a); await passed(b);
  await roundTo(a, 111); await roundTo(b, 111);
  // the first ask, each with its own reserves: 1000 sat is over 1 % of 50,000 at seat A and under 1 % of 1,000,000 at seat B
  a.b.payments({ tip: 111, reservesSatsOf: () => 50_000n });
  b.b.payments({ tip: 111, reservesSatsOf: () => 1_000_000n });
  await roundTo(a, 117); await roundTo(b, 117);
  const ia = a.b.payments({ tip: 117 }).map((t) => t.id), ib = b.b.payments({ tip: 117 }).map((t) => t.id);
  console.log(`#1175 part ids at tip 117: seat A (50,000 sat held) ${ia.map((x) => x.slice(0, 12)).join(',')} | seat B (1,000,000 sat held) ${ib.map((x) => x.slice(0, 12)).join(',')} | ${ia.join() === ib.join() ? 'SAME' : 'DIFFERENT: the plan is "no passed vote" at the other'}`);
  assert.deepEqual(ia, ib, 'the coordinator\'s part id is a passed vote at every peer');
  assert.deepEqual(ia, [trancheIdOf(IDH, 0, 4)]);
});

test('#1175: a row the old rule fixed is set right while no part is payable; once one is, it stands', async () => {
  const w = seat(); await passed(w);
  await roundTo(w, 111);
  w.db.prepare('INSERT INTO funding_payments (proposal, tranches, cancelled) VALUES (?, 1, NULL)').run(IDH);   // fixed by the old rule
  assert.deepEqual(w.b.payments({ tip: 111 }), []);
  assert.equal(w.db.prepare('SELECT tranches FROM funding_payments WHERE proposal = ?').get(IDH).tranches, 4, 'set right before anything was payable');
  const late = seat(); await passed(late);
  await roundTo(late, 117);
  late.db.prepare('INSERT INTO funding_payments (proposal, tranches, cancelled) VALUES (?, 1, NULL)').run(IDH);
  const [t] = late.b.payments({ tip: 117 });
  assert.deepEqual([t.id, t.of], [IDH, 1], 'its single payment may have gone under the proposal\'s id: the row stands');
});

test('#1175: the payment row has one transition function; a cancellation is terminal', () => {
  const { fundingPaymentStep: step, FUNDING_PAYMENT_STATE: S, fundingPaymentStateOf: stateOf, paymentIdsOf } = book;
  const f = step(null, { kind: 'fix', tranches: 4 });
  assert.equal(stateOf(f.row), S.FIXED);
  assert.equal(step(f.row, { kind: 'fix', tranches: 1 }).ok, false, 'fixed once');
  assert.equal(step(f.row, { kind: 'refix', tranches: 1, payable: true }).ok, false, 'not once a part is payable');
  const c = step(f.row, { kind: 'cancel', k: 2, why: 'NO' });
  assert.equal(stateOf(c.row), S.CANCELLED);
  assert.equal(step(c.row, { kind: 'cancel', k: 1, why: 'reorg' }).ok, false, 'a cancellation never moves');
  assert.equal(step(c.row, { kind: 'refix', tranches: 1, payable: false }).ok, false);
  assert.equal(step(null, { kind: 'fix', tranches: 3 }).ok, false, 'one part or four');
  assert.deepEqual(paymentIdsOf(IDH).slice(0, 2), [IDH, trancheIdOf(IDH, 0, 4)], 'rule 4 counts every id the proposal can have paid under');
  assert.equal(book.trancheCountOf(3n), 1, 'too small to split');
  assert.equal(book.trancheCountOf(4n), 4);
});

test('#1235 (audit 3 FIXES-11): no refix on an unknown tip, none once a payment id of the proposal is recorded; the cap never pays past the amount', async () => {
  const { capStands } = await import('../../arena-protocol/src/funding.js');
  const partsOf = (w) => w.db.prepare('SELECT tranches FROM funding_payments WHERE proposal = ?').get(IDH).tranches;
  const w = seat(); await passed(w);
  await roundTo(w, 111);
  w.db.prepare('INSERT INTO funding_payments (proposal, tranches, cancelled) VALUES (?, 1, NULL)').run(IDH);   // fixed by the old rule, and paid
  w.b.payments({ tip: null });
  const afterNull = partsOf(w);
  w.b.payments({ tip: 111, recorded: (id) => id === IDH });
  const afterRecorded = partsOf(w);
  const fresh = seat(); await passed(fresh); await roundTo(fresh, 111);
  fresh.db.prepare('INSERT INTO funding_payments (proposal, tranches, cancelled) VALUES (?, 1, NULL)').run(IDH);
  fresh.b.payments({ tip: 111, recorded: () => false });
  const cap = (paid, now) => capStands({ proposalSats: 1000n, paymentSats: now, reservesSats: 1_000_000n, paidByProposalSats: paid });
  const caps = { paidThenPart: cap(1000n, 250n), lastPart: cap(750n, 250n) };
  console.log('  MEASURED #1235:', JSON.stringify({ afterNull, afterRecorded, freshRefix: partsOf(fresh), paidThenPart: caps.paidThenPart.ok, lastPart: caps.lastPart.ok }));
  assert.equal(afterNull, 1, 'an unknown tip never refixes');
  assert.equal(afterRecorded, 1, 'a recorded payment id keeps the row as fixed');
  assert.equal(partsOf(fresh), 4, 'nothing recorded, a known tip, nothing payable: set right as before');
  assert.equal(caps.paidThenPart.ok, false); assert.equal(caps.paidThenPart.final, true); assert.match(caps.paidThenPart.why, /more than the 1000 sat it asked/);
  assert.equal(caps.lastPart.ok, true, 'the last part of four still fits');
});
