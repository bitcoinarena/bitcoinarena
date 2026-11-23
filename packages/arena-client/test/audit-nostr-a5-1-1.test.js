// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// audit nostr a5-1-1: seedFor (nostr/nostr-login.js) takes as "the seed event" the NEWEST event any relay of the login list answers
// that is signed by the player - it never checks that the event is kind 30078 with d = "bitcoin-arena/seed". One public relay of the
// list (role c: relay.snort.social, nos.lol, relay.primal.net, or any relay of a custom list) answers the seed REQ with a newer event
// the player signed anyway (the profile the page itself publishes there, any note) - the page then says "your game seed is on the
// relays but did not decrypt" and the Nostr login fails on every try, while the game's own relay holds the genuine seed.
// Safe: an event that is not the seed event (kind/d) is passed over; the login answers the genuine seed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startRelay } from '../../arena-node/src/nostr-relay.js';
import { generateSecretKey, finalizeEvent } from 'nostr-tools/pure';
import { SimplePool } from 'nostr-tools/pool';
import { localSigner, seedFor } from '../nostr/nostr-login.js';

const hex = (b) => Buffer.from(b).toString('hex');

test('audit nostr a5-1-1: a relay answering the seed REQ with the player\'s newer profile does not block the login', async () => {
  const secret = generateSecretKey();
  const a = await startRelay({ port: 0 });
  const urlA = `ws://127.0.0.1:${a.port}`;
  const urlB = 'ws://public-relay.invalid';
  const pools = [];
  try {
    // day 1: the seed lands on the game's relay
    const p1 = new SimplePool(); pools.push(p1);
    const day1 = await seedFor(localSigner(secret), { pool: p1, relays: [urlA], maxWait: 1500 });
    assert.equal(day1.created, true);
    // the player's own profile, signed later (the page publishes kind 0 to every login relay)
    const profile = finalizeEvent({ kind: 0, created_at: Math.floor(Date.now() / 1000) + 5, tags: [], content: JSON.stringify({ name: 'alice' }) }, secret);
    // day 2: relay B (public, of the list) answers ANY filter with that profile, then EOSE
    const p2 = new SimplePool(); pools.push(p2);
    const fakeB = { subscribe: (filters, h) => { setTimeout(() => { h.onevent(profile); h.oneose(); }, 10); return { close() {} }; }, publish: async () => 'ok' };
    const ensure = async (u, o) => (u === urlB ? fakeB : p2.ensureRelay(u, o));
    const pool = new Proxy(p2, { get: (t, k) => (k === 'ensureRelay' ? ensure : typeof t[k] === 'function' ? t[k].bind(t) : t[k]) });
    let day2;
    try { day2 = await seedFor(localSigner(secret), { pool, relays: [urlA, urlB], maxWait: 1500 }); } catch (e) { day2 = { refused: e.message }; }
    console.log(`  FACTS: day 1 seed ${hex(day1.seed).slice(0, 12)}; day 2 ${day2.refused ? `refused: ${day2.refused}` : `seed ${hex(day2.seed).slice(0, 12)} from ${day2.from}`}`);
    assert.ok(!day2.refused, `the login failed because one relay answered a non-seed event: ${day2.refused}`);
    assert.equal(hex(day2.seed), hex(day1.seed));
  } finally {
    for (const p of pools) { try { p.close([urlA]); } catch { /* closed */ } }
    await a.close();
  }
});
