// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// #1489 a45-refute-17 skeptic 2, test 1 (refutes c6163b6b9 "never dropped unsent"): the shed takes "the longest lane's newest
// send", but ties go to the FIRST lane in the map - the oldest waiting. A stranger whose sends each name a different host (one send
// per lane) makes every lane length 1, so the honest receipt's lane is the longest-and-first and its only send is shed: settled,
// never sent. Setup: right after a start (or any restart: `proven` is memory only) every host is unproven; 24 silent hosts hold
// the 24 unproven slots, the honest receipt waits in its own lane, and 1000 more sends to 1000 distinct hosts (125 one-sat zaps x
// 8 relays) push the queue over ZAP_PUBLISH_QUEUED.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { relay, address, sleep } from './wf1489-a45-refute-17-s2-common.js';

test('#1489 a45-refute-17-s2-1: a flood of one-send lanes does not shed the honest receipt (tie in "longest lane")', { timeout: 60000 }, async () => {
  const silent = []; for (let i = 0; i < 24; i++) silent.push(await relay({ answer: false }));
  const good = await relay();
  const { z, zap, logs, receiptOf } = await address();
  try {
    for (let i = 0; i < 3; i++) await zap(silent.slice(i * 8, i * 8 + 8).map((s) => s.url));   // 3 sat: 24 unproven slots held 10 s
    await z.watch();
    const mine = await zap([good.url]);
    await z.watch();                                                                            // the honest receipt waits
    const receipt = receiptOf(mine);
    assert.ok(receipt, 'signed');
    const t0 = Date.now();
    for (let k = 0; k < 125; k++) await zap(Array.from({ length: 8 }, (_, i) => `ws://f${k}x${i}.invalid/`));   // 125 sat
    await z.watch();
    const shed = logs.filter((l) => l.includes(receipt.id.slice(0, 16)) && l.includes('shed'));
    console.log(`flood paid by +${Date.now() - t0} ms; honest receipt shed: ${shed.length ? shed[0] : 'no'}`);
    await sleep(14000);
    const at = good.seen.get(receipt.id);
    console.log(`honest receipt ${at ? `reached its relay at +${at - t0} ms` : 'was NEVER sent (shed from the queue)'}`);
    assert.ok(at, 'the honest receipt was shed unsent: a tie in "longest lane" sheds the oldest lane\'s send');
  } finally {
    await z.close();
    for (const s of silent) await s.close();
    await good.close();
  }
});
