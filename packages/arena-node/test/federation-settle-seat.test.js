// 2026.0.3 STEP 5b - THE SEAT SIGNS, STORES AND SERVES ONE SETTLEMENT TRANSACTION PER FEDERATION (kanban #348). Two signer nodes of
// a 2-of-2 claim key (a dealer's split) settle a round that takes any federation: the plan decided once (federationPlans: lockSettlement
// + splitByFederation), then for each federation its own FROST signature over its own bytes (the peer's doors asked with
// `&federation=`), its own submit through that federation's port, its own row (fed_lock_settlements) - served by /lock-settlement.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import * as curve from '../src/curve.js';
import { LockSettlement, federationPlans } from '../src/settlement.js';
import { openStore } from '../src/store.js';
import { Round } from '../src/round.js';
import { trustedDealerSplit } from '../../arena-protocol/src/frost.js';
import { evenGroupSecret } from '../../arena-protocol/src/frost-bip340.js';
import { encodeCommitments, decodeCommitments, encodeShare } from '../src/pool-wire.js';
import { DELIVERED, FAILED } from '../../arena-protocol/src/payout.js';
import { entryFeeMsat } from '../../arena-protocol/src/fee.js';
import { toHex, sha256 } from '../../arena-protocol/src/hash.js';
import { encodeRoundContract } from '../../arena-protocol/src/contracts.js';
import { NETWORK_ID_REGTEST } from '../../arena-protocol/src/genesis-ids.js';
import { TEST_DONATION_SET_REGTEST } from '../../arena-protocol/src/test-donation-sets.js';
import { donationSetId } from '../../arena-protocol/src/donation.js';
import { NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const pk = (n) => { const k = new Uint8Array(32); k[0] = n; k[31] = n; return k; };
const refund = (n) => { const k = new Uint8Array(33); k[0] = 0x02; k[1] = n; k[32] = n; return k; };
const RID = b32(0x5f);
const STAKE = 100000n; const FEE = entryFeeMsat(STAKE);
const A = 'aa'.repeat(32), B = 'bb'.repeat(32);
const entry = (n, outcome, score) => ({ pubkey: pk(n), stakeMsat: STAKE, feeMsat: FEE, donationMsat: 0n, outcome, score, entryId: b32(0x10 + n) });
const W1 = entry(1, DELIVERED, 5), L1 = entry(3, FAILED, 0), L2 = entry(4, FAILED, 0);
const fedOfPlayer = new Map([[1, A], [3, A], [4, B]]);
const locks = new Map([W1, L1, L2].map((e, i) => [toHex(e.pubkey), { outpoint: { txid: b32(0x40 + Number(e.pubkey[0])), outIdx: BigInt(e.pubkey[0]) }, amountMsat: STAKE - FEE, refundPk: refund(e.pubkey[0]) }]));
const PLAN = federationPlans({ roundId: RID, entries: [W1, L1, L2], minScore: 1, locks, feeLocks: new Map() },
  { federationOf: (o) => fedOfPlayer.get(Number(o.outIdx)), feesOf: (f) => (f === A ? { ppm: 0n, baseMsat: 1000n } : { ppm: 0n, baseMsat: 0n }) });

// THE FEDERATIONS' PORTS: each builds bytes from the claims, payouts and nonce it is handed, and accepts a submit only when the
// signature verifies under the claim key over exactly those bytes - as the guardians check a settlement
function fedPort(fid, log) {
  const bytesOf = ({ claims, payouts, nonce }) => sha256(new TextEncoder().encode(JSON.stringify({ fid, c: claims.map((c) => `${toHex(c.outpoint.txid)}:${c.outpoint.outIdx}:${c.amountMsat}`),
    p: payouts.map((p) => `${toHex(p.payoutPk)}:${p.msat}`), n: toHex(nonce) })));
  return {
    fees: async () => (fid === A ? { ppm: 0n, baseMsat: 1000n } : { ppm: 0n, baseMsat: 0n }),
    settle: async ({ claimPk, claims, payouts, nonce, signature }) => {
      const msg = bytesOf({ claims, payouts, nonce });
      if (!signature) return { message: toHex(msg), txid: toHex(msg) };
      const accepted = schnorr.verify(signature, msg, claimPk.subarray(1));
      log.push({ fid, claims: claims.map((c) => Number(c.outpoint.outIdx)), payouts: payouts.map((p) => [toHex(p.payoutPk).slice(0, 6), p.msat]), nonce: toHex(nonce), accepted });
      return accepted ? { accepted: true } : { accepted: false, error: 'bad signature' };
    },
  };
}

test('two signer nodes settle a round that takes any federation: one signed, submitted and kept transaction per federation', async () => {
  assert.equal(PLAN.ok, true, PLAN.why);
  const G = evenGroupSecret(0x51515n, curve);
  const deal = trustedDealerSplit({ secret: G.secret, max: 2, min: 2, coefficients: [0x77n], curve });
  const claimPk = deal.groupPublicKey;
  const log = [];
  const ports = { [A]: fedPort(A, log), [B]: fedPort(B, log) };
  const router = { forFederation: async (f) => ports[f] || null, settle: async () => { throw new Error('a round that takes any federation never settles on the home port'); } };
  const contract = { stakeMsat: STAKE, protocolVersion: 3, federationId: new Uint8Array(32), nodes: [pk(0xa1), pk(0xa2)], minScore: 1 };
  const nodes = [];
  for (const id of [1, 2]) {
    const round = new Round(openStore(':memory:'));
    const ls = new LockSettlement(round, { dkg: {}, port: router, curve, random: (n) => crypto.getRandomValues(new Uint8Array(n)),
      stakeSecrets: { open: async () => ({ ok: true, preimage: b32(0x99) }) }, peersFor: () => (id === 1 ? ['http://peer2'] : []) });
    // THE PLAN, as planOf answers it for a round that takes any federation (its inputs from the store are the store's business)
    ls.planOf = async () => ({ ok: true, anyFed: true, plan: PLAN.plan, split: PLAN.split, contract, claimPk,
      held: { signerNode: deal.shares[id - 1] }, lockEntry: new Map([W1, L1, L2].map((e) => [toHex(e.pubkey), e.entryId])) });
    nodes.push(ls);
  }
  // node 1 reaches node 2's doors (server.js /settle-commit, /settle-share, /settle-signature with &federation=)
  nodes[0].fetcher = async (url, o) => {
    const u = new URL(url); const fed = u.searchParams.get('federation'); const two = nodes[1];
    const ok = (bytes) => ({ ok: true, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length), text: async () => '' });
    const no = (why) => ({ ok: false, text: async () => why });
    if (u.pathname === '/settle-commit') { const g = await two.commit(RID, { txid: u.searchParams.get('txid'), federation: fed }); return g.ok ? ok(encodeCommitments([g.commitment])) : no(g.why); }
    if (u.pathname === '/settle-share') { const g = await two.share(RID, decodeCommitments(new Uint8Array(o.body)), { federation: fed }); return g.ok ? ok(encodeShare(g.share)) : no(g.why); }
    if (u.pathname === '/settle-signature') { const g = await two.take(RID, o.body, { federation: fed }); return g.ok ? ok(new Uint8Array(0)) : no(g.why); }
    return no('no such door');
  };
  // the round row the settle step reads its version from: a v3 round naming no federation
  const V3 = encodeRoundContract({ networkId: NETWORK_ID_REGTEST, configHash: b32(1), censusConfirmations: 1, gameVerifySlots: 7, settlementSlots: 7,
    gameId: NEXTBLOCK_GAME_ID, simCoreHash: b32(9), committeeTimeMs: 0n, randomnessRule: 'bitcoin-block-hash', startTimeMs: 1n, entryCloseMs: 2n,
    objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20, slashRemainder: 'SPLIT', federationId: new Uint8Array(32),
    stakeExpiryBlocks: 144, publicationRelays: ['wss://r.example'], donationSetId: donationSetId(TEST_DONATION_SET_REGTEST.recipients), censusHeight: 900000,
    censusRoot: b32(2), stakeMsat: STAKE, bondMinSats: 50000n, blockTicks: 4920, exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20,
    timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4, nodes: [], protocolVersion: 3 });
  for (const n of nodes) n.round.get = (rid) => (toHex(rid) === toHex(RID) ? { contract: V3 } : null);
  const got = await nodes[0].settle(RID);
  console.log('  SETTLE:', got.why);
  console.log('  PORTS:', JSON.stringify(log, (k, v) => (typeof v === 'bigint' ? String(v) : v)));
  assert.equal(got.ok, true, got.why);
  assert.equal(log.length, 2, 'one submit per federation');
  const a = log.find((x) => x.fid === A), b = log.find((x) => x.fid === B);
  assert.deepEqual(a.claims.sort(), [3], 'A spends only the lock it holds (L1)');
  assert.deepEqual(b.claims.sort(), [4], 'B spends only the lock it holds (L2)');
  assert.ok(a.accepted && b.accepted, 'each signature verifies under the claim key over that federation\'s own bytes');
  assert.notEqual(a.nonce, b.nonce, 'a nonce per federation');
  // kept per federation at both nodes (the peer by the signature it was handed), and served as /lock-settlement serves it
  const rows = nodes[0].fedSummary(RID);
  assert.deepEqual(rows.map((r) => [r.federation, r.state]), [[A, 'ACCEPTED'], [B, 'ACCEPTED']]);
  assert.deepEqual(nodes[1].fedSummary(RID).map((r) => [r.federation, r.state]), [[A, 'SUBMITTING'], [B, 'SUBMITTING']]);
  // asked again: nothing submitted twice
  const again = await nodes[0].settle(RID);
  assert.equal(again.ok, true); assert.equal(log.length, 2);
  // a single-federation message is refused for such a round
  assert.match((await nodes[0].commit(RID)).why, /signed one federation at a time/);
});
