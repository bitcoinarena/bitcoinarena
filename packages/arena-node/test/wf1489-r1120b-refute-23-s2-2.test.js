// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 refute #2981 (skeptic 2): THE 64 MiB BOUND COUNTS ANSWER BODIES, NOT KEYS. doorCacheKey re-encodes each kept parameter with
// encodeURIComponent, so a `+` in the query (read as a space) becomes `%20` in the key: 3 key bytes per request byte. GET /served keeps
// label/n/count/height in its key though it reads none of them, and an empty window answers 200 with a tiny body. A stranger sends 2048
// queries of ~15.5 KB of '+' in label= with a distinct n=: 2048 entries of ~46 KB keys stay for 60 s, uncounted by DOOR_CACHE_BYTES.
// Safe: the door cache's whole memory (keys included) stays inside DOOR_CACHE_BYTES (64 MiB).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import v8 from 'node:v8';
import vm from 'node:vm';
import { serve } from '../src/server.js';
import { openStore } from '../src/store.js';
import { opts } from './window-fixture.js';
import { HOSTED } from './plugins/hosted.js';

v8.setFlagsFromString('--expose-gc');
const gc = vm.runInNewContext('gc');

test('refute #2981 s2-2: long re-encoded keys of GET /served are held outside the 64 MiB bound', async () => {
  const a = await serve(openStore(':memory:'), { plugins: HOSTED, port: 0, ...opts });
  try {
    const base = `http://127.0.0.1:${a.port}`;
    const to = Date.now() - 3600000, from = to - 60000;
    const pad = '+'.repeat(15500);
    const probe = await fetch(`${base}/served?to=${to}&from=${from}&label=${pad}&n=x`);
    assert.equal(probe.status, 200);
    const bodyBytes = (await probe.arrayBuffer()).byteLength;
    gc(); await new Promise((go) => setTimeout(go, 100)); gc();
    const before = process.memoryUsage();
    const K = 2048;
    for (let i = 0; i < K; i++) {
      const r = await fetch(`${base}/served?to=${to}&from=${from}&label=${pad}&n=${i}`);
      assert.equal(r.status, 200);
      await r.arrayBuffer();
    }
    gc(); await new Promise((go) => setTimeout(go, 300)); gc();
    const after = process.memoryUsage();
    const grewMB = ((after.arrayBuffers + after.heapUsed) - (before.arrayBuffers + before.heapUsed)) / 1048576;
    console.log(`  FACTS: body ${bodyBytes} B each (${(K * bodyBytes / 1048576).toFixed(1)} MB counted); ${K} stranger queries with ${pad.length} '+' in label=; heap+buffers grew ${grewMB.toFixed(1)} MB`);
    assert.ok(grewMB < 64, `the door cache holds ${grewMB.toFixed(1)} MB though DOOR_CACHE_BYTES is 64 MiB: the keys (3x the query, label= never read by /served) are not counted`);
  } finally { await a.close?.(); }
});
