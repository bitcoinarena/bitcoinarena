// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// KANBAN #2410 (feedback #014 by Hexbox Tools): a bypass of #1567. A resume took every served batch the player had
// signed - but never checked the served chain was as long as what this client had already published. A home seat that
// cut its own store back to a prefix of the player's batches (each still the player's, each verifying) refused the next
// batch (chain head); the resume adopted the prefix, rewound nextTick/batchHead and the client signed a second batch on
// a previousHash it had already built on - an equivocation the honest peers, holding the longer chain, refuse forever.
// A reloaded client (published = []) adopted the same prefix. Now a served chain that does not carry every batch this
// client published (in memory), or that a committee peer shows is shorter than one the player signed (after a reload),
// is that seat's fault: nodeFault, the run ends there, nothing is signed again on an old head.
//
// The rig is #1567's (resume-forged-1567.test.js): A seat takes a batch only signed by the entry's session
// key - but `resume` signed every batch past `published` that the home seat's GET /transcript served and fed it to every
// peer, never checking that this client recorded it. So one malicious home seat appended a bare forged batch to its own
// store, refused the player's next batch (chain head), and the player's OWN client signed the forgery into the committee;
// a reloaded client (published = []) signed the whole served transcript. Measured on f64efd1bb: the honest peer B stored
// 120 forged ticks as the player's (refusal) and 90 (reload).
//
// Now a resume re-publishes only frames this client signed itself: kept in memory as they are signed, and after a reload
// the seats' own copies of each batch's signature (GET /batch-signatures), each verified under the entry's session key.
// A served batch it cannot show is its own is that seat's fault - nothing of it is signed, nothing goes to a peer.
import { TEST_FEDERATION_ID } from '../../arena-protocol/src/test-federation.js';
import { TRUCK_CORE_HASH, TRUCK_V3_CONFIG_HASH, NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';
import { BLOCK_TICKS } from '../../nextblock/src/rules/gate.js';
import { TEST_DONATION_SET_REGTEST } from '../../arena-protocol/src/test-donation-sets.js';
import { donationSetId as idOfDonationSet } from '../../arena-protocol/src/donation.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { ed25519 } from '@noble/curves/ed25519.js';
import { schnorr } from '@noble/curves/secp256k1.js';

import { openStore } from '../../arena-node/src/store.js';
import { serve } from '../../arena-node/src/server.js';
import { Client } from '../src/client.js';
import { batchId, decodeInputBatch, batchTicks, splitSignedBatch } from '../../arena-protocol/src/batch.js';
import { entryId as entryIdOf, encodeRoundContract } from '../../arena-protocol/src/contracts.js';
import { MIN_ENTRY_WINDOW_MS } from '../../arena-protocol/src/constants.js';
import { NETWORK_ID_REGTEST } from '../../arena-protocol/src/genesis-ids.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { assumeStakeSeen } from '../../arena-node/test/assignment.js';
import { HOSTED } from '../../arena-node/test/plugins/hosted.js';

const require = createRequire(import.meta.url);
const core = require('../../nextblock/dist/blwp-core.js');
const b32 = (n) => new Uint8Array(32).fill(n);
const verify = (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const FUNDED = { funded: () => true, randomnessFor: () => ({ hash: b32(0xbe), height: 900005, timeMs: 900n }) };
const HONEST = [45875, 22000, 0, 0, 0];

async function rig() {
  const a = await serve(openStore(':memory:'), { plugins: HOSTED, port: 0, ...FUNDED });   // the home seat - malicious
  const b = await serve(openStore(':memory:'), { plugins: HOSTED, port: 0, ...FUNDED });   // an honest peer
  const session = ed25519.utils.randomSecretKey();
  const sign = (id) => ed25519.sign(id, session);
  const contract = {
    networkId: NETWORK_ID_REGTEST, configHash: TRUCK_V3_CONFIG_HASH, censusConfirmations: 6,
    gameVerifySlots: 2, settlementSlots: 2, gameId: NEXTBLOCK_GAME_ID, simCoreHash: TRUCK_CORE_HASH,
    committeeTimeMs: 500n, randomnessRule: 'bitcoin-block-hash',
    startTimeMs: 500n + MIN_ENTRY_WINDOW_MS, entryCloseMs: 200000n,
    objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20,
    slashRemainder: 'SPLIT', federationId: TEST_FEDERATION_ID, stakeExpiryBlocks: 144, publicationRelays: ['wss://r.example'], donationSetId: idOfDonationSet(TEST_DONATION_SET_REGTEST.recipients), censusHeight: 900000,
    censusRoot: b32(2), stakeMsat: 0n, bondMinSats: 50000n, blockTicks: BLOCK_TICKS,
    exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20,
    timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4,
    nodes: [a.round.pubkey, b.round.pubkey],
  };
  const open = async () => {
    const client = new Client({ base: `http://127.0.0.1:${a.port}`, core, sign, verify });
    client.deliverTo([`http://127.0.0.1:${b.port}`]);
    const rid = await client.openRound(contract);
    // the peer holds the round too (a page opens it at every committee node through the lobby; here by hand)
    const r = await fetch(`http://127.0.0.1:${b.port}/round`, { method: 'POST', body: encodeRoundContract(contract) });
    assert.ok(r.status === 201 || r.status === 200, `the peer took the round (${r.status})`);
    return { client, rid };
  };
  const { client, rid } = await open();
  const entry = {
    roundId: rid, playerPubkey: b32(5), sessionPubkey: ed25519.getPublicKey(session),
    stakeCommitment: b32(7), stakeMsat: 0n, feeMsat: 0n, donationMsat: 0n,
    joinTick: 0, worldSecret: b32(0x5e), vssSharesRef: new Uint8Array(32), stakePoint: new Uint8Array(33), feePreimage: new Uint8Array(32), stakeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, feeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, claimKeyAttestationRef: new Uint8Array(32),
  };
  const eid = await client.join(entry);
  assert.deepEqual(eid, entryIdOf(entry));
  for (const n of [a, b]) { assert.ok(n.round.entry(eid), 'both seats hold the entry'); assumeStakeSeen(n.round, entry); }
  await client.connect();
  client.setRound({ roundId: rid, entryId: eid, blockTicks: contract.blockTicks });
  return { a, b, client, rid, eid, entry, open, contract };
}

/** Records `n` honest ticks and lets every publish go out. */
// EVERY RECORDED TICK ITS OWN WORDS, so a batch re-signed at an older tick is a different batch, not a coincident copy
let recorded = 0;
async function drive(client, n) {
  for (let i = 0; i < n; i++) client.record([HONEST[0], HONEST[1] + (recorded++ % 4096), 0, 0, 0]);
  for (let i = 0; i < 60; i++) {
    const p = client.drain();
    if (p) { try { await p; } catch { /* the refusal is the measurement */ } }
    if (client.recovering) { try { await client.recovering; } catch { /* named on the client */ } }
    await wait(3);
    if ((!client.hold.length && !client.publishing) || client.ended) break;
  }
}
const ticksAt = (node, rid, eid) => node.round.transcript(rid, eid).ticks;
async function settle(client, node, rid, eid, want) {
  for (let i = 0; i < 100; i++) {
    client.pumpPeers();
    await wait(20);
    if (ticksAt(node, rid, eid).length >= want) return;
  }
}
/** The malicious home seat cuts its own store back to its first `keep` batches - every one of them still the player's. */
function truncate(a, rid, eid, keep) {
  const rows = a.round.db.prepare('SELECT seq, bytes FROM batches WHERE round_id = ? AND entry_id = ? ORDER BY seq').all(rid, eid);
  assert.ok(rows.length > keep, `the seat holds ${rows.length} batches, more than the ${keep} it keeps`);
  const last = rows[keep - 1];
  const through = batchTicks(decodeInputBatch(new Uint8Array(last.bytes))).at(-1);
  a.round.db.prepare('DELETE FROM batches WHERE round_id = ? AND entry_id = ? AND seq > ?').run(rid, eid, last.seq);
  a.round.db.prepare('DELETE FROM ticks WHERE round_id = ? AND entry_id = ? AND tick > ?').run(rid, eid, through);
  return through + 1;
}
/** Two frames this client signed on one previousHash: an equivocation the honest committee refuses forever. */
function forks(frames) {
  const byParent = new Map();
  for (const bytes of frames) {
    const b = decodeInputBatch(splitSignedBatch(bytes).body);
    const k = toHex(b.previousHash);
    byParent.set(k, (byParent.get(k) || new Set()).add(toHex(batchId(b))));
  }
  return [...byParent.values()].filter((s) => s.size > 1).length;
}

test('#2410 refusal path: a home seat that cut its chain back to a prefix of the player\'s own batches is a node fault, not a rewind', async () => {
  const { a, b, client, rid, eid } = await rig();
  try {
    await drive(client, 30);
    await drive(client, 30);
    await settle(client, b, rid, eid, 60);
    assert.equal(ticksAt(b, rid, eid).length, 60, 'the honest peer holds the player\'s first 60 ticks');
    assert.ok(client.published.length >= 2, `the client published ${client.published.length} batches`);

    const cut = truncate(a, rid, eid, 1);     // A now serves only the player's first batch; the next batch is refused there
    await drive(client, 30);
    await settle(client, b, rid, eid, 1e9);

    assert.equal(forks(client.signedFrames.values()), 0, 'the client never signs a second batch on a head it already built on');
    assert.ok(client.nextTick >= 60, `the client did not rewind to tick ${client.nextTick} (the seat cut to ${cut})`);
    assert.ok(client.nodeFault, 'the home seat is named at fault');
    assert.match(client.nodeFault.why, /shorter|published/);
    assert.equal(client.ended, true, 'the run does not go on through a seat that dropped the player\'s inputs');
    assert.ok(ticksAt(b, rid, eid).length >= 60, 'and the honest peer keeps what the player published');
  } finally { client.close(); await a.close(); await b.close(); }
});

test('#2410 reload path: a reloaded client does not adopt a prefix a committee peer shows is shorter than the player\'s own chain', async () => {
  const { a, b, client, rid, eid, open } = await rig();
  let back = null;
  try {
    await drive(client, 30);
    await drive(client, 30);
    await settle(client, b, rid, eid, 60);
    client.close();

    truncate(a, rid, eid, 1);
    ({ client: back } = await open());
    let threw = null;
    try { await back.resumeAfterReload({ roundId: rid, entryId: eid, blockTicks: BLOCK_TICKS }); }
    catch (e) { threw = e; }
    assert.ok(threw, `the reload does not resume onto the cut chain (it resumed at tick ${back.nextTick})`);
    assert.ok(back.nodeFault, 'the home seat is named at fault');
    assert.match(back.nodeFault.why, /shorter|published/);
    assert.equal(back.ended, true);
  } finally { if (back) back.close(); client.close(); await a.close(); await b.close(); }
});

test('#2410 honest: a lost answer and a reload over a whole chain still resume (a peer behind the home seat is no fault)', async () => {
  const { a, b, client, rid, eid, open } = await rig();
  let back = null;
  try {
    await drive(client, 30);
    await drive(client, 30);
    await settle(client, b, rid, eid, 60);
    // the peer lags one batch behind: it is the home seat that is ahead, which is the normal order
    client.deliverTo([]);
    await drive(client, 30);
    client.close();

    ({ client: back } = await open());
    const got = await back.resumeAfterReload({ roundId: rid, entryId: eid, blockTicks: BLOCK_TICKS });
    assert.equal(got.nextTick, 90);
    assert.equal(back.nodeFault, null);
    await back.connect();
    await drive(back, 30);
    await settle(back, b, rid, eid, 120);
    assert.equal(back.ended, false, `the run goes on after an honest reload (${back.endingReason})`);
    assert.equal(ticksAt(a, rid, eid).length, 120);
    assert.equal(ticksAt(b, rid, eid).length, 120, 'and the peer catches up');
  } finally { if (back) back.close(); client.close(); await a.close(); await b.close(); }
});
