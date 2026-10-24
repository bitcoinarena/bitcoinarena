// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE CLAIM KEY A LOCK MAY NAME (v4.6.2 §23.1 step 0, F3).
//
// "Once selected, the settlement signer nodes run a dealerless DKG for this round's
// threshold key claim_pk and each signer node signs (round_id, claim_pk). The key is
// valid only with signatures from >=5 signer nodes (claim_key_attestation_ref); a
// client MUST refuse to lock to a key without them. Otherwise one signer node could
// serve its own key and, after the shares are released, claim a loser's stake
// for itself." protocol claim-key.js holds the attestation, its set's id and
// claimKeyIsAttested; the round's threshold is its own (2 of 2, 5 of 7).
//
// MEASURED BEFORE (TASKBOOK, aed31be): GET /claim-key 404 on every signer node, the
// page's bundle had no way to check a key, entryFor wrote a zero attestation,
// claimKeyIsAttested had 0 callers in node and client.
// A PAYING ROUND OPENS ONLY ON A SIGNER NODE THAT REACHES A FEDERATION (RULED 2026-09-25): this file's paying-round
// daemons get the lock fixture's port - the test federation, two gateways, zero base fee. Contracts unchanged.
import { lockPort, bondedChainSlot, bondedChainFor } from '../../arena-node/test/lock-fixture.js';
import { TRUCK_CORE_HASH, TRUCK_V3_CONFIG_HASH } from '../../nextblock/plugin/nextblock.js';
import { test } from 'node:test';
// The run length is the core's; a literal 9000 is refused by the node as a contract
// disagreeing with the network it names (WAR_TACTICS moved a run to 10800).
import { BLOCK_TICKS } from '../../nextblock/src/rules/gate.js';
import { TEST_FEDERATION_ID } from '../../arena-protocol/src/test-federation.js';
import { TEST_DONATION_SET_REGTEST } from '../../arena-protocol/src/test-donation-sets.js';
import { donationSetId as idOfDonationSet } from '../../arena-protocol/src/donation.js';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { schnorr } from '@noble/curves/secp256k1.js';

import { openStore } from '../../arena-node/src/store.js';
import { serve } from '../../arena-node/src/server.js';
import { assumeAssigned } from '../../arena-node/test/assignment.js';
import { NETWORK_ID_REGTEST } from '../../arena-protocol/src/genesis-ids.js';
import { encodeRoundContract, roundId } from '../../arena-protocol/src/contracts.js';
import { MIN_ENTRY_WINDOW_MS } from '../../arena-protocol/src/constants.js';
import { encodeClaimKeyAttestation, claimKeyAttestationId } from '../../arena-protocol/src/claim-key.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { CORE_HASH } from '../../arena-node/tools/core-hash.mjs';
import { entryFor, attestedClaimKey, roundLocks } from '../src/join.js';
import { pageCurve } from '../src/page-curve.js';
import { HOSTED } from '../../arena-node/test/plugins/hosted.js';
import { NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';

const require = createRequire(import.meta.url);
const b32 = (n) => new Uint8Array(32).fill(n);
const ROOT = new URL('../../../', import.meta.url).pathname;
const CLAIM = Uint8Array.from([0x02, ...b32(0xc1)]);
const ROGUE = Uint8Array.from([0x03, ...b32(0xe7)]);

/**
 * A paying round that names a federation, and its signer nodes' daemons; `keyOf(i)` is the claim key signer node i holds.
 * HARNESS KEY: each signer node is handed its key, so a disagreeing or rogue signer node can be staged. The shipping
 * path, where the signer nodes make the key themselves, is arena-node/test/claim-key-own.test.js.
 */
async function federationRound({ signerNodes = 2, keyOf = () => CLAIM, federationId = TEST_FEDERATION_ID } = {}) {
  const daemons = [];
  // ON A CHAIN THAT BONDS THE ROUND'S SIGNER NODES (RULED 2026-09-25): one chain every daemon reads; the claim keys stay the
  // harness's (claimKeyFor), which is what this file stages. Only the round's censusRoot changes.
  const slot = bondedChainSlot(lockPort());
  for (let i = 0; i < signerNodes; i++)
    daemons.push(await serve(openStore(':memory:'), { plugins: HOSTED, port: 0, stakeLocks: slot.port, chainFor: slot.chainFor,
      randomnessFor: slot.randomnessFor, funded: () => true, claimKeyFor: () => keyOf(i) }));
  const now = BigInt(Date.now());
  const drafted = {
    networkId: NETWORK_ID_REGTEST, configHash: TRUCK_V3_CONFIG_HASH, censusConfirmations: 1,
    gameVerifySlots: signerNodes, settlementSlots: signerNodes, gameId: NEXTBLOCK_GAME_ID, simCoreHash: CORE_HASH, startTimeMs: now + MIN_ENTRY_WINDOW_MS,
    entryCloseMs: now + MIN_ENTRY_WINDOW_MS + 600000n, objectionWindowMs: 600000n, custody: 'FEDERATION',
    slashMinimumServed: 20, slashRemainder: 'SPLIT', federationId, stakeExpiryBlocks: 144,
    publicationRelays: daemons.map((d) => `http://127.0.0.1:${d.port}`), donationSetId: idOfDonationSet(TEST_DONATION_SET_REGTEST.recipients), censusHeight: 900000,
    censusRoot: b32(2), committeeTimeMs: now - 1000n, randomnessRule: 'bitcoin-block-hash', stakeMsat: 100000n,
    bondMinSats: 50000n, blockTicks: BLOCK_TICKS, exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20,
    timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4,
    nodes: daemons.map((d) => d.round.pubkey),
  };
  const round = { ...drafted, censusRoot: bondedChainFor(drafted.nodes, drafted, slot,
    { endpoints: daemons.map((d) => `ws://127.0.0.1:${d.port}`) }).censusRoot };
  const rid = roundId(round);
  for (const d of daemons) {
    const r = await fetch(`http://127.0.0.1:${d.port}/round`, { method: 'POST', body: encodeRoundContract(round) });
    assert.equal(r.status, 201, await r.text());
    assumeAssigned(d.round, rid, round.nodes);
  }
  const nodes = daemons.map((d) => `http://127.0.0.1:${d.port}`);
  return { daemons, slot, round: { ...round, id: rid }, rid, nodes, signerNodes: round.nodes,
    ask: (asked = nodes) => attestedClaimKey({ round: { ...round, id: rid }, signerNodes: round.nodes, nodes: asked, curve: pageCurve }),
    close: async () => { for (const d of daemons) await d.close(); } };
}

const callers = (dir) => readdirSync(ROOT + dir).filter((f) => f.endsWith('.js'))
  .filter((f) => readFileSync(ROOT + dir + f, 'utf8').includes('claimKeyIsAttested(')).length;
const entryWith = (f, extra = {}) => entryFor(f.round, { seed: b32(0x51), curve: pageCurve, random: (n) => new Uint8Array(n).fill(7), ...extra });

test('two signer nodes both attest the claim key: the page accepts it and its entry names the attested set, not zeros', async () => {
  const f = await federationRound();
  try {
    const got = await f.ask();
    assert.equal(got.ok, true, got.why);
    assert.equal(toHex(got.claimPk), toHex(CLAIM));
    // A lock round's entry now names its lock too (W1b); the outpoint is not what this test measures.
    const entry = entryWith(f, { claimKey: got, stakeLock: { outpoint: { txid: b32(0x7a), outIdx: 0n } } });
    const bundled = require('../dist/arena-client.js');
    const facts = {
      attested: got.attested, needed: got.needed, entryRef: toHex(entry.claimKeyAttestationRef) === toHex(got.ref),
      refIsZero: entry.claimKeyAttestationRef.every((b) => b === 0), locks: roundLocks(f.round),
      pageChecks: typeof bundled.attestedClaimKey === 'function',
      callers: { node: callers('packages/arena-node/src/'), client: callers('packages/arena-client/src/') },
    };
    console.log('  FACTS (2 signer nodes, one key):', JSON.stringify(facts));
    assert.deepEqual(facts, { attested: 2, needed: 2, entryRef: true, refIsZero: false, locks: true, pageChecks: true,
      callers: { node: 0, client: 1 } });
  } finally { await f.close(); }
});

test('seven signer nodes: five attesting one key is enough, four is not', async () => {
  for (const [agree, ok] of [[5, true], [4, false]]) {
    const f = await federationRound({ signerNodes: 7, keyOf: (i) => (i < agree ? CLAIM : Uint8Array.from([0x02, ...b32(0x40 + i)])) });
    try {
      const got = await f.ask();
      console.log(`  ${agree} of 7 signer nodes attest one key: ${got.ok ? `accepted (${got.attested} of ${got.needed})` : got.why}`);
      assert.equal(got.ok, ok, got.why);
      if (ok) assert.equal(toHex(got.claimPk), toHex(CLAIM));
      else assert.match(got.why, /4 of 7 signer nodes attest this claim key, and this round needs 5/);
    } finally { await f.close(); }
  }
});

test('a signer node that serves its own key is refused: asked alone it does not make the key, and among the others it is not the key taken', async () => {
  const f = await federationRound({ signerNodes: 7, keyOf: (i) => (i === 0 ? ROGUE : CLAIM) });
  try {
    const alone = await f.ask([f.nodes[0]]);
    assert.equal(alone.ok, false, 'one signer node\'s own key was accepted');
    assert.match(alone.why, /1 of 7 signer nodes attest this claim key, and this round needs 5/);
    assert.throws(() => entryWith(f, { claimKey: alone }), /must refuse to lock to a key without it/);
    const all = await f.ask();
    assert.equal(all.ok, true, all.why);
    assert.equal(toHex(all.claimPk), toHex(CLAIM), 'the rogue signer node\'s key was taken');
    // answered once its attestation stands (kanban #606): at the round's needed count, not after every seat
    assert.ok(all.attested >= all.needed && all.attested <= 6, `attested ${all.attested} of needed ${all.needed}`);
  } finally { await f.close(); }
});

test('a seat that hangs does not hold the claim key: it is answered once enough signer nodes attested (kanban #606)', async () => {
  const f = await federationRound({ signerNodes: 7 });
  try {
    const hung = f.nodes[0];
    const fetcher = (url, o) => (url.startsWith(hung) ? new Promise((_, reject) => { o && o.signal && o.signal.addEventListener('abort', () => reject(new Error('aborted'))); }) : fetch(url, o));
    const t0 = Date.now();
    const got = await attestedClaimKey({ round: f.round, signerNodes: f.signerNodes, nodes: f.nodes, curve: pageCurve, fetcher, timeoutMs: 20000 });
    assert.equal(got.ok, true, got.why);
    assert.ok(Date.now() - t0 < 5000, `took ${Date.now() - t0} ms with one seat hanging`);
  } finally { await f.close(); }
});

test('a stranger\'s signed claim key counts for nothing, and a node not assigned to the round attests none', async () => {
  const f = await federationRound();
  try {
    const stranger = new Uint8Array(randomBytes(32));
    const a = { roundId: f.rid, claimPk: ROGUE, signerNodePubkey: schnorr.getPublicKey(stranger) };
    const forged = [...encodeClaimKeyAttestation(a), ...schnorr.sign(claimKeyAttestationId(a), stranger)];
    const fakeNode = 'http://stranger.example';
    const fetcher = (url, o) => (url.startsWith(fakeNode) ? Promise.resolve(new Response(new Uint8Array(forged))) : fetch(url, o));
    const got = await attestedClaimKey({ round: f.round, signerNodes: f.signerNodes, nodes: [fakeNode, f.nodes[0]], curve: pageCurve, fetcher });
    assert.equal(got.ok, false, 'a stranger\'s signature made up the threshold');
    assert.match(got.why, /1 of 2 signer nodes attest this claim key/);
    // AND A NODE THAT IS NOT A SIGNER NODE OF THIS ROUND SIGNS NOTHING FOR IT.
    // ON THE SAME CHAIN: it reads the round's census, and its key is not in it.
    const outsider = await serve(openStore(':memory:'), { plugins: HOSTED, port: 0, stakeLocks: f.slot.port, chainFor: f.slot.chainFor,
      randomnessFor: f.slot.randomnessFor, funded: () => true, claimKeyFor: () => CLAIM });
    try {
      await fetch(`http://127.0.0.1:${outsider.port}/round`, { method: 'POST', body: encodeRoundContract(f.round) });
      const r = await fetch(`http://127.0.0.1:${outsider.port}/claim-key?round=${toHex(f.rid)}`);
      assert.equal(r.status, 409);
      assert.match(await r.text(), /not assigned to that round/);
    } finally { await outsider.close(); }
  } finally { await f.close(); }
});

// NO HOLD ROUND (RULED 2026-09-24, the enum slice's fifth cut): a paying round that names no federation was the
// hold invoice's, and the page used to build its entry - a stake, no lock, no attestation. It is not a round of this
// network: entryFor refuses it before any key is asked, and zero attestations are a free round's only.
test('a round whose stake goes into a lock gets no entry without an attested key; a paying round naming no federation gets no entry at all', async () => {
  const f = await federationRound();
  try {
    assert.throws(() => entryWith(f), /no claim key has its signer nodes' attestation: a client must refuse to lock to a key without it/);
    const unnamed = { ...f.round, federationId: new Uint8Array(32) };
    assert.equal(roundLocks(unnamed), false);
    assert.throws(() => entryFor(unnamed, { seed: b32(0x51), curve: pageCurve, random: (n) => new Uint8Array(n).fill(7) }),
      /^Error: this round takes a stake and names no federation, so it is not a round of this network \(§23\.6\)$/);
  } finally { await f.close(); }
});

test('the claim key is asked of every node at once: ten nodes of 200 ms each answer in well under the 2 s one after another took', async () => {
  const nodes = Array.from({ length: 10 }, (_, i) => `https://seat-${i}.example`);
  let open = 0, most = 0;
  const fetcher = async () => { open++; most = Math.max(most, open); await new Promise((r) => setTimeout(r, 200)); open--;
    return { ok: false, status: 409, text: async () => 'this signer node holds no claim key for that round yet' }; };
  const t = Date.now();
  const got = await attestedClaimKey({ round: { id: new Uint8Array(32).fill(7) }, signerNodes: [], nodes, curve: { verify: () => true }, fetcher });
  const took = Date.now() - t;
  assert.equal(got.ok, false);
  assert.equal(got.refused.length, 10, 'every node named once, in the nodes\' order');
  assert.ok(got.refused[0].startsWith('https://seat-0.example') && got.refused[9].startsWith('https://seat-9.example'));
  assert.equal(most, 10, `all ten asked together, ${most} at most at once`);
  assert.ok(took < 1200, `ten 200 ms nodes took ${took} ms`);
});
