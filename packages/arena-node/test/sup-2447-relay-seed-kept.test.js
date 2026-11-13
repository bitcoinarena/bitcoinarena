// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// Adapted to 1.9 by #2536 (kanban #2447): 1.9's full relay makes room by fair share (#1943, #1983) and protects only the authors in
// `keep` (ARENA_RELAY_KEEP, the seats' node keys, #2146 / #2214): a node's events are never given back for another author's write. The test
// runs the relay as it must be run, with the node's key kept. (copied unchanged: green on 1.9)
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
const has = (ws, ids) => new Promise((x) => { const got = new Set(); const sid = 'q' + Math.random().toString(36).slice(2, 8);
  const h = (raw) => { const a = JSON.parse(String(raw)); if (a[1] !== sid) return; if (a[0] === 'EVENT') got.add(a[2].id); if (a[0] === 'EOSE') { ws.off('message', h); x(ids.filter((i) => got.has(i))); } };
  ws.on('message', h); ws.send(JSON.stringify(['REQ', sid, { ids }])); });
// a fresh socket per few writes: the per-socket budget is 60 messages
const writer = (r, socks) => { let ws = null, n = 0; return async (e) => { if (!ws || ++n % 40 === 0) { ws = await open(r.port); socks.push(ws); } return put(ws, e); }; };
const SEED_D = 'bitcoin-arena/seed';
// kanban #1489 a44-refute-24 skeptic 2, STRANGER vs a PLAYER, reload path: past the total a stranger's kind 8 that names "its own"
// 30009 (no such definition needs to exist) makes room like a seed - so the total no longer refuses any regular event - and with one
// event a fresh key the strangers are never the heaviest: the honest player (profile + seed) is. The player's seed 30078 is pushed
// out; on the next login (reload, another device) seedFor sees EOSE with no seed on our relay (public relays prune NIP-78) and a
// signer account mints a NEW random seed - the old wallet is gone.
test('#1489 a44-refute-24-s2-1: strangers on a full relay do not delete a player\'s game seed (kept node configured)', async () => {
  const node = key();
  const r = await startRelay({ port: 0, limits: { authorEvents: 10, totalEvents: 20 }, keep: [node.pub] });
  const socks = [];
  try {
    const w = writer(r, socks);
    const player = key();
    assert.equal((await w(ev(player, 0, [], 1700000002, '{"name":"p"}')))[2], true);
    const seed = ev(player, 30078, [['d', SEED_D]], 1700000000, 'encrypted-seed');
    assert.equal((await w(seed))[2], true);
    for (let i = 0; i < 3; i++) assert.equal((await w(ev(node, 30762, [['d', 'arena:result:' + String(i).repeat(64)]], 1700000010 + i, '{"v":1}')))[2], true);
    // fill to the total with one regular kind 8 per fresh key, each naming "its own" 30009 (never published)
    for (let k = 0; k < 15; k++) { const s = key(); assert.equal((await w(ev(s, 8, [['a', `30009:${s.pub}:x`], ['p', s.pub]])))[2], true); }
    // past the total: more of the same regular event - the relay should refuse them or push out strangers' events, not the player's
    const taken = [];
    for (let k = 0; k < 4; k++) { const s = key(); taken.push((await w(ev(s, 8, [['a', `30009:${s.pub}:x`], ['p', s.pub]])))[2]); }
    const ws = await open(r.port); socks.push(ws);
    const kept = await has(ws, [seed.id]);
    assert.equal(kept.length, 1, `a stranger's regular kind 8 past the total (taken: ${taken.join(',')}) deleted the player's game seed`);
  } finally { for (const s of socks) s.terminate(); await r.close(); }
});
