// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 v1-refute-22 (#1513): the byte quotas are counted in characters (SQLite LENGTH() of TEXT, JS string .length), not bytes.
// Content of 3-byte UTF-8 characters stores ~3x the author's byte quota (and ~3x TOTAL_BYTES on disk).
import test from 'node:test';
import assert from 'node:assert/strict';
import { startRelay } from '../src/nostr-relay.js';
import { key, ev, publish } from './_r22-common.mjs';

test('#1513 v1-refute-22-3: one author keeps no more than authorBytes bytes', async () => {
  const LIM = 200_000;
  const r = await startRelay({ port: 0, limits: { authorBytes: LIM } });
  const socks = [];
  try {
    const a = key();
    const evs = Array.from({ length: 30 }, (_, i) => ev(a, { at: 1_700_000_000 + i, content: '€'.repeat(20000) + i }));
    await publish(r.port, evs, socks);
    const bytes = r.events().filter((e) => e.pubkey === a.pub).reduce((s, e) => s + Buffer.byteLength(JSON.stringify(e)), 0);
    assert.ok(bytes <= LIM, `one author keeps ${bytes} bytes against a quota of ${LIM}`);
  } finally { for (const w of socks) w.terminate(); await r.close(); }
});
