// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// SECTION 13C'S NO-QUORUM RULE, ON ONE NODE.
//
// "If, after the result window, no result has 5-of-7 signatures: if the
// disagreement is explained by proven player equivocation (13B) -> FORFEIT.
// Otherwise the fault is on the operator side -> the entry becomes VOID, the
// stake is refunded by letting the HTLC expire, and the entry is excluded from
// the pool and from the payout table."
//
// "This is deliberately asymmetric: a player cannot manufacture a refund by
// causing disagreement, because the only way a player can cause it is
// equivocation, and equivocation forfeits."
//
// NO DAEMONS ARE INVENTED HERE. Both inputs are already in the tree: the fork
// proof a node publishes, and a count of how many committee members signed. The
// output is the word `computePayoutTable` already consumes, so the money end of
// the rule is the one that has been measured since before this file existed.
//
// WHAT IS NOT HERE: the result window, the HTLC that hands the stake back, and
// the slashing of nodes that contradict a replay. Those need the other six
// daemons or Lightning, and none of them is pretended at.
import { TEST_FEDERATION_ID } from '../../arena-protocol/src/test-federation.js';
import { TRUCK_CORE_HASH, TRUCK_V3_CONFIG_HASH } from '../../nextblock/plugin/nextblock.js';
import { BLOCK_TICKS } from '../../nextblock/src/rules/gate.js';
import { test } from 'node:test';
import { TEST_DONATION_SET_REGTEST } from '../../arena-protocol/src/test-donation-sets.js';
import { donationSetId as idOfDonationSet } from '../../arena-protocol/src/donation.js';
import assert from 'node:assert/strict';
import { ed25519 } from '@noble/curves/ed25519.js';
import { schnorr } from '@noble/curves/secp256k1.js';

import { openStore } from '../src/store.js';
import { Round } from '../src/round.js';
import { serve } from '../src/server.js';
import {
  noQuorumOutcome, computePayoutTable,
  isRefund, REFUNDS,
  DELIVERED, FORFEIT, VOID, ENTRY_VOID,
} from '../../arena-protocol/src/payout.js';
import { lockActions, lockAction, CLAIM, RETURN, EXPIRE } from '../../arena-protocol/src/lock-action.js';
import { resultId } from '../../arena-protocol/src/result.js';
import { finality, FINAL, PROVISIONALLY_FINAL } from '../../arena-protocol/src/objection.js';
import {
  encodeCheckpoint, checkpointId, NO_PREVIOUS, joinSigned, provesEquivocation,
  SIGNED_CHECKPOINT_BYTES,
} from '../../arena-protocol/src/checkpoint.js';
import { decodeEntryContract } from '../../arena-protocol/src/contracts.js';
import { GENESIS } from '../../arena-protocol/src/transcript.js';
import { encodeInputBatch } from '../../arena-protocol/src/batch.js';
import { toHex } from '../../arena-protocol/src/hash.js';

// The node fee is 27A.7's 2% of the stake, and the door checks it now
// (M3.3 item 20) - so a fixture carries the RULE rather than a number.
import { entryFeeMsat } from '../../arena-protocol/src/fee.js';
import { HOSTED } from './plugins/hosted.js';
import { NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';
const b32 = (n) => new Uint8Array(32).fill(n);
const verify = (s, m, k) => { try { return ed25519.verify(s, m, k); } catch { return false; } };
const NEEDED = 5;

const contract = () => ({
  networkId: b32(0x4e), configHash: TRUCK_V3_CONFIG_HASH, censusConfirmations: 6, gameVerifySlots: 7, settlementSlots: 7, gameId: NEXTBLOCK_GAME_ID, simCoreHash: TRUCK_CORE_HASH, startTimeMs: 60500n, entryCloseMs: 2000n, objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20, slashRemainder: 'SPLIT', federationId: TEST_FEDERATION_ID, stakeExpiryBlocks: 144, publicationRelays: ['wss://r.example'], donationSetId: idOfDonationSet(TEST_DONATION_SET_REGTEST.recipients),
  censusHeight: 900000, censusRoot: b32(2), committeeTimeMs: 500n, randomnessRule: 'bitcoin-block-hash',
  stakeMsat: 100000n, bondMinSats: 50000n, blockTicks: BLOCK_TICKS,
  exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20,
  timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4,
  nodes: [b32(4)],
});

/** One entry on a real node, optionally made to sign two chains. */
function player(round, rid, seed, { forks = false } = {}) {
  const session = ed25519.utils.randomSecretKey();
  const eid = round.enter({
    roundId: rid, playerPubkey: b32(seed), sessionPubkey: ed25519.getPublicKey(session),
    stakeCommitment: b32(7), stakeMsat: 100000n, feeMsat: entryFeeMsat(100000n), donationMsat: 0n, joinTick: 0, worldSecret: b32(0x5e), vssSharesRef: new Uint8Array(32), stakePoint: new Uint8Array(33), feePreimage: new Uint8Array(32), stakeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, feeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, claimKeyAttestationRef: new Uint8Array(32),
  });
  const sign = (m) => joinSigned(encodeCheckpoint(m), ed25519.sign(checkpointId(m), session));
  // THE INPUTS FIRST, as a client sends them: a node refuses a checkpoint at a
  // tick whose inputs it does not hold, and every mark here is at 180 or less.
  round.batch(encodeInputBatch({
    roundId: rid, entryId: eid, previousHash: GENESIS, firstTick: 0,
    ticks: Array.from({ length: 400 }, (_, i) => [65536, i, 0, 0, 0]), liquidations: [],
  }));
  const first = {
    roundId: rid, entryId: eid, tick: 60, stateHash: b32(seed),
    inputChainHash: GENESIS, previousHash: NO_PREVIOUS,
  };
  round.checkpoint(sign(first));
  if (forks) {
    const parent = checkpointId(first);
    round.checkpoint(sign({ ...first, tick: 120, stateHash: b32(0xa1), previousHash: parent }));
    assert.throws(
      () => round.checkpoint(sign({ ...first, tick: 180, stateHash: b32(0xb2), previousHash: parent })),
      /does not follow the chain head/);
  }
  return { eid, session };
}

/** Exactly what a third party does: fetch the proof, fetch the key, check it. */
async function forkProven(base, rid, eid) {
  const r = await fetch(`${base}/equivocation?round=${toHex(rid)}&entry=${toHex(eid)}`);
  if (r.status !== 200) return false;
  const body = new Uint8Array(await r.arrayBuffer());
  const got = await fetch(`${base}/entry?id=${toHex(eid)}`);
  const entry = decodeEntryContract(new Uint8Array(await got.arrayBuffer()));
  const seen = await provesEquivocation(
    body.subarray(0, SIGNED_CHECKPOINT_BYTES),
    body.subarray(SIGNED_CHECKPOINT_BYTES), entry.sessionPubkey, verify);
  return seen.ok;
}

test('equivocation forfeits, and disagreement without a fork proof is VOID', async () => {
  const round = new Round(openStore(), () => 1234, { plugins: HOSTED });
  const rid = round.open(contract());
  const a = player(round, rid, 0x0a, { forks: true });    // signed two chains
  const b = player(round, rid, 0x0b);                     // played straight

  const node = await serve(round.db, { plugins: HOSTED, port: 0, funded: () => true });
  try {
    const base = `http://127.0.0.1:${node.port}`;

    // the evidence, from the doors, exactly as a stranger would take it
    const aForked = await forkProven(base, rid, a.eid);
    const bForked = await forkProven(base, rid, b.eid);
    assert.equal(aForked, true, 'the fork proof did not come off the door');
    assert.equal(bForked, false, 'a player who played straight was proven a forker');

    // 1. a published fork and no quorum
    const one = noQuorumOutcome({ signatures: 3, needed: NEEDED, equivocationProven: aForked });
    assert.equal(one.outcome, FORFEIT);
    assert.match(one.why, /no quorum at 3 of 5, and the player signed two chains/);

    // 2. no proof and no quorum
    const two = noQuorumOutcome({ signatures: 3, needed: NEEDED, equivocationProven: bForked });
    assert.equal(two.outcome, VOID);
    assert.match(two.why, /nothing shows the player caused it/);

    // and a committee that DID agree is not this rule's business
    const agreed = noQuorumOutcome({ signatures: 5, needed: NEEDED, equivocationProven: false });
    assert.equal(agreed.outcome, null);
    assert.match(agreed.why, /the committee agreed: 5 of 5/);
  } finally { await node.close(); }
});

/**
 * THE ASYMMETRY, IN MONEY. The forfeited stake joins the pool the winner is
 * paid from; the void stake does not, and the void entry is not in the table
 * at all. A player who could VOID by causing disagreement would have a free
 * refund on every losing round.
 */
test('the forfeited stake pays the winner and the void stake stays out', () => {
  const winner = { entryId: b32(1), pubkey: b32(1), outcome: DELIVERED, score: 100, stakeMsat: 100000n, feeMsat: 0n, donationMsat: 0n };
  const forker = { entryId: b32(2), pubkey: b32(2), outcome: FORFEIT, score: 0, stakeMsat: 100000n, feeMsat: 0n, donationMsat: 0n };
  const voided = { entryId: b32(3), pubkey: b32(3), outcome: VOID, score: 0, stakeMsat: 100000n, feeMsat: 0n, donationMsat: 0n };

  const t = computePayoutTable({ roundId: b32(9), minScore: 1, entries: [winner, forker, voided] });

  assert.equal(t.pool, 100000n, 'the pool is the forfeited stake and nothing else');
  assert.equal(t.qualifiers, 1);
  assert.equal(t.table.length, 2, 'the void entry is in the payout table');
  assert.equal(t.table[0].amountMsat, 200000n, 'the winner gets their stake and the forfeited one');
  assert.equal(t.table[1].amountMsat, 0n);

  // the same round with the forker VOIDed instead: nothing to win
  const noPool = computePayoutTable({
    roundId: b32(9), minScore: 1,
    entries: [winner, { ...forker, outcome: VOID }, voided],
  });
  assert.equal(noPool.pool, 0n);
  assert.equal(noPool.table[0].amountMsat, 100000n, 'only the stake back');
});

test('a count that is not a count is refused rather than guessed', () => {
  assert.throws(() => noQuorumOutcome({ signatures: -1, needed: 5 }), /cannot be negative/);
  assert.throws(() => noQuorumOutcome({ signatures: 1.5, needed: 5 }), /count of committee members/);
  assert.throws(() => noQuorumOutcome({ signatures: 3, needed: 0 }), /positive count/);

  // AND ONLY `true` FORFEITS. An object, a string or a truthy answer somebody
  // forgot to await must not take a stake.
  for (const said of [undefined, null, 'yes', 1, {}, Promise.resolve(true)]) {
    assert.equal(noQuorumOutcome({ signatures: 3, needed: 5, equivocationProven: said }).outcome,
      VOID, String(said));
  }
});

/**
 * A FINAL RESULT CANNOT BE VOIDED.
 *
 * Section 14: "once a player's result is FINAL, later infrastructure failure
 * does not erase it", and its ladder puts VOID and ENTRY_VOID reachable ONLY
 * from PROVISIONAL.
 *
 * Measured before this refusal existed: a result five committee members had
 * signed, whose objection window had closed, answered FINAL - and
 * noQuorumOutcome, asked afterwards with a low count, answered VOID. Both
 * functions were right on their own and nothing crossed them, so a settled
 * round could be refunded after the fact.
 */
test('a result that is already FINAL is not voided by a later low count', () => {
  const committee = [1, 2, 3, 4, 5, 6, 7].map(b32);
  const r = {
    roundId: b32(1), playerPubkey: b32(2), outcome: DELIVERED, score: 1,
    transcriptHash: b32(3), simCoreHash: TRUCK_CORE_HASH, nodePubkey: committee[0],
  };
  const signedBy = [0, 1, 2, 3, 4].map((i) => ({ resultId: resultId(r), nodePubkey: committee[i] }));
  const at = 10000n;
  const closed = finality({
    signedBy, committee, contract: { objectionWindowMs: 600000n }, custody: 'FEDERATION', slashMinimumServed: 20, slashRemainder: 'SPLIT', federationId: TEST_FEDERATION_ID, stakeExpiryBlocks: 144, publicationRelays: ['wss://r.example'], donationSetId: idOfDonationSet(TEST_DONATION_SET_REGTEST.recipients),
    provisionalAtMs: at, now: at + 600000n,
  });
  assert.equal(closed.state, FINAL);

  // asked anyway, with a count that would have voided a provisional result
  const after = noQuorumOutcome({
    signatures: 3, needed: NEEDED, equivocationProven: false, state: closed.state,
  });
  assert.equal(after.outcome, null, 'a FINAL result was voided');
  assert.notEqual(after.outcome, VOID);
  assert.match(after.why, /already FINAL/);
  assert.match(after.why, /reachable only from PROVISIONAL/);

  // and the hold is not refunded a second time: FINAL is not a refund state
  const entries = [
    { entryId: b32(1), pubkey: b32(1), outcome: DELIVERED, score: 100, stakeMsat: 100000n, feeMsat: 0n, donationMsat: 0n },
    { entryId: b32(2), pubkey: b32(2), outcome: FORFEIT, score: 0, stakeMsat: 100000n, feeMsat: 0n, donationMsat: 0n },
  ];
  const s = lockActions({ roundId: b32(9), minScore: 1, entries });
  assert.equal(s.refundedMsat, 100000n, 'only the winner s own stake goes home');
  assert.equal(s.poolMsat, 100000n);

  // FROM PROVISIONAL, the same low count still voids
  const provisional = noQuorumOutcome({
    signatures: 3, needed: NEEDED, equivocationProven: false, state: PROVISIONALLY_FINAL,
  });
  assert.equal(provisional.outcome, VOID);
  assert.match(provisional.why, /nothing shows the player caused it/);

  // and with no state given at all it behaves as it always did
  assert.equal(noQuorumOutcome({ signatures: 3, needed: NEEDED }).outcome, VOID);
});

/**
 * ENTRY_VOID IS ARENA'S FIFTH WORD, not a synonym for VOID.
 *
 * Section 14's ladder and section 18's pool rule name both, and 23.2 gives
 * them the same hold. They behave alike everywhere money is counted - the
 * stake goes home, the pool never sees it - and they stay two words because
 * they say different things: VOID is a round played and unsettleable,
 * ENTRY_VOID is an entry that never activated.
 */
test('an entry that never activated is ENTRY_VOID, and neither word touches the pool', () => {
  const winner = { entryId: b32(1), pubkey: b32(1), outcome: DELIVERED, score: 100, stakeMsat: 100000n, feeMsat: 0n, donationMsat: 0n };
  const loser = { entryId: b32(2), pubkey: b32(2), outcome: FORFEIT, score: 0, stakeMsat: 100000n, feeMsat: 0n, donationMsat: 0n };
  const voided = { entryId: b32(3), pubkey: b32(3), outcome: VOID, score: 0, stakeMsat: 100000n, feeMsat: 0n, donationMsat: 0n };
  const never = { entryId: b32(4), pubkey: b32(4), outcome: ENTRY_VOID, score: 0, stakeMsat: 100000n, feeMsat: 0n, donationMsat: 0n };

  const s = lockActions({ roundId: b32(9), minScore: 1, entries: [winner, loser, voided, never] });
  const said = new Map(s.actions.map((a) => [a.entry, a.action]));

  assert.equal(said.get(never), EXPIRE, 'a never-activated entry was made to act');
  assert.equal(said.get(voided), EXPIRE);
  assert.equal(said.get(loser), CLAIM);
  assert.equal(said.get(winner), RETURN);

  assert.equal(s.poolMsat, 100000n, 'a refunded entry contributed to the pool');
  assert.equal(s.refundedMsat, 300000n, 'the winner s, the void and the never-activated');
  assert.equal(s.poolMsat - s.sharesMsat, 0n);

  // "VOID and ENTRY_VOID entries neither contribute to nor draw from the pool"
  assert.equal(s.table.table.length, 2, 'a refunded entry is in the payout table');
  assert.equal(s.table.table[0].amountMsat, 200000n);

  // the words are distinct: one is not written as the other
  assert.notEqual(ENTRY_VOID, VOID);
  assert.deepEqual(REFUNDS, [VOID, ENTRY_VOID]);
  assert.equal(isRefund(ENTRY_VOID), true);
  assert.equal(isRefund(FORFEIT), false);

  // and it needs nothing to refund, exactly as VOID does
  const said2 = lockAction({ outcome: ENTRY_VOID, state: 'SUSPENDED', shares: 0, signatures: 0 });
  assert.equal(said2.action, EXPIRE);
  assert.equal(said2.authorised, true);
});
