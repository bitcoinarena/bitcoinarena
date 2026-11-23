// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// KANBAN #3237 (feedback #374/#375, "invalid input: 2-The note is already spent"): a lock client reads its wallet from storage once, when it opens,
// and spends from its copy in memory. Two tabs of one phrase each held the same notes; tab A spent them, tab B's copy still listed them and handed
// them to the federation again - refused, the buy or the stake gone with an error. The fake lock client below is that client: notes read from the
// store at join, spent from memory, removed through the store, and a federation that refuses a note spent before.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openPlayerWallet, walletStoreFor, walletSecretFor } from '../src/page-lock.js';
import { TEST_FEDERATION_ID } from '../../arena-protocol/src/test-federation.js';

const INVITE = 'fed11qgqzc2nhwden5te0vejkg6tdd9h8gepwvejkg6tdd9h8garhduhx6at5d9h8jmn9wshxxmmd9uqqzgxg6s3evnr6m9zdxr6hxkdkukexpcs3mn7mj3g5pc5dfh63l4tj6g9zk4er';
const storage = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k),
  key: (i) => [...m.keys()][i] ?? null, get length() { return m.size; } }; };

// one federation; a lock client per "tab" (the page keeps one client per LockClient and storage, so two LockClient objects on one storage are two tabs)
function federation() {
  const spent = new Set();
  let joins = 0;
  const lockClient = () => ({
    join: async (_inv, _fed, _secret, store) => {
      joins += 1;
      const notes = new Map(JSON.parse(store.entries()).filter(([k]) => k.startsWith('aa')));   // read once, as TabDatabase::load
      return {
        balanceMsat: async () => String([...notes.values()].reduce((s, v) => s + parseInt(v, 16), 0)),
        sendEcash: async (msat) => {
          const [k] = [...notes].find(([, v]) => parseInt(v, 16) >= Number(msat)) || [];
          if (!k) throw new Error('insufficient funds');
          notes.delete(k); store.remove(k);                     // the spend commits before the federation answers, as fedimint's does
          if (spent.has(k)) throw new Error('invalid input: 2-The note is already spent');
          spent.add(k);
          return JSON.stringify({ note: k });
        },
      };
    },
  });
  return { lockClient, spent, joins: () => joins };
}

const seed = new Uint8Array(32).fill(0x37);
function keptWallet(S) {
  const st = walletStoreFor(S, TEST_FEDERATION_ID, walletSecretFor(seed, TEST_FEDERATION_ID));
  st.entries();
  for (const k of ['aa01', 'aa02', 'aa03']) st.put(k, '64');   // three notes of 100 msat
  return st;
}

test('#3237 a tab whose wallet another tab spent from opens it again before it spends: no note is handed in twice', async () => {
  const S = storage(), F = federation();
  keptWallet(S);
  const open = (LockClient) => openPlayerWallet({ federationId: TEST_FEDERATION_ID, invite: INVITE, seed, LockClient, storage: S });
  const tabA = await open(F.lockClient()), tabB = await open(F.lockClient());
  assert.deepEqual(JSON.parse(await tabA.sendEcash('100')), { note: 'aa01' });
  // tab B's copy still lists aa01; before the fix it handed it in again: "The note is already spent"
  const b = JSON.parse(await tabB.sendEcash('100'));
  console.log(`  MEASURED #3237: tab A spent aa01, tab B then spent ${b.note}; joins ${F.joins()}; federation spent ${[...F.spent].join(',')}`);
  assert.notEqual(b.note, 'aa01');
  assert.equal(await tabB.balanceMsat(), '100', 'tab B reads the one note left');
  assert.equal(await tabA.balanceMsat(), '100', 'tab A reads tab B\'s spend too');
  assert.equal(F.joins(), 4, 'each tab opened once and again once after the other tab\'s write');
});

test('#3237 a wallet that was not seen to change (no mark: an older page\'s tab) and is refused as already spent opens again and spends once more - once', async () => {
  const S = storage(), F = federation();
  keptWallet(S);
  const tabB = await openPlayerWallet({ federationId: TEST_FEDERATION_ID, invite: INVITE, seed, LockClient: F.lockClient(), storage: S });
  // an older page in another tab spends aa01 and removes it from storage without the mark
  F.spent.add('aa01');
  for (let i = 0; i < S.length; i++) { const k = S.key(i); if (k.startsWith('arena.walletdb.') && k.endsWith('aa01')) { S.removeItem(k); break; } }
  const b = JSON.parse(await tabB.sendEcash('100'));
  assert.equal(b.note, 'aa02', 'refused as already spent, the wallet opened again from storage and spent another note');
  // every note spent elsewhere: refused again after the one retry, by name
  F.spent.add('aa03');
  for (let i = 0; i < S.length; i++) { const k = S.key(i); if (k.startsWith('arena.walletdb.') && k.endsWith('aa03')) { S.removeItem(k); break; } }
  await assert.rejects(tabB.sendEcash('100'), /insufficient funds|already spent/);
});

test('#3237 a submission refused behind as already spent is not made again here; the next spend opens the wallet again from storage', async () => {
  const S = storage(), F = federation();
  keptWallet(S);
  let accepted = 0;
  const base = F.lockClient();
  const LockClient = { join: async (...a) => Object.assign(await base.join(...a), {
    lockAccepted: async () => { accepted += 1; throw new Error('the federation did not accept the lock transaction: invalid input: 2-The note is already spent'); } }) };
  const w = await openPlayerWallet({ federationId: TEST_FEDERATION_ID, invite: INVITE, seed, LockClient, storage: S });
  await assert.rejects(w.lockAccepted('{}'), /already spent/);
  assert.equal(accepted, 1, 'the acceptance read once, never a second submission');
  const joinsBefore = F.joins();
  await w.balanceMsat();
  assert.equal(F.joins(), joinsBefore + 1, 'the next read opened the wallet again');
});
