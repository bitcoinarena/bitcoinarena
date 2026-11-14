// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// WF1489 CLIENT-2: THE OWED SCAN (findOwedRounds, every page load's "rounds owed to this browser") TRUSTS ONE SEAT'S /settled.
// (a) The seats are read one after another with no timeout: one seat that accepts the request and never answers stalls the scan
//     for good - a winner whose tab closed is never shown the payout the honest seats list.
// (b) No limit on one seat's list: every listed round id costs 33 key derivations per kept phrase; one seat listing thousands of
//     made-up ids burns the page's thread for minutes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as PL from '../src/page-lock.js';
import { playerFor } from '../src/join.js';
import { pageCurve } from '../src/page-curve.js';
import { refundKeyOf } from '../../arena-protocol/src/stake-lock.js';
import { decodeRoundContract, encodeRoundContract, roundId } from '../../arena-protocol/src/contracts.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { signedSeats } from './settled-signed.js';   // kanban #2108: seats sign their /settled answers

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

test('wf1489-client-2a: one seat that never answers /settled does not stall the owed scan (the honest seats list the payout)', async () => {
  PL.forgetOwedRounds();
  const fetcher = (url) => (url.startsWith('https://liar') ? new Promise(() => {}) : Promise.resolve(honest(url)));
  const scan = PL.findOwedRounds({ seed, curve: pageCurve, nodes: ['https://liar', 'https://h1', 'https://h2'], ...signedSeats(fetcher, ['https://liar', 'https://h1', 'https://h2']), sinceMs: 0 });
  let t; const LIMIT = 30000;
  const res = await Promise.race([scan.then((f) => ({ found: f })), new Promise((r) => { t = setTimeout(() => r({ stalled: true }), LIMIT); })]);
  clearTimeout(t);
  console.log('  FACTS owed scan with one silent seat:', res.stalled ? `still waiting after ${LIMIT} ms` : `${res.found.length} round(s) found`);
  assert.ok(!res.stalled, `one seat that never answers stalled the owed scan for more than ${LIMIT} ms`);
  assert.deepEqual(res.found.map((f) => f.roundIdHex), [id]);
});

test('wf1489-client-2b: one seat listing 3000 made-up settled rounds does not cost the page 3000 x 33 key derivations', async () => {
  PL.forgetOwedRounds();
  const fake = Array.from({ length: 3000 }, (_, i) => ({ id: (i + 1).toString(16).padStart(64, '0'), payouts: [], refunds: [] }));
  const fetcher = async (url) => (url.startsWith('https://liar') && url.includes('/settled?') ? { ok: true, json: async () => ({ rounds: fake }) } : honest(url));
  let derived = 0;
  const curve = { ...pageCurve, pointX: (s) => { derived += 1; return pageCurve.pointX(s); } };
  const t0 = Date.now();
  const found = await PL.findOwedRounds({ seed, curve, nodes: ['https://liar', 'https://h1'], ...signedSeats(fetcher, ['https://liar', 'https://h1']), sinceMs: 0 });
  const ms = Date.now() - t0;
  console.log(`  FACTS one seat listing 3000 fake rounds: ${derived} key derivations, ${ms} ms of the page's thread, ${found.length} found`);
  assert.deepEqual(found.map((f) => f.roundIdHex), [id]);
  // the safe bound: the rounds the honest seats list (1) and a bounded share of one seat's list - never one seat's whole list x 33
  assert.ok(derived <= 1000 * 33, `one seat's list made the page derive ${derived} keys (${ms} ms)`);
});
