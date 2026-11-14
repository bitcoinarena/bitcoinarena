// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// wf1489 r3 census-1 (P8/P4, §27A.2 self-binding scalars): the bond_min floor a 2026.0.3+ round must name is the census's bond-weighted
// median of the DECLARED bond_min - and census-median.js bondWeightedMedian leaves out every node that declares nothing. The installer's
// adverts declare nothing (only tools/testnet4-advert-update.mjs with ARENA_ADVERT_DECLARE does), so ONE bonded node that posts an
// advertisement update declaring bond_min = 10^12 sat is the whole median: after notice_period every honest seat refuses at POST /round
// every new round naming a realistic bond_min (and a round naming 10^12 draws nobody) - one seat freezes new rounds network-wide.
// The safe behaviour: a node holding a third of the census weight cannot move the floor alone; the round naming the bond_min the
// other two-thirds live with is taken.
import { test } from 'node:test';
import { BOND_MEDIAN_ALL_VERSION } from '../../arena-protocol/src/constants.js';
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

// lock-fixture.js bondedChainFor, with each node's own `declares` (null: the advert declares nothing, as the installer's)
function bondedChainEach(nodes, contract, slot, { endpoints = [], protocolVersions = [1, 2, 3], declaresOf = () => null } = {}) {
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
  }, { previousTxid: b32(0xa0 + i), previousVout: 0, outputKey: bondFor(key) }));
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

async function run(version) {
  const slot = bondedChainSlot(lockPort());
  const d = await serve(openStore(':memory:'), { plugins: HOSTED, port: 0, stakeLocks: slot.port, ...opts, chainFor: slot.chainFor,
    randomnessFor: slot.randomnessFor, claimKeyFor: () => new Uint8Array(33).fill(2) });
  try {
    const base = `http://127.0.0.1:${d.port}`;
    const nodes = [d.round.pubkey, b32(0x33), b32(0x34)];
    const drafted = { ...contractFor(nodes, 3000n, ['wss://r.example']), custody: 'FEDERATION', federationId: TEST_FEDERATION_ID, protocolVersion: version };
    // the attacker: node 2 alone, a third of the bonded weight, declares an absurd floor; the other two run the installer's advert (no declaration)
    const censusRoot = bondedChainEach(drafted.nodes, drafted, slot, { endpoints: [`ws://127.0.0.1:${d.port}`],
      declaresOf: (i) => (i === 2 ? { bondMinSats: 1000000000000n, proposalDepositSats: 1n } : null), protocolVersions: Array.from({ length: version }, (_, k) => k + 1) });
    const named = { ...drafted, censusRoot };
    const post = async (c) => { const x = await fetch(`${base}/round`, { method: 'POST', body: encodeRoundContract(c) }); return { status: x.status, text: (await x.text()).trim() }; };
    const free = { ...named, federationId: new Uint8Array(32), stakeMsat: 0n, configHash: TRUCK_V3_CONFIG_HASH, bondMinSats: 50000n, slashMinimumServed: 31 };
    const got = await post(free);
    return got;
  } finally { await d.close(); }
}

// kanban #2686 (Daniel 2026-11-14 "ja"): from protocol 30 every census bond counts, a node declaring nothing at its network's default
test('#2686: from protocol 30 one bonded node of three declaring bond_min 10^12 does not set the floor every new round must name (§27A.2)', async () => {
  const got = await run(BOND_MEDIAN_ALL_VERSION);
  // on b5f391bbb (and below 30): 409 "names bond_min 50000 sat, under the 1000000000000 sat in force at its census height"
  assert.equal(got.status, 201, `a round naming bond_min 50000 (what two thirds of the bonded weight declare nothing against) was refused: ${got.text}`);
});

test('#2686 control: a round below protocol 30 keeps the old median (only declaring nodes count)', async () => {
  const got = await run(3);
  assert.equal(got.status, 409, `a protocol-3 round read the new median: ${got.status} ${got.text}`);
  assert.match(got.text, /under the 1000000000000 sat in force/);
});
