// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #2779 (feedback #081): on the testnet4 federation A seats the public path <seat>/guardian is the guardian's own websocket API,
// so the seat's documented GET /guardian never reaches the seat there (405 "POST is required"). The seat answers the same at
// /guardian-info, and the API reference lists it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { openStore } from '../src/store.js';
import { serve } from '../src/server.js';
import { HOSTED } from './plugins/hosted.js';

test('#2779 GET /guardian-info answers what GET /guardian answers, guardian or not, and the API reference lists both', async () => {
  for (const guardian of [null, { endpoint: 'wss://tn4.example/guardian-1/guardian' }]) {
    const d = await serve(openStore(':memory:'), { plugins: HOSTED, port: 0, funded: () => true, guardian });
    try {
      const a = await (await fetch(`http://127.0.0.1:${d.port}/guardian`)).json();
      const r = await fetch(`http://127.0.0.1:${d.port}/guardian-info`);
      assert.equal(r.status, 200);
      assert.deepEqual(await r.json(), a);
      assert.deepEqual(a, guardian ? { guardian: true, endpoint: guardian.endpoint } : { guardian: false });
    } finally { await d.close(); }
  }
  const E = JSON.parse(readFileSync(new URL('../../../src/website/docs/endpoints.json', import.meta.url), 'utf8'));
  assert.ok(E.some((e) => e.method === 'GET' && e.path === '/guardian-info'));
  assert.match(E.find((e) => e.method === 'GET' && e.path === '/guardian').purpose, /\/guardian-info/);
});
