// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE GAME'S OWN NOSTR RELAY: what the page's Nostr login writes to first - a profile, an encrypted game seed
// (NIP-78, kind 30078), NIP-46 signing messages. Signatures are checked, a newer replaceable event replaces the older, the
// filters select, a live subscription is told at once, and anything outside the game's kinds is refused.
import test from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { schnorr } from '@noble/curves/secp256k1.js';
import { startRelay, eventId } from '../src/nostr-relay.js';

const hex = (b) => Buffer.from(b).toString('hex');
const keyOf = (n) => { const sk = new Uint8Array(32).fill(n); return { sk, pk: hex(schnorr.getPublicKey(sk)) }; };
const sign = (k, { kind, content = '', tags = [], created_at = Math.floor(Date.now() / 1000) }) => {
  const e = { pubkey: k.pk, created_at, kind, tags, content };
  e.id = eventId(e);
  e.sig = hex(schnorr.sign(Uint8Array.from(Buffer.from(e.id, 'hex')), k.sk));
  return e;
};
const client = async (port) => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise((r) => ws.on('open', r));
  const inbox = [];
  ws.on('message', (m) => inbox.push(JSON.parse(String(m))));
  const next = async (pred, ms = 2000) => { for (const t = Date.now(); Date.now() - t < ms; await new Promise((r) => setTimeout(r, 10))) { const i = inbox.findIndex(pred); if (i >= 0) return inbox.splice(i, 1)[0]; } return null; };
  return { ws, send: (m) => ws.send(JSON.stringify(m)), next, inbox };
};


// KANBAN #1470 (feedback #002 by Hexbox Tools, 2026-11-11): a REQ whose filter has ids, authors or kinds that are not lists threw in the socket's message handler
// and took the relay down. Now such a filter is CLOSED as invalid, any other error in one message is caught, and the relay goes on for every client.
test('#1470 bad filters are refused and nothing takes the relay down; a good event and subscription still work after them', async () => {
  const r = await startRelay({ port: 0 });
  const a = keyOf(3);
  const bad = await client(r.port), good = await client(r.port);
  try {
    const sent = [{ ids: 5 }, { kinds: 'x' }, { authors: [1] }, { '#e': 7 }, { limit: -1 }, { ids: ['zz'] }];
    for (const [i, f] of sent.entries()) bad.send(['REQ', `s${i}`, f]);
    const closed = [];
    for (let i = 0; i < sent.length; i++) closed.push((await bad.next((m) => m[0] === 'CLOSED' && m[1] === `s${i}`))?.[2]);
    console.log('  FACTS (#1470):', JSON.stringify(closed));
    for (const c of closed) assert.match(String(c), /^invalid: /);
    // the relay still answers: an event is kept and a subscription hears it
    good.send(['REQ', 'live', { kinds: [0] }]); await good.next((m) => m[0] === 'EOSE' && m[1] === 'live');
    const e = sign(a, { kind: 0, content: '{"name":"still here"}' });
    bad.send(['EVENT', e]);
    assert.equal((await bad.next((m) => m[0] === 'OK' && m[1] === e.id))[2], true);
    assert.equal((await good.next((m) => m[0] === 'EVENT' && m[1] === 'live'))[2].id, e.id);
  } finally { bad.ws.close(); good.ws.close(); await r.close(); }
});
