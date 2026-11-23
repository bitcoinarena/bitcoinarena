// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// audit nostr a6-3-3: A TRANSIENT 'rate-limited:' ANSWER IS BOOKED AS THE RELAY'S FINAL REFUSAL. nostr-results.js publishPass (used for every
// round result, kind 30762, and every NIP-58 definition / award, nostr-badges.js) treats any OK false as "that relay's refusal, kept and not
// asked again": r.relays[url] = 'refused: ...' and, once every relay answered, done: true with published_ms set. NIP-01 defines 'rate-limited:'
// as a "try again" answer, and the game's own relay sends exactly it ('rate-limited: the relay is checking too many signatures, try again
// shortly') whenever its verify budget is empty - which a stranger can hold empty (a6-2-1 replays, a6-3-2 seen keys, #3145 junk). So one burst
// at the moment a seat publishes and that round's signed result (or a badge award) never reaches the game relay - not after the burst, not
// after a restart (the row is published_ms != NULL and never due again).
// Safe: a 'rate-limited:' (or 'error:') OK false leaves that relay owed and asks it again after the backoff.
import test from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { schnorr } from '@noble/curves/secp256k1.js';
import { startRelay, eventId } from '../src/nostr-relay.js';
import { publishPass } from '../src/nostr-results.js';

const hex = (b) => Buffer.from(b).toString('hex');
const keyOf = (n) => { const sk = new Uint8Array(32).fill(n); return { sk, pk: hex(schnorr.getPublicKey(sk)) }; };
const sign = (k, fields) => {
  const e = { pubkey: k.pk, created_at: Math.floor(Date.now() / 1000), tags: [], content: '', ...fields };
  e.id = eventId(e); e.sig = hex(schnorr.sign(Uint8Array.from(Buffer.from(e.id, 'hex')), k.sk));
  return e;
};

test('a seat\'s result answered rate-limited by the game relay is asked again, not booked as refused for good', async () => {
  const seat = keyOf(5);
  // the game relay with its verify budget empty for this moment (as a stranger's flood holds it): no tokens, no refill
  const r = await startRelay({ port: 0, keep: [seat.pk],
    limits: { verifyBurst: 0, verifyPerS: 0, verifyStandingBurst: 0, verifyStandingPerS: 0, verifyCleanBurst: 0, verifyCleanPerS: 0 } });
  try {
    const url = `ws://127.0.0.1:${r.port}`;
    const ev = sign(seat, { kind: 30762, tags: [['d', 'arena:result:r1']], content: '{"round":"r1"}' });
    const rows = [{ event: ev, relays: {}, attempts: 0 }];
    const [o] = await publishPass(rows, [url], { connect: (u) => new WebSocket(u), timeoutMs: 3000 });
    console.log(`  FACTS: relay answer booked as ${JSON.stringify(rows[0].relays)}; outcome ${JSON.stringify({ done: o.done, publishedMs: !!o.publishedMs, why: o.why })}`);
    console.log(`  the relay holds the result: ${r.events().some((e) => e.id === ev.id)}`);
    assert.equal(o.done, false, `a transient rate-limited answer ended publishing for good: ${o.why}`);
    assert.ok(!rows[0].relays[url], `the relay is no longer owed the result: ${rows[0].relays[url]}`);
  } finally { await r.close(); }
});
