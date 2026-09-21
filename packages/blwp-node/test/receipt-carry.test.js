// A CHECKPOINT'S RECEIPTS ARE CARRIED ACROSS THE COMMITTEE AT THE CLOSE (M3.3-22).
//
// Section 13C: the canonical transcript is "the longest checkpoint chain that
// carries receipts from at least T committee nodes". Measured on the regtest
// rehearsal through the real daemons: every mark was receipted by BOTH daemons,
// each kept only its own half - 20 of 20 and 7 of 7 its own, 0 from the other -
// and both closes said "no checkpoint of that entry is carried by 2 committee
// members: the first has 1". No run was replayed to a result, and every hold
// went home on its own timelock.
//
// The client collected both receipts and forwarded none, and must not be the
// one to: a losing player who withheld them would reach no-quorum and a VOID
// refund, which 13C says a player cannot manufacture. So each daemon PULLS its
// peers' receipts at the close, and every record goes through `takeReceipt`
// unchanged - the mark held here, the signer joined, the signature verified.
import { TRUCK_CORE_HASH, TRUCK_CONFIG_HASH } from '../src/cores.js';
import { BLOCK_TICKS } from '../../core/src/rules/gate.js';
import { PLANTED_FIRST_MARK_DEADLINE } from './planted-marks.js';
import { TEST_DONATION_SET_REGTEST } from '../../protocol/src/test-donation-sets.js';
import { donationSetId as idOfDonationSet } from '../../protocol/src/donation.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { ed25519 } from '@noble/curves/ed25519.js';
import { schnorr } from '@noble/curves/secp256k1.js';
import { WebSocket } from 'ws';

import { openStore } from '../src/store.js';
import { serve } from '../src/server.js';
import { Round } from '../src/round.js';
import { Roster } from '../src/roster.js';
import { assumeAssigned } from './assignment.js';
import { NETWORK_ID_REGTEST } from '../../protocol/src/genesis-ids.js';
import {
  encodeRoundContract, decodeRoundContract, roundId, encodeEntryContract, entryId,
} from '../../protocol/src/contracts.js';
import { encodeInputBatch, batchId } from '../../protocol/src/batch.js';
import { encodeCheckpoint, checkpointId, joinSigned, NO_PREVIOUS } from '../../protocol/src/checkpoint.js';
import {
  encodeCheckpointReceipt, receiptId, joinSignedReceipt, splitSignedReceipt,
  decodeCheckpointReceipt, SIGNED_RECEIPT_BYTES,
} from '../../protocol/src/receipt.js';
import { init, step } from '../../core/src/sim.js';
import { hash as stateHash } from '../../core/src/state.js';
import { seedWordForEntry } from '../../protocol/src/seed.js';
import { toHex } from '../../protocol/src/hash.js';
import { chainOf, FIRST_TIME, SPACING, publicationOf } from '../../protocol/tools/chainview.js';
import { bondTransaction } from '../../protocol/tools/bond.js';
import { deriveCensus } from '../../protocol/src/census.js';
import { parseTransaction } from '../../protocol/src/tx.js';
import { bondSetFor } from '../src/curve.js';
import { bondFor } from './curve.js';
import { beaconFromChain } from '../../protocol/src/beacon.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const FUNDED = { funded: () => true };
const RANDOMNESS = b32(0x9b);
const BEACON = { hash: RANDOMNESS, height: 900001, timeMs: 900n };
const GENESIS_HASH = (await import('../../protocol/src/transcript.js')).GENESIS;
// THE NODE FIXTURE'S OWN DRIVE, which wrecks this world secret at tick 956 (547 before the armour doctrine) -
// any ending will do: what is measured is whether a run is replayed at all.
const TICKS = 1000;
const wordsAt = (t) => [45875, ((t * 977) % 30000) - 15000, (t % 700) < 40 ? 65536 : 0, 0, 0];
const session = ed25519.utils.randomSecretKey();

/** A free round - carrying receipts is not about money, so no Lightning. */
const contractFor = (nodes) => ({
  startDeadlineTicks: PLANTED_FIRST_MARK_DEADLINE, networkId: NETWORK_ID_REGTEST, configHash: TRUCK_CONFIG_HASH, censusConfirmations: 1,
  gameVerifySlots: 2, settlementSlots: 2, simCoreHash: TRUCK_CORE_HASH, startTimeMs: 60500n,
  entryCloseMs: 2000n, objectionWindowMs: 600000n, custody: 'THRESHOLD_LN',
  slashMinimumServed: 20, slashRemainder: 'BURN', federationId: new Uint8Array(32), stakeExpiryBlocks: 144, publicationRelays: [], donationSetId: idOfDonationSet(TEST_DONATION_SET_REGTEST.recipients),
  censusHeight: 900000, censusRoot: b32(2), committeeTimeMs: 500n,
  randomnessRule: 'bitcoin-block-hash', stakeMsat: 0n, bondMinSats: 50000n,
  blockTicks: BLOCK_TICKS, exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20,
  timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4, nodes,
});
const entryFor = (rid) => ({
  roundId: rid, playerPubkey: b32(5), sessionPubkey: ed25519.getPublicKey(session),
  stakeCommitment: b32(7), stakeMsat: 0n, feeMsat: 0n, donationMsat: 0n,
  joinTick: 0, worldSecret: b32(0x16), vssSharesRef: new Uint8Array(32), stakePoint: new Uint8Array(33), feePreimage: new Uint8Array(32), stakeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, feeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, claimKeyAttestationRef: new Uint8Array(32),
});

const say = (port, message) => new Promise((resolve, reject) => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/play`);
  ws.on('open', () => ws.send(message));
  ws.on('message', (d, bin) => { resolve(bin ? new Uint8Array(d) : d.toString()); ws.close(); });
  ws.on('error', reject);
});

/**
 * TWO DAEMONS, ONE RUN, AND EACH RECEIPTS ITS OWN HALF - exactly what the
 * client leaves behind: the inputs and the mark go to both, each answers with
 * its own receipt, and nobody forwards one to the other.
 */
async function played() {
  const a = await serve(openStore(':memory:'), { port: 0, ...FUNDED, randomnessFor: () => BEACON });
  const b = await serve(openStore(':memory:'), { port: 0, ...FUNDED, randomnessFor: () => BEACON });
  const c = contractFor([a.round.pubkey, b.round.pubkey]);
  const rid = roundId(c);
  const entry = entryFor(rid);
  const eid = entryId(entry);
  const input = { roundId: rid, entryId: eid, previousHash: GENESIS_HASH, firstTick: 0,
    ticks: Array.from({ length: TICKS }, (_, t) => wordsAt(t)), liquidations: [] };
  const st = init(seedWordForEntry(entry, RANDOMNESS));
  for (let t = 0; t < TICKS; t++) step(st, ...wordsAt(t));
  const mark = {
    roundId: rid, entryId: eid, tick: TICKS,
    stateHash: Uint8Array.from(stateHash(st).match(/../g).map((x) => parseInt(x, 16))),
    inputChainHash: batchId(input), previousHash: NO_PREVIOUS, sessionPubkey: ed25519.getPublicKey(session),
  };
  const signedMark = joinSigned(encodeCheckpoint(mark), ed25519.sign(checkpointId(mark), session));
  for (const d of [a, b]) {
    await fetch(`http://127.0.0.1:${d.port}/round`, { method: 'POST', body: encodeRoundContract(c) });
    assumeAssigned(d.round, rid, c.nodes);
    await fetch(`http://127.0.0.1:${d.port}/entry`, { method: 'POST', body: encodeEntryContract(entry) });
    assert.equal(await say(d.port, encodeInputBatch(input)), String(TICKS));
    const receipt = await say(d.port, signedMark);
    assert.equal(receipt.length, SIGNED_RECEIPT_BYTES, `the daemon did not receipt the mark: ${receipt}`);
  }
  return { a, b, rid, eid, mark, close: async () => { await a.close(); await b.close(); } };
}

/** Close a round on one daemon and read what its replay made of this run. */
async function closeOn(d, rid, eid) {
  assert.equal(await say(d.port, `close ${toHex(rid)}`), 'closed');
  const closed = await d.verifier.settling;
  return closed.replayed.find((r) => toHex(r.entryId) === toHex(eid));
}

/** Who signed the receipts a daemon holds for this run. */
async function signersOn(d, rid, eid) {
  const r = await fetch(`http://127.0.0.1:${d.port}/receipts?round=${toHex(rid)}&entry=${toHex(eid)}`);
  const bytes = new Uint8Array(await r.arrayBuffer());
  const out = [];
  for (let at = 0; at + SIGNED_RECEIPT_BYTES <= bytes.length; at += SIGNED_RECEIPT_BYTES)
    out.push(toHex(decodeCheckpointReceipt(splitSignedReceipt(bytes.subarray(at, at + SIGNED_RECEIPT_BYTES)).body).nodePubkey));
  return out.sort();
}

test('each daemon pulls its peer\'s receipts at the close, and the run is replayed to a result on both', async () => {
  const w = await played();
  try {
    // WHAT THE CLIENT LEFT: each daemon holds only its own receipt.
    assert.deepEqual(await signersOn(w.a, w.rid, w.eid), [toHex(w.a.round.pubkey)]);
    assert.deepEqual(await signersOn(w.b, w.rid, w.eid), [toHex(w.b.round.pubkey)]);
    w.a.verifier.peers = [`http://127.0.0.1:${w.b.port}`];
    w.b.verifier.peers = [`http://127.0.0.1:${w.a.port}`];
    const onA = await closeOn(w.a, w.rid, w.eid);
    const onB = await closeOn(w.b, w.rid, w.eid);
    assert.equal(onA.stored, true, `A: ${onA.why}`);
    assert.equal(onB.stored, true, `B: ${onB.why}`);
    assert.equal(onA.outcome, 'FAILED');
    assert.equal(onB.outcome, onA.outcome);
    const both = [toHex(w.a.round.pubkey), toHex(w.b.round.pubkey)].sort();
    assert.deepEqual(await signersOn(w.a, w.rid, w.eid), both, 'A does not carry B\'s receipt');
    assert.deepEqual(await signersOn(w.b, w.rid, w.eid), both, 'B does not carry A\'s receipt');
  } finally { await w.close(); }
});

test('a peer serving a forged receipt or a stranger\'s adds nothing, and a peer that is down is named and does not stop the other', async () => {
  const w = await played();
  // THE BAD PEER: one record of garbage, one well-signed by a key the round never assigned.
  const stranger = schnorr.utils.randomSecretKey();
  const theirs = { checkpointId: checkpointId(w.mark), receivedAtMs: 1n, nodePubkey: schnorr.getPublicKey(stranger) };
  const strangers = joinSignedReceipt(encodeCheckpointReceipt(theirs), schnorr.sign(receiptId(theirs), stranger));
  const garbage = new Uint8Array(SIGNED_RECEIPT_BYTES).fill(0x33);
  const bad = createServer((req, res) => { res.writeHead(200); res.end(Buffer.concat([garbage, strangers])); });
  await new Promise((r) => bad.listen(0, '127.0.0.1', r));
  const badUrl = `http://127.0.0.1:${bad.address().port}`;
  const downUrl = 'http://127.0.0.1:9';
  try {
    // B HAS ONLY BAD PEERS: nothing it is offered counts, and it stays at one.
    w.b.verifier.peers = [downUrl, badUrl];
    const onB = await closeOn(w.b, w.rid, w.eid);
    assert.equal(onB.stored, false, 'a forged or stranger\'s receipt made a canonical chain');
    assert.match(onB.why, /the first has 1/);
    assert.deepEqual(await signersOn(w.b, w.rid, w.eid), [toHex(w.b.round.pubkey)]);
    const carriedB = w.b.verifier.carried.get(`${toHex(w.rid)}:${toHex(w.eid)}`);
    assert.equal(carriedB.taken, 0);
    assert.equal(carriedB.refused.length, 2, `refused: ${JSON.stringify(carriedB.refused)}`);
    assert.ok(carriedB.down.some((d) => d.startsWith(downUrl)), 'the peer that was down was not named');

    // A HAS THE SAME BAD PEERS AND THE REAL ONE: the real one carries it.
    w.a.verifier.peers = [downUrl, badUrl, `http://127.0.0.1:${w.b.port}`];
    const onA = await closeOn(w.a, w.rid, w.eid);
    assert.equal(onA.stored, true, `A: ${onA.why}`);
    assert.deepEqual(await signersOn(w.a, w.rid, w.eid),
      [toHex(w.a.round.pubkey), toHex(w.b.round.pubkey)].sort(), 'a stranger\'s receipt was stored');
  } finally { bad.close(); await w.close(); }
});

// THE CENSUS'S OWN ADDRESSES, when the operator gave none - the same record
// signer node selection reads, the signed advertisement in each bond.
const HEIGHT = 900000;
const TIP = HEIGHT + 10;
const FROM = HEIGHT - 20;
const advertFor = (key, endpoint) => ({
  nodePubkey: key, operatorId: 'operator', protocolVersions: [1],
  roles: ['game', 'settlement'], endpoint, region: 'eu-west',
  capacityClass: 1, softwareHash: b32(2), settlementCapabilities: 0, lightningCapabilities: 0,
  bondTxid: new Uint8Array(32), bondVout: 0, bondScriptTemplateVersion: 1,
  payoutPubkey: b32(3), guardianOf: [], timestamp: 1788700000000n,
});
const bondOf = (key, n, endpoint) => bondTransaction(advertFor(key, endpoint), {
  previousTxid: b32(0xa0 + n), previousVout: 0, outputKey: bondFor(key),
});
const chainWith = (bonds, contract) => {
  const blocks = [];
  for (let h = FROM; h <= TIP; h++) blocks.push({ transactions: h === FROM ? bonds : [] });
  // AND THE ROUND'S PUBLICATION, well below any beacon (5A.5, v4.6.2): a node
  // signer nodes only a round its own chain shows published before the beacon block.
  if (contract) blocks[1] = { transactions: [publicationOf(contract)] };
  return chainOf(blocks, FROM);
};
const censusContract = (nodes, censusRoot) => ({
  ...contractFor(nodes), censusConfirmations: 6, censusHeight: HEIGHT, censusRoot,
  committeeTimeMs: BigInt(FIRST_TIME + 15 * SPACING) * 1000n,
  startTimeMs: BigInt(FIRST_TIME + 15 * SPACING) * 1000n + 60500n,
  entryCloseMs: BigInt(FIRST_TIME + 15 * SPACING) * 1000n + 200000n,
});

test('with no peers given, a daemon\'s verifier takes the round\'s committee endpoints from the census; a given list still wins', async () => {
  const a = await serve(openStore(':memory:'), { port: 0, ...FUNDED });
  const b = await serve(openStore(':memory:'), { port: 0, ...FUNDED });
  try {
    const keys = [a.round.pubkey, b.round.pubkey];
    const endpoints = [`ws://127.0.0.1:${a.port}`, `ws://127.0.0.1:${b.port}`];
    const bonds = [bondOf(keys[0], 1, endpoints[0]), bondOf(keys[1], 2, endpoints[1])];
    const view = chainWith(bonds);
    const byTxid = new Map();
    for (const block of view.blocks)
      for (const raw of block.transactions) byTxid.set(toHex(parseTransaction(raw).txid), raw);
    const census = deriveCensus(view, {
      contract: decodeRoundContract(encodeRoundContract(censusContract(keys, b32(2)))),
      bond: bondSetFor('regtest'),
      resolve: (e) => { const raw = byTxid.get(toHex(e.txid)); return raw ? { transaction: raw } : null; },
    });
    assert.equal(census.ok, true, census.why);
    const c = censusContract(keys, census.root);
    const published = chainWith(bonds, c);
    const beacon = (() => {
      const named = beaconFromChain(c, { headers: published.blocks.map((x) => x.header), firstHeight: published.firstHeight });
      return { hash: named.hash, height: named.height, timeMs: named.timeMs };
    })();
    // A, re-served on its own store with the chain this round's census is in:
    // the committee is A and B, so A's peers are B's endpoint and never its own.
    const storeA = a.round.db;
    await a.close();
    const again = await serve(storeA, { port: a.port, ...FUNDED, chainFor: () => published, randomnessFor: () => beacon });
    try {
      const rid = again.round.open(c);
      const roster = new Roster(again.round, { chainFor: () => published, randomnessFor: () => beacon });
      const assigned = roster.assignSignerNodes(rid);
      assert.equal(assigned.ok, true, assigned.why);
      assert.equal(typeof again.verifier.peersOf, 'function', 'the verifier has no per-round peer list');
      assert.deepEqual(again.verifier.peersOf(rid), [`http://127.0.0.1:${b.port}`],
        'the verifier did not take the other signer node\'s endpoint from the census');
      again.verifier.peers = ['http://operator-given:1'];
      assert.deepEqual(again.verifier.peersOf(rid), ['http://operator-given:1'], 'a given peers list was replaced');
    } finally { await again.close(); }
  } finally { await b.close(); }
});
