// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// wf1489 r24 census-1 (bypass of the #2792 fix, P4/P5 turned around): the #2792 cap on POST /proposal is ONE global window of
// DOOR_CENSUS_KEYS (4) new (network, height) census reads a minute, shared by every poster. A stranger with no bond self-signs 4
// proposals naming 4 real block hashes of other heights and posts them at the start of each minute: the window is full, and every
// honest bonded proposer posting its real proposal (its deposit at a 5th height) is answered 503 "ask again shortly" - every minute,
// at every seat the stranger also posts to. The proposal never gets kept anywhere (the peer pull only spreads what a seat holds),
// misses its review window and fails: one stranger censors the whole config ballot for 4 requests a minute per seat.
// SAFE: a stranger's unbonded posts do not shut the door on a bonded proposer's proposal.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { createProposals } from '../src/proposals.js';
import { encodeConfigProposalBody, configHashOf, proposalBodyId, CLASS } from '../../arena-protocol/src/ballot.js';
import { BALLOT_GENESIS } from '../../arena-protocol/src/ballot-chain.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const NET = new Uint8Array(32).fill(0x4e);
const keyOf = (i) => { const sec = new Uint8Array(32).fill(0x60); sec[31] = i + 1; return sec; };
const HONEST = 9;
const honestPk = schnorr.getPublicKey(keyOf(HONEST));
const proposalHex = (i) => {
  const sec = keyOf(i);
  const config = Uint8Array.of(4, i);
  const p = { networkId: NET, parent: BALLOT_GENESIS.configHash, configHash: configHashOf(config), config, class: CLASS.DESIGN,
    activationHeight: 9000 + i, proposer: schnorr.getPublicKey(sec), depositTxid: new Uint8Array(32).fill(i + 1) };
  return toHex(Uint8Array.from([...encodeConfigProposalBody(p), ...schnorr.sign(proposalBodyId(p), sec)]));
};

test('wf1489 r24 census-1: four unbonded stranger posts do not lock a bonded proposer out of POST /proposal', async () => {
  const proposals = createProposals({
    confirmedTx: async () => null,
    blockHeightOf: async (hash) => 4000 + parseInt(hash.slice(0, 4), 16),
    // the census at the honest proposer's deposit height bonds it; the stranger's key is bonded nowhere
    censusAt: async (net, h) => (h === 4000 + 0x0100 ? [{ pubkey: honestPk, bondSats: 100000000n }] : []),
    recipientsFor: (net) => (net === toHex(NET) ? [] : null),
    lowestBondMinSatsFor: () => 50000n,
    verify: (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } },
    store: { read: () => [], write: () => {} },
    censusNow: () => [{ pubkey: honestPk, bondSats: 100000000n }],   // kanban #2831: the census the seat holds now names the honest proposer
  });
  // the stranger: 4 self-signed proposals, 4 block hashes of 4 old heights
  for (let i = 0; i < 4; i++) {
    const got = await proposals.add({ proposal: proposalHex(i), blockHash: (i + 1).toString(16).padStart(4, '0') + 'ab'.repeat(30) });
    assert.equal(got.ok, false);
  }
  // the honest bonded proposer, its deposit at height 4256
  const honest = await proposals.add({ proposal: proposalHex(HONEST), blockHash: '0100' + 'cd'.repeat(30) });
  console.log(`  honest bonded proposal after 4 stranger posts: ${honest.status} ${honest.why}`);
  assert.notEqual(honest.status, 503, `the bonded proposer is shut out: ${honest.why}`);
  // and an unbonded stranger past the window is still held to it (kanban #2831: the budget stands for posters the census does not name)
  const fifth = await proposals.add({ proposal: proposalHex(5), blockHash: '0007' + 'ab'.repeat(30) });
  assert.equal(fifth.status, 503, `a fifth stranger height is read anyway: ${fifth.status} ${fifth.why}`);
});
