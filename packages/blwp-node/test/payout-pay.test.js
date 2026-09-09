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
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { schnorr } from '@noble/curves/secp256k1.js';

import { openStore } from '../src/store.js';
import { Round } from '../src/round.js';
import { Payouts, PAYOUT_QUEUED, PAID, NOTHING_OWED } from '../src/payout.js';
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
  slashRemainder: 'BURN', donationSetId: b32(0xd0), censusHeight: 900000,
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
  ({ entryId: b32(p.n), pubkey: p.pubkey, outcome, score, stakeMsat }));

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

test('a round at the fixture stake cannot be paid on chain, and says so by name', () => {
  // MEASURED, not assumed: a default bitcoind refuses a P2TR output below 330
  // sats. At 100000 msat a whole round's pool is 100 or 200 sats, so this is
  // not a corner - it is every round the daily could run today.
  const stake = 100000n;
  const winner = player(1); const loser = player(2);
  const entries = entriesOf(stake, [winner, DELIVERED, 9], [loser, FORFEIT, 0]);
  const built = tableFor({ roundId: b32(1), entries, minScore: 1 });
  const owed = winnings({ table: built.table, stakes: entries });

  const out = payoutOutputs({ rows: owed.rows, poolSats: 100n });
  assert.equal(out.ok, false);
  assert.match(out.why, /is owed 100 sats and a node will not relay an output below 330/);
  assert.match(out.why, /this round cannot be paid on chain/);

  // DROPPING THE ROW WOULD BE THE OPERATOR KEEPING IT. The refusal is the
  // point: the money stays in the pool and everybody can see why.
  assert.equal(DUST_SATS, 330n);
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

test('a payout with no chain moves nothing and says so', async () => {
  const { round, rid, contract } = node(1000000n);
  const payouts = new Payouts(round, { curve, random: rand });
  const seen = await payouts.pay({ roundId: rid, rows: [], utxo: {}, signers: [] });
  assert.equal(seen.ok, false);
  assert.match(seen.why, /no queued payout/);
  assert.equal((await payouts.reconcile()).ok, false);
});
