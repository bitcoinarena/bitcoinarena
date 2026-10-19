// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A PAYING FEDERATION ROUND OPENS ONLY ON A FEDERATION WITH TWO DISTINCT LIVE GATEWAYS (§23.6: "deposits and
// withdrawals through any of at least two gateways ... run by different operators"; RULED 2026-09-23).
//
// The count is read through the signer node's own lock port, as the guardians are: the names the federation's
// guardians registered, each with the Lightning node key it answered `routing_info` with. Identity is that key;
// two names on one key are one gateway; a name that does not answer is none. Under two, `POST /round` refuses
// by name, stores nothing, and the round is 404. Inbound is not read here - a deposit through each gateway is
// where it is shown (the own-federation probe) - and a free round is not refused for any of this.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { openStore } from '../src/store.js';
import { serve } from '../src/server.js';
import { contractFor, opts, b32 } from './window-fixture.js';
import { lockPort, bondedChainSlot, bondedChainFor } from './lock-fixture.js';
import { encodeRoundContract, roundId } from '../../arena-protocol/src/contracts.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { HOSTED } from './plugins/hosted.js';

const KEY_A = '02' + 'a1'.repeat(32);
const KEY_B = '03' + 'b2'.repeat(32);
const gw = (url, key, live = true) => ({ url, live, lightningPublicKey: live ? key : null });

async function opened(gateways, { stakeMsat } = {}) {
  // ON A CHAIN THAT BONDS THE ROUND'S TWO NODES (RULED 2026-09-25): the one daemon and a keyless placeholder, so the claim
  // key is claimKeyFor's. Only the round's censusRoot changes.
  const slot = bondedChainSlot(lockPort({ gateways }));
  const d = await serve(openStore(':memory:'), { plugins: HOSTED, port: 0, ...opts, stakeLocks: slot.port, chainFor: slot.chainFor,
    randomnessFor: slot.randomnessFor, claimKeyFor: () => new Uint8Array(33).fill(2) });
  try {
    const drafted = { ...contractFor([d.round.pubkey, b32(0x33)], 3000n, ['wss://r.example']),
      ...(stakeMsat !== undefined ? { stakeMsat } : {}) };
    const c = { ...drafted, censusRoot: bondedChainFor(drafted.nodes, drafted, slot,
      { endpoints: [`ws://127.0.0.1:${d.port}`] }).censusRoot };
    const r = await fetch(`http://127.0.0.1:${d.port}/round`, { method: 'POST', body: encodeRoundContract(c) });
    const why = (await r.text()).trim();
    const held = (await fetch(`http://127.0.0.1:${d.port}/round?id=${toHex(roundId(c))}`)).status;
    const stored = d.round.db.prepare('SELECT COUNT(*) AS n FROM rounds').get().n;
    return { status: r.status, why, held, stored };
  } finally { await d.close(); }
}

const refusedUnderTwo = (got, n, label) => {
  console.log(`  ${label}: ${got.status} "${got.why.slice(0, 120)}" held ${got.held} stored ${got.stored}`);
  assert.equal(got.status, 409, `${label}: ${got.why}`);
  assert.match(got.why, new RegExp(`that round's federation has ${n} distinct live gateway\\(s\\).*a paying round needs at least two, run by different operators \\(§23\\.6\\)`));
  assert.equal(got.held, 404, `${label}: the refused round exists on the signer node`);
  assert.equal(got.stored, 0, `${label}: something of the refused round was stored`);
};

test('under two distinct live gateways a paying round is refused by name, stores nothing, and is 404: none, one, two names on one node, one of two not answering', async () => {
  refusedUnderTwo(await opened([]), 0, 'no gateway');
  refusedUnderTwo(await opened([gw('http://a/', KEY_A)]), 1, 'one gateway');
  refusedUnderTwo(await opened([gw('http://a/', KEY_A), gw('http://a-again/', KEY_A)]), 1, 'two names on one node');
  refusedUnderTwo(await opened([gw('http://a/', KEY_A), gw('http://b/', KEY_B, false)]), 1, 'one answering, one not');
});

test('two distinct live gateways open the paying round, and a third name on one of their nodes does not stop it', async () => {
  for (const [label, list] of [
    ['two independent', [gw('http://a/', KEY_A), gw('http://b/', KEY_B)]],
    ['two independent and a second name on one', [gw('http://a/', KEY_A), gw('http://b/', KEY_B), gw('http://a-again/', KEY_A)]],
  ]) {
    const got = await opened(list);
    console.log(`  ${label}: ${got.status} held ${got.held}`);
    assert.equal(got.status, 201, `${label}: ${got.why}`);
    assert.equal(got.held, 200, `${label}: the opened round is not held`);
  }
});

test('a free round is not refused for its federation\'s gateways', async () => {
  const got = await opened([], { stakeMsat: 0n });
  assert.equal(got.status, 201, got.why);
  assert.equal(got.held, 200);
});
