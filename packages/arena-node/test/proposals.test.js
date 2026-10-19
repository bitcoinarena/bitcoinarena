// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #329: the proposals a seat keeps and serves - taken when they stand and their deposit is on the seat's chain (option A)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { createProposals } from '../src/proposals.js';
import { encodeConfigProposalBody, proposalBodyId, CLASS, SCHEDULES, configHashOf } from '../../arena-protocol/src/ballot.js';
import { depositOutputsExpected } from '../../arena-protocol/src/ballot-chain.js';
import { parseTransaction } from '../../arena-protocol/src/tx.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const le = (n, bytes) => Uint8Array.from({ length: bytes }, (_, i) => Number((BigInt(n) >> BigInt(8 * i)) & 0xffn));
const tx = (outs) => Uint8Array.from([...le(2, 4), 1, ...new Uint8Array(32).fill(7), ...le(0, 4), 0, ...le(0xffffffff, 4),
  outs.length, ...outs.flatMap((o) => [...le(o.sats, 8), o.script.length, ...o.script]), ...le(0, 4)]);
const secret = new Uint8Array(32).fill(1); const proposer = schnorr.getPublicKey(secret);
const pk = (i) => Uint8Array.from([0x02, ...schnorr.getPublicKey(new Uint8Array(32).fill(i))]);
const SET = [{ recipientPk: pk(2), shareBps: 6000, label: 'a' }, { recipientPk: pk(3), shareBps: 4000, label: 'b' }];
const verify = (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } };
const NET = new Uint8Array(32).fill(0x4e);

function proposalWithDeposit(sats, { activationHeight = 200 + 8 } = {}) {
  const want = depositOutputsExpected(sats, SET);
  const raw = tx(want.outputs.map((o) => ({ sats: o.sats, script: o.script })));
  const p = { networkId: NET, parent: new Uint8Array(32).fill(0x10), configHash: configHashOf(Uint8Array.of(1, 2, 3)), config: Uint8Array.of(1, 2, 3),
    class: CLASS.DESIGN, activationHeight, proposer, depositTxid: Uint8Array.from(parseTransaction(raw).txid) };
  const signature = schnorr.sign(proposalBodyId(p), secret);
  return { raw, hex: toHex(Uint8Array.from([...encodeConfigProposalBody(p), ...signature])), txidDisplay: toHex(Uint8Array.from(p.depositTxid).reverse()) };
}

test('a seat keeps a proposal that stands and whose deposit is in the block named, and serves it; anything else by name', async () => {
  const BLOCK = 'bb'.repeat(32);
  const chain = new Map();
  const saved = [];
  const seat = createProposals({ confirmedTx: async (txid, block) => (block === BLOCK && chain.has(txid) ? { raw: chain.get(txid), height: 200 } : null),
    recipientsFor: (net, height) => (net === toHex(NET) && height === 200 ? SET : null), lowestBondMinSatsFor: () => 100000n, verify, schedule: SCHEDULES.regtest,
    store: { read: () => [], write: (l) => saved.push(l.length) } });
  const good = proposalWithDeposit(1000);
  chain.set(good.txidDisplay, good.raw);
  const got = await seat.add({ proposal: good.hex, blockHash: BLOCK });
  console.log('  KEPT:', JSON.stringify({ status: got.status, id: got.id && got.id.slice(0, 16), publishedAt: got.publishedAt, depositSats: got.depositSats, votingFrom: got.votingFrom, votingUntil: got.votingUntil }));
  assert.equal(got.status, 201, got.why);
  assert.deepEqual([got.publishedAt, got.depositSats, got.votingFrom, got.votingUntil, got.class], [200, '1000', 201, 207, 'DESIGN']);
  assert.equal(seat.list().length, 1); assert.deepEqual(saved, [1]);
  assert.equal((await seat.add({ proposal: good.hex, blockHash: BLOCK })).already, true, 'the same proposal again is the one kept');
  // over the cap (1000 > 100 000 / 100 is not; 1001 is)
  const over = proposalWithDeposit(1001); chain.set(over.txidDisplay, over.raw);
  assert.match((await seat.add({ proposal: over.hex, blockHash: BLOCK })).why, /over the cap of 1000/);
  // activation before the end of cooldown (200 + 1 + 6 + 1 = 208)
  const early = proposalWithDeposit(1000, { activationHeight: 207 }); chain.set(early.txidDisplay, early.raw);
  assert.match((await seat.add({ proposal: early.hex, blockHash: BLOCK })).why, /before the end of cooldown/);
  // a deposit not in the block named
  const elsewhere = proposalWithDeposit(999);
  assert.match((await seat.add({ proposal: elsewhere.hex, blockHash: BLOCK })).why, /does not hold the deposit/);
  assert.equal((await seat.add({ proposal: 'zz', blockHash: BLOCK })).status, 400);
  assert.equal(seat.list().length, 1);
});

test('on a running seat: POST /proposal reads the deposit through `ballot`, checks it against the network\'s keyed set in force, GET /proposals serves it', async () => {
  const { serve } = await import('../src/server.js');
  const { openStore } = await import('../src/store.js');
  const { TEST_DONATION_SET_KEYS_REGTEST: KEYS } = await import('../../arena-protocol/src/test-donation-set-keys-regtest.js');
  const { NETWORK_ID_REGTEST } = await import('../../arena-protocol/src/genesis-ids.js');
  const want = depositOutputsExpected(700, KEYS.recipients);
  assert.equal(want.ok, true, want.why);
  const raw = tx(want.outputs.map((o) => ({ sats: o.sats, script: o.script })));
  const p = { networkId: NETWORK_ID_REGTEST, parent: new Uint8Array(32).fill(0x10), configHash: configHashOf(Uint8Array.of(9)), config: Uint8Array.of(9),
    class: CLASS.MONEY, activationHeight: 300 + 8, proposer, depositTxid: Uint8Array.from(parseTransaction(raw).txid) };
  const hex = toHex(Uint8Array.from([...encodeConfigProposalBody(p), ...schnorr.sign(proposalBodyId(p), secret)]));
  const BLOCK = 'cc'.repeat(32);
  const d = await serve(openStore(':memory:'), { port: 0, donationSets: [KEYS],
    ballot: { confirmedTx: async (txid, block) => (block === BLOCK && txid === toHex(Uint8Array.from(p.depositTxid).reverse()) ? { raw, height: 300 } : null), lowestBondMinSats: 100000n } });
  try {
    const base = `http://127.0.0.1:${d.port}`;
    const post = await fetch(`${base}/proposal`, { method: 'POST', body: JSON.stringify({ proposal: hex, blockHash: BLOCK }) });
    const got = await post.json();
    const listed = (await (await fetch(`${base}/proposals`)).json()).proposals;
    console.log('  SEAT:', JSON.stringify({ status: post.status, class: got.class, publishedAt: got.publishedAt, depositSats: got.depositSats, listed: listed.length, outputs: want.outputs.map((o) => Number(o.sats)) }));
    assert.equal(post.status, 201, got.why);
    assert.deepEqual([got.class, got.publishedAt, got.depositSats, listed.length], ['MONEY', 300, '700', 1]);
    const wrong = await fetch(`${base}/proposal`, { method: 'POST', body: JSON.stringify({ proposal: hex, blockHash: 'dd'.repeat(32) }) });
    assert.equal(wrong.status, 200, 'kept already: the same proposal answers the one kept');
  } finally { await d.close(); }
});
