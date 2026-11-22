// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #3289: measured on the live page 2026-11-22 at 390x844, one Rock Paper Scissors load read GET /headers 16 times, 686 KB each (11 MB):
// the games screen's federation check, the lobby's round and the warm-up each read the same chain at the same moment, none kept yet. A read
// of a chain under way is now waited for by the next caller instead of read again beside it; what makes a chain (two agreeing sources, the
// anchor) is unchanged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clientCommittee } from '../src/committee.js';
import { pageCurve } from '../src/page-curve.js';
import { NETWORK_ID_TESTNET4 } from '../../arena-protocol/src/genesis-ids.js';

test('two committees of the same network asked at once: the headers are read once, not twice', async () => {
  const b = (n) => new Uint8Array(32).fill(n);
  const asked = [];
  const fetcher = (u, { signal } = {}) => new Promise((resolve, reject) => {
    asked.push(String(u));
    setTimeout(() => reject(new Error('down')), 150);
    if (signal) signal.addEventListener('abort', () => reject(new Error('aborted')));
  });
  const contract = { networkId: NETWORK_ID_TESTNET4, gameVerifySlots: 7, settlementSlots: 7, censusConfirmations: 6, censusRoot: b(4), censusHeight: 160000n, committeeTimeMs: 1n };
  const nodes = ['https://s1', 'https://s2', 'https://s3', 'https://s4'];
  const one = clientCommittee('ab'.repeat(32), contract, nodes, { curve: pageCurve, fetcher });
  const two = clientCommittee('cd'.repeat(32), contract, nodes, { curve: pageCurve, fetcher });
  await new Promise((r) => setTimeout(r, 60));
  const headers = asked.filter((u) => /\/headers/.test(u));
  assert.ok(headers.length > 0, 'the chain is read');
  assert.equal(new Set(headers).size, headers.length, `each source asked once while the read runs: ${headers.join(' ')}`);
  await Promise.allSettled([one, two]);
});
