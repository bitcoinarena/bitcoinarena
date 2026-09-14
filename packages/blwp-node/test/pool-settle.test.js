// A CLOSED ROUND PAYS ITS WINNER WITHOUT AN OPERATOR IN THE MIDDLE.
//
// M3.3 item 18. `pool-committee.test.js` proved that five daemons on five
// sockets can sign one spend of the pool - and NOTHING IN THE DAEMON EVER
// ASKED THEM TO. `payWithCommittee` took the output to spend as an argument
// and had zero callers in `src/`: a close signed the table, agreed what was
// owed, wrote PAYOUT_QUEUED and stopped, because no code in the daemon could
// say which of the pool's outputs to spend. The winner was paid by a test
// handing the daemon an outpoint.
//
// Two halves closed it. `pool-watch.js` asks the chain (that was 80cc813), and
// `Payouts.settleQueued` is the caller: it checks this node is the round's
// asker, asks its own seat what the round owes, asks the watch for the one
// confirmed output that covers it, and runs the signing round.
//
// AND EXACTLY ONE SEAT ASKS. Every seat closes the round, so seven askers
// would run seven signing rounds over one output - seven DIFFERENT
// transactions, because FROST aggregates over the nonces that were committed,
// and each seat holds one live nonce pair per round. `askerFor` picks one out
// of the round id over the seated keys: no message, no election, no clock.
import { test } from 'node:test';
import { TEST_DONATION_SET_REGTEST } from '../../protocol/src/test-donation-sets.js';
import { donationSetId as idOfDonationSet } from '../../protocol/src/donation.js';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { schnorr } from '@noble/curves/secp256k1.js';
import { ed25519 } from '@noble/curves/ed25519.js';

import { openStore } from '../src/store.js';
import { serve } from '../src/server.js';
import { askerFor, askerOrder, eligibleAsker, TAKEOVER_BLOCKS, PAYOUT_QUEUED, PAID } from '../src/payout.js';
import { PoolSigning } from '../src/pool-signing.js';
import { txidToRpc } from '../src/pool-watch.js';
import { trustedDealerSplit } from '../../protocol/src/frost.js';
import { evenGroupSecret } from '../../protocol/src/frost-bip340.js';
import { poolOutput } from '../../protocol/src/pool.js';
import { payToKey } from '../../protocol/src/payout-spend.js';
import { encodeRoundContract, encodeEntryContract, roundId, entryId as entryIdOf } from '../../protocol/src/contracts.js';
import { encodePlayerResult, resultId, joinSignedResult } from '../../protocol/src/result.js';
import { DELIVERED, FORFEIT, netStakeMsat } from '../../protocol/src/payout.js';
import { scalarFrom32, FIELD, SHARES_NEEDED, SHARES_TOTAL } from '../../protocol/src/shares.js';
import { MIN_ENTRY_WINDOW_MS } from '../../protocol/src/constants.js';
import { NETWORK_ID_REGTEST } from '../../protocol/src/genesis-ids.js';
import { feldmanGroup, tweakPoint } from '../src/curve.js';
import { assumeSeated } from './seating.js';
import { toHex } from '../../protocol/src/hash.js';
import { parseTransaction } from '../../protocol/src/tx.js';

// The node fee is 27A.7's 2% of the stake, and the door checks it now
// (M3.3 item 20) - so a fixture carries the RULE rather than a number.
import { entryFeeMsat } from '../../protocol/src/fee.js';
const rand = (n) => new Uint8Array(randomBytes(n));
const b32 = (n) => new Uint8Array(32).fill(n);
const curve = { ...feldmanGroup, tweakPoint };
const NOW = 1788700000000;
const POOL_SATS = 200000n;
const FUNDED = { funded: () => true };
// THE ROUND'S OWN CHAIN ANCHOR. Every seat reads the same one; the takeover
// order is measured in blocks past it.
const BEACON_HEIGHT = 900001;
const BEACON = { hash: b32(0x9b), height: BEACON_HEIGHT, timeMs: BigInt(NOW) };
const post = (port, path, body) => fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', body });

const contractFor = (nodes) => ({
  networkId: NETWORK_ID_REGTEST, configHash: b32(0x43), censusConfirmations: 1,
  gameVerifySlots: SHARES_TOTAL, settlementSlots: SHARES_TOTAL, simCoreHash: b32(1),
  committeeTimeMs: BigInt(NOW), randomnessRule: 'bitcoin-block-hash',
  startTimeMs: BigInt(NOW) + MIN_ENTRY_WINDOW_MS,
  entryCloseMs: BigInt(NOW) + MIN_ENTRY_WINDOW_MS + 200000n,
  objectionWindowMs: 600000n, custody: 'THRESHOLD_LN', slashMinimumServed: 20,
  slashRemainder: 'BURN', federationId: new Uint8Array(32), stakeExpiryBlocks: 144, publicationRelays: [], donationSetId: idOfDonationSet(TEST_DONATION_SET_REGTEST.recipients), censusHeight: 900000,
  censusRoot: b32(2), stakeMsat: 1000000n, bondMinSats: 50000n, blockTicks: 9000,
  exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20,
  timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4,
  nodes,
});

const player = () => { const s = rand(32); return { secret: s, pubkey: schnorr.getPublicKey(s) }; };

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
 * A BITCOIND THAT HOLDS WHAT IT IS TOLD TO HOLD.
 *
 * `scantxoutset` and `gettxout` in bitcoind's own shapes, taken from
 * `pool-watch.js`'s recorded ones. `held` is a list of `{ txid, vout, sats,
 * confirmations }`; the script is always the pool's, because an output paying
 * anything else is `pool-watch.js`'s own test and not this file's.
 */
function chainHolding(held, script) {
  const calls = [];
  const at = { height: BEACON_HEIGHT, spent: new Set() };
  return {
    calls,
    at,
    /** Mine blocks, which is the only clock the takeover waits on. */
    mine: (n) => { at.height += n; },
    /** Take an output out of the mempool's view, the way a spend does. */
    spend: (txid, vout) => at.spent.add(`${toHex(txid)}:${vout}`),
    call: async (method, params) => {
      calls.push(method);
      if (method === 'getblockcount') return at.height;
      if (method === 'scantxoutset') return {
        success: true, height: at.height,
        unspents: held.map((u) => ({
          txid: txidToRpc(u.txid), vout: u.vout,
          amount: Number(u.sats) / 1e8,
          confirmations: u.confirmations === undefined ? 6 : u.confirmations,
          scriptPubKey: toHex(script),
        })),
      };
      if (method === 'gettxout') {
        const want = held.find((u) => txidToRpc(u.txid) === params[0] && u.vout === params[1]);
        // `gettxout` SEES A MEMPOOL and `scantxoutset` does not, which is the
        // whole reason a takeover re-reads its output through this one.
        if (want && at.spent.has(`${toHex(want.txid)}:${want.vout}`)) return null;
        if (!want) return null;
        return {
          confirmations: want.confirmations === undefined ? 6 : want.confirmations,
          value: Number(want.sats) / 1e8, scriptPubKey: { hex: toHex(script) },
        };
      }
      throw new Error(`no fixture for ${method}`);
    },
  };
}

/**
 * Seven daemons, one round, one queued payout each, one share each - and a
 * chain each of them can ask about the pool.
 */
async function committee({ held = null, chain = null } = {}) {
  const dealt = dealThePool();
  const pool = { groupPublicKey: dealt.groupPublicKey };
  const out = poolOutput({ groupPublicKey: dealt.groupPublicKey, curve });
  assert.equal(out.ok, true, out.why);

  const holding = chainHolding(
    held === null ? [{ txid: b32(0xab), vout: 0, sats: POOL_SATS }] : held, out.script);

  const nodes = [];
  for (let i = 0; i < SHARES_TOTAL; i++) {
    nodes.push(await serve(openStore(':memory:'), {
      port: 0, ...FUNDED, now: () => NOW,
      poolKey: pool, poolCurve: curve, poolSeat: dealt.shares[i],
      poolCall: holding.call, randomnessFor: () => BEACON,
      ...(chain ? { chainSpend: chain } : {}),
    }));
  }
  const contract = contractFor(nodes.map((n) => n.round.pubkey));
  const rid = roundId(contract);

  const winner = player();
  const loser = player();
  const session = ed25519.utils.randomSecretKey();
  const entries = [[winner, DELIVERED, 9], [loser, FORFEIT, 0]].map(([p, outcome, score]) => ({
    contract: {
      roundId: rid, playerPubkey: p.pubkey, sessionPubkey: ed25519.getPublicKey(session),
      stakeCommitment: b32(7), stakeMsat: contract.stakeMsat, feeMsat: entryFeeMsat(contract.stakeMsat),
      donationMsat: 0n, joinTick: 0, worldSecret: b32(0x5e), vssSharesRef: new Uint8Array(32), stakePoint: new Uint8Array(33), feePreimage: new Uint8Array(32), stakeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, feeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, claimKeyAttestationRef: new Uint8Array(32),
    },
    outcome, score, player: p,
  }));

  for (const n of nodes) {
    assert.equal((await post(n.port, '/round', encodeRoundContract(contract))).status, 201);
    assumeSeated(n.round, rid, contract.nodes);
    for (const e of entries) {
      assert.equal((await post(n.port, '/entry', encodeEntryContract(e.contract))).status, 201);
      const eid = entryIdOf(e.contract);
      const result = {
        roundId: rid, playerPubkey: e.player.pubkey, outcome: e.outcome, score: e.score,
        transcriptHash: b32(0x11), simCoreHash: contract.simCoreHash, nodePubkey: n.round.pubkey,
      };
      const id = resultId(result);
      n.round.putResult(rid, eid, n.round.pubkey, id,
        joinSignedResult(encodePlayerResult(result), schnorr.sign(id, n.round.identity.secret)));
    }
  }

  const entriesOf = (n) => new PoolSigning(n.round, {}).entriesFor(rid).entries;
  for (const n of nodes)
    n.payouts.sign({ roundId: rid, entries: entriesOf(n), minScore: contract.minScore });
  for (const n of nodes) {
    n.payouts.peers = nodes.filter((o) => o !== n).map((o) => `http://127.0.0.1:${o.port}`);
    await n.payouts.gather({ roundId: rid });
    const queued = n.payouts.queue({
      roundId: rid, entries: entriesOf(n), minScore: contract.minScore, contract,
    });
    assert.equal(queued.ok, true, queued.why);
    assert.equal(queued.state, PAYOUT_QUEUED);
  }

  return { nodes, dealt, pool, contract, rid, out, winner, loser, holding,
    close: () => Promise.all(nodes.map((n) => n.close())) };
}

/**
 * THE RULE FIRST, on its own, because it decides whether the rest of this file
 * is describing one spend or seven.
 */
test('every seat works out the same asker, and only that one asks', () => {
  const seats = Array.from({ length: SHARES_TOTAL }, (_, i) => b32(i + 1));

  // The same round always names the same seat, however many times it is asked.
  const rid = new Uint8Array([0, 0, 0, 9, ...new Uint8Array(28)]);
  const first = askerFor(rid, seats);
  assert.equal(first.ok, true, first.why);
  assert.equal(first.of, SHARES_TOTAL);
  assert.deepEqual(askerFor(rid, seats).asker, first.asker);
  assert.equal(first.at, 9 % SHARES_TOTAL);

  // AND IT MOVES WITH THE ROUND. A committee that always asked through its
  // first seat would be one node's committee: the load and the exposure both
  // belong to whoever the round names.
  const asked = new Set();
  for (let i = 0; i < 200; i++) {
    const r = new Uint8Array(32);
    r.set([(i >> 24) & 255, (i >> 16) & 255, (i >> 8) & 255, i & 255]);
    asked.add(askerFor(r, seats).at);
  }
  assert.equal(asked.size, SHARES_TOTAL, `200 rounds only ever asked ${asked.size} of the seats`);
  console.log(`  200 rounds asked all ${asked.size} seats; one round always names the same one`);

  // A TOP BIT SET IS NOT A NEGATIVE INDEX. `<<` in JavaScript makes a signed
  // 32-bit number, so a round id starting 0xff would have picked seats[-x] and
  // handed every such round to nobody at all.
  const high = new Uint8Array(32); high.set([0xff, 0xff, 0xff, 0xfe]);
  const it = askerFor(high, seats);
  assert.equal(it.ok, true, it.why);
  assert.ok(it.at >= 0 && it.at < SHARES_TOTAL, `a round id of 0xfffffffe picked seat ${it.at}`);

  assert.equal(askerFor(b32(1), []).ok, false);
  assert.equal(askerFor(new Uint8Array(4), seats).ok, false);
});

/**
 * THE NUMBER THAT CLOSES ITEM 18: a queued payout becomes a transaction with
 * nobody naming an outpoint.
 */
test('the round\'s own asker finds the pool and pays the winner', async () => {
  const sent = [];
  const chain = { send: async (raw) => { sent.push(raw); return { ok: true, txid: b32(0xcd) }; } };
  const c = await committee({ chain });
  try {
    const seats = c.nodes[0].round.seats(c.rid);
    const who = askerFor(c.rid, seats);
    const asker = c.nodes.find((n) => toHex(n.round.pubkey) === toHex(who.asker));
    assert.ok(asker, 'the round named a seat that is not on this committee');
    console.log(`  the round names seat ${who.at + 1} of ${who.of}`);

    // NOBODY NAMES AN OUTPOINT. That is the whole of the letter: the only
    // arguments are the round and the things this node already holds.
    const paid = await asker.payouts.settleQueued({
      roundId: c.rid, contract: c.contract, signing: asker.signing, watch: asker.poolWatch,
    });
    assert.equal(paid.ok, true, `${paid.why} ${JSON.stringify(paid.refused || '')}`);
    assert.equal(paid.state, PAID);
    assert.equal(paid.signed, SHARES_NEEDED);
    assert.equal(sent.length, 1, `the committee sent ${sent.length} transactions`);
    assert.ok(c.holding.calls.includes('scantxoutset'), 'the asker never asked the chain');

    // AND IT PAYS THE WINNER, checked against the key rather than against the
    // table this node wrote.
    const tx = parseTransaction(sent[0]);
    const toWinner = tx.outputs.filter((o) => toHex(o.script) === toHex(payToKey(c.winner.pubkey)));
    assert.equal(toWinner.length, 1, 'the winner has no output in the transaction');
    assert.ok(toWinner[0].value > 0n);
    const toLoser = tx.outputs.filter((o) => toHex(o.script) === toHex(payToKey(c.loser.pubkey)));
    assert.equal(toLoser.length, 0, 'a forfeited run was paid');
    console.log(`  ${toWinner[0].value} sats to the winner, out of a ${POOL_SATS} sat pool`);

    assert.equal(asker.round.payout(c.rid).state, PAID);
  } finally { await c.close(); }
});

/**
 * AND WITH NO PEER LIST, THE ROUND'S OWN SEATS SIGN IT.
 *
 * Measured on the real-lnd rehearsal with the daemons' own 2-of-2 pool: both
 * seats signed and queued the table, and the round's asker stopped at "1 of 2
 * seats committed to this spend". `settleQueued` handed the signing round
 * `this.peers` - the list an operator passes - while the table's gather beside
 * it asks `peersOf`, which falls back to the round's settlement seats off the
 * census (M3.3-24). A daemon given no list - the rehearsal's, the Daily's,
 * `main.js` at a live close - asked nobody for a signature.
 */
test('with no peer list, the round\'s asker asks the round\'s own seats and pays the winner', async () => {
  const sent = [];
  const chain = { send: async (raw) => { sent.push(raw); return { ok: true, txid: b32(0xce) }; } };
  const c = await committee({ chain });
  try {
    // WHAT A LAUNCHED DAEMON HAS: no operator list, only the census's seats.
    for (const n of c.nodes) {
      const others = c.nodes.filter((o) => o !== n).map((o) => `http://127.0.0.1:${o.port}`);
      n.payouts.peers = [];
      n.payouts.peersFor = () => others;
    }
    const who = askerFor(c.rid, c.nodes[0].round.seats(c.rid));
    const asker = c.nodes.find((n) => toHex(n.round.pubkey) === toHex(who.asker));
    const paid = await asker.payouts.settleQueued({
      roundId: c.rid, contract: c.contract, signing: asker.signing, watch: asker.poolWatch,
    });
    assert.equal(paid.ok, true, `the asker with no peer list did not pay: ${paid.why}`);
    assert.equal(paid.state, PAID);
    assert.equal(paid.signed, SHARES_NEEDED);
    assert.equal(sent.length, 1);
    const tx = parseTransaction(sent[0]);
    assert.equal(tx.outputs.filter((o) => toHex(o.script) === toHex(payToKey(c.winner.pubkey))).length, 1,
      'the winner has no output in the transaction');
  } finally { await c.close(); }
});

/**
 * AND THE SIX OTHERS DO NOT, AT THE HEIGHT THE ROUND CLOSES AT.
 *
 * The round's own asker is first in the order and is alone at beacon+0. Every
 * other seat names the height at which its own turn comes, so a refusal says
 * WHEN rather than only no.
 */
test('at the beacon height only the round\'s own asker may ask', async () => {
  const sent = [];
  const chain = { send: async (raw) => { sent.push(raw); return { ok: true, txid: b32(0xcd) }; } };
  const c = await committee({ chain });
  try {
    const who = askerFor(c.rid, c.nodes[0].round.seats(c.rid));
    let waiting = 0;
    for (const n of c.nodes) {
      if (toHex(n.round.pubkey) === toHex(who.asker)) continue;
      const got = await n.payouts.settleQueued({
        roundId: c.rid, contract: c.contract, signing: n.signing, watch: n.poolWatch,
      });
      assert.equal(got.ok, false);
      assert.equal(got.waiting, true);
      assert.ok(got.place > 0, 'a waiting seat thinks it is first in the order');
      assert.match(got.why, /in the takeover order and may ask at height/);
      assert.equal(n.round.payout(c.rid).state, PAYOUT_QUEUED, 'a waiting seat moved its row');
      waiting++;
    }
    assert.equal(waiting, SHARES_TOTAL - 1);
    assert.equal(sent.length, 0, 'a seat that is not the asker reached the chain');
    console.log(`  at beacon+0: ${waiting} seats waited, 0 transactions sent`);
  } finally { await c.close(); }
});

/**
 * ITEM 19, AND THE NUMBER IT IS OPENED ON: THE ASKER IS DOWN.
 *
 * Nothing is broadcast and the winner is unpaid for as long as the chain has
 * not advanced. Then the next seat in the order pays, and it is ONE
 * transaction - not one per eligible seat.
 */
test('a down asker strands nothing: the next seat pays after the wait', async () => {
  const sent = [];
  const chain = { send: async (raw) => { sent.push(raw); return { ok: true, txid: b32(0xcd) }; } };
  const c = await committee({ chain });
  try {
    const ring = askerOrder(c.rid, c.nodes[0].round.seats(c.rid));
    const nodeAt = (k) => c.nodes.find((n) => toHex(n.round.pubkey) === toHex(ring.order[k]));
    const down = nodeAt(0);
    const next = nodeAt(1);
    const settle = (n, extra = {}) => n.payouts.settleQueued({
      roundId: c.rid, contract: c.contract, signing: n.signing, watch: n.poolWatch, ...extra,
    });

    // THE ASKER IS DOWN. It simply never runs, and the second seat is refused
    // by the clock rather than by anything the first one said.
    const early = await settle(next);
    assert.equal(early.ok, false);
    assert.equal(early.waiting, true);
    assert.equal(early.nextAt, BEACON_HEIGHT + TAKEOVER_BLOCKS);
    assert.equal(sent.length, 0, 'something was broadcast while the asker was merely late');
    assert.equal(next.round.payout(c.rid).state, PAYOUT_QUEUED);
    console.log(`  asker down, chain at the beacon: ${early.why}`);

    // THE CHAIN ADVANCES. Two blocks, which is TAKEOVER_BLOCKS.
    c.holding.mine(TAKEOVER_BLOCKS);
    const took = await settle(next);
    assert.equal(took.ok, true, took.why);
    assert.equal(took.state, PAID);
    assert.equal(sent.length, 1, `the takeover sent ${sent.length} transactions`);

    // AND IT PAYS THE SAME TABLE THE ROUND'S OWN ASKER WOULD HAVE. A failover
    // that paid somebody else, or a different amount, would make an outage
    // worth arranging.
    const tx = parseTransaction(sent[0]);
    const toWinner = tx.outputs.filter((o) => toHex(o.script) === toHex(payToKey(c.winner.pubkey)));
    assert.equal(toWinner.length, 1);
    assert.equal(toWinner[0].value, netStakeMsat({ stakeMsat: c.contract.stakeMsat, feeMsat: entryFeeMsat(c.contract.stakeMsat), donationMsat: 0n }) / 1000n, 'the takeover paid a different amount');
    assert.equal(tx.outputs.filter((o) => toHex(o.script) === toHex(payToKey(c.loser.pubkey))).length, 0);
    console.log(`  after ${TAKEOVER_BLOCKS} blocks seat ${2} of ${ring.of} paid `
      + `${toWinner[0].value} sats - the same table`);

    // AND THE SEAT THAT WAS DOWN COMES BACK. Its own row still says queued;
    // it must not build a second spend.
    const back = await settle(down);
    assert.equal(back.ok, true, back.why);
    assert.equal(sent.length, 2, 'the returning asker did not run a signing round');
    assert.equal(toHex(sent[0]), toHex(sent[1]),
      'the returning asker built DIFFERENT bytes from the takeover');
    console.log('  the asker came back and rebuilt the identical transaction');
  } finally { await c.close(); }
});

/**
 * AND A RESTART IN THE MIDDLE DOES NOT MAKE A RIVAL TRANSACTION.
 *
 * This is the fault that made the durable nonce part of 19 rather than a later
 * letter. `PoolSigning.live` was a Map that died with the process: a committee
 * that restarted between two asks signed the same spend with FRESH nonces, so
 * the same input was spent by two different sets of bytes. Measured before the
 * pair was on disk - different signature, same txid, because a segwit txid
 * does not cover the witness - and identical after.
 */
test('a restart between two asks reproduces the same bytes, not a rival', async () => {
  const sent = [];
  const chain = { send: async (raw) => { sent.push(raw); return { ok: true, txid: b32(0xcd) }; } };
  const c = await committee({ chain });
  try {
    const ring = askerOrder(c.rid, c.nodes[0].round.seats(c.rid));
    const asker = c.nodes.find((n) => toHex(n.round.pubkey) === toHex(ring.order[0]));
    const first = await asker.payouts.settleQueued({
      roundId: c.rid, contract: c.contract, signing: asker.signing, watch: asker.poolWatch,
    });
    assert.equal(first.ok, true, first.why);
    assert.equal(sent.length, 1);

    // EVERY SEAT RESTARTS: fresh PoolSigning objects over the same stores,
    // which is exactly what a process restart leaves behind.
    for (const n of c.nodes)
      n.signing = new PoolSigning(n.round, {
        curve, seat: c.dealt.shares[c.nodes.indexOf(n)], pool: c.pool,
      });

    c.holding.mine(TAKEOVER_BLOCKS * SHARES_TOTAL);       // everybody is eligible now
    const after = c.nodes.find((n) => toHex(n.round.pubkey) === toHex(ring.order[2]));
    const second = await after.payouts.settleQueued({
      roundId: c.rid, contract: c.contract, signing: after.signing, watch: after.poolWatch,
    });
    assert.equal(second.ok, true, second.why);
    assert.equal(sent.length, 2, 'the second ask sent nothing at all');
    assert.equal(toHex(sent[0]), toHex(sent[1]),
      'a restarted committee signed the same input with different bytes');
    console.log('  a restarted committee rebuilt the identical transaction, byte for byte');
  } finally { await c.close(); }
});

/**
 * AND A SPEND ALREADY IN A MEMPOOL STOPS THE NEXT SEAT BEFORE IT ASKS.
 *
 * `forRound` reads `scantxoutset`, which scans the UTXO set and does not see a
 * mempool, so on its own a takeover would start a signing round over an output
 * that is already going. `outpoint` asks `gettxout`, which does see one.
 */
test('an output already going stops a takeover before it asks anybody', async () => {
  const sent = [];
  const chain = { send: async (raw) => { sent.push(raw); return { ok: true, txid: b32(0xcd) }; } };
  const c = await committee({ chain });
  try {
    const ring = askerOrder(c.rid, c.nodes[0].round.seats(c.rid));
    const next = c.nodes.find((n) => toHex(n.round.pubkey) === toHex(ring.order[1]));
    c.holding.mine(TAKEOVER_BLOCKS);

    // The seat in front broadcast a minute ago: the output is out of the
    // mempool's view but still in the UTXO set, which is the window this
    // check exists for.
    c.holding.spend(b32(0xab), 0);

    const got = await next.payouts.settleQueued({
      roundId: c.rid, contract: c.contract, signing: next.signing, watch: next.poolWatch,
    });
    assert.equal(got.ok, false);
    assert.equal(got.spending, true);
    assert.match(got.why, /already going/);
    assert.equal(sent.length, 0, 'a takeover ran a signing round over an output already spent');
    assert.equal(next.round.payout(c.rid).state, PAYOUT_QUEUED);
    console.log(`  ${got.why}`);
  } finally { await c.close(); }
});

/**
 * AND NO NODE CAN MOVE ITS OWN PLACE.
 *
 * The order is the seats the store keeps sorted BY PUBKEY - which no seat
 * picks - rotated by an index taken from the round id, which is a hash of a
 * contract signed before the round ran.
 */
test('the takeover order is the round\'s, and nothing a node holds moves it', () => {
  const seats = Array.from({ length: SHARES_TOTAL }, (_, i) => b32(i + 1));
  const rid = b32(0x21);

  const ring = askerOrder(rid, seats);
  assert.equal(ring.ok, true, ring.why);
  assert.equal(ring.order.length, SHARES_TOTAL);
  assert.deepEqual(ring.order[0], askerFor(rid, seats).asker, 'the ring does not start at the asker');
  assert.equal(new Set(ring.order.map(toHex)).size, SHARES_TOTAL, 'a seat appears twice in the order');
  assert.deepEqual(askerOrder(rid, seats).order.map(toHex), ring.order.map(toHex),
    'the order is not the same twice');

  // THE SAME SEATS IN A DIFFERENT ORDER ARE THE SAME RING. The store sorts by
  // pubkey, so a node cannot present its own list and move itself up.
  const shuffled = [...seats].reverse();
  assert.notDeepEqual(shuffled.map(toHex), seats.map(toHex));
  const sorted = [...shuffled].sort((a, b) => (toHex(a) < toHex(b) ? -1 : 1));
  assert.deepEqual(askerOrder(rid, sorted).order.map(toHex), ring.order.map(toHex));

  // AND THE WAIT IS THE CHAIN'S. One seat at the beacon, one more every
  // TAKEOVER_BLOCKS, all of them once the chain is far enough past it.
  const at = (tip) => eligibleAsker({ roundId: rid, seats, beaconHeight: 100, tipHeight: tip });
  assert.equal(at(100).allowed.length, 1);
  assert.equal(at(100).nextAt, 100 + TAKEOVER_BLOCKS);
  assert.equal(at(100 + TAKEOVER_BLOCKS - 1).allowed.length, 1, 'a seat came in early');
  assert.equal(at(100 + TAKEOVER_BLOCKS).allowed.length, 2);
  assert.equal(at(100 + TAKEOVER_BLOCKS * (SHARES_TOTAL - 1)).allowed.length, SHARES_TOTAL);
  assert.equal(at(100 + TAKEOVER_BLOCKS * (SHARES_TOTAL - 1)).nextAt, null);
  assert.equal(at(99).allowed.length, 0, 'a seat asked before the beacon it waits from');

  // A round with no beacon and a node with no tip both refuse rather than
  // guessing that it is somebody's turn.
  assert.equal(eligibleAsker({ roundId: rid, seats, tipHeight: 100 }).ok, false);
  assert.equal(eligibleAsker({ roundId: rid, seats, beaconHeight: 100 }).ok, false);
  console.log(`  ${SHARES_TOTAL} seats, one at the beacon and one more every `
    + `${TAKEOVER_BLOCKS} blocks; the order is the same however the list arrives`);
});

/**
 * WHAT THE POOL HAS TO LOOK LIKE, and both refusals are `pool-watch.js`'s own
 * rule reaching the daemon: zero outputs is a refusal by name and several is a
 * refusal by name, because choosing between them is an operator's decision
 * wearing arithmetic.
 */
test('an empty pool and a pool with a choice both refuse, and the row stays queued', async () => {
  const chain = { send: async () => { throw new Error('it should not have got this far'); } };

  const empty = await committee({ chain, held: [] });
  try {
    const who = askerFor(empty.rid, empty.nodes[0].round.seats(empty.rid));
    const asker = empty.nodes.find((n) => toHex(n.round.pubkey) === toHex(who.asker));
    const got = await asker.payouts.settleQueued({
      roundId: empty.rid, contract: empty.contract, signing: asker.signing, watch: asker.poolWatch,
    });
    assert.equal(got.ok, false);
    assert.match(got.why, /none of them covers/);
    assert.equal(asker.round.payout(empty.rid).state, PAYOUT_QUEUED);
    console.log(`  empty pool: ${got.why}`);
  } finally { await empty.close(); }

  const two = await committee({ chain, held: [
    { txid: b32(0xab), vout: 0, sats: POOL_SATS },
    { txid: b32(0xac), vout: 1, sats: POOL_SATS },
  ] });
  try {
    const who = askerFor(two.rid, two.nodes[0].round.seats(two.rid));
    const asker = two.nodes.find((n) => toHex(n.round.pubkey) === toHex(who.asker));
    const got = await asker.payouts.settleQueued({
      roundId: two.rid, contract: two.contract, signing: asker.signing, watch: asker.poolWatch,
    });
    assert.equal(got.ok, false);
    assert.match(got.why, /name the one to spend/);
    assert.equal(asker.round.payout(two.rid).state, PAYOUT_QUEUED);
    console.log(`  two covering outputs: ${got.why}`);
  } finally { await two.close(); }
});

/**
 * A POOL OUTPUT TOO SHALLOW TO SPEND, and the sentence is not the empty pool's.
 *
 * WHAT THIS IS NOT is a funding transaction still in a mempool, which is what
 * this test claimed until a real regtest disproved it: `scantxoutset` scans the
 * UTXO SET, so an unconfirmed pool is not in the answer at all and correctly
 * reads as a pool holding nothing. This is an output that IS in the set and
 * has fewer confirmations than the caller asked for.
 */
test('an output too shallow for the depth asked for is refused by its own name', async () => {
  const chain = { send: async () => { throw new Error('it should not have got this far'); } };
  const c = await committee({ chain, held: [
    { txid: b32(0xab), vout: 0, sats: POOL_SATS, confirmations: 3 },
  ] });
  try {
    const who = askerFor(c.rid, c.nodes[0].round.seats(c.rid));
    const asker = c.nodes.find((n) => toHex(n.round.pubkey) === toHex(who.asker));
    const got = await asker.payouts.settleQueued({
      roundId: c.rid, contract: c.contract, signing: asker.signing, watch: asker.poolWatch,
      minConfirmations: 6,
    });
    assert.equal(got.ok, false);
    assert.match(got.why, /fewer than 6 confirmation\(s\)/);
    assert.equal(got.shallow, 1);
    assert.equal(got.confirmed, 0);
    assert.equal(asker.round.payout(c.rid).state, PAYOUT_QUEUED);
    console.log(`  three deep against six: ${got.why}`);
  } finally { await c.close(); }
});

/**
 * AND A NODE THAT WAS DOWN WHEN ITS ROUND CLOSED STILL PAYS.
 *
 * `reconcile` asks whether a transaction this node had already built went out,
 * which leaves a round that never got that far exactly where it was. Without
 * this sweep a queued payout waits for a close that has already happened.
 */
test('a queued payout is swept on start, and a paid one is left alone', async () => {
  const sent = [];
  const chain = { send: async (raw) => { sent.push(raw); return { ok: true, txid: b32(0xcd) }; } };
  const c = await committee({ chain });
  try {
    const who = askerFor(c.rid, c.nodes[0].round.seats(c.rid));
    const asker = c.nodes.find((n) => toHex(n.round.pubkey) === toHex(who.asker));

    const swept = await asker.payouts.settleAllQueued({
      contractFor: () => c.contract, signing: asker.signing, watch: asker.poolWatch,
    });
    assert.equal(swept.ok, true, swept.why);
    assert.equal(swept.settled.length, 1);
    assert.equal(swept.settled[0].state, PAID, swept.settled[0].why);
    assert.equal(sent.length, 1);

    // AND A SECOND SWEEP SENDS NOTHING. A node that restarts twice must not
    // build a second spend of one output.
    const again = await asker.payouts.settleAllQueued({
      contractFor: () => c.contract, signing: asker.signing, watch: asker.poolWatch,
    });
    assert.equal(again.settled.length, 0, 'a PAID round is still queued');
    assert.equal(sent.length, 1, `a second sweep sent ${sent.length - 1} more transactions`);
    console.log('  one sweep pays, a second sends nothing');
  } finally { await c.close(); }
});
