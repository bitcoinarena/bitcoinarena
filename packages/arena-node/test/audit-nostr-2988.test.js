// kanban #2988: the card's test (audit nostr r1-2)
// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// audit nostr-r1 #2: THE PROOF-OF-WORK GATE OF #2847 IS SKIPPED BY A KEY "SEEN" THROUGH THE SEED POOL.
// #2847: an author this relay has never kept an event from pays NIP-13 proof of work while the pool it writes to is over 90 % full,
// so a fresh-key flood that cycles the pool (each write evicting the oldest author without standing) costs work per key. But
// `seen_authors` is one list for every pool: a key whose throwaway kind 30078 was kept in the seed pool (its own quota, nearly empty,
// so no proof of work) is "seen", and from then on writes to the FULL state pool with no proof of work at all. A stranger registers
// any number of keys through the seed pool, then floods the state pool for free; every write evicts the oldest event of an author
// without standing - so a new player's profile (who paid the work) is erased as soon as the flood has gone through the older events.
// Safe behaviour asserted: a key that has only ever written to the seed pool still pays the proof of work the full state pool asks,
// and the new player's profile is not erased by unpaid writes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { startRelay, eventId, leadingZeroBits } from '../src/nostr-relay.js';
import { key, hex, ev, publish, open, ask } from './_r22-common.mjs';

const mined = (k, { kind = 0, at, content = '{}' }, bits) => {
  for (let n = 0; ; n++) {
    const e = { pubkey: k.pub, created_at: at, kind, tags: [['nonce', String(n), String(bits)]], content };
    e.id = eventId(e);
    if (leadingZeroBits(e.id) >= bits) { e.sig = hex(schnorr.sign(Buffer.from(e.id, 'hex'), k.s)); return e; }
  }
};

test('audit nostr-r1 #2: keys registered through the seed pool flood the full state pool without proof of work and erase a new player\'s profile', async () => {
  const r = await startRelay({ port: 0, limits: { totalEvents: 10, powBase: 8, powMax: 10 }, pow: true });
  const socks = [];
  try {
    const t0 = Math.floor(Date.now() / 1000) - 1000;
    // the state pool full of earlier strangers' profiles (they paid the work where it was asked)
    const first = await publish(r.port, Array.from({ length: 10 }, (_, i) => mined(key(), { at: t0 + i }, 10)), socks);
    assert.ok(first.every((m) => m[2] === true), JSON.stringify(first.find((m) => m[2] !== true)));
    // a new player pays the work and is kept
    const player = key();
    const [p] = await publish(r.port, [mined(player, { at: t0 + 20, content: '{"name":"new player"}' }, 10)], socks);
    assert.equal(p[2], true, p[3]);
    // the stranger: 11 fresh keys, each "seen" through one throwaway seed (the seed pool is nearly empty: no work asked)
    const keys = Array.from({ length: 11 }, () => key());
    const seeds = await publish(r.port, keys.map((k, i) => ev(k, { kind: 30078, at: t0 + 30 + i, tags: [['d', 'x']], content: 'junk' })), socks);
    assert.ok(seeds.every((m) => m[2] === true));
    // ... then each writes an UNMINED profile into the full state pool
    const flood = await publish(r.port, keys.map((k, i) => ev(k, { kind: 0, at: t0 + 60 + i, content: '{}' })), socks);
    const ws = await open(r.port); socks.push(ws);
    const kept = (await ask(ws, ['REQ', 'q', { kinds: [0], authors: [player.pub] }], (m) => m[0] === 'EOSE')).filter((m) => m[0] === 'EVENT').length;
    const unpaid = flood.filter((m) => m[2] === true).length;
    assert.equal(kept, 1, `the new player's profile was erased by ${unpaid} writes that paid no proof of work`);
    assert.equal(unpaid, 0, 'a key seen only in the seed pool pays the work the full state pool asks');
  } finally { for (const w of socks) w.terminate(); await r.close(); }
});

