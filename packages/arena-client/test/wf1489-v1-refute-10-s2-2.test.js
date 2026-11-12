// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// WF1489 v1-refute-10 skeptic 2 (kanban #1489, fix client-3): a stranger's lobby link. lobbyQuery takes any number of node=
// entries (no cap, no dedup by host), and the owed scan runs at once on the link's nodes (findTheRoundsOwed(named) before the
// lobby shows anything). One host behind eight node= spellings is eight "seats", each allowed 500 made-up ids: 8 x 500 x 33.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as PL from '../src/page-lock.js';
import { lobbyQuery } from '../src/lobby.js';
import { pageCurve } from '../src/page-curve.js';

test('wf1489-v1-refute-10-s2-2: one host behind many node= entries of a link costs the page no more than one seat', async () => {
  PL.forgetOwedRounds();
  const N = 8;
  const nodes = Array.from({ length: N }, (_, i) => `https://liar.example/s${i}`);
  const search = '?node=' + encodeURIComponent(nodes.join(',')) + '&bond=' + encodeURIComponent('https://liar.example/bond') + '&advert=' + 'ab'.repeat(64);
  let named = null;
  try { named = lobbyQuery(search); } catch (e) { named = null; console.log('  lobbyQuery refused: ' + e.message); }
  const scanNodes = named ? named.nodes : nodes;
  console.log(`  FACTS lobbyQuery kept ${named ? named.nodes.length : 0} node(s) of ${N} on one host`);
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
  await PL.findOwedRounds({ seed: new Uint8Array(32).fill(9), curve, nodes: scanNodes, fetcher, sinceMs: 0 });
  const ms = Date.now() - t0;
  console.log(`  FACTS ${scanNodes.length} node= entries on one host: ${derived} key derivations, ${ms} ms of the page's thread`);
  assert.ok(derived <= 1000 * 33, `one host behind ${scanNodes.length} node= entries made the page derive ${derived} keys (${ms} ms)`);
});
