// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 r26-nostr-1: THE SEED POOL'S NEWCOMER RULE ERASES A NEW PLAYER'S ONLY GAME SEED.
// Kind 30078 (the players' NIP-44-encrypted game seeds) has its own pool (#2393), where room is made as in the others - including
// #2677's rule: when the largest other holder holds ONE event, a writer that held at most one gets in and "the most recently arrived
// single-event holder gives its event back". In the seed pool EVERY honest player holds exactly one event (its seed). A stranger keeps
// the pool full with one 30078 per fresh key; a new player's seed gets in (it evicts a stranger) and is then the most recently arrived
// single-event holder - the stranger's next fresh-key 30078 erases it. For a signer login (extension, bunker, Amber) that seed is the
// only copy (public relays prune NIP-78): the next login sees EOSE with no seed and mints a NEW random seed - the wallet the player funded
// under the first one is no longer the account's (what #2447 says must never happen: an existing player's only seed is never pushed out).
// Safe: once a player's seed is kept, strangers' writes do not delete it (kanban #2858). A seed pool full of single-seed holders refuses a
// newcomer's seed ("blocked: the relay is full") instead of taking an earlier player's seed: refused is said to the page, erased is not.
import test from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { schnorr } from '@noble/curves/secp256k1.js';
import { startRelay, eventId } from '../src/nostr-relay.js';

const hex = (b) => Buffer.from(b).toString('hex');
const key = () => { const s = schnorr.utils.randomSecretKey(); return { s, pub: hex(schnorr.getPublicKey(s)) }; };
const ev = (k, kind, tags, at = Math.floor(Date.now() / 1000), content = 'x') => {
  const e = { pubkey: k.pub, created_at: at, kind, tags, content };
  e.id = eventId(e); e.sig = hex(schnorr.sign(Buffer.from(e.id, 'hex'), k.s));
  return e;
};
const open = async (port) => { const ws = new WebSocket(`ws://127.0.0.1:${port}`); await new Promise((x) => ws.on('open', x)); return ws; };
const put = (ws, e) => new Promise((x) => { const h = (raw) => { const a = JSON.parse(String(raw)); if (a[0] === 'OK' && a[1] === e.id) { ws.off('message', h); x(a); } }; ws.on('message', h); ws.send(JSON.stringify(['EVENT', e])); });
const count = (ws, f) => new Promise((x) => { let n = 0; const sid = 'q' + Math.random().toString(36).slice(2, 8);
  const h = (raw) => { const a = JSON.parse(String(raw)); if (a[1] !== sid) return; if (a[0] === 'EVENT') n++; if (a[0] === 'EOSE') { ws.off('message', h); x(n); } };
  ws.on('message', h); ws.send(JSON.stringify(['REQ', sid, f])); });
const writer = (r, socks) => { let ws = null, n = 0; return async (e) => { if (!ws || ++n % 40 === 0) { ws = await open(r.port); socks.push(ws); } return put(ws, e); }; };
const SEED_D = 'bitcoin-arena/seed';

test('#1489 r26-nostr-1: a stranger\'s next fresh-key 30078 does not erase a new player\'s only game seed', async () => {
  const r = await startRelay({ port: 0, limits: { seedEvents: 6 } });
  const socks = [];
  try {
    const w = writer(r, socks);
    // the stranger fills the seed pool: one 30078 per fresh key
    for (let k = 0; k < 6; k++) { const s = key(); assert.equal((await w(ev(s, 30078, [['d', SEED_D]], undefined, 'junk')))[2], true); }
    // a new player (signer login) publishes its random seed - the only copy of its wallet seed
    const player = key();
    const seed = ev(player, 30078, [['d', SEED_D]], undefined, 'nip44-encrypted-seed');
    const took = await w(seed);
    assert.equal(took[2], false, 'a full seed pool of single-seed holders takes nobody\'s seed for a newcomer');
    assert.match(String(took[3]), /blocked: the relay is full/);
    // a player whose seed was kept before the pool filled: strangers' fresh-key 30078s never erase it
    const r2 = await startRelay({ port: 0, limits: { seedEvents: 6 } });
    try {
      const w2 = writer(r2, socks); const early = key();
      assert.equal((await w2(ev(early, 30078, [['d', SEED_D]], undefined, 'nip44-encrypted-seed')))[2], true);
      for (let k = 0; k < 12; k++) await w2(ev(key(), 30078, [['d', SEED_D]], undefined, 'junk'));
      const ws2 = await open(r2.port); socks.push(ws2);
      assert.equal(await count(ws2, { kinds: [30078], authors: [early.pub] }), 1, 'an earlier player\'s seed stays');
    } finally { await r2.close(); }
    const ws = await open(r.port); socks.push(ws);
    const before = await count(ws, { kinds: [30078], authors: [player.pub] });
    // the stranger writes ONE more 30078 under a fresh key
    const s = key(); const more = await w(ev(s, 30078, [['d', SEED_D]], undefined, 'junk'));
    const after = await count(ws, { kinds: [30078], authors: [player.pub] });
    console.log(`  FACTS: player's seed kept=${took[2]}, on the relay before=${before}; stranger's next fresh-key 30078 taken=${more[2]}; player's seed on the relay after=${after}`);
    assert.equal(after, 0, 'the refused newcomer holds nothing here, and nothing of anyone else was erased for it');
  } finally { for (const s of socks) s.terminate(); await r.close(); }
});
