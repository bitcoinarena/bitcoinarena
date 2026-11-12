// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// WF1489 CLIENT-3 (kanban #1489): THE OWED SCAN (findOwedRounds, every page load's "rounds owed to this browser") TRUSTS ONE SEAT'S /settled.
// No limit on one seat's list: every listed round id costs 33 key derivations per kept phrase; one seat listing thousands of
// made-up ids burns the page's thread for minutes. (The silent-seat stall of the same scan is wf1489-client-2.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as PL from '../src/page-lock.js';
import { playerFor } from '../src/join.js';
import { pageCurve } from '../src/page-curve.js';
import { refundKeyOf } from '../../arena-protocol/src/stake-lock.js';
import { decodeRoundContract, encodeRoundContract, roundId } from '../../arena-protocol/src/contracts.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';

const CONTRACT_HEX = readFileSync(new URL('./page-collect-other-seeds.test.js', import.meta.url), 'utf8').match(/CONTRACT_HEX = '([0-9a-f]+)'/)[1];
const contract = decodeRoundContract(fromHex(CONTRACT_HEX));
const id = toHex(roundId(contract));
const seed = new Uint8Array(32).fill(7);
const owedTo = toHex(refundKeyOf(playerFor({ id: fromHex(id) }, { seed, curve: pageCurve }).pubkey));
const honest = (url) => {
  if (url.includes('/settled?')) return { ok: true, json: async () => ({ rounds: [{ id, payouts: [owedTo], refunds: [] }] }) };
  if (url.includes('/round?id=')) return { ok: true, arrayBuffer: async () => encodeRoundContract(contract).buffer.slice(0) };
  return { ok: false };
};

test('wf1489-client-3: one seat listing 3000 made-up settled rounds does not cost the page 3000 x 33 key derivations', async () => {
  PL.forgetOwedRounds();
  const fake = Array.from({ length: 3000 }, (_, i) => ({ id: (i + 1).toString(16).padStart(64, '0'), payouts: [], refunds: [] }));
  const fetcher = async (url) => (url.startsWith('https://liar') && url.includes('/settled?') ? { ok: true, json: async () => ({ rounds: fake }) } : honest(url));
  let derived = 0;
  const curve = { ...pageCurve, pointX: (s) => { derived += 1; return pageCurve.pointX(s); } };
  const t0 = Date.now();
  const found = await PL.findOwedRounds({ seed, curve, nodes: ['https://liar', 'https://h1'], fetcher, sinceMs: 0 });
  const ms = Date.now() - t0;
  console.log(`  FACTS one seat listing 3000 fake rounds: ${derived} key derivations, ${ms} ms of the page's thread, ${found.length} found`);
  assert.deepEqual(found.map((f) => f.roundIdHex), [id]);
  // the safe bound: the rounds the honest seats list (1) and a bounded share of one seat's list - never one seat's whole list x 33
  assert.ok(derived <= 1000 * 33, `one seat's list made the page derive ${derived} keys (${ms} ms)`);
});
