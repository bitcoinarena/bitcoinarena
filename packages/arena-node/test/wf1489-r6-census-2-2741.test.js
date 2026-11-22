// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 r6 census-2 (P1): the price of a config proposal is the proposer's own word. §27A.7.2: "proposal_deposit_sats is a median
// scalar (§27A.2) - the network prices proposing through the mechanism that needs no proposal - but it is capped" (<= bond_min / 100), and
// the deposit is "a fixed price for occupying the whole network's attention for a month". proposals.js checks only the cap
// (proposalStands: depositSats > cap refused); nothing reads the census's declared proposal_deposit_sats (advert `declares`,
// census-median.js bondWeightedMedian, served at GET /census-median and read by nothing else). A bonded node pays 1 sat per proposal -
// each one kept, served at GET /proposals, pulled by every seat, voted on and tallied - so the rate limit the deposit is for is gone.
// Safe behaviour: a deposit below the bond-weighted median proposal_deposit_sats of the census at its publication is refused.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { createProposals } from '../src/proposals.js';
import { encodeConfigProposalBody, proposalBodyId, CLASS, SCHEDULES, configHashOf } from '../../arena-protocol/src/ballot.js';
import { depositOutputsExpected } from '../../arena-protocol/src/ballot-chain.js';
import { bondWeightedMedian } from '../../arena-protocol/src/census-median.js';
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

function proposalWithDeposit(sats) {
  const want = depositOutputsExpected(sats, SET);
  const raw = tx(want.outputs.map((o) => ({ sats: o.sats, script: o.script })));
  const p = { networkId: NET, parent: new Uint8Array(32).fill(0x10), configHash: configHashOf(Uint8Array.of(1, 2, 3)), config: Uint8Array.of(1, 2, 3),
    class: CLASS.DESIGN, activationHeight: 208, proposer, depositTxid: Uint8Array.from(parseTransaction(raw).txid) };
  const signature = schnorr.sign(proposalBodyId(p), secret);
  return { raw, hex: toHex(Uint8Array.from([...encodeConfigProposalBody(p), ...signature])), txidDisplay: toHex(Uint8Array.from(p.depositTxid).reverse()) };
}

test('wf1489 r6 census-2: a 1-sat deposit does not buy a config proposal where the census prices proposing at 1000 sat', async () => {
  // the census at the publication height: the proposer and two other bonded nodes, all declaring proposal_deposit_sats = 1000 (cap 100 000 / 100 = 1000)
  const declares = { bondMinSats: 100000n, proposalDepositSats: 1000n };
  const census = [proposer, schnorr.getPublicKey(new Uint8Array(32).fill(8)), schnorr.getPublicKey(new Uint8Array(32).fill(9))]
    .map((k, i) => ({ pubkey: k, outpoint: `${'cd'.repeat(32)}:${i}`, bondSats: 200000n, advert: { declares } }));
  assert.equal(bondWeightedMedian(census, 'proposalDepositSats'), 1000n, 'setup: the network prices a proposal at 1000 sat');
  const BLOCK = 'bb'.repeat(32);
  const chain = new Map();
  const seat = createProposals({ confirmedTx: async (txid, block) => (block === BLOCK && chain.has(txid) ? { raw: chain.get(txid), height: 200 } : null),
    recipientsFor: (net, height) => (net === toHex(NET) && height === 200 ? SET : null), lowestBondMinSatsFor: () => 100000n, verify, schedule: SCHEDULES.regtest,
    censusAt: async () => census, store: { read: () => [], write: () => {} } });
  const cheap = proposalWithDeposit(1);
  chain.set(cheap.txidDisplay, cheap.raw);
  const got = await seat.add({ proposal: cheap.hex, blockHash: BLOCK });
  assert.notEqual(got.status, 201, `a proposal with a deposit of ${got.depositSats} sat was kept (phase counting, voted on, served) where the census's price is 1000 sat`);
  assert.equal(seat.list().length, 0);
});
