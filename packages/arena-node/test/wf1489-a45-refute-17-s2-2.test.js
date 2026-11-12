// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// #1489 a45-refute-17 skeptic 2, test 2 (refutes c6163b6b9 "a payer's silent hosts cannot hold the sends to relays that answer"):
// the attacker RUNS the relays. 16 relay hosts of its own (16 ports) answer once, fast, so each is proven; then they go silent.
// Proven hosts may take every one of the 32 slots, ZAP_PUBLISH_RESERVED included, and a host is marked unproven only when its
// send ENDS - 10 s later. 32 sends (4 one-sat zaps x 8 relays, 2 per host) hold all 32 slots, and the honest receipt to a proven,
// answering relay waits the full 10 s.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { relay, address, sleep } from './wf1489-a45-refute-17-s2-common.js';

test('#1489 a45-refute-17-s2-2: proven-then-silent relays do not hold an honest receipt to an answering relay', { timeout: 60000 }, async () => {
  const evil = []; for (let i = 0; i < 16; i++) evil.push(await relay({ answer: true }));
  const good = await relay();
  const { z, zap, receiptOf } = await address();
  try {
    await zap([good.url]);                                             // the honest relay is proven too
    await zap(evil.slice(0, 8).map((s) => s.url)); await zap(evil.slice(8).map((s) => s.url));   // 2 sat: 16 hosts proven
    await z.watch(); await sleep(500);
    for (const e of evil) e.answer = false;                            // now silent
    const paths = (p) => evil.map((s) => s.url + p);
    for (const p of ['a', 'b']) { await zap(paths(p).slice(0, 8)); await zap(paths(p).slice(8)); }   // 4 sat: 32 sends, 2 per host
    await z.watch();
    const mine = await zap([good.url]);
    const t0 = Date.now();
    await z.watch();
    const receipt = receiptOf(mine);
    await sleep(3000);
    const at = good.seen.get(receipt.id);
    console.log(`after 3 s the honest receipt ${at ? `reached its relay at +${at - t0} ms` : 'has NOT reached its proven relay: 32 proven-then-silent sends hold every slot'}`);
    assert.ok(at, 'the honest receipt waits on the attacker\'s proven-then-silent relays');
  } finally {
    await z.close();
    for (const s of evil) await s.close();
    await good.close();
  }
});
