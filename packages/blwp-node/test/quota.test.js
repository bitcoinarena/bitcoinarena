// DISK IS SPENT ONLY ON STAKES THAT EXIST.
//
// IMPLEMENTATION.md calls this the main anti-DoS lever: "A funded entry is
// required before the node stores one byte of transcript." Measured before it
// existed - a stranger who had funded nothing opened 200 rounds, the node
// answered 201 to every one and wrote 200 rows, and then took an entry in one
// of them for nothing as well.
//
// The node cannot decide funding by itself: a stake is a hold invoice and
// there is no payment layer here. So it refuses until something it trusts says
// otherwise, and the default is no - a daemon that assumed funding would be
// the flood lever rather than the guard against it.
import { TRUCK_CORE_HASH, TRUCK_CONFIG_HASH } from '../src/cores.js';
import { BLOCK_TICKS } from '../../core/src/rules/gate.js';
import { test } from 'node:test';
import { TEST_DONATION_SET_REGTEST } from '../../protocol/src/test-donation-sets.js';
import { donationSetId as idOfDonationSet } from '../../protocol/src/donation.js';
import assert from 'node:assert/strict';
import { mkdtempSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ed25519 } from '@noble/curves/ed25519.js';
import { schnorr } from '@noble/curves/secp256k1.js';

import { openStore } from '../src/store.js';
import { serve, NOTHING_IS_FUNDED } from '../src/server.js';
import { encodeRoundContract, roundId, encodeEntryContract, entryId } from '../../protocol/src/contracts.js';
import { encodeInputBatch } from '../../protocol/src/batch.js';
import { GENESIS } from '../../protocol/src/transcript.js';
import { toHex } from '../../protocol/src/hash.js';

// The node fee is 27A.7's 2% of the stake, and the door checks it now
// (M3.3 item 20) - so a fixture carries the RULE rather than a number.
import { entryFeeMsat } from '../../protocol/src/fee.js';
const b32 = (n) => new Uint8Array(32).fill(n);
const key = ed25519.utils.randomSecretKey();
const contract = (n = 1) => ({
  networkId: b32(0x4e), configHash: TRUCK_CONFIG_HASH, censusConfirmations: 6, gameVerifySlots: 7, settlementSlots: 7, simCoreHash: TRUCK_CORE_HASH, startTimeMs: 60500n, entryCloseMs: 2000n, objectionWindowMs: 600000n, custody: 'THRESHOLD_LN', slashMinimumServed: 20 + n, slashRemainder: 'SPLIT', federationId: new Uint8Array(32), stakeExpiryBlocks: 144, publicationRelays: [], donationSetId: idOfDonationSet(TEST_DONATION_SET_REGTEST.recipients), censusHeight: 900000,
  censusRoot: b32(2), committeeTimeMs: 500n, randomnessRule: 'bitcoin-block-hash', stakeMsat: 100000n, bondMinSats: 50000n,
  blockTicks: BLOCK_TICKS, exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20,
  timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4,
  nodes: [b32(4)],
});
const entryFor = (rid) => ({
  roundId: rid, playerPubkey: b32(5), sessionPubkey: schnorr.getPublicKey(key),
  stakeCommitment: b32(7), stakeMsat: 100000n, feeMsat: entryFeeMsat(100000n), donationMsat: 0n, joinTick: 0, worldSecret: b32(0x5e), vssSharesRef: new Uint8Array(32), stakePoint: new Uint8Array(33), feePreimage: new Uint8Array(32), stakeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, feeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, claimKeyAttestationRef: new Uint8Array(32),
});

/** A node on a real file, so "bytes on disk" is a measurement and not a figure of speech. */
async function onDisk(funded) {
  const path = join(mkdtempSync(join(tmpdir(), 'blwp-')), 'node.db');
  const db = openStore(path);
  const node = await serve(db, { port: 0, funded });
  node.base = `http://127.0.0.1:${node.port}`;
  node.path = path;
  // The file quantises to a 4 KB page, so the pages are counted too - a page
  // count moves where a stat does not, and it is what the disk actually costs.
  node.bytes = () => {
    const page = db.prepare('PRAGMA page_size').get().page_size;
    const count = db.prepare('PRAGMA page_count').get().page_count;
    return { file: statSync(path).size, pages: count * page };
  };
  node.rows = (t) => db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n;
  return node;
}
const post = (base, door, body) => fetch(`${base}/${door}`, { method: 'POST', body });

test('an unfunded open is refused and writes nothing at all', async () => {
  const node = await onDisk(NOTHING_IS_FUNDED);
  try {
    const before = node.bytes();

    // a stranger opening rounds by the hundred, having funded nothing
    let seen = new Set();
    for (let i = 0; i < 200; i++) {
      const r = await post(node.base, 'round', encodeRoundContract(contract(i)));
      seen.add(r.status);
    }
    assert.deepEqual([...seen], [402], 'an unfunded open must be refused, and by one answer');

    const after = node.bytes();
    assert.equal(node.rows('rounds'), 0, 'a round was stored for somebody who paid nothing');
    assert.equal(after.pages, before.pages, 'the node spent pages on an unfunded stranger');
    assert.equal(after.file, before.file, 'and the file grew');

    // and the entry door is shut the same way
    const e = entryFor(roundId(contract(0)));
    const j = await post(node.base, 'entry', encodeEntryContract(e));
    assert.equal(j.status, 402);
    assert.match((await j.text()).trim(), /nobody has funded/);
    assert.equal(node.rows('entries'), 0);

    // there is no round to fetch and no transcript to serve
    const g = await fetch(`${node.base}/round?id=${toHex(roundId(contract(0)))}`);
    assert.equal(g.status, 404, 'a round nobody funded must not be there to read');
  } finally { await node.close(); }
});

test('a funded open is accepted, and only then does the node write', async () => {
  const node = await onDisk(() => true);
  try {
    const before = node.bytes();
    const c = contract(1);
    const opened = await post(node.base, 'round', encodeRoundContract(c));
    assert.equal(opened.status, 201);
    assert.deepEqual(new Uint8Array(await opened.arrayBuffer()), roundId(c));
    assert.equal(node.rows('rounds'), 1);

    const e = entryFor(roundId(c));
    const joined = await post(node.base, 'entry', encodeEntryContract(e));
    assert.equal(joined.status, 201);
    assert.deepEqual(new Uint8Array(await joined.arrayBuffer()), entryId(e));
    assert.equal(node.rows('entries'), 1);

    const after = node.bytes();
    assert.ok(after.pages >= before.pages, 'a funded round must actually be stored');
    assert.equal(node.rows('rounds'), 1);
  } finally { await node.close(); }
});

/**
 * AND THE TAPE IS SHUT TOO. The socket doors need the round and the entry to
 * exist, so refusing at the two HTTP doors closes them by construction - but
 * that is exactly the sort of thing that is true until somebody adds a door,
 * so it is measured rather than reasoned about.
 */
test('with nothing funded there is nowhere to send a tape or a mark', async () => {
  const node = await onDisk(NOTHING_IS_FUNDED);
  try {
    const c = contract(1);
    const rid = roundId(c), eid = entryId(entryFor(rid));
    await post(node.base, 'round', encodeRoundContract(c));

    const sock = new WebSocket(`ws://127.0.0.1:${node.port}/play`);
    sock.binaryType = 'arraybuffer';
    await new Promise((r) => sock.addEventListener('open', r));
    const said = [];
    sock.addEventListener('message', (e) => {
      const w = said.shift();
      if (w) w(typeof e.data === 'string' ? e.data : new Uint8Array(e.data));
    });
    const say = (m) => new Promise((r) => { said.push(r); sock.send(m); });

    const answer = await say(encodeInputBatch({
      roundId: rid, entryId: eid, previousHash: GENESIS, firstTick: 0,
      ticks: [[65536, 0, 0, 0, 0]], liquidations: [],
    }));
    assert.match(String(answer), /^error /, `a tape was taken for an unfunded round: ${answer}`);
    assert.equal(node.rows('batches'), 0);
    assert.equal(node.rows('checkpoints'), 0);
    assert.equal(node.rows('receipts'), 0);
    sock.close();
  } finally { await node.close(); }
});

/**
 * AND THE DEFAULT IS NO. A daemon started without being told who pays refuses
 * everything, because the alternative - assuming funding - makes the node the
 * flood lever rather than the guard.
 */
test('a node told nothing about funding refuses everything', async () => {
  const node = await onDisk(undefined);
  try {
    const r = await post(node.base, 'round', encodeRoundContract(contract(1)));
    assert.equal(r.status, 402, 'the default must be no');
    assert.equal(node.rows('rounds'), 0);
  } finally { await node.close(); }
});
