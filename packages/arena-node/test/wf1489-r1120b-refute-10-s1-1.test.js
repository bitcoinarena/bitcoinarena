// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 refute of #3044: the relay-wide signature budget (VERIFY_BURST 200, VERIFY_PER_S 200) is shared by everyone, the seats'
// node keys (`keep`) included, and the refused-pair memory only helps against a RE-SENT frame. A stranger who makes each junk frame
// distinct (a counter in `content`, so a fresh id and a fresh (id, sig) pair - one sha256 each, free) over a few free sockets at
// a few thousand frames/s keeps the bucket empty, and every honest EVENT - a seat's signed round result (30762), a player's profile - is answered
// 'rate-limited' for as long as the flood lasts. The CPU stall became a write blackout of the whole relay.
// SAFE: a retrying honest writer (8 tries, 200 ms apart, during the flood) gets its signed EVENT kept at least once.
import test from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { schnorr } from '@noble/curves/secp256k1.js';
import { startRelay, eventId } from '../src/nostr-relay.js';

const hex = (b) => Buffer.from(b).toString('hex');
const keyOf = (n) => { const sk = new Uint8Array(32).fill(n); return { sk, pk: hex(schnorr.getPublicKey(sk)) }; };
const sign = (k, fields) => {
  const e = { pubkey: k.pk, created_at: Math.floor(Date.now() / 1000), tags: [], content: '', ...fields };
  e.id = eventId(e); e.sig = hex(schnorr.sign(Uint8Array.from(Buffer.from(e.id, 'hex')), k.sk));
  return e;
};
const open = async (port) => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`); await new Promise((r) => ws.on('open', r));
  const inbox = []; ws.on('message', (m) => inbox.push(JSON.parse(String(m))));
  return { ws, inbox, send: (m) => ws.send(JSON.stringify(m)) };
};
const until = async (f, ms = 5000) => { for (const t = Date.now(); !f() && Date.now() - t < ms;) await new Promise((r) => setTimeout(r, 10)); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const victim = keyOf(7), seat = keyOf(5);
let ctr = 0;
const junk = () => {   // distinct each time: never in the refused-pair memory
  const e = { pubkey: victim.pk, created_at: Math.floor(Date.now() / 1000), kind: 0, tags: [], content: `x${ctr++}` };
  e.id = eventId(e); e.sig = 'ab'.repeat(64);
  return ['EVENT', e];
};

async function underFlood(r, makeHonest) {
  // the honest writer is a retrying client: it tries again every 200 ms, 8 times (1.6 s), each time a fresh event
  const socks = [];
  try {
    const attackers = await Promise.all(Array.from({ length: 300 }, () => open(r.port)));   // 300 x 60 = 18000 frames of budget, free sockets
    socks.push(...attackers);
    const honest = await open(r.port); socks.push(honest);
    let sent = 0, next = 0;
    const tries = [];
    for (let it = 0; it < 260; it++) {   // ~2.6 s; each tick 40 distinct junk frames, spread over the sockets (each under its own 60-message budget)
      for (let i = 0; i < 40; i++) { attackers[next].send(junk()); next = (next + 1) % attackers.length; sent++; }
      if (it >= 80 && it % 20 === 0 && tries.length < 8) { const e = makeHonest(tries.length); tries.push(e.id); honest.send(['EVENT', e]); }
      await sleep(10);
    }
    await until(() => tries.every((id) => honest.inbox.some((m) => m[0] === 'OK' && m[1] === id)));
    const oks = tries.map((id) => honest.inbox.find((m) => m[0] === 'OK' && m[1] === id));
    console.log(`junk frames sent: ${sent}; honest answers: ${oks.map((o) => (o ? (o[2] ? 'kept' : o[3].slice(0, 12)) : 'none')).join(', ')}`);
    return oks;
  } finally {
    for (const s of socks) { try { s.ws.terminate(); } catch { /* gone */ } }
  }
}

test('#1489 r1120b-refute-10-s1 a seat\'s signed round result is kept while a stranger floods distinct junk-signature frames', async () => {
  const r = await startRelay({ port: 0, keep: [seat.pk] });
  try {
    const oks = await underFlood(r, (n) => sign(seat, { kind: 30762, tags: [['d', `round-${n}`]], content: `{"result":${n}}` }));
    assert.ok(oks.some((o) => o && o[2] === true), `all 8 tries of the seat's round result were refused during the flood: ${oks.map((o) => o && o[3]).join(' | ')}`);
  } finally { await r.close(); }
});

test('#1489 r1120b-refute-10-s1 a player\'s profile is kept while a stranger floods distinct junk-signature frames', async () => {
  const r = await startRelay({ port: 0 });
  try {
    const oks = await underFlood(r, (n) => sign(keyOf(3), { kind: 0, content: `{"name":"player${n}"}` }));
    assert.ok(oks.some((o) => o && o[2] === true), `all 8 tries of the player's profile were refused during the flood: ${oks.map((o) => o && o[3]).join(' | ')}`);
  } finally { await r.close(); }
});
