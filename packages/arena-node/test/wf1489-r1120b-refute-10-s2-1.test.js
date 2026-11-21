// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 r1120b-refute-10-s2 (skeptic 2 of #3044 / #3145): a NEW angle at the #3145 reserve.
//
// #3145 kept honest EVENTs alive under a junk-signature flood by giving a CLEAN socket (c.badSigs === 0) a
// reserve past the shared bucket: `keep`/seen authors a `standingBucket`, everyone else a `cleanBucket`.
//   const ok = take(verifyBucket)
//     || (c.badSigs === 0 && (keepSet.has(e.pubkey) || seenAuthor.get(e.pubkey) ? take(standingBucket) : take(cleanBucket)));
// Two facts the fix did not weigh together:
//   (a) `c.badSigs === 0` is read BEFORE the signature is verified, so a socket's FIRST frame ALWAYS reaches a
//       reserve - a junk-signature frame too. The frame is refused afterwards and the socket turns dirty, but
//       by then it has already spent a reserve token.
//   (b) e.pubkey is chosen by the sender, and a seat's `keep` key is public. A stranger puts that key on a junk
//       frame and the first frame draws from the STANDING reserve - the one that is supposed to protect the seats.
// So a stranger (different attacker role than skeptic 1, who drained only the SHARED bucket) opens a fresh socket,
// fires one keep-pubkey junk frame to burn a standing token, and reconnects for the next (reload/reconnect path -
// a fresh socket is clean again, c.badSigs back to 0). Reconnecting is cheap: no signing, no CPU on the relay's
// verify loop for a token already spent. With the shared bucket held empty and the standing reserve drained, the
// seat's own signed round result is answered 'rate-limited' - exactly the honest write the fix promised to keep.
//
// This is modelled deterministically with small budgets (the fixture style of nostr-relay-quota-1513): the shared
// bucket at 0 (a plain flood holds it empty, as skeptic 1 showed), the standing reserve at 2 with no refill. The
// real reserve refills at 50/s - but an attacker reconnects far faster than 50 sockets/s (it costs the attacker a
// TCP handshake, not a signature), so the drain outruns the refill in the field just as it does here.
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
const answerFor = (sock, id) => sock.inbox.find((m) => m[0] === 'OK' && m[1] === id);

let ctr = 0;
const junkAs = (pk) => {   // a junk-signature frame bearing WHOEVER's pubkey the caller names; a fresh id each time (never in refusedSigs)
  const e = { pubkey: pk, created_at: Math.floor(Date.now() / 1000), kind: 0, tags: [], content: `x${ctr++}` };
  e.id = eventId(e); e.sig = 'ab'.repeat(64);
  return ['EVENT', e];
};

const seat = keyOf(5), stranger = keyOf(9);

test('#1489 r1120b-refute-10-s2 a stranger drains the standing reserve with keep-pubkey junk on fresh sockets, so the seat\'s own signed round result is rate-limited', async () => {
  // shared bucket empty throughout (a plain junk flood keeps it so in the field); the standing reserve is 2 with no refill
  const r = await startRelay({ port: 0, keep: [seat.pk],
    limits: { verifyBurst: 0, verifyPerS: 0, verifyStandingBurst: 2, verifyStandingPerS: 0, verifyCleanBurst: 2, verifyCleanPerS: 0, badSigsPerSocket: 1000 } });
  try {
    // the stranger opens a FRESH socket per standing token and fires one junk frame carrying the SEAT's public keep key
    for (let i = 0; i < 2; i++) {
      const a = await open(r.port);
      const frame = junkAs(seat.pk);
      a.send(frame);
      await until(() => answerFor(a, frame[1].id));
      const o = answerFor(a, frame[1].id);
      assert.equal(o[2], false, 'the junk frame is of course refused');   // but it has already spent a standing token
      a.ws.terminate();   // reconnect: the next fresh socket is clean again (c.badSigs back to 0)
    }

    // now the honest seat, on its own clean socket, publishes its real signed round result
    const seatSock = await open(r.port);
    const good = sign(seat, { kind: 30762, tags: [['d', 'round-0']], content: '{"result":0}' });
    seatSock.send(['EVENT', good]);
    await until(() => answerFor(seatSock, good.id));
    const ans = answerFor(seatSock, good.id);
    console.log(`honest seat round result: ${ans ? (ans[2] ? 'kept' : `refused: ${ans[3]}`) : 'no answer'}`);
    seatSock.ws.terminate();

    assert.ok(ans && ans[2] === true,
      `the seat's valid signed round result was refused after a stranger drained the standing reserve with junk: ${ans && ans[3]}`);
  } finally {
    await r.close();
  }
});

test('#1489 r1120b-refute-10-s2 the same move drains the clean reserve, so an honest player\'s profile is rate-limited', async () => {
  const r = await startRelay({ port: 0,
    limits: { verifyBurst: 0, verifyPerS: 0, verifyStandingBurst: 2, verifyStandingPerS: 0, verifyCleanBurst: 2, verifyCleanPerS: 0, badSigsPerSocket: 1000 } });
  try {
    for (let i = 0; i < 2; i++) {   // a stranger drains the clean reserve with plain junk (no pubkey spoof needed here)
      const a = await open(r.port);
      const frame = junkAs(keyOf(20 + i).pk);
      a.send(frame);
      await until(() => answerFor(a, frame[1].id));
      a.ws.terminate();
    }
    const player = await open(r.port);
    const good = sign(stranger, { kind: 0, content: '{"name":"player"}' });
    player.send(['EVENT', good]);
    await until(() => answerFor(player, good.id));
    const ans = answerFor(player, good.id);
    console.log(`honest player profile: ${ans ? (ans[2] ? 'kept' : `refused: ${ans[3]}`) : 'no answer'}`);
    player.ws.terminate();
    assert.ok(ans && ans[2] === true,
      `the honest player's valid profile was refused after a stranger drained the clean reserve with junk: ${ans && ans[3]}`);
  } finally {
    await r.close();
  }
});
