// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// wf1489 r3 census-2 (P3/P8, §27A.2-3): server.js bondMinFloorFor keeps the bond-weighted median of each census height in
// `medianAtHeight`, keyed by the HEIGHT ALONE - but the census it reads is derived for the contract being posted (roster.censusFor
// with `posted`), and deriveCensus drops every bond under that contract's own bond_min (and every advert not speaking its version).
// So the first POST /round to name a height decides that height's median for every later round. A stranger posts a throw-away round
// naming bond_min = the attacker node's bond: only the attacker's bond is in that census, the median is the attacker's declared value,
// it is cached for all seven sampled heights (the throw-away round itself is then refused - after the cache is written), and the next
// honest round on those census heights is refused. With 4096 entries kept FIFO, the attacker evicts and re-poisons at will.
// Here the honest majority (two of three nodes, 2/3.5 of the bonded weight) declares 80,000 sat: the true median is 80,000.
// The safe behaviour: a round naming bond_min 80,000 is taken after the stranger's round, as it would be before.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lockPort, bondedChainSlot } from './lock-fixture.js';
import { TRUCK_V3_CONFIG_HASH, NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';
import { openStore } from '../src/store.js';
import { serve } from '../src/server.js';
import { contractFor, opts, b32 } from './window-fixture.js';
import { encodeRoundContract, decodeRoundContract } from '../../arena-protocol/src/contracts.js';
import { TEST_FEDERATION_ID } from '../../arena-protocol/src/test-federation.js';
import { HOSTED } from './plugins/hosted.js';
import { bondTransaction } from '../../arena-protocol/tools/bond.js';
import { deriveCensus } from '../../arena-protocol/src/census.js';
import { parseTransaction } from '../../arena-protocol/src/tx.js';
import { bondSetFor } from '../src/curve.js';
import { bondFor } from './curve.js';
import { toHex } from '../../arena-protocol/src/hash.js';

// lock-fixture.js bondedChainFor, with each node's own `declares` and bond value
function bondedChainEach(nodes, contract, slot, { endpoints = [], protocolVersions = [1, 2, 3], declaresOf = () => null, valueOf = () => 100000000 } = {}) {
  slot.federationId = contract.federationId;
  slot.committeeSec = Math.floor(Number(contract.committeeTimeMs) / 1000);
  slot.views.clear();
  slot.guardianKeys = nodes.map((_, i) => Uint8Array.from([0x02, ...new Uint8Array(32).fill(0x60 + i)]));
  slot.bonds = nodes.map((key, i) => bondTransaction({
    nodePubkey: key, operatorId: `operator${i}`, protocolVersions, hostedGames: [NEXTBLOCK_GAME_ID], roles: ['game', 'settlement'],
    endpoint: endpoints[i] || `ws://node${i}`, region: 'eu-west', capacityClass: 1, softwareHash: b32(2), settlementCapabilities: 0,
    lightningCapabilities: 0, bondTxid: new Uint8Array(32), bondVout: 0, bondScriptTemplateVersion: 1, payoutPubkey: b32(3),
    guardianOf: [{ federationId: contract.federationId, guardianKey: slot.guardianKeys[i] }], timestamp: 1788700000000n,
    ...(declaresOf(i) ? { declares: declaresOf(i) } : {}),
  }, { previousTxid: b32(0xa0 + i), previousVout: 0, outputKey: bondFor(key), value: valueOf(i) }));
  const view = slot.chainWith(null);
  const byTxid = new Map();
  for (const block of view.blocks) for (const raw of block.transactions) byTxid.set(toHex(parseTransaction(raw).txid), raw);
  const census = deriveCensus(view, {
    contract: decodeRoundContract(encodeRoundContract({ ...contract, censusHeight: 900000 })),
    bond: bondSetFor('regtest'),
    resolve: (e) => { const raw = byTxid.get(toHex(e.txid)); return raw ? { transaction: raw } : null; },
  });
  if (!census.ok) throw new Error(`the bonded chain derives no census: ${census.why}`);
  return census.root;
}

test('a stranger\'s throw-away round naming a high bond_min does not fix the bond_min floor of its census height for every later round', async () => {
  const slot = bondedChainSlot(lockPort());
  const d = await serve(openStore(':memory:'), { plugins: HOSTED, port: 0, stakeLocks: slot.port, ...opts, chainFor: slot.chainFor,
    randomnessFor: slot.randomnessFor, claimKeyFor: () => new Uint8Array(33).fill(2) });
  try {
    const base = `http://127.0.0.1:${d.port}`;
    const nodes = [d.round.pubkey, b32(0x33), b32(0x34)];
    const drafted = { ...contractFor(nodes, 3000n, ['wss://r.example']), custody: 'FEDERATION', federationId: TEST_FEDERATION_ID, protocolVersion: 3 };
    // nodes 0 and 1 (1 BTC each) declare 80,000 sat; node 2, the attacker (1.5 BTC, a minority of the 3.5 BTC), declares 10^12
    const censusRoot = bondedChainEach(drafted.nodes, drafted, slot, { endpoints: [`ws://127.0.0.1:${d.port}`],
      declaresOf: (i) => (i === 2 ? { bondMinSats: 1000000000000n, proposalDepositSats: 1n } : { bondMinSats: 80000n, proposalDepositSats: 100000n }),
      valueOf: (i) => (i === 2 ? 150000000 : 100000000) });
    const named = { ...drafted, censusRoot };
    const post = async (c) => { const x = await fetch(`${base}/round`, { method: 'POST', body: encodeRoundContract(c) }); return { status: x.status, text: (await x.text()).trim() }; };
    const free = (bondMinSats, more = {}) => ({ ...named, federationId: new Uint8Array(32), stakeMsat: 0n, configHash: TRUCK_V3_CONFIG_HASH, bondMinSats, ...more });
    // the stranger's round: bond_min 1.5 BTC - only the attacker's bond is in its census; refused, but after the median cache is written
    const poison = await post(free(150000000n, { slashMinimumServed: 41 }));
    assert.notEqual(poison.status, 201, 'the throw-away round itself is not the point');
    // an honest round on the same census height, naming the bond_min the census really declares
    const honest = await post(free(80000n, { slashMinimumServed: 42 }));
    // on b5f391bbb: 409 "names bond_min 80000 sat, under the 1000000000000 sat in force at its census height 900000"
    assert.equal(honest.status, 201, `after a stranger's round, an honest round naming the census median 80000 was refused: ${honest.text}`);
  } finally { await d.close(); }
});

test('control: without the stranger\'s round the same honest round is taken (the median is 80,000)', async () => {
  const slot = bondedChainSlot(lockPort());
  const d = await serve(openStore(':memory:'), { plugins: HOSTED, port: 0, stakeLocks: slot.port, ...opts, chainFor: slot.chainFor,
    randomnessFor: slot.randomnessFor, claimKeyFor: () => new Uint8Array(33).fill(2) });
  try {
    const base = `http://127.0.0.1:${d.port}`;
    const nodes = [d.round.pubkey, b32(0x33), b32(0x34)];
    const drafted = { ...contractFor(nodes, 3000n, ['wss://r.example']), custody: 'FEDERATION', federationId: TEST_FEDERATION_ID, protocolVersion: 3 };
    const censusRoot = bondedChainEach(drafted.nodes, drafted, slot, { endpoints: [`ws://127.0.0.1:${d.port}`],
      declaresOf: (i) => (i === 2 ? { bondMinSats: 1000000000000n, proposalDepositSats: 1n } : { bondMinSats: 80000n, proposalDepositSats: 100000n }),
      valueOf: (i) => (i === 2 ? 150000000 : 100000000) });
    const c = { ...drafted, censusRoot, federationId: new Uint8Array(32), stakeMsat: 0n, configHash: TRUCK_V3_CONFIG_HASH, bondMinSats: 80000n, slashMinimumServed: 42 };
    const x = await fetch(`${base}/round`, { method: 'POST', body: encodeRoundContract(c) });
    assert.equal(x.status, 201, (await x.text()).trim());
  } finally { await d.close(); }
});
