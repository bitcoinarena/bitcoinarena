// FIVE SEATS, FIVE STORES, FIVE SHARES THAT NEVER MOVE, ONE SIGNATURE.
//
// Item 13 gave the pool a key five of seven can spend; item 10 gave the
// committee a FROST signature. What neither gave it was a committee. Measured
// before this file: `Payouts#pay` takes `signers` - five SECRET scalars - as an
// argument and makes every nonce and every share in one `map`, it has zero
// callers outside tests, no daemon holds a share at all, and no door serves a
// nonce commitment or a signature share. Five of seven was arithmetic in one
// process.
//
// Here each seat is its own `Round` on its own store with its own identity and
// its own share, and the only things that cross between them are a nonce
// commitment and a signature share - the two rounds RFC 9591 asks for. Nothing
// in this file ever puts two shares in one object.
import { test } from 'node:test';
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

const rand = (n) => new Uint8Array(randomBytes(n));
const b32 = (n) => new Uint8Array(32).fill(n);
const curve = { ...feldmanGroup, tweakPoint };
const NOW = 1788700000000;
const POOL_SATS = 200000n;

const contractFor = (nodes, stakeMsat = 1000000n) => ({
  networkId: NETWORK_ID_REGTEST, configHash: b32(0x43), censusConfirmations: 1,
  gameVerifySlots: SHARES_TOTAL, settlementSlots: SHARES_TOTAL, simCoreHash: b32(1),
  committeeTimeMs: BigInt(NOW), randomnessRule: 'bitcoin-block-hash',
  startTimeMs: BigInt(NOW) + MIN_ENTRY_WINDOW_MS,
  entryCloseMs: BigInt(NOW) + MIN_ENTRY_WINDOW_MS + 200000n,
  objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20,
  slashRemainder: 'BURN', donationSetId: b32(0xd0), censusHeight: 900000,
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
function dealThePool() {
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
function committee({ minScore = 1 } = {}) {
  const rounds = Array.from({ length: SHARES_TOTAL },
    () => new Round(openStore(':memory:'), () => NOW));
  const nodes = rounds.map((r) => r.pubkey);
  const contract = contractFor(nodes);
  const dealt = dealThePool();

  const winner = player(1);
  const loser = player(2);
  const session = ed25519.utils.randomSecretKey();

  const rid = rounds[0].open(contract);
  const entries = [[winner, DELIVERED, 9], [loser, FORFEIT, 0]].map(([p, outcome, score]) => ({
    contract: {
      roundId: rid, playerPubkey: p.pubkey, sessionPubkey: ed25519.getPublicKey(session),
      stakeCommitment: b32(7), stakeMsat: contract.stakeMsat, feeMsat: 1000n,
      donationMsat: 0n, joinTick: 0, worldSecret: b32(0x5e), vssSharesRef: new Uint8Array(32),
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
const signingEntries = (round, rid) =>
  new PoolSigning(round, {}).entriesFor(rid).entries;

/** Round one and round two, over the wire and nowhere else. */
function signWith(chosen, { rid, contract, utxo }) {
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

test('five seats on five stores sign one spend of the pool, and no share ever moves', () => {
  const c = committee();
  const five = c.seats.slice(0, SHARES_NEEDED);
  const { commitments, shares } = signWith(five, c);

  // THE SPEND IS EACH SEAT'S OWN, so the asker is only aggregating.
  const spends = five.map((s) => s.spendFor({ roundId: c.rid, utxo: c.utxo, contract: c.contract }));
  for (const s of spends) assert.equal(s.ok, true, s.why);
  for (const s of spends.slice(1))
    assert.deepEqual(s.sighash, spends[0].sighash, 'two seats built two different transactions');

  const sig = aggregate340({
    commitments, message: spends[0].sighash,
    groupPublicKey: spends[0].groupPublicKey, shares, curve,
  });
  assert.equal(sig.signature.length, 64);
  assert.ok(schnorr.verify(sig.signature, spends[0].sighash, c.out.outputKey),
    'five seats produced no signature the pool output would accept');

  // AND IT IS A TRANSACTION, not just 64 bytes: the witness goes on the input
  // the sighash was taken over.
  const raw = serializeSpend({
    inputs: spends[0].inputs, outputs: spends[0].outputs,
    witnesses: [[sig.signature]],
  });
  assert.ok(raw.length > 100, 'that is not a transaction');

  // THE WINNER IS PAID WHAT THE TABLE SAYS. `payoutOutputs` decides the
  // amounts; what is checked here is that the seats built exactly those.
  const entries = signingEntries(c.rounds[0], c.rid);
  const table = tableFor({ roundId: c.rid, entries, minScore: c.minScore }).table;
  const owed = winnings({
    table, stakes: entries.map((e) => ({ pubkey: e.pubkey, stakeMsat: e.stakeMsat })),
  });
  assert.equal(owed.ok, true, owed.why);
  assert.equal(owed.rows.length, 1, 'this fixture owes exactly the one winner');
  const want = payoutOutputs({ rows: owed.rows, poolSats: POOL_SATS });
  assert.deepEqual(spends[0].outputs, want.outputs,
    'the seats did not build the outputs the table asks for');
});

test('four seats produce nothing a pool output would accept', () => {
  const c = committee();
  const four = c.seats.slice(0, SHARES_NEEDED - 1);
  const { commitments, shares } = signWith(four, c);
  const spend = four[0].spendFor({ roundId: c.rid, utxo: c.utxo, contract: c.contract });

  const sig = aggregate340({
    commitments, message: spend.sighash, groupPublicKey: spend.groupPublicKey, shares, curve,
  });
  assert.equal(schnorr.verify(sig.signature, spend.sighash, c.out.outputKey), false,
    'four seats signed for the pool');
});

test('a seat refuses to sign an output that is not this committee\'s pool', () => {
  const c = committee();
  const elsewhere = { ...c.utxo, script: new Uint8Array(34).fill(0x51) };
  const got = c.seats[0].commit({ roundId: c.rid, utxo: elsewhere, contract: c.contract, random: rand });
  assert.equal(got.ok, false);
  assert.match(got.why, /not the pool this committee holds/);
});

test('a seat that has committed to one spend will not commit to another', () => {
  const c = committee();
  const first = c.seats[0].commit({ roundId: c.rid, utxo: c.utxo, contract: c.contract, random: rand });
  assert.equal(first.ok, true, first.why);

  // The same ask again is the same answer, because a retry is ordinary.
  const again = c.seats[0].commit({ roundId: c.rid, utxo: c.utxo, contract: c.contract, random: rand });
  assert.equal(again.ok, true);
  assert.deepEqual(again.commitment.hiding, first.commitment.hiding,
    'a retry was given a second nonce pair');

  // A DIFFERENT SPEND IS REFUSED. Two live pairs is how a seat gets walked
  // into signing twice.
  const other = { ...c.utxo, vout: 1 };
  const second = c.seats[0].commit({ roundId: c.rid, utxo: other, contract: c.contract, random: rand });
  assert.equal(second.ok, false);
  assert.match(second.why, /already committed to a different spend/);
});

test('a seat signs once under one commitment list, and never twice under two', () => {
  const c = committee();
  const five = c.seats.slice(0, SHARES_NEEDED);
  const { commitments, shares } = signWith(five, c);

  // The same list again is the same bytes back - a dropped answer is ordinary.
  const retry = five[0].signatureShare({ roundId: c.rid, utxo: c.utxo, contract: c.contract, commitments });
  assert.equal(retry.ok, true, retry.why);
  assert.equal(retry.share, shares[0], 'a retry produced a second signature');

  // A DIFFERENT LIST IS A DIFFERENT MESSAGE, because the list is hashed into
  // the binding factors and therefore into the challenge. Signing both with
  // one nonce pair publishes the share.
  const sixth = c.seats[SHARES_NEEDED].commit({
    roundId: c.rid, utxo: c.utxo, contract: c.contract, random: rand,
  });
  const wider = [...commitments, sixth.commitment];
  const twice = five[0].signatureShare({ roundId: c.rid, utxo: c.utxo, contract: c.contract, commitments: wider });
  assert.equal(twice.ok, false);
  assert.match(twice.why, /will not sign twice/);
});

test('a seat refuses a commitment list it is not in, and one that misquotes it', () => {
  const c = committee();
  const five = c.seats.slice(0, SHARES_NEEDED);
  const commitments = five.map((s) =>
    s.commit({ roundId: c.rid, utxo: c.utxo, contract: c.contract, random: rand }).commitment);

  const without = commitments.slice(1);
  const missing = five[0].signatureShare({ roundId: c.rid, utxo: c.utxo, contract: c.contract, commitments: without });
  assert.equal(missing.ok, false);
  assert.match(missing.why, /not in the commitment list/);

  const forged = commitments.map((x, i) => (i === 0 ? { ...x, hiding: commitments[1].hiding } : x));
  const wrong = five[0].signatureShare({ roundId: c.rid, utxo: c.utxo, contract: c.contract, commitments: forged });
  assert.equal(wrong.ok, false);
  assert.match(wrong.why, /a commitment this seat never made/);
});

test('a seat whose committee never agreed a table signs nothing', () => {
  const c = committee();
  // A seat that holds only its own table signature has agreed with nobody, so
  // it has no final table and therefore no spend to build.
  const alone = new Round(openStore(':memory:'), () => NOW);
  const lonely = new PoolSigning(alone, {
    curve, seat: c.dealt.shares[0], pool: { groupPublicKey: c.dealt.groupPublicKey },
  });
  const got = lonely.commit({ roundId: c.rid, utxo: c.utxo, contract: c.contract, random: rand });
  assert.equal(got.ok, false);
  assert.match(got.why, /queued no payout/);
});

test('a node that holds no share of the pool says so instead of signing', () => {
  const c = committee();
  const shareless = new PoolSigning(c.rounds[0], { curve, pool: { groupPublicKey: c.dealt.groupPublicKey } });
  const got = shareless.commit({ roundId: c.rid, utxo: c.utxo, contract: c.contract, random: rand });
  assert.equal(got.ok, false);
  assert.match(got.why, /holds no share of the pool/);
});

test('a row that says queued is not evidence: without five signatures the seat will not sign', () => {
  const c = committee();
  // A NODE WHOSE STORE SAYS PAYOUT_QUEUED AND WHOSE COMMITTEE AGREED NOTHING.
  // A row is what a node WROTE DOWN; what authorises a signature is what the
  // SEATED committee has signed, and this one holds none of that - its own
  // signature is not even a seat's, because the census seated seven other
  // keys. So the count is zero and the seat builds nothing, which is the check
  // that stops a queued row standing in for five of seven.
  const alone = new Round(openStore(':memory:'), () => NOW);
  assert.deepEqual(alone.open(c.contract), c.rid);
  assumeSeated(alone, c.rid, c.contract.nodes);
  for (const e of c.entries) {
    const { player, outcome, score } = e;
    const eid = alone.enter(e.contract);
    const result = {
      roundId: c.rid, playerPubkey: player.pubkey, outcome, score,
      transcriptHash: b32(0x11), simCoreHash: c.contract.simCoreHash, nodePubkey: alone.pubkey,
    };
    const id = resultId(result);
    alone.putResult(c.rid, eid, alone.pubkey, id,
      joinSignedResult(encodePlayerResult(result), schnorr.sign(id, alone.identity.secret)));
  }
  const built = new Payouts(alone, { curve, random: rand })
    .sign({ roundId: c.rid, entries: signingEntries(alone, c.rid), minScore: c.minScore });
  alone.putPayout({
    roundId: c.rid, tableId: built.tableId, state: PAYOUT_QUEUED,
    why: 'written by a node that agreed with nobody',
  });

  const seat = new PoolSigning(alone, {
    curve, seat: c.dealt.shares[0], pool: { groupPublicKey: c.dealt.groupPublicKey },
  });
  const got = seat.commit({ roundId: c.rid, utxo: c.utxo, contract: c.contract, random: rand });
  assert.equal(got.ok, false);
  assert.match(got.why, /0 of 5 seats signed this table/);
});

test('a seat asked in round two about a different output signs nothing', () => {
  const c = committee();
  const first = c.seats[0].commit({ roundId: c.rid, utxo: c.utxo, contract: c.contract, random: rand });
  assert.equal(first.ok, true, first.why);

  // The SAME pool, a different output of it: a legitimate spend this seat
  // never committed to. Its nonces belong to the first one.
  const elsewhere = { ...c.utxo, vout: 3 };
  const got = c.seats[0].signatureShare({
    roundId: c.rid, utxo: elsewhere, contract: c.contract,
    commitments: [first.commitment],
  });
  assert.equal(got.ok, false);
  assert.match(got.why, /committed to a different spend/);
});
