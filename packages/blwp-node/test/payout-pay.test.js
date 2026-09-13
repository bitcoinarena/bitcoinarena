// FROM A FINAL RESULT TO SATS, AND WHO HAD TO AGREE ON THE WAY.
//
// 9.4's qualifying tail. Measured before this: AWAITING_INVOICE,
// CANCEL_REQUESTED, PAYOUT_QUEUED and PAID were in no source file, and
// `encodePayoutTable` had zero callers - so a delivered player got their own
// stake back and was never paid a winning.
//
// Three thresholds and they are not the same one: the results are final, the
// TABLE is final, and the spend is authorised. This file measures the second
// and the third.
import { test } from 'node:test';
import { TEST_DONATION_SET_REGTEST } from '../../protocol/src/test-donation-sets.js';
import { donationSetId as idOfDonationSet } from '../../protocol/src/donation.js';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { schnorr } from '@noble/curves/secp256k1.js';

import { openStore } from '../src/store.js';
import { Round } from '../src/round.js';
import { Payouts, PAYOUT_QUEUED, PAID, PAID_IN_PART, NOTHING_OWED } from '../src/payout.js';
import { tableFor, signPayoutTable, verifiedTable, SIGNED_TABLE_BYTES } from '../src/payout-table.js';
import { winnings, payoutOutputs, payToKey, DUST_SATS } from '../../protocol/src/payout-spend.js';
import { trustedDealerSplit } from '../../protocol/src/frost.js';
import { evenGroupSecret } from '../../protocol/src/frost-bip340.js';
import { poolOutput } from '../../protocol/src/pool.js';
import { DELIVERED, FORFEIT, VOID } from '../../protocol/src/payout.js';
import { scalarFrom32, FIELD, SHARES_NEEDED, SHARES_TOTAL } from '../../protocol/src/shares.js';
import { MIN_ENTRY_WINDOW_MS } from '../../protocol/src/constants.js';
import { NETWORK_ID_REGTEST } from '../../protocol/src/genesis-ids.js';
import { feldmanGroup, tweakPoint } from '../src/curve.js';
import { assumeSeated } from './seating.js';
import { toHex } from '../../protocol/src/hash.js';
import { parseTransaction } from '../../protocol/src/tx.js';

const rand = (n) => new Uint8Array(randomBytes(n));
const b32 = (n) => new Uint8Array(32).fill(n);
const curve = { ...feldmanGroup, tweakPoint };
const NOW = 1788700000000;

/** Seven seats, whose keys this test holds so it can play any of them. */
const seatSecrets = Array.from({ length: SHARES_TOTAL }, () => rand(32));
const seatKeys = seatSecrets.map((s) => schnorr.getPublicKey(s));

const contractFor = (stakeMsat) => ({
  networkId: NETWORK_ID_REGTEST, configHash: b32(0x43), censusConfirmations: 1,
  gameVerifySlots: 7, settlementSlots: 7, simCoreHash: b32(1),
  committeeTimeMs: BigInt(NOW), randomnessRule: 'bitcoin-block-hash',
  startTimeMs: BigInt(NOW) + MIN_ENTRY_WINDOW_MS,
  entryCloseMs: BigInt(NOW) + MIN_ENTRY_WINDOW_MS + 200000n,
  objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20,
  slashRemainder: 'BURN', federationId: new Uint8Array(32), stakeExpiryBlocks: 144, publicationRelays: [], donationSetId: idOfDonationSet(TEST_DONATION_SET_REGTEST.recipients), censusHeight: 900000,
  censusRoot: b32(2), stakeMsat, bondMinSats: 50000n, blockTicks: 9000,
  exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20,
  timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4,
  nodes: seatKeys,
});

/** A player who is a real key now, which is what makes them payable. */
function player(n) {
  const secret = rand(32);
  return { secret, pubkey: schnorr.getPublicKey(secret), n };
}

/** A node holding a round, seated with all seven. */
function node(stakeMsat = 100000n) {
  const round = new Round(openStore(':memory:'), () => NOW);
  const contract = contractFor(stakeMsat);
  const rid = round.open(contract);
  // THIS NODE IS ONE OF THE SEVEN. Its own signature only counts if the census
  // seated its key, which is `verifiedTable`'s whole point - so the seated set
  // is this daemon plus six others.
  const seats = [round.pubkey, ...seatKeys.slice(1)];
  assumeSeated(round, rid, seats);
  return { round, rid, contract, seats };
}

const entriesOf = (stakeMsat, ...spec) => spec.map(([p, outcome, score]) =>
  ({ entryId: b32(p.n), pubkey: p.pubkey, outcome, score, stakeMsat, feeMsat: 0n, donationMsat: 0n }));

test('the table this node signs is the one it computed, and a stranger is not a seat', () => {
  const { round, rid, contract } = node();
  const winner = player(1); const loser = player(2);
  const entries = entriesOf(100000n, [winner, DELIVERED, 9], [loser, FORFEIT, 0]);
  const built = tableFor({ roundId: rid, entries, minScore: 1 });

  assert.equal(built.tableId.length, 32);
  assert.equal(built.table.length, 2);

  // Six of the seven seats sign it, plus a stranger who is not seated.
  const records = seatSecrets.slice(0, 6).map((secret, i) =>
    signPayoutTable({ tableId: built.tableId, secret, pubkey: seatKeys[i] }));
  const strangerSecret = rand(32);
  records.push(signPayoutTable({
    tableId: built.tableId, secret: strangerSecret, pubkey: schnorr.getPublicKey(strangerSecret),
  }));
  assert.equal(records[0].length, SIGNED_TABLE_BYTES);

  const seen = verifiedTable(records, { contract, seats: seatKeys, tableId: built.tableId });
  assert.equal(seen.ok, true, seen.why);
  assert.equal(seen.agreed, 6);
  assert.equal(seen.needed, 5);
  assert.equal(seen.strangers, 1, 'a key the census never seated was counted');
  assert.equal(seen.final, true);
});

test('four of seven is not a final table, and a seat signing another one is named', () => {
  const { rid, contract } = node();
  const winner = player(1); const loser = player(2);
  const entries = entriesOf(100000n, [winner, DELIVERED, 9], [loser, FORFEIT, 0]);
  const built = tableFor({ roundId: rid, entries, minScore: 1 });

  const four = seatSecrets.slice(0, 4).map((secret, i) =>
    signPayoutTable({ tableId: built.tableId, secret, pubkey: seatKeys[i] }));
  const short = verifiedTable(four, { contract, seats: seatKeys, tableId: built.tableId });
  assert.equal(short.final, false);
  assert.match(short.why, /4 of 5 seats signed this table, so nothing is spent/);

  // A SEAT THAT SIGNED SOMETHING ELSE IS NOT A VOTE FOR THIS TABLE, and it is
  // counted separately rather than dropped: two tables in one round is a
  // disagreement an operator has to see.
  const other = [...four, signPayoutTable({
    tableId: b32(0xee), secret: seatSecrets[4], pubkey: seatKeys[4],
  })];
  const split = verifiedTable(other, { contract, seats: seatKeys, tableId: built.tableId });
  assert.equal(split.agreed, 4);
  assert.equal(split.signedSomethingElse, 1);
  assert.equal(split.final, false);

  // And one seat cannot become two by signing twice.
  const twice = [...four, four[0]];
  assert.equal(verifiedTable(twice, { contract, seats: seatKeys, tableId: built.tableId }).doubled, 1);
});

test('the pool owes the winnings, not the stake that came back on its own', () => {
  // A qualifier's row is their own stake PLUS what they won, because that is
  // what they end holding - but the stake came back over Lightning when the
  // hold was cancelled, so paying the row would pay it twice.
  const stake = 100000n;
  const winner = player(1); const loser = player(2);
  const entries = entriesOf(stake, [winner, DELIVERED, 9], [loser, FORFEIT, 0]);
  const built = tableFor({ roundId: b32(1), entries, minScore: 1 });

  const row = built.table.find((r) => toHex(r.pubkey) === toHex(winner.pubkey));
  assert.equal(row.amountMsat, stake * 2n, 'the table does not hand the winner both stakes');

  const owed = winnings({ table: built.table, stakes: entries });
  assert.equal(owed.ok, true, owed.why);
  assert.equal(owed.rows.length, 1, 'the loser is owed nothing and should not be an output');
  assert.equal(owed.rows[0].msat, stake, 'the pool owes the winnings and not the stake as well');
  assert.equal(owed.owedMsat, stake);

  // AND THAT SUM IS THE POOL. holdSettlement already throws when it is not.
  assert.equal(owed.owedMsat, stake, 'the pool is one forfeited stake');
});

test('a below-score winner and a VOID entry draw nothing from the pool', () => {
  const stake = 100000n;
  const placed = player(1); const cautious = player(2); const loser = player(3);
  const voided = player(4);
  const entries = entriesOf(stake,
    [placed, DELIVERED, 9], [cautious, DELIVERED, 0], [loser, FORFEIT, 0], [voided, VOID, 0]);
  const built = tableFor({ roundId: b32(1), entries, minScore: 1 });
  const owed = winnings({ table: built.table, stakes: entries });

  assert.equal(owed.rows.length, 1);
  assert.equal(toHex(owed.rows[0].pubkey), toHex(placed.pubkey));
  assert.equal(owed.rows[0].msat, stake, 'the only qualifier takes the whole pool');
  for (const who of [cautious, loser, voided])
    assert.equal(owed.rows.some((r) => toHex(r.pubkey) === toHex(who.pubkey)), false,
      'somebody who never qualified is being paid from the pool');
});

test('a round at the fixture stake pays nobody, and the debt is named rather than dropped', () => {
  // MEASURED, not assumed: a default bitcoind refuses a P2TR output at 329
  // sats and takes it at 330. At 100000 msat a whole round's pool is 100 or
  // 200 sats, so this is not a corner - it is every round the daily could run
  // today.
  const stake = 100000n;
  const winner = player(1); const loser = player(2);
  const entries = entriesOf(stake, [winner, DELIVERED, 9], [loser, FORFEIT, 0]);
  const built = tableFor({ roundId: b32(1), entries, minScore: 1 });
  const owed = winnings({ table: built.table, stakes: entries });

  const out = payoutOutputs({ rows: owed.rows, poolSats: 100n });
  assert.equal(out.ok, false);
  assert.match(out.why, /every one of the 1 player\(s\) this round owes is under 330 sats/);
  assert.match(out.why, /the sats stay in the pool and the debt stands/);

  // THE DEBT IS RETURNED, NOT LOST. Dropping the row would be the operator
  // keeping money the player had no part in losing.
  assert.equal(out.owed.length, 1);
  assert.equal(out.owedSats, 100n);
  assert.equal(toHex(out.owed[0].pubkey), toHex(winner.pubkey));
  assert.equal(DUST_SATS, 330n);
});

test('one player under the floor no longer blocks the players over it', () => {
  // THE FAULT THIS LETTER IS ABOUT. Before, a single 100-sat winner refused
  // the whole payout, so a player owed thousands got nothing either.
  const rows = [
    { pubkey: player(1).pubkey, msat: 5000n * 1000n },
    { pubkey: player(2).pubkey, msat: 100n * 1000n },
    { pubkey: player(3).pubkey, msat: 700n * 1000n },
  ];
  const out = payoutOutputs({ rows, poolSats: 6000n });
  assert.equal(out.ok, true, out.why);
  assert.equal(out.outputs.length, 2, 'the two payable winners were not both paid');
  assert.equal(out.paidSats, 5700n);
  assert.equal(out.owed.length, 1);
  assert.equal(out.owedSats, 100n);
  assert.equal(toHex(out.owed[0].pubkey), toHex(rows[1].pubkey));

  // AND THE SATS ARE NOT BUMPED, NOT DONATED TO THE FEE, NOT DROPPED: what is
  // left over is only the pool's own rounding, and the debt stands beside it.
  assert.equal(out.paidSats + out.feeSats, 6000n);
  for (const o of out.outputs)
    assert.notEqual(o.value, 330n, 'a sub-dust row was bumped to the floor');
});

test('above the floor the outputs pay every winner and nobody keeps the change', () => {
  // EIGHT QUALIFIERS PAY TWO RANKS: `payingRanks` is ceil(q/4), so a round
  // needs five finishers before a second one places. That is the table's rule
  // and this file does not get to have an opinion about it - what is measured
  // here is that whoever the table names is paid, and nobody else is.
  const stake = 1000000n;                      // 1000 sats
  const winners = [1, 2, 3, 4, 5].map(player);
  const losers = [6, 7].map(player);
  const entries = entriesOf(stake,
    ...winners.map((p, i) => [p, DELIVERED, 90 - i * 10]),
    ...losers.map((p) => [p, FORFEIT, 0]));
  const built = tableFor({ roundId: b32(1), entries, minScore: 1 });
  const owed = winnings({ table: built.table, stakes: entries });
  assert.equal(owed.owedMsat, stake * 2n, 'the pool is the two forfeited stakes');
  assert.equal(owed.rows.length, 2, 'five qualifiers place two');

  const poolSats = 2000n;
  const out = payoutOutputs({ rows: owed.rows, poolSats });
  assert.equal(out.ok, true, out.why);
  assert.equal(out.outputs.length, owed.rows.length);
  assert.equal(out.paidSats + out.feeSats, poolSats, 'sats went missing between the pool and the outputs');

  // EVERY OUTPUT PAYS A PLAYER'S OWN KEY, which is the whole reason
  // player_pubkey had to become one.
  for (const o of out.outputs) {
    assert.equal(o.script.length, 34);
    assert.equal(o.script[0], 0x51);
    const paid = owed.rows.find((r) => toHex(payToKey(r.pubkey)) === toHex(o.script));
    assert.ok(paid, 'an output pays a key no row named');
  }
  // AND THERE IS NO CHANGE OUTPUT. Whatever is left is the miner's, because a
  // change output is one an operator chooses the destination of.
  assert.equal(out.outputs.length, owed.rows.length);
});

test('a payout is queued only when the committee agrees, and written down before anything moves', () => {
  const { round, rid, contract } = node(1000000n);
  const winner = player(1); const loser = player(2);
  const entries = entriesOf(1000000n, [winner, DELIVERED, 9], [loser, FORFEIT, 0]);
  const payouts = new Payouts(round, { curve, random: rand });

  // This node's own signature is one. One of seven is not five.
  const alone = payouts.queue({ roundId: rid, entries, minScore: 1, contract });
  assert.equal(alone.ok, false);
  assert.match(alone.why, /1 of 5 seats signed this table/,
    'this node is seated, so its own signature is one');
  assert.equal(round.payout(rid), null, 'a payout was queued before the committee agreed');

  // Four more seats agree.
  const built = tableFor({ roundId: rid, entries, minScore: 1 });
  for (let i = 1; i < 5; i++)
    round.putPayoutSignature(rid, seatKeys[i],
      signPayoutTable({ tableId: built.tableId, secret: seatSecrets[i], pubkey: seatKeys[i] }));

  const queued = payouts.queue({ roundId: rid, entries, minScore: 1, contract });
  assert.equal(queued.ok, true, queued.why);
  assert.equal(queued.state, PAYOUT_QUEUED);
  assert.equal(queued.rows.length, 1);
  const row = round.payout(rid);
  assert.equal(row.state, PAYOUT_QUEUED);
  assert.deepEqual(row.tableId, built.tableId);
  assert.equal(row.txid, null, 'a payout was marked paid before it was sent');
});

test('a round that owes nobody is not queued, and is not an error either', () => {
  const { round, rid, contract } = node(1000000n);
  const a = player(1); const b = player(2);
  const entries = entriesOf(1000000n, [a, VOID, 0], [b, VOID, 0]);
  const payouts = new Payouts(round, { curve, random: rand });

  const built = tableFor({ roundId: rid, entries, minScore: 1 });
  for (let i = 1; i < 5; i++)
    round.putPayoutSignature(rid, seatKeys[i],
      signPayoutTable({ tableId: built.tableId, secret: seatSecrets[i], pubkey: seatKeys[i] }));

  const seen = payouts.queue({ roundId: rid, entries, minScore: 1, contract });
  assert.equal(seen.ok, true, seen.why);
  assert.equal(seen.state, NOTHING_OWED);
  assert.equal(round.payout(rid).state, NOTHING_OWED);
});

/** The committee's pool key, and a chain that remembers what it was sent. */
function poolFor() {
  const even = evenGroupSecret(scalarFrom32(rand(32)) % FIELD, feldmanGroup);
  const dealt = trustedDealerSplit({
    secret: even.secret, max: SHARES_TOTAL, min: SHARES_NEEDED,
    coefficients: Array.from({ length: SHARES_NEEDED - 1 }, () => scalarFrom32(rand(32)) % FIELD),
    curve: feldmanGroup,
  });
  return dealt;
}
function fakeChain() {
  const sent = new Map();
  return {
    sent,
    async send(raw) {
      const txid = parseTransaction(raw).txid;
      sent.set(toHex(txid), raw);
      return { ok: true, txid };
    },
    async look(txid) { return { known: sent.has(toHex(txid)) }; },
  };
}

test('five of seven pay the winner, and the transaction is on disk before it is sent', async () => {
  const { round, rid, contract } = node(1000000n);
  const winner = player(1); const loser = player(2);
  const entries = entriesOf(1000000n, [winner, DELIVERED, 9], [loser, FORFEIT, 0]);
  const dealt = poolFor();
  const chain = fakeChain();
  const payouts = new Payouts(round, { curve, random: rand, chain, pool: dealt });

  const built = tableFor({ roundId: rid, entries, minScore: 1 });
  for (let i = 1; i < 5; i++)
    round.putPayoutSignature(rid, seatKeys[i],
      signPayoutTable({ tableId: built.tableId, secret: seatSecrets[i], pubkey: seatKeys[i] }));
  const queued = payouts.queue({ roundId: rid, entries, minScore: 1, contract });
  assert.equal(queued.state, PAYOUT_QUEUED);

  const utxo = { txid: rand(32), vout: 0, value: 1000n };
  const five = dealt.shares.slice(0, 5);
  const paid = await payouts.pay({ roundId: rid, rows: queued.rows, utxo, signers: five });
  assert.equal(paid.ok, true, paid.why);
  assert.equal(paid.state, PAID);

  const row = round.payout(rid);
  assert.equal(row.state, PAID);
  assert.ok(row.raw, 'the raw transaction was not written down');
  assert.deepEqual(row.txid, paid.txid);
  assert.equal(chain.sent.size, 1);

  // AND THE OUTPUT PAYS THE WINNER'S OWN KEY.
  const tx = parseTransaction(row.raw);
  assert.equal(tx.outputs.length, 1);
  assert.deepEqual(tx.outputs[0].script, payToKey(winner.pubkey));

  // ASKED TWICE, SENT ONCE.
  const again = await payouts.pay({ roundId: rid, rows: queued.rows, utxo, signers: five });
  assert.equal(again.already, true);
  assert.equal(chain.sent.size, 1);
});

test('four of seven are refused before a byte is built', async () => {
  const { round, rid, contract } = node(1000000n);
  const winner = player(1); const loser = player(2);
  const entries = entriesOf(1000000n, [winner, DELIVERED, 9], [loser, FORFEIT, 0]);
  const dealt = poolFor();
  const chain = fakeChain();
  const payouts = new Payouts(round, { curve, random: rand, chain, pool: dealt });

  const built = tableFor({ roundId: rid, entries, minScore: 1 });
  for (let i = 1; i < 5; i++)
    round.putPayoutSignature(rid, seatKeys[i],
      signPayoutTable({ tableId: built.tableId, secret: seatSecrets[i], pubkey: seatKeys[i] }));
  const queued = payouts.queue({ roundId: rid, entries, minScore: 1, contract });

  const utxo = { txid: rand(32), vout: 0, value: 1000n };
  const four = await payouts.pay({
    roundId: rid, rows: queued.rows, utxo, signers: dealt.shares.slice(0, 4),
  });
  assert.equal(four.ok, false);
  assert.match(four.why, /4 of 5 signers: a pool nobody can move stays where it is/);
  assert.equal(chain.sent.size, 0);
  assert.equal(round.payout(rid).state, PAYOUT_QUEUED, 'a refused payout changed the state');
});

test('a node that died mid-send asks the chain rather than building a second spend', async () => {
  const { round, rid, contract } = node(1000000n);
  const winner = player(1); const loser = player(2);
  const entries = entriesOf(1000000n, [winner, DELIVERED, 9], [loser, FORFEIT, 0]);
  const dealt = poolFor();
  const chain = fakeChain();
  const payouts = new Payouts(round, { curve, random: rand, chain, pool: dealt });

  const built = tableFor({ roundId: rid, entries, minScore: 1 });
  for (let i = 1; i < 5; i++)
    round.putPayoutSignature(rid, seatKeys[i],
      signPayoutTable({ tableId: built.tableId, secret: seatSecrets[i], pubkey: seatKeys[i] }));
  const queued = payouts.queue({ roundId: rid, entries, minScore: 1, contract });

  // The send reached the network and the answer never came back.
  const utxo = { txid: rand(32), vout: 0, value: 1000n };
  chain.send = async (raw) => {
    const txid = parseTransaction(raw).txid;
    chain.sent.set(toHex(txid), raw);
    throw new Error('the node stopped here');
  };
  await assert.rejects(() => payouts.pay({ roundId: rid, rows: queued.rows, utxo, signers: dealt.shares.slice(0, 5) }));

  const stuck = round.payout(rid);
  assert.equal(stuck.state, PAYOUT_QUEUED);
  assert.ok(stuck.raw, 'the bytes it sent were not written down, so it cannot ask about them');

  const asked = await payouts.reconcile();
  assert.equal(asked.ok, true, asked.why);
  assert.deepEqual(asked.asked.map((a) => a.state), [PAID]);
  assert.equal(round.payout(rid).state, PAID);
  assert.equal(chain.sent.size, 1, 'a second spend of one pool output was built');
});

test('a node that died mid-send on a table it cannot pay in full comes back PAID_IN_PART, debt intact', async () => {
  // Measured on regtest before this: at every kill point the restarted seat
  // wrote PAID with 0 owed, while the six seats around it read PAID_IN_PART
  // with 252 sats owed to one player.
  const stake = 300000n;
  const { round, rid, contract } = node(stake);
  const ps = [1, 2, 3, 4, 5, 6, 7].map(player);
  const entries = entriesOf(stake,
    ...[90, 80, 70, 60, 50].map((score, i) => [ps[i], DELIVERED, score]),
    [ps[5], FORFEIT, 0], [ps[6], FORFEIT, 0]);
  const dealt = poolFor();
  const chain = fakeChain();
  const payouts = new Payouts(round, { curve, random: rand, chain, pool: dealt });

  const built = tableFor({ roundId: rid, entries, minScore: 1 });
  for (let i = 1; i < 5; i++)
    round.putPayoutSignature(rid, seatKeys[i],
      signPayoutTable({ tableId: built.tableId, secret: seatSecrets[i], pubkey: seatKeys[i] }));
  const queued = payouts.queue({ roundId: rid, entries, minScore: 1, contract });
  const sats = queued.rows.map((r) => r.msat / 1000n);
  const under = sats.filter((x) => x < DUST_SATS);
  assert.ok(under.length && sats.some((x) => x >= DUST_SATS), `the fixture must straddle the floor: ${sats}`);

  const utxo = { txid: rand(32), vout: 0, value: sats.reduce((a, x) => a + x, 0n) };
  chain.send = async (raw) => {
    chain.sent.set(toHex(parseTransaction(raw).txid), raw);
    throw new Error('the node stopped here');
  };
  await assert.rejects(() => payouts.pay({ roundId: rid, rows: queued.rows, utxo, signers: dealt.shares.slice(0, 5) }));

  const asked = await payouts.reconcile();
  assert.deepEqual(asked.asked.map((a) => a.state), [PAID_IN_PART]);
  const row = round.payout(rid);
  assert.equal(row.state, PAID_IN_PART, 'a table that left somebody owed was recorded as paid');
  assert.equal(row.owedCount, under.length);
  assert.equal(row.owedSats, under.reduce((a, x) => a + x, 0n), 'the debt did not survive the restart');
  assert.equal(chain.sent.size, 1);
});

test('a payout with no chain moves nothing and says so', async () => {
  const { round, rid, contract } = node(1000000n);
  const payouts = new Payouts(round, { curve, random: rand });
  const seen = await payouts.pay({ roundId: rid, rows: [], utxo: {}, signers: [] });
  assert.equal(seen.ok, false);
  assert.match(seen.why, /no queued payout/);
  assert.equal((await payouts.reconcile()).ok, false);
});

test('a table naming a key the round never seated pays nobody', () => {
  // The table comes from this node's own computation, but it arrives at
  // `winnings` as an argument, and an argument is where a wrong row gets in.
  const stake = 1000000n;
  const winner = player(1); const loser = player(2); const stranger = player(9);
  const entries = entriesOf(stake, [winner, DELIVERED, 9], [loser, FORFEIT, 0]);
  const built = tableFor({ roundId: b32(1), entries, minScore: 1 });

  const smuggled = [...built.table, { pubkey: stranger.pubkey, amountMsat: stake }];
  const owed = winnings({ table: smuggled, stakes: entries });
  assert.equal(owed.ok, false);
  assert.match(owed.why, /pays a key this round never seated/);
});

test('a payout cannot spend more than the pool holds', () => {
  const stake = 1000000n;
  const winner = player(1); const loser = player(2);
  const entries = entriesOf(stake, [winner, DELIVERED, 9], [loser, FORFEIT, 0]);
  const built = tableFor({ roundId: b32(1), entries, minScore: 1 });
  const owed = winnings({ table: built.table, stakes: entries });

  const short = payoutOutputs({ rows: owed.rows, poolSats: 400n });
  assert.equal(short.ok, false);
  assert.match(short.why, /the table owes 1000 sats and the pool holds 400/);

  // And a fee it cannot cover is a refusal too, rather than a smaller payout.
  const tight = payoutOutputs({ rows: owed.rows, poolSats: 1000n, feeSats: 200n });
  assert.equal(tight.ok, false);
  assert.match(tight.why, /0 sats are left for a fee of 200/);
});

test('a seat\'s signature is verified, not counted', () => {
  const { rid, contract } = node(1000000n);
  const winner = player(1); const loser = player(2);
  const entries = entriesOf(1000000n, [winner, DELIVERED, 9], [loser, FORFEIT, 0]);
  const built = tableFor({ roundId: rid, entries, minScore: 1 });

  const honest = [1, 2, 3, 4].map((i) =>
    signPayoutTable({ tableId: built.tableId, secret: seatSecrets[i], pubkey: seatKeys[i] }));
  // A seated key, the right table id, and 64 bytes that are not a signature.
  const forged = signPayoutTable({ tableId: built.tableId, secret: seatSecrets[5], pubkey: seatKeys[5] });
  forged[64] ^= 0xff;

  const seen = verifiedTable([...honest, forged], {
    contract, seats: seatKeys, tableId: built.tableId,
  });
  assert.equal(seen.agreed, 4, 'a forged signature was counted as agreement');
  assert.equal(seen.forged, 1);
  assert.equal(seen.final, false);
});

test('a restart asks the chain, and a transaction it never saw stays queued', async () => {
  const { round, rid, contract } = node(1000000n);
  const winner = player(1); const loser = player(2);
  const entries = entriesOf(1000000n, [winner, DELIVERED, 9], [loser, FORFEIT, 0]);
  const dealt = poolFor();
  const chain = fakeChain();
  const payouts = new Payouts(round, { curve, random: rand, chain, pool: dealt });

  const built = tableFor({ roundId: rid, entries, minScore: 1 });
  for (let i = 1; i < 5; i++)
    round.putPayoutSignature(rid, seatKeys[i],
      signPayoutTable({ tableId: built.tableId, secret: seatSecrets[i], pubkey: seatKeys[i] }));
  const queued = payouts.queue({ roundId: rid, entries, minScore: 1, contract });

  // The send never left, so the chain has never heard of it.
  const utxo = { txid: rand(32), vout: 0, value: 1000n };
  chain.send = async () => { throw new Error('the node stopped before the call left'); };
  await assert.rejects(() => payouts.pay({ roundId: rid, rows: queued.rows, utxo, signers: dealt.shares.slice(0, 5) }));

  const asked = await payouts.reconcile();
  assert.equal(asked.ok, true, asked.why);
  assert.deepEqual(asked.asked.map((a) => a.state), [PAYOUT_QUEUED],
    'a transaction nobody has seen was written down as paid');
  assert.equal(round.payout(rid).state, PAYOUT_QUEUED);

  // AND WHEN IT DOES LAND, the same restart finds it.
  chain.send = async (raw) => {
    const txid = parseTransaction(raw).txid;
    chain.sent.set(toHex(txid), raw);
    return { ok: true, txid };
  };
  const paid = await payouts.pay({ roundId: rid, rows: queued.rows, utxo, signers: dealt.shares.slice(0, 5) });
  assert.equal(paid.state, PAID);
});

test('the score the round set is the score the table is computed at', () => {
  // §20 makes a node that signs a table which is not F(its inputs) slashable,
  // so the floor has to reach the computation. A node that dropped it would
  // sign a different table from every honest seat and never reach five.
  const stake = 1000000n;
  const placed = player(1); const cautious = player(2); const loser = player(3);
  const entries = entriesOf(stake,
    [placed, DELIVERED, 9], [cautious, DELIVERED, 0], [loser, FORFEIT, 0]);

  const strict = tableFor({ roundId: b32(1), entries, minScore: 1 });
  const open = tableFor({ roundId: b32(1), entries, minScore: 0 });
  assert.notEqual(toHex(strict.tableId), toHex(open.tableId),
    'the minimum score does not reach the table this node signs');

  // WHAT THE FLOOR ACTUALLY CHANGES, since both floors happen to pay the same
  // winner here: below the score a delivered player keeps their stake and
  // places nowhere, so their ROW is their stake back rather than nothing.
  const rowFor = (t, who) => t.find((r) => toHex(r.pubkey) === toHex(who.pubkey)).amountMsat;
  assert.equal(rowFor(strict.table, cautious), 0n, 'a player below the score placed anyway');
  assert.equal(rowFor(open.table, cautious), stake, 'with no floor they qualify and keep their stake');
});

test('a node signing at another floor never reaches five', () => {
  // The consequence of the test above, and the reason §20 makes it slashable:
  // a seat that computes the table at a different floor signs a different id,
  // so it is not disagreement that gets averaged out - it simply never agrees.
  const { round, rid, contract } = node(1000000n);
  const placed = player(1); const cautious = player(2); const loser = player(3);
  const entries = entriesOf(1000000n,
    [placed, DELIVERED, 9], [cautious, DELIVERED, 0], [loser, FORFEIT, 0]);
  const payouts = new Payouts(round, { curve, random: rand });

  const wrong = tableFor({ roundId: rid, entries, minScore: 0 });
  for (let i = 1; i < 6; i++)
    round.putPayoutSignature(rid, seatKeys[i],
      signPayoutTable({ tableId: wrong.tableId, secret: seatSecrets[i], pubkey: seatKeys[i] }));

  const seen = payouts.queue({ roundId: rid, entries, minScore: 1, contract });
  assert.equal(seen.ok, false);
  assert.match(seen.why, /1 of 5 seats signed this table/);
  assert.equal(round.payout(rid), null);
});

test('a round that still owes somebody is PAID_IN_PART, never PAID', async () => {
  // The whole point of writing the debt down: a round is not finished while
  // sats a player earned are sitting in the pool because they were too small
  // to send. Calling it PAID would be the operator deciding a small debt does
  // not exist.
  // FIVE QUALIFIERS PAY TWO RANKS (`payingRanks` is ceil(q/4)), which is the
  // smallest round where one winner can clear the floor and another cannot.
  const { round, rid, contract } = node(1000000n);
  const winners = [1, 2, 3, 4, 5].map(player);
  const losers = [6, 7].map(player);
  const entries = [
    ...winners.map((p, i) => ({ entryId: b32(i + 1), pubkey: p.pubkey,
      outcome: DELIVERED, score: 90 - i * 10, stakeMsat: 1000000n, feeMsat: 0n, donationMsat: 0n })),
    ...losers.map((p, i) => ({ entryId: b32(i + 6), pubkey: p.pubkey,
      outcome: FORFEIT, score: 0, stakeMsat: 1000000n, feeMsat: 0n, donationMsat: 0n })),
  ];
  const dealt = poolFor();
  const chain = fakeChain();
  const payouts = new Payouts(round, { curve, random: rand, chain, pool: dealt });

  const built = tableFor({ roundId: rid, entries, minScore: 1 });
  for (let i = 1; i < 5; i++)
    round.putPayoutSignature(rid, seatKeys[i],
      signPayoutTable({ tableId: built.tableId, secret: seatSecrets[i], pubkey: seatKeys[i] }));
  const queued = payouts.queue({ roundId: rid, entries, minScore: 1, contract });
  assert.equal(queued.state, PAYOUT_QUEUED);

  assert.equal(queued.rows.length, 2, 'five qualifiers should place two');
  // A floor between the two, so the bigger winner is paid and the smaller is
  // owed - which is exactly the case that used to refuse the whole round.
  const owedSorted = [...queued.rows].sort((a, b) => (a.msat < b.msat ? -1 : 1));
  const floor = owedSorted[1].msat / 1000n;
  const utxo = { txid: rand(32), vout: 0, value: 2000n };
  const paid = await payouts.pay({
    roundId: rid, rows: queued.rows, utxo, signers: dealt.shares.slice(0, 5), dustSats: floor,
  });

  assert.equal(paid.ok, true, paid.why);
  assert.equal(paid.state, PAID_IN_PART, 'a round that still owes somebody was called PAID');
  assert.ok(paid.owedSats > 0n);
  const row = round.payout(rid);
  assert.equal(row.state, PAID_IN_PART);
  assert.equal(row.owedSats, paid.owedSats, 'the debt is not on the round');
  assert.equal(row.owedCount, paid.owed.length);
  assert.match(row.why, /still owed .* sats, under the relay floor/);
});

test('a round where nobody clears the floor sends nothing and records the debt', async () => {
  const { round, rid, contract } = node(1000000n);
  const winner = player(1); const loser = player(2);
  const entries = entriesOf(1000000n, [winner, DELIVERED, 9], [loser, FORFEIT, 0]);
  const dealt = poolFor();
  const chain = fakeChain();
  const payouts = new Payouts(round, { curve, random: rand, chain, pool: dealt });

  const built = tableFor({ roundId: rid, entries, minScore: 1 });
  for (let i = 1; i < 5; i++)
    round.putPayoutSignature(rid, seatKeys[i],
      signPayoutTable({ tableId: built.tableId, secret: seatSecrets[i], pubkey: seatKeys[i] }));
  const queued = payouts.queue({ roundId: rid, entries, minScore: 1, contract });

  const utxo = { txid: rand(32), vout: 0, value: 2000n };
  const none = await payouts.pay({
    roundId: rid, rows: queued.rows, utxo, signers: dealt.shares.slice(0, 5),
    dustSats: 5000n,                                   // above what anybody is owed
  });
  assert.equal(none.ok, false);
  assert.match(none.why, /there is no output to make/);
  assert.equal(none.owed.length, 1);
  assert.equal(chain.sent.size, 0, 'a transaction was broadcast with no payable output');

  const row = round.payout(rid);
  assert.equal(row.state, PAYOUT_QUEUED, 'a round that paid nobody was moved off the queue');
  assert.equal(row.owedSats, none.owedSats);
  assert.equal(row.owedCount, 1);
});

test('five of seven is still required, and a node with no chain still refuses', async () => {
  // The floor is a new rule beside the old ones, not instead of them.
  const { round, rid, contract } = node(1000000n);
  const winner = player(1); const loser = player(2);
  const entries = entriesOf(1000000n, [winner, DELIVERED, 9], [loser, FORFEIT, 0]);
  const dealt = poolFor();
  const chain = fakeChain();
  const payouts = new Payouts(round, { curve, random: rand, chain, pool: dealt });

  const built = tableFor({ roundId: rid, entries, minScore: 1 });
  for (let i = 1; i < 5; i++)
    round.putPayoutSignature(rid, seatKeys[i],
      signPayoutTable({ tableId: built.tableId, secret: seatSecrets[i], pubkey: seatKeys[i] }));
  const queued = payouts.queue({ roundId: rid, entries, minScore: 1, contract });
  const utxo = { txid: rand(32), vout: 0, value: 2000n };

  const four = await payouts.pay({
    roundId: rid, rows: queued.rows, utxo, signers: dealt.shares.slice(0, 4),
  });
  assert.equal(four.ok, false);
  assert.match(four.why, /4 of 5 signers/);
  assert.equal(chain.sent.size, 0);

  const blind = new Payouts(round, { curve, random: rand });
  const nowhere = await blind.pay({ roundId: rid, rows: queued.rows, utxo, signers: dealt.shares.slice(0, 5) });
  assert.equal(nowhere.ok, false);
  assert.match(nowhere.why, /reaches no chain/);
});

test('a debt survives the state changes that come after it', () => {
  // `putPayout` is called again for every transition, and none of those
  // callers knows the debt. A write that reset it would quietly clear what a
  // round still owes on its way to being marked paid.
  const { round, rid } = node(1000000n);
  round.putPayout({ roundId: rid, tableId: b32(9), state: PAYOUT_QUEUED,
    why: 'queued', owedSats: 329n, owedCount: 1 });
  assert.equal(round.payout(rid).owedSats, 329n);

  round.putPayout({ roundId: rid, tableId: b32(9), state: PAID_IN_PART, why: 'sent' });
  const after = round.payout(rid);
  assert.equal(after.owedSats, 329n, 'a later write cleared what the round still owes');
  assert.equal(after.owedCount, 1);

  // And it can be set to nothing on purpose, which is a different thing.
  round.putPayout({ roundId: rid, tableId: b32(9), state: PAID, why: 'settled',
    owedSats: 0n, owedCount: 0 });
  assert.equal(round.payout(rid).owedSats, 0n);
});

test('a payout row that has moved on is not rewritten when the close runs again - PAID stays PAID', async () => {
  // M3.3-25 runs a round's close logic again when a run turns final after the
  // first close. `queue` wrote its row with INSERT OR REPLACE, so a rerun on a
  // round already queued or paid would put it back to PAYOUT_QUEUED.
  const { round, rid, contract } = node(1000000n);
  const winner = player(1); const loser = player(2);
  const entries = entriesOf(1000000n, [winner, DELIVERED, 9], [loser, FORFEIT, 0]);
  const dealt = poolFor();
  const chain = fakeChain();
  const payouts = new Payouts(round, { curve, random: rand, chain, pool: dealt });
  const built = tableFor({ roundId: rid, entries, minScore: 1 });
  for (let i = 1; i < 5; i++)
    round.putPayoutSignature(rid, seatKeys[i],
      signPayoutTable({ tableId: built.tableId, secret: seatSecrets[i], pubkey: seatKeys[i] }));
  const queued = payouts.queue({ roundId: rid, entries, minScore: 1, contract });
  assert.equal(queued.state, PAYOUT_QUEUED);

  // QUEUED, AND QUEUED AGAIN: the row it wrote is the row it keeps.
  const why = round.payout(rid).why;
  const twice = payouts.queue({ roundId: rid, entries, minScore: 1, contract });
  assert.equal(twice.state, PAYOUT_QUEUED);
  assert.equal(round.payout(rid).why, why, 'a second queue rewrote the queued row');

  const utxo = { txid: rand(32), vout: 0, value: 1000n };
  const paid = await payouts.pay({ roundId: rid, rows: queued.rows, utxo, signers: dealt.shares.slice(0, 5) });
  assert.equal(paid.state, PAID);

  // AND PAID, THEN THE CLOSE AGAIN: still PAID, with its txid.
  const again = payouts.queue({ roundId: rid, entries, minScore: 1, contract });
  assert.equal(round.payout(rid).state, PAID, 'a rerun of the close put a PAID round back to PAYOUT_QUEUED');
  assert.equal(again.state, PAID);
  assert.ok(round.payout(rid).txid, 'the paid row lost its txid');
});
