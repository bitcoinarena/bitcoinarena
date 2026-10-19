// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A LATE JOINER RESUMES WHERE THEIR ENTRY SAYS THEY JOINED, NOT AT TICK ZERO.
//
// 0.8: "Late join is a normal feature, not merely reconnect." Section 7: "Late
// joins simply add more Entry Contracts. The Round Contract is never
// rewritten."
//
// Measured before this file existed: `resume` set `nextTick = last ?
// batchTicks(last).at(-1) + 1 : 0`. That `: 0` is the reconnect of a player
// who joined at tick 50 and had not published anything yet - a page reload
// between joining and the first batch - and it resumed numbering from zero.
// Every batch after that would carry the inputs of one tick under the number
// of another, and the node would refuse them with "expected tick 50, got 0"
// while the page looked healthy.
//
// The entry is FETCHED AND THEN HASHED rather than taken on the node's word:
// an entry id is the hash of its bytes, so a node that returns somebody else's
// entry, or the same one with a friendlier join tick, does not hash to what
// was asked for.
// A FREE ROUND (RULED 2026-09-25): nothing this file asserts depends on the stake, and a paying round opens only
// on a signer node that reaches a federation now.
import { TEST_FEDERATION_ID } from '../../arena-protocol/src/test-federation.js';
import { TRUCK_CORE_HASH, TRUCK_V3_CONFIG_HASH } from '../../nextblock/plugin/nextblock.js';
import { test } from 'node:test';
// The run length is the core's; a literal 9000 is refused by the node as a contract
// disagreeing with the network it names (WAR_TACTICS moved a run to 10800).
import { BLOCK_TICKS } from '../../nextblock/src/rules/gate.js';
import { TEST_DONATION_SET_REGTEST } from '../../arena-protocol/src/test-donation-sets.js';
import { donationSetId as idOfDonationSet } from '../../arena-protocol/src/donation.js';
import assert from 'node:assert/strict';
import { openStore } from '../../arena-node/src/store.js';
import { serve } from '../../arena-node/src/server.js';
import { Client } from '../src/client.js';
import * as core from '../../nextblock/src/index.js';
import { roundId, entryId } from '../../arena-protocol/src/contracts.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { ed25519 } from '@noble/curves/ed25519.js';
import { schnorr } from '@noble/curves/secp256k1.js';
import { createServer } from 'node:http';
import { encodeEntryContract, encodeRoundContract } from '../../arena-protocol/src/contracts.js';
import { encodeTranscript, GENESIS } from '../../arena-protocol/src/transcript.js';
import { batchId } from '../../arena-protocol/src/batch.js';

// The node fee is 27A.7's 2% of the stake, and the door checks it now
// (M3.3 item 20) - so a fixture carries the RULE rather than a number.
import { entryFeeMsat } from '../../arena-protocol/src/fee.js';
import { HOSTED } from '../../arena-node/test/plugins/hosted.js';
import { NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';
const b32 = (n) => new Uint8Array(32).fill(n);
const secret = b32(0x11);
const sessionPubkey = schnorr.getPublicKey(secret);
const sign = async (m) => ed25519.sign(m, secret);
const verify = async (sig, m, pk) => ed25519.verify(sig, m, pk);
const FUNDED = { funded: () => true };

const contract = () => ({
  networkId: b32(0x4e), configHash: TRUCK_V3_CONFIG_HASH, censusConfirmations: 6,
  gameVerifySlots: 7, settlementSlots: 7, gameId: NEXTBLOCK_GAME_ID, simCoreHash: TRUCK_CORE_HASH,
  startTimeMs: 60500n, entryCloseMs: 2000n, objectionWindowMs: 600000n,
  custody: 'FEDERATION', slashMinimumServed: 20, slashRemainder: 'SPLIT', federationId: TEST_FEDERATION_ID, stakeExpiryBlocks: 144, publicationRelays: ['wss://r.example'],
  donationSetId: idOfDonationSet(TEST_DONATION_SET_REGTEST.recipients), censusHeight: 900000, censusRoot: b32(2),
  committeeTimeMs: 500n, randomnessRule: 'bitcoin-block-hash', stakeMsat: 0n, bondMinSats: 50000n, blockTicks: BLOCK_TICKS,
  exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20,
  timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4,
  nodes: [b32(4)],
});
const entryFor = (rid, joinTick) => ({
  roundId: rid, playerPubkey: b32(5), sessionPubkey,
  stakeCommitment: b32(7), stakeMsat: 0n, feeMsat: 0n, donationMsat: 0n, joinTick,
  // The world secret the entry carries so a node can derive the world it
  // replays (the owner, e942580). Nothing in this file uses it - a late join is
  // about which TICK a run starts at - but an entry without one no longer
  // encodes, and an entry that does not encode has no id to be late with.
  worldSecret: b32(0x5c), vssSharesRef: new Uint8Array(32), stakePoint: new Uint8Array(33), feePreimage: new Uint8Array(32), stakeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, feeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, claimKeyAttestationRef: new Uint8Array(32),
});

async function joinedAt(joinTick) {
  const node = await serve(openStore(), { plugins: HOSTED, port: 0, ...FUNDED });
  const client = new Client({ base: `http://127.0.0.1:${node.port}`, core, sign, verify });
  const c = { ...contract(), nodes: [node.round.pubkey] };
  const rid = await client.openRound(c);
  const e = entryFor(rid, joinTick);
  const eid = await client.join(e);
  return { node, client, rid, eid, entry: e };
}

/**
 * THE RECONNECT BEFORE THE FIRST BATCH. Nothing has been published, so the
 * node returns an empty transcript - and the run still begins at fifty.
 */
test('a player who joined at tick 50 resumes at 50, not at 0', async () => {
  const { node, rid, eid } = await joinedAt(50);
  try {
    const back = new Client({ base: `http://127.0.0.1:${node.port}`, core, sign, verify });
    back.nodes = [node.round.pubkey];
    assert.equal(back.nextTick, 0, 'a fresh client knows nothing about the round');

    const got = await back.resume({ roundId: rid, entryId: eid });
    assert.equal(got.batches, 0, 'the fixture published something after all');
    assert.equal(back.nextTick, 50,
      'the run resumed at tick 0, so every batch after this carries the wrong number');
    assert.equal(got.nextTick, 50);
  } finally { await node.close(); }
});

/**
 * AND A PLAYER WHO JOINED AT ZERO STILL RESUMES AT ZERO, so the fix is reading
 * the entry rather than adding a constant.
 */
test('a player who joined at tick 0 resumes at 0', async () => {
  const { node, rid, eid } = await joinedAt(0);
  try {
    const back = new Client({ base: `http://127.0.0.1:${node.port}`, core, sign, verify });
    back.nodes = [node.round.pubkey];

    await back.resume({ roundId: rid, entryId: eid });
    assert.equal(back.nextTick, 0);
  } finally { await node.close(); }
});

/**
 * THE ENTRY IS CHECKED, NOT BELIEVED. Its id is the hash of its bytes, so a
 * node that answers with another entry is caught by arithmetic rather than by
 * trust - 25.1's rule for chain providers, applied to this one: a node may
 * omit, and it may not forge.
 */
test('an entry the node returns is hashed against the id that was asked for', async () => {
  const { node, rid, eid, client } = await joinedAt(50);
  try {
    // a second entry exists on this node, and asking for one id must not be
    // answerable with the other
    const other = entryFor(rid, 7);
    other.playerPubkey = b32(0x55);
    const otherId = await client.join(other);
    assert.notEqual(toHex(otherId), toHex(eid));

    const back = new Client({ base: `http://127.0.0.1:${node.port}`, core, sign, verify });
    const mine = await back.entryFor(eid);
    assert.equal(mine.joinTick, 50);
    assert.equal(toHex(entryId(mine)), toHex(eid));

    const theirs = await back.entryFor(otherId);
    assert.equal(theirs.joinTick, 7, 'the node answered with the wrong entry');

    // and an id nobody entered is a refusal, not a default
    await assert.rejects(() => back.entryFor(b32(0x99)), /has no entry/);
  } finally { await node.close(); }
});

/**
 * AND THE ROUND CONTRACT IS NEVER REWRITTEN BY A LATE JOIN. Section 7 says so;
 * this measures it, because "more Entry Contracts only" is the whole shape of
 * late join and a round whose id moved would be a different round.
 */
test('a late entry adds an Entry Contract and leaves the round id alone', async () => {
  const { node, client, rid } = await joinedAt(0);
  try {
    const c = { ...contract(), nodes: [node.round.pubkey] };
    assert.equal(toHex(rid), toHex(roundId(c)), 'the round did not hash to its own contract');

    const late = entryFor(rid, 900);
    late.playerPubkey = b32(0x66);
    const lateId = await client.join(late);

    assert.equal(toHex(rid), toHex(roundId(c)),
      'a late join rewrote the round contract');
    assert.equal(toHex(lateId), toHex(entryId(late)));
    assert.equal((await client.entryFor(lateId)).joinTick, 900);
  } finally { await node.close(); }
});

/**
 * A NODE THAT LIES, because an honest one cannot produce the answers these
 * two guards exist for.
 *
 * 25.1's rule for chain providers is the rule here too: a provider may OMIT
 * and may not FORGE. The real node enforces the start tick on the way in -
 * `round.batch` refuses "expected tick 50, got 0" - so it can never serve a
 * transcript that begins at the wrong tick, and it always returns the entry it
 * was asked for. Testing the client's own checks against it measures nothing.
 */
const liar = (answers) => new Promise((resolve) => {
  const http = createServer((req, res) => {
    const path = req.url.split('?')[0];
    const body = answers[path];
    if (!body) { res.writeHead(404); return res.end('no'); }
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    res.end(Buffer.from(body));
  });
  http.listen(0, '127.0.0.1', () => resolve({
    base: `http://127.0.0.1:${http.address().port}`,
    close: () => new Promise((r) => http.close(r)),
  }));
});

test('an entry that does not hash to the id asked for is refused', async () => {
  const rid = b32(1);
  const mine = entryFor(rid, 50);
  const theirs = { ...entryFor(rid, 0), playerPubkey: b32(0x55) };

  // the node answers every /entry with SOMEBODY ELSE'S contract
  const node = await liar({ '/entry': encodeEntryContract(theirs) });
  try {
    const client = new Client({ base: node.base, core, sign, verify });
    await assert.rejects(() => client.entryFor(entryId(mine)),
      /is not the contract this player signed/,
      'the client took a node\'s word for which entry it had signed');

    // and asking for the one it DID return is fine, so this is a comparison
    // and not a blanket refusal
    const back = await client.entryFor(entryId(theirs));
    assert.equal(back.joinTick, 0);
  } finally { await node.close(); }
});

test('a transcript that does not begin at the entry\'s join tick is refused on resume', async () => {
  // A REAL ROUND, served by the stub too (M3 R1 R3): resume reads a run's length off the round it
  // fetches and hashes, as it does the entry. Before, rid was b32(1), no round's hash - and resume,
  // asking for the round, stopped at "the node has no round" before the check this test is about.
  const round = contract();
  const rid = roundId(round);
  const entry = entryFor(rid, 50);
  const eid = entryId(entry);

  // a real chain, correctly formed, that simply begins at tick 0 - which
  // `checkTranscript` accepts, because it IS a chain
  const first = {
    roundId: rid, entryId: eid, previousHash: GENESIS, firstTick: 0,
    ticks: [[65536, 0, 0, 0, 0], [65536, 1, 0, 0, 0]], liquidations: [],
  };
  const early = { roundId: rid, entryId: eid, batches: [first] };

  const node = await liar({
    '/transcript': encodeTranscript(early),
    '/entry': encodeEntryContract(entry),
    '/round': encodeRoundContract(round),
  });
  try {
    const client = new Client({ base: node.base, core, sign, verify });
    await assert.rejects(() => client.resume({ roundId: rid, entryId: eid }),
      /is not this entry's run: that transcript begins at tick 0 and that entry joined at 50/,
      'a run that began before the player joined was resumed');
  } finally { await node.close(); }

  // The control for this one is the first test in this file, against the REAL
  // node: a player who joined at 50 resumes at 50. It is not repeated against
  // the stub, because `resume` goes on to recover receipts and a stub that
  // answered those would be a second node rather than a lying one.
});

test('a series round taking entries for hours is no late join: offered until its own entry close (2026-10-14: Tick Tock "join until 0:00")', async () => {
  const { isLateJoinRound, entryOpenUntilMs, lateJoinTick, LATE_JOIN_WINDOW_MS } = await import('../src/late-join.js');
  assert.equal(LATE_JOIN_WINDOW_MS, (await import('../../arena-protocol/src/series.js')).LATE_JOIN_MS, 'the page\'s late-join window is the series\'');
  const start = 1791949075500n;
  const sixHours = { seriesId: new Uint8Array(32).fill(3), startTimeMs: start, entryCloseMs: start + 6n * 3600000n };
  assert.equal(isLateJoinRound(sixHours), false);
  assert.equal(entryOpenUntilMs(sixHours), Number(start + 6n * 3600000n), 'offered until its entry close, as the seats take it');
  assert.equal(lateJoinTick(sixHours, Number(start) + 3600000).joinTick, 0);
  const ninety = { seriesId: new Uint8Array(32).fill(3), startTimeMs: start, entryCloseMs: start + 45000n };
  assert.equal(isLateJoinRound(ninety), true, 'a 45 s window is the late join');
  assert.equal(entryOpenUntilMs(ninety), Number(start) + 37000 - 5000);
});
