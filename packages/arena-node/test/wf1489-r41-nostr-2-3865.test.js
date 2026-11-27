// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// #1489 r41-nostr-2: ONE SEAT'S NODE KEY ERASES EVERY PLAYER'S ONLY GAME SEED FROM A FULL SEED POOL.
// nostr-relay.js, seed pool step 2 (#2146 kept-author rule beside #2858): `if (h && (over || keepSet.has(e.pubkey))) victim = oldestIn(h)` -
// a write by a key in `keep` (ARENA_RELAY_KEEP: every seat's node key) takes the largest other holder's oldest seed even when that holder
// holds ONE seed, i.e. a player's only one. Seats never write kind 30078, so this only serves a seat that does it on purpose: one seat of
// seven (role b) writes kind 30078 events under its own key with fresh `d`s; each write into the full seed pool deletes one player's seed
// (the newest-arrived first), and once the seat holds AUTHOR_EVENTS its own oldest rolls out, so it can go on for ever. For a signer
// login (extension, bunker, Amber) the seed event is the only copy of the wallet seed (nostr-login.js seedFor): the next login finds
// none and mints a new random seed - the funded wallet is no longer the account's. The pool is full whenever enough players logged in,
// or after a stranger's ~2,000 fresh-key 64 KB seeds (by bytes; free under POW_FILL).
// SAFE (kanban #2447, #2858): a kept player's only seed is never taken for another author's room - also not for a seat key's 30078.
import test from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { schnorr } from '@noble/curves/secp256k1.js';
import { startRelay, eventId } from '../src/nostr-relay.js';

const hex = (b) => Buffer.from(b).toString('hex');
const key = () => { const s = schnorr.utils.randomSecretKey(); return { s, pub: hex(schnorr.getPublicKey(s)) }; };
const ev = (k, kind, tags, content = 'x', at = Math.floor(Date.now() / 1000)) => {
  const e = { pubkey: k.pub, created_at: at, kind, tags, content };
  e.id = eventId(e); e.sig = hex(schnorr.sign(Buffer.from(e.id, 'hex'), k.s));
  return e;
};
const open = async (port) => { const ws = new WebSocket(`ws://127.0.0.1:${port}`); await new Promise((x) => ws.on('open', x)); return ws; };
const put = (ws, e) => new Promise((x) => { const h = (raw) => { const a = JSON.parse(String(raw)); if (a[0] === 'OK' && a[1] === e.id) { ws.off('message', h); x(a); } }; ws.on('message', h); ws.send(JSON.stringify(['EVENT', e])); });
const count = (ws, f) => new Promise((x) => { let n = 0; const sid = 'q' + Math.random().toString(36).slice(2, 8);
  const h = (raw) => { const a = JSON.parse(String(raw)); if (a[1] !== sid) return; if (a[0] === 'EVENT') n++; if (a[0] === 'EOSE') { ws.off('message', h); x(n); } };
  ws.on('message', h); ws.send(JSON.stringify(['REQ', sid, f])); });
const SEED_D = 'bitcoin-arena/seed';

test('#1489 r41-nostr-2: a seat key\'s own kind 30078 writes do not erase players\' only game seeds', async () => {
  const seat = key();
  const r = await startRelay({ port: 0, keep: [seat.pub], limits: { seedEvents: 4 } });
  const socks = [];
  try {
    const ws = await open(r.port); socks.push(ws);
    // four players logged in with a signer: each one's random seed, the only copy of its wallet seed; the seed pool is now full
    const players = [key(), key(), key(), key()];
    for (const p of players) assert.equal((await put(ws, ev(p, 30078, [['d', SEED_D]], 'nip44-encrypted-seed')))[2], true);
    // one seat (its node key is in ARENA_RELAY_KEEP) writes kind 30078 under its own key, a fresh d each time
    const answers = [];
    for (let i = 0; i < 4; i++) answers.push(await put(ws, ev(seat, 30078, [['d', `junk-${i}`]], 'junk')));
    let left = 0;
    for (const p of players) left += await count(ws, { kinds: [30078], authors: [p.pub] });
    console.log(`  FACTS: seat writes taken=${answers.map((a) => a[2]).join(',')}; players' seeds still on the relay=${left} of ${players.length}`);
    assert.equal(left, players.length, 'every player\'s only seed stays: a seat key\'s 30078 is refused (or rolls out its own) rather than taking one');
  } finally { for (const s of socks) s.terminate(); await r.close(); }
});
