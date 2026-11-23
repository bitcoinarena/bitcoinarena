// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// audit nostr r2 (a6-2-1): a P11 bypass of the #3145 / #3174 signature reserves with VALID, replayed frames.
//
// #3145 gave a CLEAN socket (no bad signature yet) a reserve past the shared verify bucket; #3174 gives a reserve token back when the
// signature turns out bad. Both assume the flood is junk. But the relay verifies a frame's signature BEFORE it looks whether the event is
// already kept (has.get -> 'duplicate:'), and keeps no memory of signatures it already found good. So a stranger who copies ANY public
// valid event and re-sends it stays clean for good, and every copy spends one verify token:
//   - a seat's own kept 30762 round result (public: any REQ returns it) carries a `keep` key -> it is checked from the STANDING reserve;
//   - one ephemeral event (24133 / 23194: never kept, so its author is never "seen") signed once under a fresh key -> the CLEAN reserve.
// Re-sending costs the stranger nothing (no signing); the relay pays a BIP-340 check per copy, and the reserves the seats and the players
// were promised are empty: the seat's next round result and a new player's profile / seed are answered 'rate-limited'.
// Modelled like wf1489-r1120b-refute-10-s2 (small budgets, no refill; the shared bucket held empty by the same replay flood).
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
const until = async (f, ms = 3000) => { for (const t = Date.now(); !f() && Date.now() - t < ms;) await new Promise((r) => setTimeout(r, 5)); };
const answers = (sock, id) => sock.inbox.filter((m) => m[0] === 'OK' && m[1] === id);

const seat = keyOf(5), stranger = keyOf(9), player = keyOf(11);

test('a stranger re-sending a seat\'s own public round result does not take the verify reserve the seat\'s next result needs', async () => {
  const r = await startRelay({ port: 0, keep: [seat.pk],
    limits: { verifyBurst: 0, verifyPerS: 0, verifyStandingBurst: 3, verifyStandingPerS: 0, verifyCleanBurst: 3, verifyCleanPerS: 0 } });
  try {
    // the seat publishes round 1's result (one standing token)
    const seatSock = await open(r.port);
    const old = sign(seat, { kind: 30762, tags: [['d', 'arena:result:r1']], content: '{"round":"r1"}' });
    seatSock.send(['EVENT', old]);
    await until(() => answers(seatSock, old.id).length);
    assert.equal(answers(seatSock, old.id)[0][2], true, 'round 1 result kept');

    // a stranger copies that public result and re-sends it: valid signature, so its socket stays clean and is never closed
    const a = await open(r.port);
    for (let i = 0; i < 2; i++) a.send(['EVENT', old]);
    await until(() => answers(a, old.id).length >= 2);
    console.log('stranger re-sends answered:', answers(a, old.id).map((m) => m[3]).join(' | '));

    // the seat's next, new round result
    const next = sign(seat, { kind: 30762, tags: [['d', 'arena:result:r2']], content: '{"round":"r2"}' });
    seatSock.send(['EVENT', next]);
    await until(() => answers(seatSock, next.id).length);
    const ans = answers(seatSock, next.id)[0];
    console.log(`seat round 2 result: ${ans ? (ans[2] ? 'kept' : `refused: ${ans[3]}`) : 'no answer'}`);
    seatSock.ws.terminate(); a.ws.terminate();
    assert.ok(ans && ans[2] === true, `the seat's new signed round result was refused after a stranger replayed its old one: ${ans && ans[3]}`);
  } finally { await r.close(); }
});

test('a stranger re-sending ONE valid ephemeral event (signed once) does not take the clean reserve a new player\'s profile needs', async () => {
  const r = await startRelay({ port: 0,
    limits: { verifyBurst: 0, verifyPerS: 0, verifyStandingBurst: 3, verifyStandingPerS: 0, verifyCleanBurst: 3, verifyCleanPerS: 0 } });
  try {
    const a = await open(r.port);
    const eph = sign(stranger, { kind: 24133, tags: [['p', keyOf(12).pk]], content: 'x' });   // NIP-46 frame: never kept, author never "seen"
    for (let i = 0; i < 3; i++) a.send(['EVENT', eph]);
    await until(() => answers(a, eph.id).length >= 3);
    console.log('stranger ephemeral re-sends answered:', answers(a, eph.id).map((m) => `${m[2]} ${m[3]}`).join(' | '));

    const p = await open(r.port);
    const profile = sign(player, { kind: 0, content: '{"name":"new player"}' });
    p.send(['EVENT', profile]);
    await until(() => answers(p, profile.id).length);
    const ans = answers(p, profile.id)[0];
    console.log(`new player profile: ${ans ? (ans[2] ? 'kept' : `refused: ${ans[3]}`) : 'no answer'}`);
    p.ws.terminate(); a.ws.terminate();
    assert.ok(ans && ans[2] === true, `a new player's valid profile was refused after a stranger replayed one signed ephemeral event: ${ans && ans[3]}`);
  } finally { await r.close(); }
});

// The root cause, isolated: the relay verifies the signature of EVERY EVENT frame before it looks whether the id is already kept
// (has.get -> 'duplicate:', which runs only AFTER sigRefusal). refusedSigs memoizes only BAD (id, sig) pairs; a GOOD one is never
// remembered, so a re-sent already-kept event is re-verified each time and spends a verify token. The #3174 fix (refund on bad sig)
// does not touch this - the sig is good. Safe behaviour: re-sending an event the relay already holds and already verified once must
// not cost another signature check, so a verify token stays for an honest, never-seen write.
test('re-sending an already-kept valid event must not re-spend a signature-verify token (so an honest write keeps its budget)', async () => {
  // one shared token total, no reserves, no refill: exactly enough to verify ONE new event
  const r = await startRelay({ port: 0,
    limits: { verifyBurst: 2, verifyPerS: 0, verifyStandingBurst: 0, verifyStandingPerS: 0, verifyCleanBurst: 0, verifyCleanPerS: 0 } });
  try {
    const a = await open(r.port);
    const kept = sign(stranger, { kind: 0, content: '{"name":"kept once"}' });
    a.send(['EVENT', kept]);                 // token 1: verified and kept
    await until(() => answers(a, kept.id).length);
    assert.equal(answers(a, kept.id)[0][2], true, 'first copy kept');
    a.send(['EVENT', kept]);                 // a re-send of the SAME kept event: must be a cheap 'duplicate:', not a re-verify
    await until(() => answers(a, kept.id).length >= 2);
    console.log('re-send of kept event answered:', answers(a, kept.id)[1][3]);

    // an honest, never-seen writer now asks for the one remaining token
    const p = await open(r.port);
    const profile = sign(player, { kind: 0, content: '{"name":"new player"}' });
    p.send(['EVENT', profile]);
    await until(() => answers(p, profile.id).length);
    const ans = answers(p, profile.id)[0];
    console.log(`honest profile after a kept-event re-send: ${ans && (ans[2] ? 'kept' : ans[3])}`);
    a.ws.terminate(); p.ws.terminate();
    assert.ok(ans && ans[2] === true, `the honest write was refused because re-verifying an already-kept event burned the verify token: ${ans && ans[3]}`);
  } finally { await r.close(); }
});
