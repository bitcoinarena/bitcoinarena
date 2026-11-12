// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// WF1489 v1-refute-10 skeptic 3 (kanban #1489, #1832): findOwedRounds groups node= entries by new URL(n).hostname. One machine has
// several hostname spellings a lobby link accepts (join.js origin): the domain, the domain with its trailing root dot, its IPv4
// literal and the IPv4-mapped IPv6 literal. Each spelling is its own "host" with its own 500-id allowance, up to the scan's 2000.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as PL from '../src/page-lock.js';
import { lobbyQuery } from '../src/lobby.js';
import { pageCurve } from '../src/page-curve.js';

test('wf1489-v1-refute-10-s3-1: one host behind its hostname spellings costs the page no more than one seat', async () => {
  PL.forgetOwedRounds();
  const nodes = ['https://liar.example/s0', 'https://liar.example./s1', 'http://192.0.2.1/s2', 'http://[::ffff:192.0.2.1]/s3'];
  const search = '?node=' + encodeURIComponent(nodes.join(',')) + '&bond=' + encodeURIComponent('https://liar.example/bond') + '&advert=' + 'ab'.repeat(64);
  const named = lobbyQuery(search);
  console.log(`  FACTS lobbyQuery kept ${named.nodes.length} node(s): ${named.nodes.join(' ')}`);
  const fetcher = async (url) => {
    if (url.includes('/settled?')) {
      const k = Number((url.match(/\/s(\d+)\/settled/) || [0, 0])[1]);
      const fake = Array.from({ length: 500 }, (_, i) => ({ id: (k * 100000 + i + 1).toString(16).padStart(64, '0'), madeMs: Date.now(), payouts: [], refunds: [] }));
      return { ok: true, json: async () => ({ rounds: fake }) };
    }
    return { ok: false };
  };
  let derived = 0;
  const curve = { ...pageCurve, pointX: (s) => { derived += 1; return pageCurve.pointX(s); } };
  const t0 = Date.now();
  await PL.findOwedRounds({ seed: new Uint8Array(32).fill(9), curve, nodes: named.nodes, fetcher, sinceMs: 0 });
  const ms = Date.now() - t0;
  console.log(`  FACTS ${named.nodes.length} spellings of one host: ${derived} key derivations, ${ms} ms of the page's thread`);
  assert.ok(derived <= 1000 * 33, `one host behind ${named.nodes.length} hostname spellings made the page derive ${derived} keys (${ms} ms)`);
});
