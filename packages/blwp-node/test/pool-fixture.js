// THE COMMITTEE FIXTURE, IN ONE PLACE.
//
// Seven seats on seven stores, one round each has taken the same two entries
// and signed its own result for both, every seat's table signature in every
// seat's store, and a queued payout - which is the state a close leaves behind
// and what every pool test starts from. It was written inside
// `pool-signing.test.js`; letter 18 needs TWO rounds sharing ONE pool, and a
// second copy of a hundred lines is a second place for the fixture to drift.
//
// `dealt` is optional and is the whole reason this moved: a pool is dealt once
// and many rounds are settled out of it, so a test about two rounds hands the
// same shares to both.
import { test } from 'node:test';
import { TEST_DONATION_SET_REGTEST } from '../../protocol/src/test-donation-sets.js';
import { donationSetId as idOfDonationSet } from '../../protocol/src/donation.js';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { schnorr } from '@noble/curves/secp256k1.js';
import { openStore } from '../src/store.js';
import { Round } from '../src/round.js';
import { Payouts, PAYOUT_QUEUED } from '../src/payout.js';
import { PoolSigning } from '../src/pool-signing.js';
import { signPayoutTable, tableFor } from '../src/payout-table.js';
import { trustedDealerSplit } from '../../protocol/src/frost.js';
import { evenGroupSecret, aggregate340, xOnly } from '../../protocol/src/frost-bip340.js';
import { poolOutput } from '../../protocol/src/pool.js';
import { payoutOutputs, winnings } from '../../protocol/src/payout-spend.js';
import { serializeSpend } from '../../protocol/src/bond-spend.js';
import { DELIVERED, FORFEIT } from '../../protocol/src/payout.js';
import { encodePlayerResult, resultId, joinSignedResult } from '../../protocol/src/result.js';
import { encodeEntryContract, entryId } from '../../protocol/src/contracts.js';
import { scalarFrom32, FIELD, SHARES_NEEDED, SHARES_TOTAL } from '../../protocol/src/shares.js';
import { MIN_ENTRY_WINDOW_MS } from '../../protocol/src/constants.js';
import { NETWORK_ID_REGTEST } from '../../protocol/src/genesis-ids.js';
import { feldmanGroup, tweakPoint } from '../src/curve.js';
import { assumeSeated } from './seating.js';
import { toHex } from '../../protocol/src/hash.js';
import { ed25519 } from '@noble/curves/ed25519.js';

// The node fee is 27A.7's 2% of the stake, and the door checks it now
// (M3.3 item 20) - so a fixture carries the RULE rather than a number.
import { entryFeeMsat } from '../../protocol/src/fee.js';
export const rand = (n) => new Uint8Array(randomBytes(n));
export const b32 = (n) => new Uint8Array(32).fill(n);
export const curve = { ...feldmanGroup, tweakPoint };
export const NOW = 1788700000000;
export const POOL_SATS = 200000n;

export const contractFor = (nodes, stakeMsat = 1000000n) => ({
  networkId: NETWORK_ID_REGTEST, configHash: b32(0x43), censusConfirmations: 1,
  gameVerifySlots: SHARES_TOTAL, settlementSlots: SHARES_TOTAL, simCoreHash: b32(1),
  committeeTimeMs: BigInt(NOW), randomnessRule: 'bitcoin-block-hash',
  startTimeMs: BigInt(NOW) + MIN_ENTRY_WINDOW_MS,
  entryCloseMs: BigInt(NOW) + MIN_ENTRY_WINDOW_MS + 200000n,
  objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20,
  slashRemainder: 'BURN', federationId: new Uint8Array(32), stakeExpiryBlocks: 144, publicationRelays: [], donationSetId: idOfDonationSet(TEST_DONATION_SET_REGTEST.recipients), censusHeight: 900000,
  censusRoot: b32(2), stakeMsat, bondMinSats: 50000n, blockTicks: 9000,
  exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20,
  timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4,
  nodes,
});

const player = (n) => {
  const secret = rand(32);
  return { n, secret, pubkey: schnorr.getPublicKey(secret) };
};

/** The pool's key, split once and handed out one share per seat. */
export function dealThePool() {
  let secret;
  do { secret = scalarFrom32(rand(32)); } while (secret === 0n || secret >= FIELD);
  const even = evenGroupSecret(secret, curve);
  return trustedDealerSplit({
    secret: even.secret, max: SHARES_TOTAL, min: SHARES_NEEDED,
    coefficients: Array.from({ length: SHARES_NEEDED - 1 }, () => scalarFrom32(rand(32))),
    curve,
  });
}

/**
 * A WHOLE COMMITTEE, each seat on its own store.
 *
 * Every seat opens the same round, takes the same two entries, signs its OWN
 * result for each of them, collects the other six seats' table signatures and
 * queues the payout. That is the state a close leaves behind, built here
 * because this file is about what happens AFTER it.
 */
export function committee({ minScore = 1, dealt = dealThePool() } = {}) {
  const rounds = Array.from({ length: SHARES_TOTAL },
    () => new Round(openStore(':memory:'), () => NOW));
  const nodes = rounds.map((r) => r.pubkey);
  const contract = contractFor(nodes);

  const winner = player(1);
  const loser = player(2);
  const session = ed25519.utils.randomSecretKey();

  const rid = rounds[0].open(contract);
  const entries = [[winner, DELIVERED, 9], [loser, FORFEIT, 0]].map(([p, outcome, score]) => ({
    contract: {
      roundId: rid, playerPubkey: p.pubkey, sessionPubkey: ed25519.getPublicKey(session),
      stakeCommitment: b32(7), stakeMsat: contract.stakeMsat, feeMsat: entryFeeMsat(contract.stakeMsat),
      donationMsat: 0n, joinTick: 0, worldSecret: b32(0x5e), vssSharesRef: new Uint8Array(32), stakePoint: new Uint8Array(33), feePreimage: new Uint8Array(32), stakeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, feeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, claimKeyAttestationRef: new Uint8Array(32),
    },
    player: p, outcome, score,
  }));

  for (const r of rounds) {
    if (r !== rounds[0]) assert.deepEqual(r.open(contract), rid);
    assumeSeated(r, rid, nodes);
    for (const e of entries) {
      const eid = r.enter(e.contract);
      // THE SEAT'S OWN RESULT, signed under its own key. `entriesFor` reads
      // these and nothing else, so a seat that never replayed a run computes
      // no table for it.
      const result = {
        roundId: rid, playerPubkey: e.player.pubkey, outcome: e.outcome, score: e.score,
        transcriptHash: b32(0x11), simCoreHash: contract.simCoreHash, nodePubkey: r.pubkey,
      };
      const body = encodePlayerResult(result);
      const id = resultId(result);
      r.putResult(rid, eid, r.pubkey, id,
        joinSignedResult(body, schnorr.sign(id, r.identity.secret)));
    }
  }

  // EVERY SEAT'S TABLE SIGNATURE, IN EVERY SEAT'S STORE. §20's five of seven
  // is what `spendFor` checks before it will build anything, and a seat that
  // holds only its own signature has agreed with nobody.
  const payouts = rounds.map((r) => new Payouts(r, { curve, random: rand }));
  const built = payouts.map((p, i) => p.sign({
    roundId: rid,
    entries: signingEntries(rounds[i], rid),
    minScore,
  }));
  for (let i = 0; i < rounds.length; i++)
    for (let j = 0; j < rounds.length; j++)
      if (i !== j) rounds[i].putPayoutSignature(rid, rounds[j].pubkey, built[j].record);

  for (let i = 0; i < rounds.length; i++) {
    const queued = payouts[i].queue({
      roundId: rid, entries: signingEntries(rounds[i], rid), minScore, contract,
    });
    assert.equal(queued.ok, true, queued.why);
    assert.equal(queued.state, PAYOUT_QUEUED);
  }

  const out = poolOutput({ groupPublicKey: dealt.groupPublicKey, curve });
  assert.equal(out.ok, true, out.why);
  const utxo = { txid: b32(0xab), vout: 0, value: POOL_SATS, script: out.script };

  const seats = rounds.map((r, i) => new PoolSigning(r, {
    curve, seat: dealt.shares[i], pool: { groupPublicKey: dealt.groupPublicKey },
  }));
  return { rounds, seats, rid, contract, utxo, out, dealt, winner, loser, minScore, entries };
}

/** What a seat's own store says the round's entries came to. */
export const signingEntries = (round, rid) =>
  new PoolSigning(round, {}).entriesFor(rid).entries;

/** Round one and round two, over the wire and nowhere else. */
export function signWith(chosen, { rid, contract, utxo }) {
  const commitments = chosen.map((s) => {
    const c = s.commit({ roundId: rid, utxo, contract, random: rand });
    assert.equal(c.ok, true, c.why);
    return c.commitment;
  });
  const shares = chosen.map((s) => {
    const got = s.signatureShare({ roundId: rid, utxo, contract, commitments });
    assert.equal(got.ok, true, got.why);
    return got.share;
  });
  return { commitments, shares };
}

