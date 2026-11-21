// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #2670, wf1489 r2 census-3: POST /proposal (public, no auth, no rate limit) reads this seat's bitcoind BEFORE it looks at the proposal's
// own signature: proposals.add calls confirmedTx (main.js: getblockheader + getrawtransaction(txid, false, blockHash) - bitcoind
// loads and parses the whole named block from disk) for a body whose signature is 64 junk bytes. A stranger who posts such bodies
// naming large real blocks, many at once, fills bitcoind's RPC work queue: the seat's tally, census, settlement and seating reads
// fail ("Work queue depth exceeded") - P2, accepted (read) before verified.
// SAFE: a proposal that is not signed by the key it names (or whose proposer holds no bond now) is refused before the chain is read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { createProposals } from '../src/proposals.js';
import { encodeConfigProposalBody, configHashOf, proposalBodyId, CLASS } from '../../arena-protocol/src/ballot.js';
import { BALLOT_GENESIS } from '../../arena-protocol/src/ballot-chain.js';
import { toHex } from '../../arena-protocol/src/hash.js';

test('wf1489 r2 census-3: a proposal with a junk signature is refused before this seat reads its chain', async () => {
  const stranger = schnorr.getPublicKey(new Uint8Array(32).fill(0x55));
  let chainReads = 0;
  const proposals = createProposals({
    confirmedTx: async () => { chainReads++; return null; },
    recipientsFor: () => [], lowestBondMinSatsFor: () => 50000n,
    verify: (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } },
    store: { read: () => [], write: () => {} },
  });
  const N = 50;
  for (let i = 0; i < N; i++) {
    const config = Uint8Array.of(2, i);
    const p = { networkId: new Uint8Array(32).fill(0x4e), parent: BALLOT_GENESIS.configHash, configHash: configHashOf(config), config, class: CLASS.DESIGN,
      activationHeight: 5000 + i, proposer: stranger, depositTxid: new Uint8Array(32).fill(i + 1) };
    const junkSig = new Uint8Array(64).fill(0x77);
    const got = await proposals.add({ proposal: toHex(Uint8Array.from([...encodeConfigProposalBody(p), ...junkSig])), blockHash: 'ab'.repeat(32) });
    assert.equal(got.ok, false);
  }
  console.log(`  ${N} POST /proposal bodies with a junk signature: ${chainReads} bitcoind reads (getblockheader + getrawtransaction of a whole block each)`);
  assert.equal(chainReads, 0, `${chainReads} chain reads for ${N} proposals no key signed`);
});

test('kanban #2670: a signed proposal from a key with no bond at the named block is refused before the block is read; a bonded one is read', async () => {
  const secret = new Uint8Array(32).fill(0x56), bonded = new Uint8Array(32).fill(0x57);
  const stranger = schnorr.getPublicKey(secret), node = schnorr.getPublicKey(bonded);
  let chainReads = 0, headers = 0;
  const proposals = createProposals({
    confirmedTx: async () => { chainReads++; return null; },
    blockHeightOf: async () => { headers++; return 4000; },
    censusAt: async (_net, h) => (h === 4000 ? [{ pubkey: toHex(node), amountSats: 100000000n }] : []),
    recipientsFor: () => [], lowestBondMinSatsFor: () => 50000n,
    verify: (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } },
    store: { read: () => [], write: () => {} },
  });
  const post = (pub, sec, i) => { const config = Uint8Array.of(3, i);
    const p = { networkId: new Uint8Array(32).fill(0x4e), parent: BALLOT_GENESIS.configHash, configHash: configHashOf(config), config, class: CLASS.DESIGN,
      activationHeight: 6000 + i, proposer: pub, depositTxid: new Uint8Array(32).fill(i + 1) };
    const sig = schnorr.sign(proposalBodyId(p), sec);
    return proposals.add({ proposal: toHex(Uint8Array.from([...encodeConfigProposalBody(p), ...sig])), blockHash: 'cd'.repeat(32) }); };
  for (let i = 0; i < 20; i++) { const got = await post(stranger, secret, i); assert.equal(got.ok, false); assert.match(got.why, /no active bond/); }
  assert.equal(chainReads, 0, `${chainReads} block reads for 20 proposals from a key with no bond`);
  const real = await post(node, bonded, 30);
  assert.equal(chainReads, 1, 'a bonded proposer\'s proposal is read from the chain');
  assert.match(real.why, /does not hold the deposit/);
  console.log(`  20 signed proposals from an unbonded key: ${chainReads - 1} block reads, ${headers} header reads`);
});
