// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1391 (Daniel 2026-11-09: "Yes fork it", "Make sure it is everything fast"): a new wallet's change-note tweaks ground in Web Workers and handed to
// the lock client. The worker here is the page's own source run in a vm; the client checks every tweak as mintv2's check_tweak does.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createHash, randomBytes } from 'node:crypto';
import { feedTweaks } from '../src/page-lock.js';

const passes = (tweakHex, filterHex) => { const d = createHash('sha256').update(Buffer.concat([Buffer.from(tweakHex, 'hex'), Buffer.from(filterHex, 'hex')])).digest(); return d[0] === 0 && d[1] === 0; };
const fakeWorkerFrom = (srcOf) => class {
  constructor(url) { this.url = url; this.onmessage = null; const self = this;
    this.ctx = vm.createContext({ crypto: globalThis.crypto, Date, Uint32Array, parseInt, setTimeout: (f) => setTimeout(f, 0), postMessage: (x) => { if (self.onmessage) self.onmessage({ data: x }); } });
    vm.runInContext(srcOf(), this.ctx); }
  postMessage(d) { this.ctx.onmessage({ data: d }); }
  terminate() { this.ctx.onmessage({ data: { on: false } }); this.gone = true; }
};

test('the workers grind tweaks that pass the wallet\'s filter, the client takes them, and they stop at high', async () => {
  const filter = randomBytes(32).toString('hex');
  let ready = 0, bad = 0;
  const client = { tweakFilter: () => filter, tweaksReady: () => ready,
    addTweaks: (hex) => { let n = 0; for (let i = 0; i < hex.length; i += 32) { if (passes(hex.slice(i, i + 32), filter)) { ready++; n++; } else bad++; } return n; } };
  let src = null; const realBlob = globalThis.Blob;
  globalThis.Blob = class extends realBlob { constructor(parts, o) { super(parts, o); src = parts.join(''); } };
  try {
    const pump = feedTweaks(client, { WorkerCtor: fakeWorkerFrom(() => src), workers: 2, high: 20, low: 10, everyMs: 50 });
    assert.ok(pump, 'a client with addTweaks is fed');
    assert.equal(feedTweaks(client, { WorkerCtor: fakeWorkerFrom(() => src) }), null, 'once per client');
    const t0 = Date.now();
    while (ready < 20 && Date.now() - t0 < 30000) await new Promise((r) => setTimeout(r, 50));
    assert.ok(ready >= 20, `20 tweaks within 30 s (got ${ready})`);
    assert.equal(bad, 0, 'every tweak handed in passes the filter');
    await new Promise((r) => setTimeout(r, 400));
    const after = ready; await new Promise((r) => setTimeout(r, 600));
    assert.ok(ready - after <= 4, `the workers stop at high (${after} -> ${ready})`);
    pump.stop();
  } finally { globalThis.Blob = realBlob; }
});

test('a lock client without addTweaks (an older build) is left to grind its own', () => {
  assert.equal(feedTweaks({ tweaksReady: () => 0 }, { WorkerCtor: class {} }), null);
  assert.equal(feedTweaks(null), null);
});
