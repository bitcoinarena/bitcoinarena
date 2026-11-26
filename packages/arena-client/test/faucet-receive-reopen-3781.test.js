// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// KANBAN #3781 (feedback #511, UI 762, 2026-11-25 20:18Z): the second "Get 300 sats" made its invoice in the player wallet, the faucet paid it
// (payer b SUCCEEDED, gateway a settled the HOLD invoice, LNv2 contract funded in 337ae01a) and the page said "The faucet paid. Your 300 sats arrive in a
// few seconds ..." - nothing was credited and no history row came. The player wallet is freshWallet's wrapper (#3237): a write another client made
// to the wallet's storage makes the next balance read (FRESH_SPENDS) open the wallet again from storage, and every call after it goes to the new
// client. The receive was made by the client before; its wait (awaitReceive) went to the new one, which holds no such operation in memory.
// The wait of an operation is now asked of the client that made it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openPlayerWallet, walletStoreFor, walletSecretFor } from '../src/page-lock.js';
import { TEST_FEDERATION_ID } from '../../arena-protocol/src/test-federation.js';

const INVITE = 'fed11qgqzc2nhwden5te0vejkg6tdd9h8gepwvejkg6tdd9h8garhduhx6at5d9h8jmn9wshxxmmd9uqqzgxg6s3evnr6m9zdxr6hxkdkukexpcs3mn7mj3g5pc5dfh63l4tj6g9zk4er';
const storage = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k),
  key: (i) => [...m.keys()][i] ?? null, get length() { return m.size; } }; };
const seed = new Uint8Array(32).fill(0x51);

// a lock client whose receive operations live in its memory (its state machines), as the wasm client's do
function lockClient() {
  let n = 0;
  const clients = [];
  return {
    clients,
    join: async () => {
      const ops = new Map(), id = clients.length;
      const c = {
        id,
        balanceMsat: async () => '0',
        receive: async (msat) => { const operation = `op${id}-${++n}`; ops.set(operation, msat); return JSON.stringify({ invoice: `lntb${msat}`, operation }); },
        awaitReceive: async (op) => { if (!ops.has(op)) throw new Error(`Operation not found: ${op}`); return 'Claimed'; },
      };
      clients.push(c);
      return c;
    },
  };
}

test('#3781 a receive made before the wallet was opened again is awaited on the client that made it - the faucet\'s 300 sat are claimed', async () => {
  const S = storage(), L = lockClient();
  const w = await openPlayerWallet({ federationId: TEST_FEDERATION_ID, invite: INVITE, seed, LockClient: L, storage: S });
  const got = JSON.parse(await w.receive('300000', ''));
  // another client wrote this wallet's storage (another tab, or an older client of this tab still running), so the next balance read opens it again
  const other = walletStoreFor(S, TEST_FEDERATION_ID, walletSecretFor(seed, TEST_FEDERATION_ID));
  other.entries(); other.put('aa01', '1');
  await w.balanceMsat();
  assert.equal(L.clients.length, 2, 'the wallet was opened again from storage');
  let final;
  try { final = await w.awaitReceive(got.operation); } catch (e) { final = `rejected: ${e.message}`; }
  console.log(`  MEASURED #3781: receive on client ${got.operation.slice(2, 3)}, wait answered ${final}`);
  assert.equal(final, 'Claimed');
});
