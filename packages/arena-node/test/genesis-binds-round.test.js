// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A ROUND CONTRACT BOUND TO ITS GENESIS AT THE SEAT (§5A.7 / §27A.62026-10-16: "On a test genesis that binds,
// a deviating contract is refused by the seat and by the client, by parameter name"). The binding genesis is mainnet's shape built from
// stand-in launch inputs inside this test - no mainnet genesis exists in this build; testnet4's does not bind.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lockPort, bondedChainSlot, bondedChainFor } from './lock-fixture.js';
import { TRUCK_V3_CONFIG_HASH } from '../../nextblock/plugin/nextblock.js';
import { openStore } from '../src/store.js';
import { serve } from '../src/server.js';
import { contractFor, opts, b32 } from './window-fixture.js';
import { encodeRoundContract } from '../../arena-protocol/src/contracts.js';
import { mainnetGenesis } from '../../arena-protocol/src/genesis.js';
import { HOSTED } from './plugins/hosted.js';

const { genesis } = mainnetGenesis({ bondMarker: b32(1), arbitrationKeys: [2, 3, 4, 5, 6, 7, 8].map(b32), authorityPubkey: b32(9), recoveryPubkey: b32(10),
  genesisSeriesStartMs: 1800000000000n, bondMinGuardianSats: 1_000_000n });

test('a seat whose genesis binds refuses a contract by the parameter it names otherwise; the same seat unbound takes it', async () => {
  for (const [bound, want] of [[false, 201], [true, 409]]) {
    const slot = bondedChainSlot(lockPort());
    const d = await serve(openStore(':memory:'), { plugins: HOSTED, port: 0, stakeLocks: slot.port, ...opts, chainFor: slot.chainFor,
      randomnessFor: slot.randomnessFor, claimKeyFor: () => new Uint8Array(33).fill(2), ...(bound ? { genesis } : {}) });
    try {
      const drafted = { ...contractFor([d.round.pubkey, b32(0x33)], 3000n, ['wss://r.example']), federationId: new Uint8Array(32), stakeMsat: 0n, configHash: TRUCK_V3_CONFIG_HASH };
      const c = { ...drafted, censusRoot: bondedChainFor(drafted.nodes, drafted, slot, { endpoints: [`ws://127.0.0.1:${d.port}`] }).censusRoot };
      const r = await fetch(`http://127.0.0.1:${d.port}/round`, { method: 'POST', body: encodeRoundContract(c) });
      const text = (await r.text()).trim();
      assert.equal(r.status, want, `${bound ? 'bound' : 'unbound'}: ${text}`);
      if (bound) assert.match(text, new RegExp(`names game_verify_slots ${c.gameVerifySlots}, the genesis binds 7; settlement_slots ${c.settlementSlots}, the genesis binds 7; census_confirmations ${c.censusConfirmations}, the genesis binds 6`));
    } finally { await d.close(); }
  }
});
