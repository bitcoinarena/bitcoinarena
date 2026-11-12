// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 v1 refute 48 s2 (#1720): a "covered" stream reads only 2 x limit tag rows, assuming an event carries a tag value at most
// twice. A stranger publishes two newer kind-9735 events, each carrying the recipient's ['p', R] ~500 times (35 KB, inside 64 KB): the
// client's own zap read { kinds: [9735], '#p': [R], limit: 500 } (arena-client src/zap.js) reads its 1000 tag rows from those two events
// and answers 2 - every real receipt for R is hidden. The build before (85f803d70) answered all 52.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import WebSocket from 'ws';
import { schnorr } from '@noble/curves/secp256k1.js';
import { startRelay, eventId } from '../src/nostr-relay.js';

const h = (s) => createHash('sha256').update(String(s)).digest('hex');
const R = h('recipient');
const signed = (sk, e) => { e.pubkey = Buffer.from(schnorr.getPublicKey(sk)).toString('hex'); e.id = eventId(e); e.sig = Buffer.from(schnorr.sign(Buffer.from(e.id, 'hex'), sk)).toString('hex'); return e; };
const open = async (port) => { const ws = new WebSocket(`ws://127.0.0.1:${port}`); await new Promise((r) => ws.on('open', r)); return ws; };
const publish = async (ws, e) => new Promise((res) => { const on = (m) => { const x = JSON.parse(String(m)); if (x[0] === 'OK' && x[1] === e.id) { ws.off('message', on); res(x); } }; ws.on('message', on); ws.send(JSON.stringify(['EVENT', e])); });
const req = async (port, f) => {
  const ws = await open(port); const got = [];
  await new Promise((r) => { ws.on('message', (m) => { const x = JSON.parse(String(m)); if (x[0] === 'EVENT') got.push(x[2]); if (x[0] === 'EOSE' || x[0] === 'CLOSED') r(); }); ws.send(JSON.stringify(['REQ', 's', f])); });
  ws.terminate(); return got;
};

test('#1489-v1-refute-48-s2-4 two events repeating a #p value do not hide the real zap receipts for it', async () => {
  const r = await startRelay({ port: 0 });
  try {
    const now = Math.floor(Date.now() / 1000);
    const lnurl = randomBytes(32), attacker = randomBytes(32);
    const ws = await open(r.port);
    for (let i = 0; i < 50; i++) {   // fifty real receipts, as the payee's LNURL server signs them (spread over the last hour, so batches stay under the rate limit)
      const ok = await publish(ws, signed(lnurl, { created_at: now - 3600 + i, kind: 9735, tags: [['p', R], ['bolt11', `lnbc${i}`]], content: '' }));
      assert.equal(ok[2], true, ok[3]);
    }
    ws.terminate();
    const ws2 = await open(r.port);
    for (let i = 0; i < 2; i++) {
      const e = signed(attacker, { created_at: now - i, kind: 9735, tags: Array.from({ length: 500 }, () => ['p', R]), content: '' });
      const ok = await publish(ws2, e);
      console.log(`  FACTS attacker event ${i}: ${JSON.stringify(e).length} bytes, OK ${ok[2]} ${ok[3]}`);
      assert.equal(ok[2], true, ok[3]);
    }
    ws2.terminate();
    const got = await req(r.port, { kinds: [9735], '#p': [R], limit: 500 });
    const real = got.filter((e) => e.tags.some((t) => t[0] === 'bolt11')).length;
    console.log(`  FACTS the client's zap read {kinds:[9735], #p:[R], limit:500}: ${got.length} events, ${real} of the 50 real receipts`);
    assert.equal(real, 50, 'the real zap receipts are hidden behind two events that repeat the tag');
  } finally { await r.close(); }
});
