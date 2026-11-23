// Audit settle r2-1 (gap in #2725): GET /season?scope=network takes any 64-hex game id, keys its cache by it, and on every miss runs
// seasonAccounts - a whole-store seasonRounds read (every round with entries, every contract decoded) plus a GET /season-rounds to every
// network seat. #2725 dropped made-up ids only on GET /season-rounds and the local /season. A stranger's fresh random id per request
// costs a full store read and a fan-out to every seat each time.
// SAFE: made-up game ids (no hosted game, no stored round) cost no whole-store read and no peer ask per request.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { schnorr } from '@noble/curves/secp256k1.js';
import { serve } from '../src/server.js';
import { openStore } from '../src/store.js';
import { opts, b32 } from './window-fixture.js';
import { HOSTED } from './plugins/hosted.js';
import { toHex } from '../../arena-protocol/src/hash.js';

test('made-up game ids on GET /season?scope=network do not each cost a whole-store read and a peer fan-out', async () => {
  const peers = ['http://127.0.0.1:9/seat-a', 'http://127.0.0.1:9/seat-b', 'http://127.0.0.1:9/seat-c'];
  let asked = 0;
  const seasonFetch = async (u) => {
    if (/\/identity\?/.test(u)) return new Response('no', { status: 404 });
    if (/\/season-rounds/.test(u)) asked++;
    return new Response(JSON.stringify({ node: toHex(schnorr.getPublicKey(b32(0xa1))), rounds: [], roundKeys: true }), { status: 200 });
  };
  const store = openStore(':memory:');
  let fullReads = 0;
  const prep = store.prepare.bind(store);
  store.prepare = (sql) => { if (/FROM rounds r WHERE EXISTS \(SELECT 1 FROM entries e/.test(sql)) fullReads++; return prep(sql); };
  const d = await serve(store, { plugins: HOSTED, port: 0, peers, seasonFetch, ...opts });
  try {
    const N = 20;
    const before = fullReads;
    for (let i = 0; i < N; i++) {
      const id = randomBytes(32).toString('hex');
      const r = await fetch(`http://127.0.0.1:${d.port}/season?game=${id}&scope=network`);
      await r.text();
    }
    const reads = fullReads - before;
    console.log(`# ${N} made-up ids: ${asked} peer /season-rounds asks, ${reads} whole-store season reads`);
    assert.ok(asked <= peers.length, `${N} made-up ids made ${asked} peer /season-rounds asks (one fan-out to every seat per id)`);
    assert.ok(reads <= 1, `${N} made-up ids made ${reads} whole-store season reads`);
  } finally { await d.close(); }
});
