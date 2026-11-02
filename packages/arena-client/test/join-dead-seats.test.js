// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE JOIN'S READS WITH DEAD SEATS (kanban #926): after the donation set (donation-pay.test.js), the steps before a lock: the fees, the reserve key and the handout, seven seats,
// 1 to 3 of them answering 530 or 502. Each of these steps needs 5 seats, so 2 dead seats pass and 3 cannot: 5 of 7 is the rule, not a fault of the page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchFees } from '../src/fee-proposal-page.js';
import { fetchReserveKey } from '../src/reserves-page.js';
import { postHandout } from '../src/join.js';

const nodes = [1, 2, 3, 4, 5, 6, 7].map((n) => `http://127.0.0.1:${n}`);
const fed = new Uint8Array(32).fill(7), fedHex = '07'.repeat(32), KEY = `02${'ab'.repeat(32)}`;
const json = (o) => new Response(JSON.stringify(o), { status: 200 });
const seat = (status, dead) => async (url) => {
  const u = new URL(url);
  if (Number(u.port) <= dead) return new Response('error', { status });
  if (u.pathname === '/fees') return json({ atHeight: { a: 1 }, tip: 5 });
  if (u.pathname === '/reserves') return json({ federations: [{ federationId: fedHex, key: KEY }] });
  return new Response('{}', { status: 200 });
};

for (const status of [530, 502]) test(`${status}: the fees, the reserve key and the handout pass with 1 or 2 dead seats of 7, and stop at 3`, async () => {
  const facts = [];
  for (const dead of [1, 2, 3]) {
    const f = seat(status, dead);
    const t = Date.now();
    const fees = await fetchFees({ nodes, height: 5, fetcher: f });
    const key = await fetchReserveKey({ federationId: fed, nodes, fetcher: f });
    const hand = await postHandout({ body: new Uint8Array(1) }, nodes, { needed: 5, fetcher: f, graceMs: 50 });
    facts.push({ dead, fees: fees.ok, key: key.ok, handout: hand.ok, ms: Date.now() - t });
  }
  console.log(`  FACTS (${status}):`, JSON.stringify(facts));
  assert.deepEqual(facts.map((x) => [x.dead, x.fees, x.key, x.handout]), [[1, true, true, true], [2, true, true, true], [3, false, false, false]]);
  assert.ok(facts.every((x) => x.ms < 3000));
});
