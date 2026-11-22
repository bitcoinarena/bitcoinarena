// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// wf1489 r20 census-1 (bypass of the #2670 fix, P5): POST /proposal (public, no auth) now checks the proposer's bond BEFORE the block is
// read - by deriving the census at (the proposal's own network_id, the height of the block the poster names). Both are the stranger's
// choice: a fresh key signs its own proposal, names any real block hash and any 32-byte network id. main.js censusAt is
// chainCensusKept('ballot', net, h): a census derivation over CENSUS_LOOKBACK (2016) blocks, cached and written to census_kept under a key
// with that net and height - one new derivation (and one new DB row, kept 3 days) per request. #1818/#2270/#2339 capped exactly this for
// the guardian doors; this door has no cap.
// SAFE: a proposal naming a network this seat keeps no donation set for is refused before any census is derived, and a stranger's
// burst of proposals naming many heights does not derive a census per request.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { createProposals } from '../src/proposals.js';
import { encodeConfigProposalBody, configHashOf, proposalBodyId, CLASS } from '../../arena-protocol/src/ballot.js';
import { BALLOT_GENESIS } from '../../arena-protocol/src/ballot-chain.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const KNOWN = new Uint8Array(32).fill(0x4e);
const setup = (heightOf) => {
  const reads = new Set(); let calls = 0;
  const proposals = createProposals({
    confirmedTx: async () => null,
    blockHeightOf: async (h) => heightOf(h),
    censusAt: async (net, h) => { calls++; reads.add(`${net}:${h}`); return []; },
    recipientsFor: (net) => (net === toHex(KNOWN) ? [] : null),
    lowestBondMinSatsFor: () => 50000n,
    verify: (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } },
    store: { read: () => [], write: () => {} },
  });
  return { proposals, reads, calls: () => calls };
};
const post = (proposals, i, networkId, blockHash) => {
  const sec = new Uint8Array(32).fill(0x60); sec[31] = i + 1;
  const config = Uint8Array.of(4, i);
  const p = { networkId, parent: BALLOT_GENESIS.configHash, configHash: configHashOf(config), config, class: CLASS.DESIGN,
    activationHeight: 7000 + i, proposer: schnorr.getPublicKey(sec), depositTxid: new Uint8Array(32).fill(i + 1) };
  const sig = schnorr.sign(proposalBodyId(p), sec);
  return proposals.add({ proposal: toHex(Uint8Array.from([...encodeConfigProposalBody(p), ...sig])), blockHash });
};

test('wf1489 r20 census-1: a proposal for a network this seat keeps no donation set for derives no census', async () => {
  const s = setup(() => 4000);
  const N = 32;
  for (let i = 0; i < N; i++) {
    const net = new Uint8Array(32).fill(0x90); net[0] = i;
    const got = await post(s.proposals, i, net, 'cd'.repeat(32));
    assert.equal(got.ok, false);
  }
  console.log(`  ${N} stranger proposals, each naming a made-up network: ${s.calls()} census derivations, ${s.reads.size} distinct census_kept keys`);
  assert.equal(s.calls(), 0, `${s.calls()} census derivations (2016-block walks + a census_kept row each) for ${N} proposals of made-up networks`);
});

test('wf1489 r20 census-1: a burst of stranger proposals naming many block heights does not derive a census per request', async () => {
  const s = setup((hash) => 4000 + parseInt(hash.slice(0, 4), 16));
  const N = 32;
  for (let i = 0; i < N; i++) {
    const got = await post(s.proposals, i, KNOWN, (i + 1).toString(16).padStart(4, '0') + 'ab'.repeat(30));
    assert.equal(got.ok, false);
  }
  console.log(`  ${N} unbonded-key proposals naming ${N} block heights: ${s.reads.size} distinct census derivations`);
  assert.ok(s.reads.size <= 4, `${s.reads.size} distinct (network, height) census derivations for ${N} stranger requests`);
});
