// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 round 2 (nostr): a REQ's cost must not grow with the whole store. stored() walks EVERY row of the events table
// (SELECT json ... ORDER BY created_at) and JSON.parses each one, once per filter, synchronously, until `limit` events match - so
// a filter that matches nothing (an unknown author) parses the whole store, ten times for a REQ of ten filters, sixty REQs per
// 10 s per socket, any number of sockets. The relay's event loop (NIP-46 signing, NWC payments) stalls for everyone.
// Safe: a filter naming authors (or ids) is answered from the index, parsing at most the rows it could match.
import test from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { schnorr } from '@noble/curves/secp256k1.js';
import { startRelay, eventId } from '../src/nostr-relay.js';

const hex = (b) => Buffer.from(b).toString('hex');
const sk = new Uint8Array(32).fill(9), pk = hex(schnorr.getPublicKey(sk));
const sign = (i) => {
  const e = { pubkey: pk, created_at: 1700000000 + i, kind: 8, tags: [['p', pk]], content: String(i) };
  e.id = eventId(e); e.sig = hex(schnorr.sign(Uint8Array.from(Buffer.from(e.id, 'hex')), sk));
  return e;
};
const open = async (port) => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`); await new Promise((r) => ws.on('open', r));
  const inbox = []; ws.on('message', (m) => inbox.push(JSON.parse(String(m))));
  return { ws, inbox, send: (m) => ws.send(JSON.stringify(m)) };
};
const until = async (f, ms = 10000) => { for (const t = Date.now(); !f() && Date.now() - t < ms;) await new Promise((r) => setTimeout(r, 10)); };

test('#1489-r2-nostr-2 a REQ for an unknown author does not parse the whole store once per filter', async () => {
  const r = await startRelay({ port: 0 });
  const socks = [];
  try {
    const N = 1000;
    for (let c = 0; c < N / 50; c++) {                 // 50 events per socket: under each socket's 60-message budget
      const s = await open(r.port); socks.push(s);
      for (let i = 0; i < 50; i++) s.send(['EVENT', sign(c * 50 + i)]);
      await until(() => s.inbox.filter((m) => m[0] === 'OK').length === 50);
    }
    assert.equal(r.events().length, N);
    const q = await open(r.port); socks.push(q);
    const realParse = JSON.parse; let parsed = 0;
    JSON.parse = function (...a) { parsed++; return realParse.apply(this, a); };
    try {
      const nobody = 'ab'.repeat(32);
      q.send(['REQ', 'x', ...Array.from({ length: 10 }, (_, i) => ({ authors: [nobody.slice(0, 63) + String(i)] }))]);
      await until(() => q.inbox.some((m) => m[0] === 'EOSE' && m[1] === 'x'));
    } finally { JSON.parse = realParse; }
    console.log(`  FACTS: ${N} stored events, one REQ of 10 filters for an author with no event: ${parsed} JSON.parse calls in the relay`);
    assert.ok(parsed < 100, `one REQ that matches nothing parsed ${parsed} stored events`);
  } finally { for (const s of socks) s.ws.terminate(); await r.close(); }
});
