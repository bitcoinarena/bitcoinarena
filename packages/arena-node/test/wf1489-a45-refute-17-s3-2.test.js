// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// #1489 a45-refute-17 skeptic 3, test 2: the lane key is new URL(relay).host, which drops a scheme's default port, so
// ws://relay.test/ (port 80) and wss://relay.test/ (port 443) share ONE lane and its ZAP_PUBLISH_PER_HOST (2) cap, though they are
// different sockets. On a relay whose port 80 is dropped by a firewall, a stranger's one-sat zap naming ws://relay.test/1..8 holds
// that lane (2 at a time, 10 s each) and the honest receipt to the proven wss://relay.test/ waits behind it: 40 s for one zap.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { address, sleep } from './wf1489-a45-refute-17-s2-common.js';

test('#1489 a45-refute-17-s3-2: silent port-80 URLs do not hold the proven wss:// relay of the same name', { timeout: 60000 }, async () => {
  const sent = new Map();
  const timers = new Set();
  const publish = async (receipt, relays) => {
    const r = relays[0];
    if (r.startsWith('wss://relay.test')) { sent.set(receipt.id, Date.now()); return; }   // the honest relay answers at once
    await new Promise((_, no) => { const t = setTimeout(() => { timers.delete(t); no(new Error('no relay answered')); }, 10000); t.unref(); timers.add(t); });
  };
  const { z, zap, receiptOf } = await address({ publish });
  try {
    await zap(['wss://relay.test/']); await z.watch(); await sleep(200);     // proven
    await zap([1, 2, 3, 4, 5, 6, 7, 8].map((i) => `ws://relay.test/${i}`));  // 1 sat, port 80 silent
    const mine = await zap(['wss://relay.test/']);
    const t0 = Date.now();
    await z.watch();
    const receipt = receiptOf(mine);
    await sleep(3000);
    const at = sent.get(receipt.id);
    console.log(`after 3 s the honest receipt ${at ? `was sent at +${at - t0} ms` : 'was NOT sent: ws://relay.test (port 80) and wss://relay.test (port 443) share one lane'}`);
    assert.ok(at, 'silent ws:// sends to the same host name held the proven wss:// relay\'s lane');
  } finally {
    await z.close();
    for (const t of timers) clearTimeout(t);
  }
});
