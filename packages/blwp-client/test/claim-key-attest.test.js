// THE CLAIM KEY A LOCK MAY NAME (v4.6.2 §23.1 step 0, F3).
//
// "Once selected, the settlement seats run a dealerless DKG for this round's
// threshold key claim_pk and each seat signs (round_id, claim_pk). The key is
// valid only with signatures from >=5 seats (claim_key_attestation_ref); a
// client MUST refuse to lock to a key without them. Otherwise one seat could
// serve its own key and, after the shares are released, claim a loser's stake
// for itself." protocol claim-key.js holds the attestation, its set's id and
// claimKeyIsAttested; the round's threshold is its own (2 of 2, 5 of 7).
//
// MEASURED BEFORE (TASKBOOK, aed31be): GET /claim-key 404 on every seat, the
// page's bundle had no way to check a key, entryFor wrote a zero attestation,
// claimKeyIsAttested had 0 callers in node and client.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { schnorr } from '@noble/curves/secp256k1.js';

import { openStore } from '../../blwp-node/src/store.js';
import { serve } from '../../blwp-node/src/server.js';
import { assumeSeated } from '../../blwp-node/test/seating.js';
import { NETWORK_ID_REGTEST } from '../../protocol/src/genesis-ids.js';
import { encodeRoundContract, roundId } from '../../protocol/src/contracts.js';
import { MIN_ENTRY_WINDOW_MS } from '../../protocol/src/constants.js';
import { encodeClaimKeyAttestation, claimKeyAttestationId } from '../../protocol/src/claim-key.js';
import { toHex } from '../../protocol/src/hash.js';
import { CORE_HASH } from '../../blwp-node/tools/core-hash.mjs';
import { entryFor, attestedClaimKey, roundLocks } from '../src/join.js';
import { pageCurve } from '../src/page-curve.js';

const require = createRequire(import.meta.url);
const b32 = (n) => new Uint8Array(32).fill(n);
const ROOT = new URL('../../../', import.meta.url).pathname;
const CLAIM = Uint8Array.from([0x02, ...b32(0xc1)]);
const ROGUE = Uint8Array.from([0x03, ...b32(0xe7)]);

/** A paying round that names a federation, and its seats' daemons; `keyOf(i)` is the claim key seat i holds. */
async function federationRound({ seats = 2, keyOf = () => CLAIM, federationId = b32(0xfe) } = {}) {
  const daemons = [];
  for (let i = 0; i < seats; i++)
    daemons.push(await serve(openStore(':memory:'), { port: 0, funded: () => true, preflight: async () => ({ ready: true, why: 'test' }), claimKeyFor: () => keyOf(i) }));
  const now = BigInt(Date.now());
  const round = {
    networkId: NETWORK_ID_REGTEST, configHash: b32(0x43), censusConfirmations: 1,
    gameVerifySlots: seats, settlementSlots: seats, simCoreHash: CORE_HASH, startTimeMs: now + MIN_ENTRY_WINDOW_MS,
    entryCloseMs: now + MIN_ENTRY_WINDOW_MS + 600000n, objectionWindowMs: 3000n, custody: 'FEDERATION',
    slashMinimumServed: 20, slashRemainder: 'BURN', federationId, stakeExpiryBlocks: 144,
    publicationRelays: daemons.map((d) => `http://127.0.0.1:${d.port}`), donationSetId: b32(0xd0), censusHeight: 900000,
    censusRoot: b32(2), committeeTimeMs: now - 1000n, randomnessRule: 'bitcoin-block-hash', stakeMsat: 100000n,
    bondMinSats: 50000n, blockTicks: 9000, exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20,
    timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4,
    nodes: daemons.map((d) => d.round.pubkey),
  };
  const rid = roundId(round);
  for (const d of daemons) {
    const r = await fetch(`http://127.0.0.1:${d.port}/round`, { method: 'POST', body: encodeRoundContract(round) });
    assert.equal(r.status, 201, await r.text());
    assumeSeated(d.round, rid, round.nodes);
  }
  const nodes = daemons.map((d) => `http://127.0.0.1:${d.port}`);
  return { daemons, round: { ...round, id: rid }, rid, nodes, seats: round.nodes,
    ask: (asked = nodes) => attestedClaimKey({ round: { ...round, id: rid }, seats: round.nodes, nodes: asked, curve: pageCurve }),
    close: async () => { for (const d of daemons) await d.close(); } };
}

const callers = (dir) => readdirSync(ROOT + dir).filter((f) => f.endsWith('.js'))
  .filter((f) => readFileSync(ROOT + dir + f, 'utf8').includes('claimKeyIsAttested(')).length;
const entryWith = (f, extra = {}) => entryFor(f.round, { seed: b32(0x51), curve: pageCurve, random: (n) => new Uint8Array(n).fill(7), ...extra });

test('two seats both attest the claim key: the page accepts it and its entry names the attested set, not zeros', async () => {
  const f = await federationRound();
  try {
    const got = await f.ask();
    assert.equal(got.ok, true, got.why);
    assert.equal(toHex(got.claimPk), toHex(CLAIM));
    const entry = entryWith(f, { claimKey: got });
    const bundled = require('../dist/blwp-client.js');
    const facts = {
      attested: got.attested, needed: got.needed, entryRef: toHex(entry.claimKeyAttestationRef) === toHex(got.ref),
      refIsZero: entry.claimKeyAttestationRef.every((b) => b === 0), locks: roundLocks(f.round),
      pageChecks: typeof bundled.attestedClaimKey === 'function',
      callers: { node: callers('packages/blwp-node/src/'), client: callers('packages/blwp-client/src/') },
    };
    console.log('  FACTS (2 seats, one key):', JSON.stringify(facts));
    assert.deepEqual(facts, { attested: 2, needed: 2, entryRef: true, refIsZero: false, locks: true, pageChecks: true,
      callers: { node: 0, client: 1 } });
  } finally { await f.close(); }
});

test('seven seats: five attesting one key is enough, four is not', async () => {
  for (const [agree, ok] of [[5, true], [4, false]]) {
    const f = await federationRound({ seats: 7, keyOf: (i) => (i < agree ? CLAIM : Uint8Array.from([0x02, ...b32(0x40 + i)])) });
    try {
      const got = await f.ask();
      console.log(`  ${agree} of 7 seats attest one key: ${got.ok ? `accepted (${got.attested} of ${got.needed})` : got.why}`);
      assert.equal(got.ok, ok, got.why);
      if (ok) assert.equal(toHex(got.claimPk), toHex(CLAIM));
      else assert.match(got.why, /4 of 7 seats attest this claim key, and this round needs 5/);
    } finally { await f.close(); }
  }
});

test('a seat that serves its own key is refused: asked alone it does not make the key, and among the others it is not the key taken', async () => {
  const f = await federationRound({ seats: 7, keyOf: (i) => (i === 0 ? ROGUE : CLAIM) });
  try {
    const alone = await f.ask([f.nodes[0]]);
    assert.equal(alone.ok, false, 'one seat\'s own key was accepted');
    assert.match(alone.why, /1 of 7 seats attest this claim key, and this round needs 5/);
    assert.throws(() => entryWith(f, { claimKey: alone }), /must refuse to lock to a key without it/);
    const all = await f.ask();
    assert.equal(all.ok, true, all.why);
    assert.equal(toHex(all.claimPk), toHex(CLAIM), 'the rogue seat\'s key was taken');
    assert.equal(all.attested, 6);
  } finally { await f.close(); }
});

test('a stranger\'s signed claim key counts for nothing, and a node not seated on the round attests none', async () => {
  const f = await federationRound();
  try {
    const stranger = new Uint8Array(randomBytes(32));
    const a = { roundId: f.rid, claimPk: ROGUE, seatPubkey: schnorr.getPublicKey(stranger) };
    const forged = [...encodeClaimKeyAttestation(a), ...schnorr.sign(claimKeyAttestationId(a), stranger)];
    const fakeNode = 'http://stranger.example';
    const fetcher = (url, o) => (url.startsWith(fakeNode) ? Promise.resolve(new Response(new Uint8Array(forged))) : fetch(url, o));
    const got = await attestedClaimKey({ round: f.round, seats: f.seats, nodes: [fakeNode, f.nodes[0]], curve: pageCurve, fetcher });
    assert.equal(got.ok, false, 'a stranger\'s signature made up the threshold');
    assert.match(got.why, /1 of 2 seats attest this claim key/);
    // AND A NODE THAT IS NOT A SEAT OF THIS ROUND SIGNS NOTHING FOR IT.
    const outsider = await serve(openStore(':memory:'), { port: 0, funded: () => true, claimKeyFor: () => CLAIM });
    try {
      await fetch(`http://127.0.0.1:${outsider.port}/round`, { method: 'POST', body: encodeRoundContract(f.round) });
      const r = await fetch(`http://127.0.0.1:${outsider.port}/claim-key?round=${toHex(f.rid)}`);
      assert.equal(r.status, 409);
      assert.match(await r.text(), /not seated on that round/);
    } finally { await outsider.close(); }
  } finally { await f.close(); }
});

test('a round whose stake goes into a lock gets no entry without an attested key; a hold-invoice round keeps a zero attestation', async () => {
  const f = await federationRound();
  try {
    assert.throws(() => entryWith(f), /no claim key has its seats' attestation: a client must refuse to lock to a key without it/);
    const hold = { ...f.round, federationId: new Uint8Array(32) };
    assert.equal(roundLocks(hold), false);
    assert.equal(entryFor(hold, { seed: b32(0x51), curve: pageCurve, random: (n) => new Uint8Array(n).fill(7) })
      .claimKeyAttestationRef.every((b) => b === 0), true);
  } finally { await f.close(); }
});
