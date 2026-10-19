// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE WITHDRAWN CUSTODY'S ON-CHAIN POOL PAYOUT IS GONE (§23.6, RULED 2026-09-22 22:59; this cut RULED 2026-09-25:
// "Cut the on-chain pool payout and those four tools now ... Do not relabel them FEDERATION").
//
// A federation round pays its winners through its own lock settlement - the federation's contracts - and never through a
// committee pool output on chain. That pool payout only ever ran after the hold invoice's settle, and nothing writes a
// PAYOUT_QUEUED row any more. MEASURED before this test (2026-09-25): every daemon still built Payouts, PoolSigning and
// PoolWatch, ran payouts.reconcile() and payouts.settleAllQueued() at every start when it could spend, served /payout,
// /pool/commit and /pool/share; main.js read the census for every PAYOUT_QUEUED round; and four regtest tools drove that
// path (cut 6b had relabelled them FEDERATION - wrongly: no federation round is paid that way).
//
// What stays: askerOrder / eligibleAsker (the lock settlement's asker, settlement.js), the node's DKG (the round's claim
// key), and the store's old payout tables (a store is not rewritten).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

import { openStore } from '../src/store.js';
import { serve } from '../src/server.js';
import { opts } from './window-fixture.js';
import { HOSTED } from './plugins/hosted.js';

const HERE = new URL('../', import.meta.url).pathname;
const TOOLS = ['payout-regtest.mjs', 'payout-committee-regtest.mjs', 'settle-regtest.mjs', 'settle-crash-regtest.mjs'];

test('a daemon serves no pool payout door: /payout, /pool/commit and /pool/share are no such door', async () => {
  const d = await serve(openStore(':memory:'), { plugins: HOSTED, port: 0, ...opts });
  try {
    const base = `http://127.0.0.1:${d.port}`;
    const rid = '00'.repeat(32);
    // THE DOOR ITSELF, not a 404 from inside it: an unknown round answers 404 too ("this node holds no such round").
    const ask = async (path, init) => { const r = await fetch(base + path, init); return `${r.status} ${(await r.text()).trim().slice(0, 40)}`; };
    const said = {
      payout: await ask(`/payout?round=${rid}`),
      commit: await ask('/pool/commit', { method: 'POST', body: new Uint8Array(8) }),
      share: await ask('/pool/share', { method: 'POST', body: new Uint8Array(8) }),
    };
    console.log('  FACTS (pool payout doors):', JSON.stringify(said));
    assert.deepEqual(said, { payout: '404 no such door', commit: '404 no such door', share: '404 no such door' });
  } finally { await d.close(); }
});

test('no server path builds, reconciles or sweeps the pool payout, and main.js reads no census for it', () => {
  const server = readFileSync(HERE + 'src/server.js', 'utf8');
  const main = readFileSync(HERE + 'src/main.js', 'utf8');
  const found = [
    ...['new Payouts(', 'new PoolSigning(', 'new PoolWatch(', '.reconcile()', '.settleAllQueued(', "from './pool-signing.js'",
      "from './pool-watch.js'", 'PAYOUT_QUEUED'].filter((s) => server.includes(s)).map((s) => `server.js: ${s}`),
    ...["from './pool-watch.js'", 'chainSpendOver', 'PAYOUT_QUEUED'].filter((s) => main.includes(s)).map((s) => `main.js: ${s}`),
  ];
  assert.deepEqual(found, []);
});

test('the pool payout\'s modules and its four regtest tools do not exist', () => {
  const there = [...['src/pool-signing.js', 'src/pool-watch.js'], ...TOOLS.map((t) => `tools/${t}`)].filter((p) => existsSync(HERE + p));
  assert.deepEqual(there, []);
});
