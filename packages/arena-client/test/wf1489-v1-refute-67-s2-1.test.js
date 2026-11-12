// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// KANBAN #1489 skeptic 2 on #1503 (feedback #012): batches are taken only signed by the entry's session key - but the
// client's resume (a dropped socket, or a page reload) re-signs EVERY batch the home seat's /transcript serves beyond what
// it published itself, and feeds those signed frames to every peer. So ONE SEAT - the player's home seat - writes a forged
// batch (ticks and a load the player never made) into its own store, waits for the player's reconnect or reload, and the
// player's own client signs that batch and carries it to the honest seats. The forged ticks land at a seat that never
// trusted the home seat, exactly the effect #1503 closed for a stranger.
import { TEST_FEDERATION_ID } from '../../arena-protocol/src/test-federation.js';
import { TRUCK_CORE_HASH, TRUCK_V3_CONFIG_HASH, NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';
import { BLOCK_TICKS } from '../../nextblock/src/rules/gate.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { TEST_DONATION_SET_REGTEST } from '../../arena-protocol/src/test-donation-sets.js';
import { donationSetId as idOfDonationSet } from '../../arena-protocol/src/donation.js';
import { openStore } from '../../arena-node/src/store.js';
import { serve } from '../../arena-node/src/server.js';
import { encodeRoundContract, encodeEntryContract } from '../../arena-protocol/src/contracts.js';
import { encodeInputBatch, batchId, signedBatchOf } from '../../arena-protocol/src/batch.js';
import { ed25519 } from '@noble/curves/ed25519.js';
import { schnorr } from '@noble/curves/secp256k1.js';
import { GENESIS } from '../../arena-protocol/src/transcript.js';
import { assumeStakeSeen } from '../../arena-node/test/assignment.js';
import { HOSTED } from '../../arena-node/test/plugins/hosted.js';
import { Client } from '../src/client.js';

const require = createRequire(import.meta.url);
const core = require('../../nextblock/dist/blwp-core.js');
const verify = (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } };
const b32 = (n) => new Uint8Array(32).fill(n);
const contract = () => ({
  networkId: b32(0x4e), configHash: TRUCK_V3_CONFIG_HASH, censusConfirmations: 6, gameVerifySlots: 7, settlementSlots: 7, gameId: NEXTBLOCK_GAME_ID, simCoreHash: TRUCK_CORE_HASH, startTimeMs: 60500n, entryCloseMs: 2000n, objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20, slashRemainder: 'SPLIT', federationId: TEST_FEDERATION_ID, stakeExpiryBlocks: 144, publicationRelays: ['wss://r.example'], donationSetId: idOfDonationSet(TEST_DONATION_SET_REGTEST.recipients),
  censusHeight: 900000, censusRoot: b32(2), committeeTimeMs: 500n, randomnessRule: 'bitcoin-block-hash',
  stakeMsat: 0n, bondMinSats: 50000n, blockTicks: BLOCK_TICKS,
  exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20,
  timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4,
  nodes: [b32(4)],
});
const entryFor = (rid, sessionPubkey) => ({
  roundId: rid, playerPubkey: b32(5), sessionPubkey,
  stakeCommitment: b32(7), stakeMsat: 0n, feeMsat: 0n, donationMsat: 0n, joinTick: 0, worldSecret: b32(0x5e), vssSharesRef: new Uint8Array(32), stakePoint: new Uint8Array(33), feePreimage: new Uint8Array(32), stakeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, feeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, claimKeyAttestationRef: new Uint8Array(32),
});
const post = async (port, path, body) => {
  const r = await fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', body });
  return { status: r.status, bytes: new Uint8Array(await r.arrayBuffer()) };
};
const talk = (port) => new Promise((resolve) => {
  const sock = new WebSocket(`ws://127.0.0.1:${port}/play`);
  sock.binaryType = 'arraybuffer';
  const said = [];
  sock.addEventListener('message', (e) => { const v = said.shift(); if (v) v(typeof e.data === 'string' ? e.data : new Uint8Array(e.data)); });
  sock.addEventListener('open', () => resolve({ say: (m) => new Promise((r) => { said.push(r); sock.send(m); }), shut: () => sock.close() }));
});
const honest = (rid, eid, previousHash = GENESIS, first = 0, n = 60) => ({
  roundId: rid, entryId: eid, previousHash, firstTick: first,
  ticks: Array.from({ length: n }, (_, i) => [65536, first + i, 0, 0, 0]), liquidations: [],
});
// the home seat's fabrication: 60 more ticks hard left the player never steered (#1488 already bounds what a load may say)
const forged = (rid, eid, previousHash) => ({
  roundId: rid, entryId: eid, previousHash, firstTick: 60,
  ticks: Array.from({ length: 60 }, () => [-65536, 65536, 65536, 0, 0]), liquidations: [],
});

async function stage() {
  const home = await serve(openStore(), { plugins: HOSTED, port: 0, funded: () => true });   // the player's home seat (malicious)
  const peer = await serve(openStore(), { plugins: HOSTED, port: 0, funded: () => true });   // an honest committee peer
  const key = ed25519.utils.randomSecretKey();
  const rc = encodeRoundContract(contract());
  const rid = (await post(home.port, '/round', rc)).bytes;
  assert.equal((await post(peer.port, '/round', rc)).bytes.length, 32);
  const e = entryFor(rid, ed25519.getPublicKey(key));
  const eid = (await post(home.port, '/entry', encodeEntryContract(e))).bytes;
  assert.equal((await post(peer.port, '/entry', encodeEntryContract(e))).bytes.length, 32);
  assumeStakeSeen(home.round, e); assumeStakeSeen(peer.round, e);
  // the player's own first batch, signed, at both seats
  const b1 = honest(rid, eid);
  const f1 = signedBatchOf(b1, (id) => ed25519.sign(id, key));
  for (const s of [home, peer]) { const t = await talk(s.port); assert.equal(await t.say(f1), '60'); t.shut(); }
  // THE HOME SEAT writes a forged batch into its own store, chained on the player's head (a seat owns its database)
  home.round.batch(encodeInputBatch(forged(rid, eid, batchId(b1))));
  return { home, peer, key, rid, eid };
}

// what the client now publishes, fed to the honest peer exactly as its peer feed would
async function feedPeer(peer, client) {
  const t = await talk(peer.port);
  const said = [];
  for (const p of client.published) said.push(String(await t.say(p.bytes)));
  t.shut();
  return said;
}

test('#1503 skeptic 2: after a page RELOAD the client never signs a batch only the home seat says it made', async () => {
  const s = await stage();
  try {
    const client = new Client({ base: `http://127.0.0.1:${s.home.port}`, core, sign: (id) => ed25519.sign(id, s.key), verify });
    try { await client.resumeAfterReload({ roundId: s.rid, entryId: s.eid, blockTicks: BLOCK_TICKS }); } catch (e) { console.log(`  resume refused: ${e.message}`); }
    const said = await feedPeer(s.peer, client);
    const t = s.peer.round.transcript(s.rid, s.eid);
    console.log(`  reload: client re-signed ${client.published.length} batch(es); peer said ${JSON.stringify(said)}; peer holds ${t.ticks.length} ticks, loads ${JSON.stringify(t.loads || [])}`);
    assert.equal(t.ticks.length, 60, 'the honest peer holds 60 ticks the player never steered, signed by the player\'s own key on the home seat\'s word');
  } finally { await s.home.close(); await s.peer.close(); }
});

test('#1503 skeptic 2: after a SOCKET DROP the client\'s resume never signs a batch only the home seat says it made', async () => {
  const s = await stage();
  try {
    const client = new Client({ base: `http://127.0.0.1:${s.home.port}`, core, sign: (id) => ed25519.sign(id, s.key), verify });
    client.setRound({ roundId: s.rid, entryId: s.eid, blockTicks: BLOCK_TICKS });
    // the client had published its own first batch (as Client.batch leaves it), then its socket dropped
    client.published.push({ bytes: signedBatchOf(honest(s.rid, s.eid), (id) => ed25519.sign(id, s.key)), through: 60 });
    client.nextTick = 60;
    try { await client.resume({ roundId: s.rid, entryId: s.eid }); } catch (e) { console.log(`  resume refused: ${e.message}`); }
    const said = await feedPeer(s.peer, client);
    const t = s.peer.round.transcript(s.rid, s.eid);
    console.log(`  drop: client holds ${client.published.length} signed batch(es); peer said ${JSON.stringify(said)}; peer holds ${t.ticks.length} ticks, loads ${JSON.stringify(t.loads || [])}`);
    assert.equal(t.ticks.length, 60, 'the honest peer holds 60 ticks the player never steered, signed by the player\'s own key on the home seat\'s word');
  } finally { await s.home.close(); await s.peer.close(); }
});

// kanban #1857: the honest side of the same rule - a reloaded tab that KEPT its own batch ids (the page's storage, beside
// the session key) takes its own batches back and resumes after them, and still never signs the home seat's tail.
test('#1857: a reloaded tab that kept its own batch ids resumes after them, and the home seat\'s tail is still not signed', { todo: 'kanban #1489 merge19v1: the 1.9 line keeps #1567 (resume-forged-1567), which closes the same hole by ending the run as a node fault on a tail the client never signed; #1857 resumes after the client\'s own batches instead - a liveness difference, not the hole (the two cases above are green)' }, async () => {
  const s = await stage();
  try {
    const mem = new Map();
    const store = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => { mem.set(k, String(v)); } };
    const hex = (u) => Buffer.from(u).toString('hex');
    store.setItem(`arena-own-batches:${hex(s.eid)}`, JSON.stringify({ took: hex(batchId(honest(s.rid, s.eid))) }));
    const client = new Client({ base: `http://127.0.0.1:${s.home.port}`, core, sign: (id) => ed25519.sign(id, s.key), verify, ownBatchStore: store });
    const got = await client.resumeAfterReload({ roundId: s.rid, entryId: s.eid, blockTicks: BLOCK_TICKS });
    assert.equal(got.nextTick, 60, 'the run resumes after the player\'s own batch');
    assert.equal(got.batches, 1);
    assert.equal(client.published.length, 1, 'only the player\'s own batch is signed again');
    assert.equal(hex(client.batchHead), hex(batchId(honest(s.rid, s.eid))));
    assert.equal(client.batchesDisowned, 1);
    const said = await feedPeer(s.peer, client);
    assert.deepEqual(said, ['0'], 'the peer already held the player\'s own batch');
    assert.equal(s.peer.round.transcript(s.rid, s.eid).ticks.length, 60);
  } finally { await s.home.close(); await s.peer.close(); }
});
