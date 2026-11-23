// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// audit nostr a6-3-2: THE #3145 "STANDING" VERIFY RESERVE IS OPEN TO ANY KEY THAT EVER WROTE ONE EVENT. nostr-relay.js:725 picks the
// standing reserve for `keepSet.has(e.pubkey) || seenAuthor.get(e.pubkey)` - and seen_authors holds every key the relay ever kept anything
// from (one free kind 0 or seed under a fresh key). So a stranger who made a few keys "seen" signs NEW, valid events under them (no replay,
// no junk: not the a6-2-1 replay and not the #3174 junk case - a fix that memoizes good signatures or dedups before verify changes nothing
// here) and spends the reserve the seats' `keep` keys were promised. The seat's next signed 30762 round result is answered 'rate-limited'.
// Safe: a seat's (keep) write keeps a verify reserve that keys any stranger can make "seen" for free cannot spend.
// Modelled like wf1489-r1120b-refute-10-s2 / a6-2-1: small budgets, no refill, the shared bucket held empty.
import test from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { schnorr } from '@noble/curves/secp256k1.js';
import { startRelay, eventId } from '../src/nostr-relay.js';

const hex = (b) => Buffer.from(b).toString('hex');
const keyOf = (n) => { const sk = new Uint8Array(32).fill(n); return { sk, pk: hex(schnorr.getPublicKey(sk)) }; };
let tick = 0;
const sign = (k, fields) => {
  const e = { pubkey: k.pk, created_at: Math.floor(Date.now() / 1000) - 100 + (tick++), tags: [], content: '', ...fields };
  e.id = eventId(e); e.sig = hex(schnorr.sign(Uint8Array.from(Buffer.from(e.id, 'hex')), k.sk));
  return e;
};
const open = async (port) => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`); await new Promise((r) => ws.on('open', r));
  const inbox = []; ws.on('message', (m) => inbox.push(JSON.parse(String(m))));
  return { ws, inbox, send: (m) => ws.send(JSON.stringify(m)) };
};
const until = async (f, ms = 3000) => { for (const t = Date.now(); !f() && Date.now() - t < ms;) await new Promise((r) => setTimeout(r, 5)); };
const answers = (sock, id) => sock.inbox.filter((m) => m[0] === 'OK' && m[1] === id);

const seat = keyOf(5), stranger = keyOf(9);

test('a stranger\'s own "seen" key signing new events does not spend the verify reserve a seat\'s round result needs', async () => {
  // the shared bucket: just enough for the stranger to make his key seen, then empty (held empty in production by a junk flood, #3145)
  const r = await startRelay({ port: 0, keep: [seat.pk],
    limits: { verifyBurst: 1, verifyPerS: 0, verifyStandingBurst: 3, verifyStandingPerS: 0, verifyCleanBurst: 3, verifyCleanPerS: 0 } });
  try {
    const a = await open(r.port);
    // 1. one free profile under a fresh key: the key is now in seen_authors
    const first = sign(stranger, { kind: 0, content: '{"name":"s"}' });
    a.send(['EVENT', first]);
    await until(() => answers(a, first.id).length);
    assert.equal(answers(a, first.id)[0][2], true, 'the stranger\'s first profile kept (shared bucket)');
    // 2. NEW valid events under that seen key (fresh created_at, a new id each): every one is checked from the standing reserve
    const fresh = [];
    for (let i = 0; i < 3; i++) { const e = sign(stranger, { kind: 0, content: `{"name":"s${i}"}` }); fresh.push(e); a.send(['EVENT', e]); }
    await until(() => fresh.every((e) => answers(a, e.id).length));
    console.log('  stranger fresh signed writes:', fresh.map((e) => { const m = answers(a, e.id)[0]; return `${m[2]} ${m[3]}`; }).join(' | '));

    // 3. the seat's next round result
    const seatSock = await open(r.port);
    const next = sign(seat, { kind: 30762, tags: [['d', 'arena:result:r2']], content: '{"round":"r2"}' });
    seatSock.send(['EVENT', next]);
    await until(() => answers(seatSock, next.id).length);
    const ans = answers(seatSock, next.id)[0];
    console.log(`  FACTS: seat round 2 result: ${ans ? (ans[2] ? 'kept' : `refused: ${ans[3]}`) : 'no answer'}`);
    seatSock.ws.terminate(); a.ws.terminate();
    assert.ok(ans && ans[2] === true, `the seat's signed round result was refused after a stranger's seen key signed 3 new profiles: ${ans && ans[3]}`);
  } finally { await r.close(); }
});
