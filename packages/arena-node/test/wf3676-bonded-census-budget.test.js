// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #3676, wf1489 r1 census-1 (P5, gap in #2792 / #2840 left by #2831): POST /proposal and the peer pull start at most DOOR_CENSUS_KEYS (4)
// new (network, height) census derivations a minute - but a proposer the seat's CURRENT census names is not held to that budget at
// all. One bonded node (one seat out of 7) signs one proposal and posts it, or lists it at its GET /proposals, naming a different
// real block hash each time: every honest seat derives a fresh census (chainCensusKept: a 2016-block walk and a census_kept row kept
// 3 days) per height it names - as many as it posts, every minute. The proposer's bond at its CURRENT census says nothing about
// those heights. SAFE: one poster cannot make a seat derive more than a bounded number of new censuses a minute.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { createProposals } from '../src/proposals.js';
import { encodeConfigProposalBody, configHashOf, proposalBodyId, CLASS } from '../../arena-protocol/src/ballot.js';
import { BALLOT_GENESIS } from '../../arena-protocol/src/ballot-chain.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const NET = new Uint8Array(32).fill(0x4e);
const sec = new Uint8Array(32).fill(0x61);
const pk = schnorr.getPublicKey(sec);
const config = Uint8Array.of(4, 1);
const body = { networkId: NET, parent: BALLOT_GENESIS.configHash, configHash: configHashOf(config), config, class: CLASS.DESIGN,
  activationHeight: 9000, proposer: pk, depositTxid: new Uint8Array(32).fill(7) };
const hex = toHex(Uint8Array.from([...encodeConfigProposalBody(body), ...schnorr.sign(proposalBodyId(body), sec)]));

test('wf1489 r1 census-1: one bonded proposer cannot make a seat derive a census per posted block hash', async () => {
  let derived = 0;
  const proposals = createProposals({
    confirmedTx: async () => null,
    blockHeightOf: async (hash) => 4000 + parseInt(hash.slice(0, 4), 16),
    censusAt: async () => { derived++; return [{ pubkey: pk, bondSats: 100000000n }]; },
    recipientsFor: (net) => (net === toHex(NET) ? [] : null),
    lowestBondMinSatsFor: () => 50000n,
    verify: (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } },
    store: { read: () => [], write: () => {} },
    censusNow: () => [{ pubkey: pk, bondSats: 100000000n }],      // the attacker's node is bonded now
  });
  for (let i = 0; i < 64; i++) await proposals.add({ proposal: hex, blockHash: (i + 1).toString(16).padStart(4, '0') + 'ab'.repeat(30) });
  // and the same through the peer pull: one listing of 64 copies of its record, each naming another block
  await proposals.pull(Array.from({ length: 64 }, (_, i) => ({ proposal: hex, blockHash: (i + 200).toString(16).padStart(4, '0') + 'cd'.repeat(30), publishedAt: i })));
  console.log(`  census derivations started by one bonded poster in one minute: ${derived}`);
  assert.ok(derived <= 8, `one bonded poster made the seat derive ${derived} censuses at heights it picked`);
});
