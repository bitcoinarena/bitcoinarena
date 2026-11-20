// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #3145 (#1489 r1120b-refute-10 of #3044): past the shared signature budget only a socket with no bad signature reaches a
// reserve, and a socket is closed after BAD_SIGS_PER_SOCKET bad signatures - so a flood's sockets cannot spend what honest writers keep.
import test from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { schnorr } from '@noble/curves/secp256k1.js';
import { startRelay, eventId, BAD_SIGS_PER_SOCKET } from '../src/nostr-relay.js';

const hex = (b) => Buffer.from(b).toString('hex');
const keyOf = (n) => { const sk = new Uint8Array(32).fill(n); return { sk, pk: hex(schnorr.getPublicKey(sk)) }; };
const sign = (k, fields) => {
  const e = { pubkey: k.pk, created_at: Math.floor(Date.now() / 1000), kind: 0, tags: [], content: '', ...fields };
  e.id = eventId(e); e.sig = hex(schnorr.sign(Uint8Array.from(Buffer.from(e.id, 'hex')), k.sk));
  return e;
};
let ctr = 0;
const junk = (k) => { const e = { pubkey: k.pk, created_at: Math.floor(Date.now() / 1000), kind: 0, tags: [], content: `j${ctr++}` }; e.id = eventId(e); e.sig = 'ab'.repeat(64); return e; };
const open = async (port) => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`); await new Promise((r) => ws.on('open', r));
  const inbox = []; ws.on('message', (m) => inbox.push(JSON.parse(String(m))));
  let closed = false; ws.on('close', () => { closed = true; });
  return { ws, inbox, closed: () => closed, send: (m) => ws.send(JSON.stringify(m)) };
};
const until = async (f, ms = 3000) => { for (const t = Date.now(); !f() && Date.now() - t < ms;) await new Promise((r) => setTimeout(r, 10)); };
const answer = async (s, id) => { await until(() => s.inbox.some((m) => m[0] === 'OK' && m[1] === id)); return s.inbox.find((m) => m[0] === 'OK' && m[1] === id); };

test('#3145 with the shared budget spent, a socket that sent a bad signature is refused and a clean one is checked', async () => {
  const r = await startRelay({ port: 0, limits: { verifyBurst: 0, verifyPerS: 0 } });   // only the reserves
  try {
    const k = keyOf(9);
    const dirty = await open(r.port), clean = await open(r.port);
    const j = junk(k); dirty.send(['EVENT', j]);
    assert.match((await answer(dirty, j.id))[3], /signature/);
    const e1 = sign(k, { content: 'from the dirty socket' }); dirty.send(['EVENT', e1]);
    const a1 = await answer(dirty, e1.id);
    assert.equal(a1[2], false); assert.match(a1[3], /rate-limited/);
    const e2 = sign(keyOf(10), { content: 'from the clean socket' }); clean.send(['EVENT', e2]);
    assert.equal((await answer(clean, e2.id))[2], true);
    for (const s of [dirty, clean]) s.ws.terminate();
  } finally { await r.close(); }
});

test('#3145 a socket is closed after BAD_SIGS_PER_SOCKET bad signatures', async () => {
  const r = await startRelay({ port: 0 });
  try {
    const s = await open(r.port), k = keyOf(8);
    for (let i = 0; i < BAD_SIGS_PER_SOCKET; i++) { const j = junk(k); s.send(['EVENT', j]); await answer(s, j.id); }
    await until(() => s.closed());
    assert.ok(s.closed(), 'the socket is still open after its bad signatures');
  } finally { await r.close(); }
});
