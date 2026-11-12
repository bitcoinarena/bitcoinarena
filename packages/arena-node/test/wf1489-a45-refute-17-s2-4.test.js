// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// #2362 #2371 (#1489 a45-refute-17-s2): the variants of tests 1 and 2 that the per-URL proven flag alone does not close.
// (a) The attacker's proven relays turn silent and are named again by their EXACT proven URLs (32 sends, 2 per host): a proven send
//     still in flight after ZAP_PUBLISH_SLOW_MS leaves the reserve, so the honest receipt waits at most about that long, not 10 s.
// (b) A flood of one-relay zaps, each from a FRESH payer key (so no payer is "most numerous"), paid after the honest receipt: the
//     newest send is parked, the honest one stays queued, nothing is given up, and the honest receipt reaches its relay.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { relay, address, sleep, keyPair } from './wf1489-a45-refute-17-s2-common.js';
import { ZAP_PUBLISH_SLOW_MS } from '../src/zap-address.js';

test('#2371 a: proven-then-silent relays named by their proven URLs hold the reserve at most ZAP_PUBLISH_SLOW_MS', { timeout: 60000 }, async () => {
  const evil = []; for (let i = 0; i < 16; i++) evil.push(await relay({ answer: true }));
  const good = await relay();
  const { z, zap, receiptOf } = await address();
  try {
    await zap([good.url]);
    await zap(evil.slice(0, 8).map((s) => s.url)); await zap(evil.slice(8).map((s) => s.url));
    await z.watch(); await sleep(500);
    for (const e of evil) e.answer = false;
    for (let r = 0; r < 2; r++) { await zap(evil.slice(0, 8).map((s) => s.url)); await zap(evil.slice(8).map((s) => s.url)); }
    const tEvil = Date.now();
    await z.watch();
    const mine = await zap([good.url]);
    await z.watch();
    const receipt = receiptOf(mine);
    await sleep(ZAP_PUBLISH_SLOW_MS + 2000);
    const at = good.seen.get(receipt.id);
    console.log(`honest receipt ${at ? `reached its relay at +${at - tEvil} ms after the 32 silent sends began` : 'has NOT reached its relay'}`);
    assert.ok(at && at - tEvil < ZAP_PUBLISH_SLOW_MS + 1500, 'the honest receipt waited on proven-then-silent relays past ZAP_PUBLISH_SLOW_MS');
  } finally {
    await z.close();
    for (const s of evil) await s.close();
    await good.close();
  }
});

test('#2362 b: a flood of fresh-key one-relay zaps parks its own sends, the honest receipt is sent', { timeout: 120000 }, async () => {
  const silent = []; for (let i = 0; i < 24; i++) silent.push(await relay({ answer: false }));
  const good = await relay();
  const { z, zap, logs, receiptOf } = await address();
  try {
    for (let i = 0; i < 3; i++) await zap(silent.slice(i * 8, i * 8 + 8).map((s) => s.url));
    await z.watch();
    const mine = await zap([good.url], keyPair());
    await z.watch();
    const receipt = receiptOf(mine);
    const t0 = Date.now();
    for (let k = 0; k < 1010; k++) await zap([`ws://g${k}.invalid/`], keyPair());   // 1010 sat, 1010 keys, one send each
    await z.watch();
    console.log(`flood paid by +${Date.now() - t0} ms; given up: ${logs.filter((l) => l.includes('given up')).length}`);
    for (let i = 0; i < 60 && !good.seen.get(receipt.id); i++) await sleep(250);
    const at = good.seen.get(receipt.id);
    console.log(`honest receipt ${at ? `reached its relay at +${at - t0} ms` : 'was NEVER sent'}`);
    assert.ok(at, 'the honest receipt was not sent');
    assert.equal(logs.filter((l) => l.includes(receipt.id.slice(0, 16)) && /shed|given up/.test(l)).length, 0);
  } finally {
    await z.close();
    for (const s of silent) await s.close();
    await good.close();
  }
});
