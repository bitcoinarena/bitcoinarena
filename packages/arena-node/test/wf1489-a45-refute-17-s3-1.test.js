// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// #1489 a45-refute-17 skeptic 3, test 1: head-of-line in the honest relay's own lane. Lanes are per host and FIFO, and pump() looks
// only at a lane's head: when the head is an unproven URL and the unproven slots are full, the lane is skipped whole. A stranger
// fills the 24 unproven slots with silent relays (3 one-sat zaps) and names the honest relay under another path (ws://host:port/x,
// a URL never proven, though it answers at once). The honest receipt to the PROVEN relay waits behind it the full 10 s; the
// reserved slots stand idle.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { relay, address, sleep } from './wf1489-a45-refute-17-s2-common.js';

test('#1489 a45-refute-17-s3-1: a stranger\'s unproven URL on the honest relay\'s host does not hold the honest receipt', { timeout: 60000 }, async () => {
  const silent = []; for (let i = 0; i < 24; i++) silent.push(await relay({ answer: false }));
  const good = await relay();
  const { z, zap, receiptOf } = await address();
  try {
    await zap([good.url]); await z.watch(); await sleep(300);          // the honest relay is proven
    for (let i = 0; i < 3; i++) await zap(silent.slice(i * 8, i * 8 + 8).map((s) => s.url));   // 24 unproven slots held 10 s
    await zap([`${good.url}x`]);                                       // 1 sat: same host:port, a new path, never proven
    const mine = await zap([good.url]);
    const t0 = Date.now();
    await z.watch();
    const receipt = receiptOf(mine);
    await sleep(3000);
    const at = good.seen.get(receipt.id);
    console.log(`after 3 s the honest receipt ${at ? `reached its relay at +${at - t0} ms` : 'has NOT reached its proven relay: stuck behind a stranger\'s unproven URL at the head of the same host lane'}`);
    assert.ok(at, 'the honest receipt to a proven relay waited behind an unproven head in its host lane');
  } finally {
    await z.close();
    for (const s of silent) await s.close();
    await good.close();
  }
});
