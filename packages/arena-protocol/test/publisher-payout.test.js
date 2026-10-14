// THE SERIES PUBLISHER IS PAID BACK ITS PUBLICATION FEE (§5A.5, kanban #304; 2026.0.3): the fee proven from the parents the publication
// spends (each its own txid), capped at 10,000 sat, paid once - in round 0, or the first round of the series with entries - off the top
// of the nodes' part of that round's fee locks, never the donation's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { publicationFee, publisherPayoutMsat, publisherRoundIndex, PUBLICATION_FEE_CAP_SATS } from '../src/publisher-payout.js';
import { parseTransaction } from '../src/tx.js';
import { lockSettlement } from '../src/lock-settlement.js';
import { DELIVERED, FAILED } from '../src/payout.js';
import { entryFeeMsat } from '../src/fee.js';
import { toHex } from '../src/hash.js';
import { TEST_FEDERATION_ID } from '../src/test-federation.js';
import { NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';

// A LEGACY TRANSACTION'S BYTES: version 2, inputs (txid, vout), outputs (sats, script), locktime 0
function rawTx(inputs, outputs) {
  const b = [];
  const u32 = (n) => b.push(n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255);
  u32(2); b.push(inputs.length);
  for (const [txid, vout] of inputs) { b.push(...txid); u32(vout); b.push(0); u32(0xffffffff); }
  b.push(outputs.length);
  for (const [sats, script] of outputs) { let v = BigInt(sats); for (let i = 0; i < 8; i++) { b.push(Number(v & 255n)); v >>= 8n; } b.push(script.length, ...script); }
  u32(0);
  return Uint8Array.from(b);
}
const P2WPKH = [0x00, 0x14, ...new Array(20).fill(7)];
const OP_RETURN = [0x6a, 0x04, 0x41, 0x52, 0x4e, 0x53];

test('the fee is what the spent outputs hold less what the publication pays out, proven by the parents; capped at 10,000 sat', () => {
  const parentA = rawTx([[new Uint8Array(32).fill(1), 0]], [[50000, P2WPKH], [7000, P2WPKH]]);
  const parentB = rawTx([[new Uint8Array(32).fill(2), 3]], [[3000, P2WPKH]]);
  const idA = parseTransaction(parentA).txid, idB = parseTransaction(parentB).txid;
  const pub = rawTx([[idA, 1], [idB, 0]], [[0, OP_RETURN], [9200, P2WPKH]]);          // in 7000 + 3000, out 9200: fee 800
  assert.deepEqual(publicationFee(pub, [parentB, parentA]), { ok: true, feeSats: 800n });
  assert.match(publicationFee(pub, [parentA]).why, /was not handed over/);
  // a parent that is not the one the input names proves nothing: it is simply not that txid
  const forged = rawTx([[new Uint8Array(32).fill(1), 0]], [[50000, P2WPKH], [70000, P2WPKH]]);
  assert.match(publicationFee(pub, [forged, parentB]).why, /was not handed over/);
  assert.match(publicationFee(rawTx([[idA, 5]], [[0, OP_RETURN]]), [parentA]).why, /has no output 5/);
  assert.equal(publisherPayoutMsat(800n), 800000n);
  assert.equal(publisherPayoutMsat(25000n), PUBLICATION_FEE_CAP_SATS * 1000n, 'capped at 10,000 sat');
  // round 0, or the first with entries
  assert.equal(publisherRoundIndex(new Map([[0, 2], [1, 5]])), 0);
  assert.equal(publisherRoundIndex(new Map([[0, 0], [1, 0], [2, 3], [3, 1]])), 2);
  assert.equal(publisherRoundIndex(new Map([[0, 0]])), null);
});

test('the round that pays it pays the publisher off the top of the nodes\' part; the nodes share the rest; nothing else moves', () => {
  const b32 = (n) => new Uint8Array(32).fill(n);
  const pk = (n) => { const k = new Uint8Array(32); k[0] = n; k[31] = n; return k; };
  const refund = (n) => { const k = new Uint8Array(33); k[0] = 0x02; k[1] = n; k[32] = n; return k; };
  const N = (n) => { const k = new Uint8Array(32); k[0] = 0xa0 + n; k[31] = n; return k; };
  const STAKE = 10000000n; const FEE = entryFeeMsat(STAKE);
  const e = (n, outcome, score) => ({ pubkey: pk(n), stakeMsat: STAKE, feeMsat: FEE, donationMsat: 0n, outcome, score });
  const W = e(1, DELIVERED, 5), L = e(2, FAILED, 0);
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
  const before = plan(null), after = plan({ payoutPk: refund(0x77), msat: publisherPayoutMsat(800n) });
  assert.equal(before.ok, true, before.why); assert.equal(after.ok, true, after.why);
  const of = (p, kind) => p.payouts.filter((x) => x.kind === kind);
  const [pubPay] = of(after, 'publisher');
  assert.equal(pubPay.msat, 800000n, 'the fee back, whole');
  assert.equal(toHex(pubPay.payoutPk), toHex(refund(0x77)));
  const sum = (xs) => xs.reduce((t, x) => t + x.msat + x.feeMsat, 0n);
  // the nodes give up exactly the publisher's payout and its output fee; the winner's line is untouched
  assert.equal(sum(of(before, 'signer node')) - sum(of(after, 'signer node')), pubPay.msat + pubPay.feeMsat);
  assert.deepEqual(of(after, 'qualifier').map((x) => x.msat), of(before, 'qualifier').map((x) => x.msat));
  console.log(`  fee locks ${2n * FEE} msat: nodes before ${of(before, 'signer node').map((x) => x.msat).join('+')}, after ${of(after, 'signer node').map((x) => x.msat).join('+')} and the publisher ${pubPay.msat}`);
});
