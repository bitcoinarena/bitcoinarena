// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// #1489 a45-refute-17 skeptic 2, test 3: the lane key is URL host with port, and ws:// and wss:// to the same host:port share it.
// A stranger names wss://<honest relay host:port>/ - the TLS handshake fails at once, markHost(host, false) - and the honest relay
// loses "proven" without ever failing. With 24 silent hosts holding the unproven slots (3 one-sat zaps), the next honest receipt
// to that relay waits the full 10 s.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { relay, address, sleep } from './wf1489-a45-refute-17-s2-common.js';

test('#1489 a45-refute-17-s2-3: another payer\'s wss:// URL does not unprove an honest ws:// relay', { timeout: 60000 }, async () => {
  const silent = []; for (let i = 0; i < 24; i++) silent.push(await relay({ answer: false }));
  const good = await relay();
  const { z, zap, receiptOf } = await address();
  try {
    await zap([good.url]); await z.watch(); await sleep(300);         // honest relay proven
    await zap([good.url.replace('ws://', 'wss://')]); await z.watch(); await sleep(500);   // 1 sat: fails at once, host unproven
    for (let i = 0; i < 3; i++) await zap(silent.slice(i * 8, i * 8 + 8).map((s) => s.url));
    await z.watch();
    const mine = await zap([good.url]);
    const t0 = Date.now();
    await z.watch();
    const receipt = receiptOf(mine);
    await sleep(3000);
    const at = good.seen.get(receipt.id);
    console.log(`after 3 s the honest receipt ${at ? `reached its relay at +${at - t0} ms` : 'has NOT reached its relay: unproven by a stranger\'s wss:// URL, behind 24 silent sends'}`);
    assert.ok(at, 'a stranger\'s wss:// URL to the same host:port made the honest relay unproven');
  } finally {
    await z.close();
    for (const s of silent) await s.close();
    await good.close();
  }
});
