// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// wf1489 r21 census-1 (P5, bypass of the #2685 fix): POST /round's bond_min floor check (server.js bondMinFloorFor) reads the census of the
// POSTED contract at its census height and at six points across the notice before it - roster.censusFor(rid, h, { asRoundsOwn: false,
// posted }), which is never kept in the roster (it returns before the memo) - and keeps only the median, keyed (since #2685) by network,
// version, BOND_MIN and depth. So every free round a stranger posts with a fresh bond_min (no creator, no funding, no auth: the check runs
// before anything else is asked of the round) is up to seven fresh whole-view census derivations on the seat's event loop
// (roster.js measured 0.5-2.7 s each on a ~2,000-block view). The proposals door holds the same derivation to a budget (#2792 / #2840:
// DOOR_CENSUS_KEYS new reads a minute); this door has none.
// Safe behaviour: a stranger's burst of throw-away rounds does not start a census derivation per round per notice point.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lockPort, bondedChainSlot, bondedChainFor } from './lock-fixture.js';
import { TRUCK_V3_CONFIG_HASH } from '../../nextblock/plugin/nextblock.js';
import { openStore } from '../src/store.js';
import { serve } from '../src/server.js';
import { contractFor, opts, b32 } from './window-fixture.js';
import { encodeRoundContract } from '../../arena-protocol/src/contracts.js';
import { TEST_FEDERATION_ID } from '../../arena-protocol/src/test-federation.js';
import { HOSTED } from './plugins/hosted.js';

test('a stranger posting throw-away rounds with fresh bond_min values does not make the seat derive seven censuses per post', async () => {
  const slot = bondedChainSlot(lockPort());
  let reads = 0;
  const chainFor = (a = {}) => { if (a.contract && Number(a.contract.censusHeight) !== 900000) reads++; return slot.chainFor(a); };
  const d = await serve(openStore(':memory:'), { plugins: HOSTED, port: 0, stakeLocks: slot.port, ...opts, chainFor,
    randomnessFor: slot.randomnessFor, claimKeyFor: () => new Uint8Array(33).fill(2) });
  try {
    const base = `http://127.0.0.1:${d.port}`;
    const nodes = [d.round.pubkey, b32(0x33), b32(0x34)];
    const drafted = { ...contractFor(nodes, 3000n, ['wss://r.example']), custody: 'FEDERATION', federationId: TEST_FEDERATION_ID, protocolVersion: 3 };
    const { censusRoot } = bondedChainFor(drafted.nodes, drafted, slot, { endpoints: [`ws://127.0.0.1:${d.port}`], protocolVersions: [1, 2, 3], declares: { bondMinSats: 80000n, proposalDepositSats: 100000n } });
    const POSTS = 12;
    const t0 = performance.now();
    const statuses = [];
    for (let i = 0; i < POSTS; i++) {
      // a free round, no creator: only its bond_min (and so its id) differs
      const c = { ...drafted, censusRoot, federationId: new Uint8Array(32), stakeMsat: 0n, configHash: TRUCK_V3_CONFIG_HASH, bondMinSats: 100000n + BigInt(i), slashMinimumServed: 50 + i };
      const x = await fetch(`${base}/round`, { method: 'POST', body: encodeRoundContract(c) });
      statuses.push(x.status); await x.text();
    }
    const ms = performance.now() - t0;
    console.log(`${POSTS} stranger POST /round (statuses ${[...new Set(statuses)].join(',')}): ${reads} census reads below the census height, ${ms.toFixed(0)} ms`);
    // on febed5955: 120 census reads (10 notice points a post on regtest, 7 on testnet4 / mainnet) - each a whole-view derivation on a live seat
    assert.ok(reads <= 20, `${POSTS} throw-away rounds from a stranger made the seat derive ${reads} censuses at notice heights - one per post per point, no budget`);
  } finally { await d.close(); }
});
