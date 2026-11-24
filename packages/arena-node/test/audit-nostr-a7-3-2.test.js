// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// audit nostr a7-3 #2 (gap in #2988's fix): the #2988 fix made "seen" per pool OUTSIDE the seed pool only. In the seed pool the PoW gate
// still asks seen_authors (every key that ever wrote anything, never shrinking): a fresh key that posts one free kind 0 into the
// non-full state pool is "seen", and then writes an UNMINED seed into the nearly full seed pool. So the last 10 % of the seed pool -
// the part #2847 prices with 20..28 bits of work per key - fills for free, and once full (#2858: nobody holds more than the writer)
// every new player's game seed is refused 'blocked: the relay is full' for good.
// Safe: a key that has only written to the state pool pays the proof of work the nearly full seed pool asks, and a new player who pays
// the work still gets a seed kept.
import test from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { startRelay, eventId, leadingZeroBits } from '../src/nostr-relay.js';
import { key, hex, ev, publish } from './_r22-common.mjs';

const mined = (k, { kind, at, tags = [], content }, bits) => {
  for (let n = 0; ; n++) {
    const e = { pubkey: k.pub, created_at: at, kind, tags: [...tags, ['nonce', String(n), String(bits)]], content };
    e.id = eventId(e);
    if (leadingZeroBits(e.id) >= bits) { e.sig = hex(schnorr.sign(Buffer.from(e.id, 'hex'), k.s)); return e; }
  }
};
const SEED = [['d', 'bitcoin-arena/seed']];
// an UNMINED event whose id has under 4 leading zero bits (a random id reaches the 10 bits asked here about once in 1,024 tries)
const unmined = (k, o) => { for (let at = o.at; ; at -= 1000) { const e = ev(k, { ...o, at }); if (leadingZeroBits(e.id) < 4) return e; } };

test('audit nostr a7-3 #2: keys seen through the state pool fill the nearly full seed pool without proof of work', async () => {
  const r = await startRelay({ port: 0, limits: { seedEvents: 40, powBase: 8, powMax: 10 }, pow: true });
  const socks = [];
  try {
    const t0 = Math.floor(Date.now() / 1000) - 1000;
    // the seed pool past 90 %: 37 of 40 seeds, each written while the pool was at most 90 % full (no work asked)
    const first = await publish(r.port, Array.from({ length: 37 }, (_, i) => ev(key(), { kind: 30078, at: t0 + i, tags: SEED, content: 'junk' })), socks);
    assert.ok(first.every((m) => m[2] === true));
    // a fresh key without a profile is asked for the work (the gate works)
    const [plain] = await publish(r.port, [unmined(key(), { kind: 30078, at: t0 + 39, tags: SEED, content: 'junk' })], socks);
    assert.equal(plain[2], false); assert.match(plain[3], /^pow:/);
    // the stranger: three fresh keys, each first posts a free profile into the (empty) state pool, then an UNMINED seed
    const keys = [key(), key(), key()];
    const prof = await publish(r.port, keys.map((k, i) => ev(k, { kind: 0, at: t0 + 60 + i, content: '{}' })), socks);
    assert.ok(prof.every((m) => m[2] === true));
    const flood = await publish(r.port, keys.map((k, i) => unmined(k, { kind: 30078, at: t0 + 70 + i, tags: SEED, content: 'junk' })), socks);
    // a new player pays the work for their seed
    const player = key();
    const [p] = await publish(r.port, [mined(player, { kind: 30078, at: t0 + 80, tags: SEED, content: 'sealed seed' }, 10)], socks);
    const unpaid = flood.filter((m) => m[2] === true).length;
    console.log(`  FACTS: ${unpaid} of 3 unmined seeds kept from keys seen only in the state pool; the new player's mined seed: ${JSON.stringify(p.slice(2))}`);
    assert.equal(unpaid, 0, 'a key seen only in the state pool pays the work the nearly full seed pool asks');
    assert.equal(p[2], true, `the new player's seed was refused: ${p[3]}`);
  } finally { for (const w of socks) w.terminate(); await r.close(); }
});
