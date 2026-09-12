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
// MEASURED FIRST, asserted as it stands.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { ed25519 } from '@noble/curves/ed25519.js';

import { openStore } from '../../blwp-node/src/store.js';
import { serve } from '../../blwp-node/src/server.js';
import { assumeSeated } from '../../blwp-node/test/seating.js';
import { NETWORK_ID_REGTEST } from '../../protocol/src/genesis-ids.js';
import { encodeRoundContract, roundId } from '../../protocol/src/contracts.js';
import { MIN_ENTRY_WINDOW_MS } from '../../protocol/src/constants.js';
import { toHex } from '../../protocol/src/hash.js';
import { CORE_HASH } from '../../blwp-node/tools/core-hash.mjs';
import { entryFor } from '../src/join.js';
import { pageCurve } from '../src/page-curve.js';

const require = createRequire(import.meta.url);
const b32 = (n) => new Uint8Array(32).fill(n);
const ROOT = new URL('../../../', import.meta.url).pathname;
export const CLAIM = Uint8Array.from([0x02, ...b32(0xc1)]);

/** A paying round that names a federation, and its two seats' daemons, each knowing the committee's claim key. */
export async function federationRound({ claimKeyFor = () => CLAIM, seats = 2 } = {}) {
  const daemons = [];
  for (let i = 0; i < seats; i++)
    daemons.push(await serve(openStore(':memory:'), { port: 0, funded: () => true, preflight: async () => ({ ready: true, why: 'test' }), claimKeyFor }));
  const now = BigInt(Date.now());
  const round = {
    networkId: NETWORK_ID_REGTEST, configHash: b32(0x43), censusConfirmations: 1,
    gameVerifySlots: seats, settlementSlots: seats, simCoreHash: CORE_HASH, startTimeMs: now + MIN_ENTRY_WINDOW_MS,
    entryCloseMs: now + MIN_ENTRY_WINDOW_MS + 600000n, objectionWindowMs: 3000n, custody: 'FEDERATION',
    slashMinimumServed: 20, slashRemainder: 'BURN', federationId: b32(0xfe), stakeExpiryBlocks: 144,
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
  return { daemons, round: { ...round, id: rid }, rid, nodes: daemons.map((d) => `http://127.0.0.1:${d.port}`),
    close: async () => { for (const d of daemons) await d.close(); } };
}

const callers = (dir) => readdirSync(ROOT + dir).filter((f) => f.endsWith('.js'))
  .filter((f) => readFileSync(ROOT + dir + f, 'utf8').includes('claimKeyIsAttested(')).length;

test('MEASURED: no seat serves a signed claim key, the page has no way to check one, and its entry names a zero attestation', async () => {
  const f = await federationRound();
  try {
    const door = await fetch(`${f.nodes[0]}/claim-key?round=${toHex(f.rid)}`);
    const bundled = require('../dist/blwp-client.js');
    const entry = entryFor(f.round, { seed: b32(0x51), curve: pageCurve, random: (n) => new Uint8Array(n).fill(7) });
    const facts = {
      claimKeyDoor: door.status,
      pageChecks: typeof bundled.attestedClaimKey === 'function',
      entryRefIsZero: entry.claimKeyAttestationRef.every((b) => b === 0),
      callers: { node: callers('packages/blwp-node/src/'), client: callers('packages/blwp-client/src/') },
    };
    console.log('  FACTS (a paying federation round, 2 seats):', JSON.stringify(facts));
    assert.deepEqual(facts, { claimKeyDoor: 404, pageChecks: false, entryRefIsZero: true, callers: { node: 0, client: 0 } });
  } finally { await f.close(); }
});
