// THE POOL'S SIGNING THRESHOLD FOLLOWS THE COMMITTEE (M3.3-28).
//
// Measured before any change: on a two-seat committee the daemons' own key
// ceremony refused to deal - "a threshold of 5 cannot be dealt to 2 seats" - so
// a two-seat round's pool had no key at all, and `pay()` counted two signers as
// "2 of 5 signers: a pool nobody can move stays where it is". One `Dkg` per
// daemon with SHARES_NEEDED = 5 for every committee it is ever on was the bug,
// and `payWithCommittee` and `pay()` carried the same flat 5.
//
// The rule is the one M3.3-26 gave the stake: the committee's own threshold,
// 2 of 2 on two seats, 5 of 7 on seven (`receiptsNeeded`). These pins run the
// daemons' OWN ceremony - no trusted dealer - and pay through the defaults, so
// a flat 5 fails the two-seat pins and the slot count (7) fails the seven-seat
// ones, where two seats are down and five must be enough.
import { test } from 'node:test';
import { TEST_DONATION_SET_REGTEST } from '../../protocol/src/test-donation-sets.js';
import { donationSetId as idOfDonationSet } from '../../protocol/src/donation.js';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { schnorr } from '@noble/curves/secp256k1.js';
import { ed25519 } from '@noble/curves/ed25519.js';

import { openStore } from '../src/store.js';
import { serve } from '../src/server.js';
import { PAYOUT_QUEUED, PAID } from '../src/payout.js';
import { PoolSigning } from '../src/pool-signing.js';
import { poolOutput } from '../../protocol/src/pool.js';
import { encodeRoundContract, encodeEntryContract, roundId, entryId as entryIdOf } from '../../protocol/src/contracts.js';
import { encodePlayerResult, resultId, joinSignedResult } from '../../protocol/src/result.js';
import { DELIVERED, FORFEIT } from '../../protocol/src/payout.js';
import { MIN_ENTRY_WINDOW_MS } from '../../protocol/src/constants.js';
import { NETWORK_ID_REGTEST } from '../../protocol/src/genesis-ids.js';
import { feldmanGroup, tweakPoint } from '../src/curve.js';
import { assumeSeated } from './seating.js';
import { toHex } from '../../protocol/src/hash.js';
import { parseTransaction } from '../../protocol/src/tx.js';
import { entryFeeMsat } from '../../protocol/src/fee.js';

const rand = (n) => new Uint8Array(randomBytes(n));
const b32 = (n) => new Uint8Array(32).fill(n);
const curve = { ...feldmanGroup, tweakPoint };
const NOW = 1788700000000;
const POOL_SATS = 200000n;

const contractFor = (nodes) => ({
  networkId: NETWORK_ID_REGTEST, configHash: b32(0x43), censusConfirmations: 1,
  gameVerifySlots: nodes.length, settlementSlots: nodes.length, simCoreHash: b32(1),
  committeeTimeMs: BigInt(NOW), randomnessRule: 'bitcoin-block-hash',
  startTimeMs: BigInt(NOW) + MIN_ENTRY_WINDOW_MS,
  entryCloseMs: BigInt(NOW) + MIN_ENTRY_WINDOW_MS + 200000n,
  objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20,
  slashRemainder: 'BURN', federationId: new Uint8Array(32), stakeExpiryBlocks: 144, publicationRelays: [], donationSetId: idOfDonationSet(TEST_DONATION_SET_REGTEST.recipients), censusHeight: 900000,
  censusRoot: b32(2), stakeMsat: 1000000n, bondMinSats: 50000n, blockTicks: 9000,
  exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20,
  timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4,
  nodes,
});

const player = () => { const s = rand(32); return { secret: s, pubkey: schnorr.getPublicKey(s) }; };
const post = (port, path, body) => fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', body });
const at = (n) => `http://127.0.0.1:${n.port}`;

/** A chain that keeps what it was sent. */
function fakeChain() {
  const sent = [];
  return { sent, async send(raw) { sent.push(raw); return { ok: true, txid: parseTransaction(raw).txid }; },
    async look(txid) { return { known: sent.some((r) => toHex(parseTransaction(r).txid) === toHex(txid)) }; } };
}

/**
 * `size` daemons that make the pool's key THEMSELVES (dkg.run, twice, as the
 * regtest tool does), one round, a winner and a loser, and a payout table every
 * seat signed, gathered and queued.
 */
async function committeeOf(size) {
  const chain = fakeChain();
  const nodes = [];
  for (let i = 0; i < size; i++)
    nodes.push(await serve(openStore(':memory:'), {
      port: 0, funded: () => true, now: () => NOW, poolCurve: curve, chainSpend: chain,
    }));
  const close = () => Promise.all(nodes.map((n) => n.close().catch(() => {})));
  try {
    const keys = nodes.map((n) => n.round.pubkey);
    for (const n of nodes) n.dkg.peers = nodes.filter((o) => o !== n).map(at);
    const ran = [];
    for (const n of nodes) ran.push(await n.dkg.run(keys));
    for (const n of nodes) await n.dkg.run(keys);
    const seats = nodes.map((n) => n.dkg.seatFor(keys));
    const dealt = await nodes[0].dkg.deal(keys);
    return { nodes, keys, chain, seats, ran, dealt, close };
  } catch (err) { await close(); throw err; }
}

/** The round, its two entries, each seat's own signed result, and the table queued on every seat. */
async function queuedRound(c) {
  const pool = { groupPublicKey: c.seats[0].pool.groupPublicKey };
  c.nodes.forEach((n, i) => { n.signing.seat = c.seats[i].seat; n.signing.pool = pool; n.payouts.pool = pool; });
  const contract = contractFor(c.keys);
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
  for (const n of c.nodes) {
    assert.equal((await post(n.port, '/round', encodeRoundContract(contract))).status, 201);
    assumeSeated(n.round, rid, contract.nodes);
    for (const e of entries) {
      assert.equal((await post(n.port, '/entry', encodeEntryContract(e.contract))).status, 201);
      const result = {
        roundId: rid, playerPubkey: e.player.pubkey, outcome: e.outcome, score: e.score,
        transcriptHash: b32(0x11), simCoreHash: contract.simCoreHash, nodePubkey: n.round.pubkey,
      };
      const id = resultId(result);
      n.round.putResult(rid, entryIdOf(e.contract), n.round.pubkey, id,
        joinSignedResult(encodePlayerResult(result), schnorr.sign(id, n.round.identity.secret)));
    }
  }
  const entriesOf = (n) => new PoolSigning(n.round, {}).entriesFor(rid).entries;
  for (const n of c.nodes) n.payouts.sign({ roundId: rid, entries: entriesOf(n), minScore: contract.minScore });
  const queued = [];
  for (const n of c.nodes) {
    n.payouts.peers = c.nodes.filter((o) => o !== n).map(at);
    await n.payouts.gather({ roundId: rid });
    const q = n.payouts.queue({ roundId: rid, entries: entriesOf(n), minScore: contract.minScore, contract });
    assert.equal(q.ok, true, q.why);
    assert.equal(q.state, PAYOUT_QUEUED);
    queued.push(q);
  }
  const out = poolOutput({ groupPublicKey: pool.groupPublicKey, curve });
  const utxo = { txid: b32(0xab), vout: 0, value: POOL_SATS, script: out.script };
  return { pool, contract, rid, utxo, out, queued, winner };
}

/** The key the ceremony made, and the threshold it dealt. */
function ceremonyOf(c) {
  for (const [i, s] of c.seats.entries()) assert.equal(s.ok, true, `seat ${i + 1} ended the ceremony with no share: ${s.why} (run: ${c.ran[i].why})`);
  const keys = new Set(c.seats.map((s) => toHex(s.pool.groupPublicKey)));
  assert.equal(keys.size, 1, `the daemons made ${keys.size} different pool keys`);
  assert.equal(c.dealt.ok, true, c.dealt.why);
  return c.dealt.contribution.commitments.length;   // Feldman commitments: one per coefficient, = the threshold
}

test('two seats: the daemons\' own ceremony deals 2-of-2, and both seats sign and pay through the default', async () => {
  const c = await committeeOf(2);
  try {
    assert.equal(ceremonyOf(c), 2, 'the ceremony did not deal the two-seat committee its own 2-of-2');
    const r = await queuedRound(c);
    const mine = c.nodes[0].signing.spendFor({ roundId: r.rid, utxo: r.utxo, contract: r.contract });
    assert.equal(mine.ok, true, mine.why);
    const paid = await c.nodes[0].payouts.payWithCommittee({
      roundId: r.rid, utxo: r.utxo, contract: r.contract, signing: c.nodes[0].signing, seats: [at(c.nodes[1])],
    });
    assert.equal(paid.ok, true, `${paid.why} ${JSON.stringify(paid.refused || [])}`);
    assert.equal(paid.state, PAID);
    assert.equal(c.chain.sent.length, 1, 'the two seats did not send one transaction');
    const tx = parseTransaction(c.chain.sent[0]);
    assert.ok(schnorr.verify(tx.witnesses[0][0], mine.sighash, r.out.outputKey),
      'two seats produced no signature the pool output would take');
  } finally { await c.close(); }
});

test('seven seats, two down: the ceremony deals 5-of-7, and the five that exist sign and pay through the default', async () => {
  const c = await committeeOf(7);
  try {
    assert.equal(ceremonyOf(c), 5, 'the ceremony did not deal the seven-seat committee its 5-of-7');
    const r = await queuedRound(c);
    await c.nodes[5].close();
    await c.nodes[6].close();
    const mine = c.nodes[0].signing.spendFor({ roundId: r.rid, utxo: r.utxo, contract: r.contract });
    const paid = await c.nodes[0].payouts.payWithCommittee({
      roundId: r.rid, utxo: r.utxo, contract: r.contract, signing: c.nodes[0].signing,
      seats: c.nodes.slice(1, 5).map(at),
    });
    assert.equal(paid.ok, true, `${paid.why} ${JSON.stringify(paid.refused || [])}`);
    assert.equal(paid.state, PAID);
    assert.equal(paid.signed, 5);
    const tx = parseTransaction(c.chain.sent[0]);
    assert.ok(schnorr.verify(tx.witnesses[0][0], mine.sighash, r.out.outputKey),
      'five of seven produced no signature the pool output would take');
  } finally { await c.close(); }
});

test('pay() on two seats pays with the two seats\' own shares - not "2 of 5 signers"', async () => {
  const c = await committeeOf(2);
  try {
    ceremonyOf(c);
    const r = await queuedRound(c);
    const paid = await c.nodes[0].payouts.pay({
      roundId: r.rid, rows: r.queued[0].rows, utxo: r.utxo, signers: c.seats.map((s) => s.seat),
    });
    assert.equal(paid.ok, true, paid.why);
    assert.equal(paid.state, PAID);
  } finally { await c.close(); }
});

test('pay() on seven seats pays with five of them - not "5 of 7 signers"', async () => {
  const c = await committeeOf(7);
  try {
    ceremonyOf(c);
    const r = await queuedRound(c);
    const paid = await c.nodes[0].payouts.pay({
      roundId: r.rid, rows: r.queued[0].rows, utxo: r.utxo, signers: c.seats.slice(0, 5).map((s) => s.seat),
    });
    assert.equal(paid.ok, true, paid.why);
    assert.equal(paid.state, PAID);
  } finally { await c.close(); }
});
