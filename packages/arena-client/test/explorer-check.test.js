// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A SECOND, INDEPENDENT VIEW OF THE CHAIN (§5A.4): the explorer names the same block at the census height, or the round is
// refused by name; an unreachable explorer is said, never taken as agreement.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { explorerAgrees, displayHash } from '../src/explorer-check.js';

const internal = Uint8Array.from({ length: 32 }, (_, i) => i);
const shown = displayHash(internal);

test('the explorer agrees, disagrees by name, or cannot be asked', async () => {
  assert.equal(shown.slice(0, 4), '1f1e', 'explorers write the hash reversed');
  const answering = (byHeight) => async (url) => { const h = Number(url.split('/').pop()); return byHeight[h] ? { ok: true, text: async () => byHeight[h] } : { ok: false, status: 404 }; };
  const yes = await explorerAgrees({ base: 'https://x/testnet4/api', points: [{ height: 156400, hash: internal }], fetcher: answering({ 156400: shown + '\n' }) });
  assert.equal(yes.ok, true); assert.equal(yes.checked, 1);
  const no = await explorerAgrees({ base: 'https://x/api', points: [{ height: 156400, hash: internal }], fetcher: answering({ 156400: 'ab'.repeat(32) }) });
  assert.equal(no.ok, false); assert.equal(no.mismatch, true); assert.match(no.why, /not one chain, the round is refused/);
  const down = await explorerAgrees({ base: 'https://x/api', points: [{ height: 1, hash: internal }], fetcher: async () => { throw new Error('offline'); } });
  assert.equal(down.ok, false); assert.equal(down.unreachable, true); assert.equal(down.mismatch, undefined);
  assert.equal((await explorerAgrees({ base: null, points: [] })).unreachable, true);
});
