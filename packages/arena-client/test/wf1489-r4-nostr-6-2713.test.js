// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 r4-nostr-6: ONE RELAY THAT ANSWERS, WHILE THE ONE HOLDING THE SEED DOES NOT, MINTS A SECOND WALLET THAT REPLACES THE FIRST.
// seedFor (nostr/nostr-login.js) makes a NEW random seed for a signer (extension, bunker, Amber) whenever the relays that ANSWERED hold no
// seed event - "no new seed is made unless a relay answered" guards only the case where none answers. A signer's seed is random and the
// event is its only copy. So when the relay that holds it does not answer within maxWait (our relay stalled by a stranger's socket -
// r4-nostr-4 - or simply down) and any other relay of the list does, the login mints seed #2, publishes it, and from then on every
// login on every device takes the NEWEST seed event (sort by created_at) - the wallet the player funded under seed #1 is gone from the
// account (and on a relay that holds both, the parameterized-replaceable rule drops seed #1's event outright).
// Safe: the account keeps its first seed - a login that cannot reach the relays a seed may sit on does not make a new one.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startRelay } from '../../arena-node/src/nostr-relay.js';
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure';
import * as nip44 from 'nostr-tools/nip44';
import { SimplePool } from 'nostr-tools/pool';
import { extensionSigner, seedFor } from '../nostr/nostr-login.js';

const hex = (b) => Buffer.from(b).toString('hex');

test('#1489 r4-nostr-6: a login that reaches only a relay without the seed does not replace the account\'s seed', async () => {
  const secret = generateSecretKey();
  const ext = { getPublicKey: async () => getPublicKey(secret), signEvent: async (t) => finalizeEvent(t, secret),
    nip44: { encrypt: async (p, t) => nip44.encrypt(t, nip44.getConversationKey(secret, p)), decrypt: async (p, t) => nip44.decrypt(t, nip44.getConversationKey(secret, p)) } };
  // OUR relay (A) and a public one (B). Day 1: B is away, the seed lands on A.
  const a = await startRelay({ port: 0 });
  const urlA = `ws://127.0.0.1:${a.port}`;
  const probe = await startRelay({ port: 0 }); const portB = probe.port; await probe.close();
  const urlB = `ws://127.0.0.1:${portB}`;
  let b = null;
  const pools = [];
  const pool = () => { const p = new SimplePool(); pools.push(p); return p; };
  try {
    const day1 = await seedFor(await extensionSigner(ext), { pool: pool(), relays: [urlA, urlB], maxWait: 800 });
    assert.equal(day1.from, 'random');
    // Day 2, another device: B is up, A does not answer (stalled or down) - the player logs in
    b = await startRelay({ port: portB });
    await new Promise((x) => setTimeout(x, 1100));          // a later second than day 1
    const day2pool = pool();
    const ensureA = async (u, o) => { if (u === urlA) throw new Error('no answer'); return day2pool.ensureRelay(u, o); };
    const fake = new Proxy(day2pool, { get: (t, k) => (k === 'ensureRelay' ? ensureA : typeof t[k] === 'function' ? t[k].bind(t) : t[k]) });
    let day2 = null;
    try { day2 = await seedFor(await extensionSigner(ext), { pool: fake, relays: [urlA, urlB], maxWait: 800 }); } catch (e) { day2 = { refused: e.message }; }
    // Day 3: both relays answer
    const day3 = await seedFor(await extensionSigner(ext), { pool: pool(), relays: [urlA, urlB], maxWait: 1500 });
    console.log(`  FACTS: day 1 seed ${hex(day1.seed).slice(0, 12)} (on ${day1.relays.length} relay); day 2 ${day2.refused ? `refused: ${day2.refused}` : `${day2.from} seed ${hex(day2.seed).slice(0, 12)} created=${day2.created}`}; day 3 seed ${hex(day3.seed).slice(0, 12)}`);
    assert.ok(day2.refused || hex(day2.seed) === hex(day1.seed), `day 2 minted a second wallet seed (${day2.from}) for an account that has one`);
    assert.equal(hex(day3.seed), hex(day1.seed), 'the account\'s seed changed: the wallet funded under the first seed is no longer the account\'s');
  } finally {
    for (const p of pools) { try { p.close([urlA, urlB]); } catch { /* closed */ } }
    await a.close(); if (b) await b.close();
  }
});
