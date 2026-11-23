// kanban #2993: the card's test (audit settle r2-1)
// Audit settle-r2 finding 1: a game round that takes any federation is planned without the fees in force at its census height
// (settlement.js planOf: the one-federation path spreads `...this.roundFees(contract)` into lockSettlement, the any-federation
// path's federationPlans call does not). A fee proposal that moves the website's share (websitePct, fee-proposal.js) is honoured by
// every one-federation round and ignored by every any-federation round: those keep paying the referring website the old 10 %
// of the nodes' fee out of the nodes' part. The safe behaviour: both paths pay the website the share in force.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import * as curve from '../src/curve.js';
import { openStore } from '../src/store.js';
import { Round } from '../src/round.js';
import { LockSettlement } from '../src/settlement.js';
import { encodeRoundContract, encodeEntryContract } from '../../arena-protocol/src/contracts.js';
import { NETWORK_ID_REGTEST } from '../../arena-protocol/src/genesis-ids.js';
import { TEST_FEDERATION_ID } from '../../arena-protocol/src/test-federation.js';
import { TEST_DONATION_SET_REGTEST } from '../../arena-protocol/src/test-donation-sets.js';
import { donationSetId } from '../../arena-protocol/src/donation.js';
import { GIFTS_IN_FEE_LOCK_VERSION, MIN_ENTRY_WINDOW_MS } from '../../arena-protocol/src/constants.js';
import { FEES_TODAY } from '../../arena-protocol/src/fee-proposal.js';
import { DELIVERED, FAILED } from '../../arena-protocol/src/payout.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { TRUCK_CORE_HASH, TRUCK_V3_CONFIG_HASH, NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';
import { BLOCK_TICKS } from '../../nextblock/src/rules/gate.js';
import { HOSTED } from './plugins/hosted.js';
import { pointKey } from '../../arena-protocol/test/point-key-fixture.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const NOW = 1788700000000;
const STAKE = 100000n, FEE = 10000n;   // protocol 27: the whole 10 % in the fee lock
const RID = b32(0x71);
const CLAIM_PK = Uint8Array.from([2, ...schnorr.getPublicKey(b32(0x33))]);
const NODES = [b32(8), b32(9)];
const SITE = pointKey(0x03, 0x5e);   // the website both entries came through
const FED_A = b32(0xaa);
const contractOf = (federationId) => ({
  networkId: NETWORK_ID_REGTEST, configHash: TRUCK_V3_CONFIG_HASH, censusConfirmations: 6, gameVerifySlots: 7, settlementSlots: 7, gameId: NEXTBLOCK_GAME_ID,
  simCoreHash: TRUCK_CORE_HASH, committeeTimeMs: BigInt(NOW), randomnessRule: 'bitcoin-block-hash', startTimeMs: BigInt(NOW) + MIN_ENTRY_WINDOW_MS,
  entryCloseMs: BigInt(NOW) + MIN_ENTRY_WINDOW_MS + 200000n, objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20,
  slashRemainder: 'SPLIT', federationId, stakeExpiryBlocks: 144, publicationRelays: ['wss://r.example'],
  donationSetId: donationSetId(TEST_DONATION_SET_REGTEST.recipients), censusHeight: 900000, censusRoot: b32(2), stakeMsat: STAKE, bondMinSats: 50000n,
  blockTicks: BLOCK_TICKS, exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20, timeFloor: 30, timeCeil: 150, minScore: 1,
  rankNumerator: 3, rankDenominator: 4, nodes: [], protocolVersion: GIFTS_IN_FEE_LOCK_VERSION });
// THE FEES IN FORCE AT THE ROUND'S CENSUS HEIGHT: a passed proposal moved the website's share from 10 % to 30 % of the nodes' fee
const IN_FORCE = { ...FEES_TODAY, websitePct: 30 };
const TARGET = { network: [{ recipientPk: pointKey(0x02, 0xa1), shareBps: 10000, label: 'dev' }], game: [{ recipientPk: pointKey(0x02, 0xa2), shareBps: 10000, label: 'game' }] };
const RK = pointKey(0x02, 0xe5);
// 2.0 (kanban #3244): a protocol-27 round at this census height locks to an Arena lock (arena-lock.js namedClaims): the lock names the round's
// settlement seats and their threshold (5 of 7), not the FROST claim key
const fields = (msat, i) => ({ paymentImage: { kind: 'hash', bytes: '' }, amountMsat: String(msat), claimPk: toHex(CLAIM_PK), refundPk: toHex(pointKey(0x02, 0x10 + i)), expiration: 1000,
  arena: true, threshold: 5, claimKeys: NODES.map(toHex), roundId: toHex(RID), fallbackAfter: 2000 });
const W = { entryId: b32(0x61), pubkey: b32(0x41), stakeMsat: STAKE, feeMsat: FEE, donationMsat: 0n, feePreimage: b32(0xb1), frontendPk: SITE, outcome: DELIVERED, score: 5 };
const L = { entryId: b32(0x62), pubkey: b32(0x42), stakeMsat: STAKE, feeMsat: FEE, donationMsat: 0n, feePreimage: b32(0xb2), frontendPk: SITE, outcome: FAILED, score: 0 };
const ENTRIES = [W, L];
const NO_FEES = { ppm: 0n, baseMsat: 0n };

function seatFor(federationId) {
  const round = new Round(openStore(':memory:'), () => NOW, { plugins: HOSTED });
  const encoded = encodeRoundContract({ ...contractOf(federationId), nodes: NODES });
  round.get = (rid) => (toHex(rid) === toHex(RID) ? { contract: encoded } : null);
  const idx = (eid) => ENTRIES.findIndex((e) => toHex(e.entryId) === toHex(eid));
  round.stakeLock = (eid) => { const i = idx(eid); return i < 0 ? null : { outpoint: `${toHex(b32(0x90 + i))}:0`, fields: fields(STAKE - FEE, i) }; };
  round.feeLock = (eid) => { const i = idx(eid); return i < 0 ? null : { outpoint: `${toHex(b32(0x90 + i))}:1`, fields: fields(FEE, i) }; };
  round.payoutAddress = (eid) => (toHex(eid) === toHex(W.entryId) ? 'lnurl1winner' : null);
  // the entry as the door kept it: it names federation A (an any-federation round's entry says where its locks are)
  round.entry = (eid) => { const e = ENTRIES[idx(eid)]; if (!e) return null;
    return encodeEntryContract({ roundId: RID, playerPubkey: e.pubkey, sessionPubkey: b32(0x71 + idx(eid)), stakeCommitment: b32(0x72), stakeMsat: STAKE, feeMsat: FEE,
      donationMsat: 0n, joinTick: 0, worldSecret: b32(0x73), vssSharesRef: b32(0), stakePoint: new Uint8Array(33), feePreimage: e.feePreimage,
      stakeLockOutpoint: { txid: b32(0x90 + idx(eid)), outIdx: 0n }, feeLockOutpoint: { txid: b32(0x90 + idx(eid)), outIdx: 1n }, claimKeyAttestationRef: b32(0x75), federationId: FED_A }); };
  const fedPort = { fees: async () => NO_FEES, settle: async () => ({}) };
  const port = { ...fedPort, forFederation: async () => fedPort };
  const ls = new LockSettlement(round, { curve, port, stakeSecrets: {}, random: (n) => crypto.getRandomValues(new Uint8Array(n)),
    dkg: { signerNodeFor: () => ({ ok: true, signerNode: { id: 1 }, pool: { groupPublicKey: CLAIM_PK } }) },
    feesFor: () => IN_FORCE, donationTargetFor: () => ({ ok: true, target: TARGET }), reserveKeyFor: async () => RK,
    signerNodesFor: () => ({ gameVerify: NODES, settlement: NODES }) });
  // the entries as this seat holds them, both FINAL (entriesOnRecord's answer; its inputs are the store's business)
  ls.entriesOnRecord = () => ({ ok: true, entries: ENTRIES.map((e) => ({ ...e })), leftOut: [] });
  return ls;
}

const websitePaid = (payouts) => payouts.filter((p) => p.kind === 'frontend' && toHex(p.payoutPk) === toHex(SITE)).reduce((t, p) => t + p.msat, 0n);

test('an any-federation round pays the website the share in force, as a one-federation round does', async () => {
  const one = await seatFor(TEST_FEDERATION_ID).planOf(RID);
  assert.equal(one.ok, true, one.why);
  assert.ok(!one.anyFed);
  const any = await seatFor(new Uint8Array(32)).planOf(RID);
  assert.equal(any.ok, true, any.why);
  assert.equal(any.anyFed, true);
  const oneSite = websitePaid(one.plan.payouts);
  const anySite = websitePaid(any.split.settlements.flatMap((s) => s.payouts));
  // nodes' part of two 10,000 msat fee locks: 2 x 4,000 = 8,000 msat; 30 % of it to the website is 2,400 msat (10 % would be 800)
  console.log(`  website paid: one federation ${oneSite} msat, any federation ${anySite} msat (websitePct in force ${IN_FORCE.websitePct})`);
  assert.equal(oneSite, 2400n, 'the one-federation round pays the website the 30 % in force');
  assert.equal(anySite, oneSite, `the any-federation round pays the website ${anySite} msat, the share of FEES_TODAY (${FEES_TODAY.websitePct} %), not the ${IN_FORCE.websitePct} % in force`);
});

