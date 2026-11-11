// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// KANBAN #1503 (feedback #012 by Hexbox Tools): input batches were unsigned, so anybody who knew a public entry id
// could write ticks and a load into another player's entry - on /play, and through POST /first-mark, where the batches
// handed with a mark were stored before the mark was checked. A batch is now taken on /play only signed by its entry's
// session key, and /first-mark stores only the chain a verified mark endorses.
import { TEST_FEDERATION_ID } from '../../arena-protocol/src/test-federation.js';
import { TRUCK_CORE_HASH, TRUCK_V3_CONFIG_HASH, NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';
import { BLOCK_TICKS } from '../../nextblock/src/rules/gate.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TEST_DONATION_SET_REGTEST } from '../../arena-protocol/src/test-donation-sets.js';
import { donationSetId as idOfDonationSet } from '../../arena-protocol/src/donation.js';
import { openStore } from '../src/store.js';
import { serve } from '../src/server.js';
import { encodeRoundContract, encodeEntryContract } from '../../arena-protocol/src/contracts.js';
import { encodeInputBatch, batchId, signedBatchOf, joinSignedBatch } from '../../arena-protocol/src/batch.js';
import { encodeCheckpoint, checkpointId, NO_PREVIOUS, joinSigned } from '../../arena-protocol/src/checkpoint.js';
import { ed25519 } from '@noble/curves/ed25519.js';
import { GENESIS } from '../../arena-protocol/src/transcript.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { assumeStakeSeen } from './assignment.js';
import { HOSTED } from './plugins/hosted.js';

const FUNDED = { funded: () => true };
const b32 = (n) => new Uint8Array(32).fill(n);
const contract = () => ({
  networkId: b32(0x4e), configHash: TRUCK_V3_CONFIG_HASH, censusConfirmations: 6, gameVerifySlots: 7, settlementSlots: 7, gameId: NEXTBLOCK_GAME_ID, simCoreHash: TRUCK_CORE_HASH, startTimeMs: 60500n, entryCloseMs: 2000n, objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20, slashRemainder: 'SPLIT', federationId: TEST_FEDERATION_ID, stakeExpiryBlocks: 144, publicationRelays: ['wss://r.example'], donationSetId: idOfDonationSet(TEST_DONATION_SET_REGTEST.recipients),
  censusHeight: 900000, censusRoot: b32(2), committeeTimeMs: 500n, randomnessRule: 'bitcoin-block-hash',
  stakeMsat: 0n, bondMinSats: 50000n, blockTicks: BLOCK_TICKS,
  exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20,
  timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4,
  nodes: [b32(4)],
});
const entryFor = (rid, sessionPubkey, who) => ({
  roundId: rid, playerPubkey: b32(who), sessionPubkey,
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

// A round with two players: the victim, whose public entry id the attacker knows, and the attacker's own (the decoy).
async function stage(node) {
  const victimKey = ed25519.utils.randomSecretKey();
  const decoyKey = ed25519.utils.randomSecretKey();
  const rid = (await post(node.port, '/round', encodeRoundContract(contract()))).bytes;
  const ve = entryFor(rid, ed25519.getPublicKey(victimKey), 5);
  const de = entryFor(rid, ed25519.getPublicKey(decoyKey), 6);
  const victim = (await post(node.port, '/entry', encodeEntryContract(ve))).bytes;
  const decoy = (await post(node.port, '/entry', encodeEntryContract(de))).bytes;
  assert.equal(victim.length, 32, 'the victim joined');
  assert.equal(decoy.length, 32, 'the decoy joined');
  assumeStakeSeen(node.round, ve);
  assumeStakeSeen(node.round, de);
  return { rid, victim, decoy, victimKey, decoyKey };
}
// Hexbox's forged batch: 120 hostile ticks and a load the victim never declared.
const hostile = (rid, eid, previousHash = GENESIS) => ({
  roundId: rid, entryId: eid, previousHash, firstTick: 0,
  ticks: Array.from({ length: 120 }, () => [-65536, 65536, 65536, 0, 0]), liquidations: [], loads: [[0, 99999, 9999]],
});
const honest = (rid, eid, previousHash = GENESIS, first = 0, n = 60) => ({
  roundId: rid, entryId: eid, previousHash, firstTick: first,
  ticks: Array.from({ length: n }, (_, i) => [65536, first + i, 0, 0, 0]), liquidations: [],
});
const stored = (node, rid, eid) => node.round.transcript(rid, eid);

test('#1503 /play: an unsigned batch, or one signed by another key, writes nothing into somebody else\'s entry', async () => {
  const node = await serve(openStore(), { plugins: HOSTED, port: 0, ...FUNDED });
  try {
    const s = await stage(node);
    const anon = await talk(node.port);
    // the old unsigned frame for the victim's entry: refused, nothing stored
    const a1 = await anon.say(encodeInputBatch(hostile(s.rid, s.victim)));
    assert.match(String(a1), /^error .*signed/, `an unsigned batch is refused by name (said ${a1})`);
    // the new frame signed by the attacker's own session key: refused
    const a2 = await anon.say(signedBatchOf(hostile(s.rid, s.victim), (id) => ed25519.sign(id, s.decoyKey)));
    assert.match(String(a2), /^error .*session key/, `a batch signed by another entry's key is refused (said ${a2})`);
    // a signature over a different batch, spliced onto the hostile one: refused
    const other = honest(s.rid, s.victim);
    const spliced = joinSignedBatch(encodeInputBatch(hostile(s.rid, s.victim)), ed25519.sign(batchId(other), s.victimKey));
    assert.match(String(await anon.say(spliced)), /^error .*session key/, 'a signature lifted from another batch does not stand');
    assert.equal(toHex(node.round.head(s.rid, s.victim)), toHex(GENESIS), 'the victim\'s chain is untouched');
    const t0 = stored(node, s.rid, s.victim);
    assert.equal(t0.ticks.length, 0, 'no forged tick was stored');
    assert.deepEqual(t0.loads || [], [], 'no forged load was stored');
    anon.shut();

    // the victim's own signed batch follows its chain from genesis and lands, and again is a no-op
    const me = await talk(node.port);
    const b1 = honest(s.rid, s.victim);
    const f1 = signedBatchOf(b1, (id) => ed25519.sign(id, s.victimKey));
    assert.equal(await me.say(f1), '60', 'the victim\'s own batch is taken');
    assert.equal(await me.say(f1), '0', 'the same signed batch again is a no-op');
    const b2 = honest(s.rid, s.victim, batchId(b1), 60, 30);
    assert.equal(await me.say(signedBatchOf(b2, (id) => ed25519.sign(id, s.victimKey))), '30');
    // and its own mark over its own inputs is taken (the run is not FORFEIT)
    const m = { roundId: s.rid, entryId: s.victim, tick: 90, stateHash: b32(9), inputChainHash: batchId(b2), previousHash: NO_PREVIOUS };
    const rc = await me.say(joinSigned(encodeCheckpoint(m), ed25519.sign(checkpointId(m), s.victimKey)));
    assert.ok(rc instanceof Uint8Array, `the victim's mark over its own inputs is receipted (said ${rc})`);
    me.shut();
    const t = stored(node, s.rid, s.victim);
    assert.equal(t.ticks.length, 90, 'the transcript is the victim\'s own run');
    assert.deepEqual(t.loads || [], [], 'and carries no forged load');
  } finally { await node.close(); }
});

test('#1503 /first-mark: a mark that does not verify stores nothing, and batches of another entry are never taken', async () => {
  const node = await serve(openStore(), { plugins: HOSTED, port: 0, ...FUNDED });
  try {
    const s = await stage(node);
    const firstMark = (eid, key, inputChainHash) => {
      const m = { roundId: s.rid, entryId: eid, tick: 90, stateHash: b32(3), inputChainHash, previousHash: NO_PREVIOUS };
      return joinSigned(encodeCheckpoint(m), ed25519.sign(checkpointId(m), key));
    };
    const handOn = async (mark, batches) => {
      const r = await fetch(`http://127.0.0.1:${node.port}/first-mark`, { method: 'POST',
        body: JSON.stringify({ mark: toHex(mark), batches: batches.map((b) => toHex(b)), receipt: null }) });
      return { status: r.status, body: await r.json().catch(() => ({})) };
    };
    const forged = encodeInputBatch(hostile(s.rid, s.victim));

    // Hexbox's second repro: a wrong-signature mark for the decoy, carrying the victim's forged batch
    const bad = await handOn(firstMark(s.decoy, ed25519.utils.randomSecretKey(), batchId(hostile(s.rid, s.victim))), [forged]);
    assert.equal(bad.status, 409, 'the mark is refused');
    assert.match(bad.body.why || '', /signature/, `by its signature (${bad.body.why})`);
    assert.equal(stored(node, s.rid, s.victim).ticks.length, 0, 'and the victim\'s entry holds nothing');

    // a GOOD mark for the decoy, carrying a batch for the victim: the victim's batch is not the mark's to endorse
    const decoyBatch = honest(s.rid, s.decoy);
    const mixed = await handOn(firstMark(s.decoy, s.decoyKey, batchId(decoyBatch)), [encodeInputBatch(decoyBatch), forged]);
    assert.equal(mixed.status, 409, `a mark handed on with another entry's batch is refused (${JSON.stringify(mixed.body)})`);
    assert.equal(stored(node, s.rid, s.victim).ticks.length, 0, 'the victim\'s entry still holds nothing');
    assert.equal(stored(node, s.rid, s.decoy).ticks.length, 0, 'and nothing of that hand-on was stored at all');

    // a good mark whose batches do not end at its input chain hash: refused, nothing stored
    const vb = honest(s.rid, s.victim);
    const notEnding = await handOn(firstMark(s.victim, s.victimKey, b32(0x77)), [encodeInputBatch(vb)]);
    assert.equal(notEnding.status, 409);
    assert.equal(stored(node, s.rid, s.victim).ticks.length, 0);

    // TRANSCRIPT SYNC STILL WORKS: the victim's own first mark with the chain it commits to - bare batches, as a seat
    // hands them on - is taken whole and receipted
    const vb2 = honest(s.rid, s.victim, batchId(vb), 60, 30);
    const ok = await handOn(firstMark(s.victim, s.victimKey, batchId(vb2)), [encodeInputBatch(vb), encodeInputBatch(vb2)]);
    assert.equal(ok.status, 200, `the endorsed chain and its mark are taken (${JSON.stringify(ok.body)})`);
    assert.ok(ok.body.receipt, 'and receipted');
    assert.equal(stored(node, s.rid, s.victim).ticks.length, 90, 'the batches the mark endorses are stored');
  } finally { await node.close(); }
});
