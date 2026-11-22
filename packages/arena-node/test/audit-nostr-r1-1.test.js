// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// audit nostr-r1 #1: STANDING BY SEED AGE IS FREE, SO A PATIENT STRANGER HOLDS THE RELAY SHUT (a way around #2847).
// #2847 made authors with standing never evictable, and gave standing to any key whose kind 30078 seed this relay kept 7 days.
// A seed is any 30078 event a fresh key signs (the seed pool is apart and nearly empty, so no proof of work). A stranger posts one
// seed under each of many fresh keys, waits 7 days, and then fills the state and log pools from those keys (each may hold up to
// AUTHOR_EVENTS / AUTHOR_BYTES) - with no proof of work either, since every one of them is a key the relay has already seen.
// From then on every author without standing - a new player's first profile, relay list, wallet info - finds nobody to evict
// and is refused 'blocked: the relay is full' for good (after paying the proof of work), which is the lock-out #1943/#2677/#2847
// set out to end ("no stranger can shut the relay to anybody else").
// Safe behaviour asserted: a new player's first profile is kept even when the pool is filled by keys that have standing only by
// the age of a seed they posted themselves (their bulk beyond a fair share is what gives way).
import test from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { startRelay, STANDING_SEED_MS, eventId, leadingZeroBits } from '../src/nostr-relay.js';
import { key, ev, hex, publish, open, ask } from './_r22-common.mjs';

// kanban #2987: since #2988 a key new to the state pool pays NIP-13 proof of work while that pool is nearly full, as an honest client does;
// the new player's profile is mined to the relay's top difficulty here so the test checks room, not the PoW gate
const mined = (k, { kind = 0, at, content = '{}' }, bits) => {
  for (let n = 0; ; n++) {
    const e = { pubkey: k.pub, created_at: at, kind, tags: [['nonce', String(n), String(bits)]], content };
    e.id = eventId(e);
    if (leadingZeroBits(e.id) >= bits) { e.sig = hex(schnorr.sign(Buffer.from(e.id, 'hex'), k.s)); return e; }
  }
};

test('audit nostr-r1 #1: strangers with 7-day-old seeds of their own fill the pool; a new player\'s profile must still be kept', async () => {
  let t = Date.now();
  const r = await startRelay({ port: 0, limits: { totalEvents: 12, powBase: 8, powMax: 10 }, pow: true, now: () => t });
  const socks = [];
  try {
    const at0 = Math.floor(t / 1000) - 100;
    // 1. three fresh stranger keys, one throwaway "seed" each (seed pool: its own quota, no proof of work)
    const strangers = [key(), key(), key()];
    const seeds = await publish(r.port, strangers.map((k, i) => ev(k, { kind: 30078, at: at0 + i, tags: [['d', 'bitcoin-arena/seed']], content: 'junk' })), socks);
    assert.ok(seeds.every((m) => m[2] === true), JSON.stringify(seeds));
    // 2. a week later those keys have standing; each fills its share of the state pool (no proof of work: they are seen authors)
    t += STANDING_SEED_MS + 60000;
    const bulk = [];
    for (const [i, k] of strangers.entries()) for (let j = 0; j < 4; j++) bulk.push(ev(k, { kind: 30009, at: at0 + 10 + i * 4 + j, tags: [['d', `junk-${j}`]], content: '' }));
    const oks = await publish(r.port, bulk, socks);
    assert.ok(oks.every((m) => m[2] === true), JSON.stringify(oks.find((m) => m[2] !== true)));
    // 3. a new player arrives: its seed, then its first profile (the lobby name)
    const player = key();
    const [s] = await publish(r.port, [ev(player, { kind: 30078, at: at0 + 50, tags: [['d', 'bitcoin-arena/seed']], content: 'enc' })], socks);
    assert.equal(s[2], true, s[3]);
    const [p] = await publish(r.port, [mined(player, { kind: 0, at: at0 + 51, content: '{"name":"new player"}' }, 10)], socks);
    const ws = await open(r.port); socks.push(ws);
    const got = (await ask(ws, ['REQ', 'q', { kinds: [0], authors: [player.pub] }], (m) => m[0] === 'EOSE')).filter((m) => m[0] === 'EVENT');
    assert.equal(p[2], true, `the new player's profile was refused: ${p[3]}`);
    assert.equal(got.length, 1, 'the new player\'s profile is kept');
  } finally { for (const w of socks) w.terminate(); await r.close(); }
});

