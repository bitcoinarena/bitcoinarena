// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// wf1489 r25 census-1 (bypass of the #2792 census-read budget through the peer pull): POST /proposal starts at most DOOR_CENSUS_KEYS (4)
// new (network, height) census reads a minute, but proposals.pull hands every record of a peer's GET /proposals listing to add() with
// `own: true`, which skips that budget. ONE seat (any census seat the others pull from, every 10 min) lists 256 self-signed junk
// proposals (fresh keys, no deposit, no bond), each naming a real block hash at another height: every pulling seat derives 256 censuses
// (a 2016-block walk and a census_kept row each, main.js chainCensusKept) before the bond check refuses each one - per pull, per seat.
// SAFE: what a peer lists is not this seat's own pass - the pull holds a peer's records to the same census-read budget as the door.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { createProposals } from '../src/proposals.js';
import { encodeConfigProposalBody, configHashOf, proposalBodyId, CLASS } from '../../arena-protocol/src/ballot.js';
import { BALLOT_GENESIS } from '../../arena-protocol/src/ballot-chain.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const NET = new Uint8Array(32).fill(0x4e);
const proposalHex = (i) => {
  const sec = new Uint8Array(32).fill(0x61); sec[30] = (i >> 8) & 0xff; sec[31] = (i & 0xff) + 1;
  const config = Uint8Array.of(4, i & 0xff, i >> 8);
  const p = { networkId: NET, parent: BALLOT_GENESIS.configHash, configHash: configHashOf(config), config, class: CLASS.DESIGN,
    activationHeight: 90000 + i, proposer: schnorr.getPublicKey(sec), depositTxid: new Uint8Array(32).fill((i % 250) + 1) };
  return toHex(Uint8Array.from([...encodeConfigProposalBody(p), ...schnorr.sign(proposalBodyId(p), sec)]));
};

test('wf1489 r25 census-1: one peer\'s listing of junk proposals does not make this seat derive a census per record', async () => {
  const reads = new Set();
  const proposals = createProposals({
    confirmedTx: async () => null,
    blockHeightOf: async (hash) => 4000 + parseInt(hash.slice(0, 4), 16),
    censusAt: async (net, h) => { reads.add(`${net}:${h}`); return []; },
    recipientsFor: (net) => (net === toHex(NET) ? [] : null),
    lowestBondMinSatsFor: () => 50000n,
    verify: (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } },
    store: { read: () => [], write: () => {} },
  });
  // the lying seat's GET /proposals: 256 records, no id, each naming a block at another height
  const listing = Array.from({ length: 256 }, (_, i) => ({ proposal: proposalHex(i), blockHash: (i + 1).toString(16).padStart(4, '0') + 'ab'.repeat(30) }));
  const took = await proposals.pull(listing);
  console.log(`  one pull of one peer's listing: took ${took}, census derivations started: ${reads.size}`);
  assert.equal(took, 0);
  assert.ok(reads.size <= 4, `one peer's listing started ${reads.size} census derivations in one pull (the door allows 4 a minute)`);
});
