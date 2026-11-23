// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// kanban #1489 wf1489-r20-settle-1: the series publisher's fee back is capped at the nodes' part of the fee locks, and the website's
// 10 % is taken off the same nodes' part afterwards with no cap of its own: in the round that pays the publisher, one entry naming a
// website (any player sets frontendPk, its own key will do) makes the fee lines come to more than the fee locks hold, and lockSettlement
// refuses the whole round's ONE settlement - the winner's payout and every fee claim with it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { publisherPayoutMsat } from '../src/publisher-payout.js';
import { lockSettlement } from '../src/lock-settlement.js';
import { DELIVERED, FAILED } from '../src/payout.js';
import { entryFeeMsat } from '../src/fee.js';
import { toHex, fromHex } from '../src/hash.js';
import { TEST_FEDERATION_ID } from '../src/test-federation.js';
import { NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';

test('#1489 r20-settle-1: in the round that pays the publisher, an entry naming a website still settles, and the fee lines stay within the fee locks', () => {
  const b32 = (n) => new Uint8Array(32).fill(n);
  const pk = (n) => { const k = new Uint8Array(32); k[0] = n; k[31] = n; return k; };
  const refund = (n) => { const k = new Uint8Array(33); k[0] = 0x02; k[1] = n; k[32] = n; return k; };
  const N = (n) => { const k = new Uint8Array(32); k[0] = 0xa0 + n; k[31] = n; return k; };
  const STAKE = 4000000n; const FEE = entryFeeMsat(STAKE);
  const e = (n, outcome, score) => ({ pubkey: pk(n), stakeMsat: STAKE, feeMsat: FEE, donationMsat: 0n, outcome, score });
  const SITE = fromHex('0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798');
  const W = { ...e(1, DELIVERED, 5), frontendPk: SITE }, L = e(2, FAILED, 0);
  const locks = new Map([W, L].map((x, i) => [toHex(x.pubkey), { outpoint: { txid: b32(0x40 + i), outIdx: BigInt(i) }, amountMsat: STAKE - FEE, refundPk: refund(i + 1) }]));
  const feeLocks = new Map([W, L].map((x, i) => [toHex(x.pubkey), { outpoint: { txid: b32(0x80 + i), outIdx: BigInt(i) }, amountMsat: FEE, preimage: b32(0xf0 + i) }]));
  const nodes = [N(1), N(2)];
  const contract = {
    networkId: b32(0x4e), configHash: b32(0x43), censusConfirmations: 1, gameVerifySlots: 2, settlementSlots: 2, gameId: NEXTBLOCK_GAME_ID, simCoreHash: b32(1),
    startTimeMs: 60500n, entryCloseMs: 2000n, objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20, slashRemainder: 'SPLIT',
    federationId: TEST_FEDERATION_ID, stakeExpiryBlocks: 144, publicationRelays: [], donationSetId: b32(0xd0), censusHeight: 900000, censusRoot: b32(2),
    committeeTimeMs: 500n, randomnessRule: 'bitcoin-block-hash', stakeMsat: STAKE, bondMinSats: 50000n, blockTicks: 9000,
    exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20, timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4, nodes,
  };
  const fees = { ppm: 0n, baseMsat: 1000n };
  const plan = (publisher) => lockSettlement({ roundId: b32(0x5f), entries: [W, L], minScore: 1, locks, feeLocks, fees, contract,
    signerNodes: { gameVerify: nodes, settlement: nodes, ...(publisher ? { publisher } : {}) } });
  const p = plan({ payoutPk: refund(0x77), msat: publisherPayoutMsat(800n) });
  const plain = lockSettlement({ roundId: b32(0x5f), entries: [{ ...W, frontendPk: undefined }, L], minScore: 1, locks, feeLocks, fees, contract,
    signerNodes: { gameVerify: nodes, settlement: nodes, publisher: { payoutPk: refund(0x77), msat: publisherPayoutMsat(800n) } } });
  assert.equal(plain.ok, true, plain.why);
  console.log(`  FACTS: without a website the round settles (winner ${plain.payouts.filter((x) => x.kind === 'qualifier').map((x) => x.msat).join(',')} msat); with one: ${p.ok ? 'settles' : `REFUSED - ${p.why}`}`);
  assert.equal(p.ok, true, `one entry naming a website stops the whole round's settlement (the winner is paid nothing): ${p.why}`);
  const feeKinds = new Set(['publisher', 'frontend', 'signer node', 'guardian payout key']);
  const feeLines = p.payouts.filter((x) => feeKinds.has(x.kind));
  const out = feeLines.reduce((t, x) => t + x.msat + x.feeMsat, 0n);
  const inputFees = 2n * fees.baseMsat;
  const spendable = 2n * FEE - inputFees;
  console.log(`  FACTS: fee locks ${2n * FEE} msat (spendable ${spendable}); fee lines pay ${out} msat with their fees: ${feeLines.map((x) => `${x.kind} ${x.msat}`).join(', ')}`);
  assert.ok(out <= spendable, `the fee lines pay ${out} msat out of fee locks that hold ${spendable} after input fees: ${out - spendable} msat taken from elsewhere`);
});
