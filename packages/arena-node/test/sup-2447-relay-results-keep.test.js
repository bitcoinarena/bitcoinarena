// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// Adapted to 1.9 by #2536 (kanban #2447): 1.9's full relay makes room by fair share (#1943, #1983) and protects only the authors in
// `keep` (ARENA_RELAY_KEEP, the seats' node keys, #2146 / #2214): a node's events are never given back for another author's write. The test
// runs the relay as it must be run, with the node's key kept. The card's s2-3 ran with NO keep list and is red on 1.9: the protection is the keep list.
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
// kanban #1489 a44-refute-24 skeptic 2, RESTART path: the node is safe only while it is in ARENA_RELAY_KEEP. A relay started
// without it (tools/nostr-relay.mjs default '', a seat whose key joined after the relay was started, a restart from a unit that
// does not carry the env) is #1620's original state: strangers with one 30078 a fresh key push out the node's round results,
// which publishPass never sends again. Nothing in the relay protects a node's kind 30762 by itself.
test('#2447 (1.9, node key kept): strangers do not delete a node\'s round results', async () => {
  const node = key();
  const r = await startRelay({ port: 0, limits: { authorEvents: 10, totalEvents: 20 }, keep: [node.pub] });
  const socks = [];
  try {
    const w = writer(r, socks);
    const results = [];
    for (let i = 0; i < 5; i++) { const e = ev(node, 30762, [['d', 'arena:result:' + String(i).repeat(64)]], 1700000000 + i, '{"v":1}'); results.push(e.id); assert.equal((await w(e))[2], true); }
    for (let k = 0; k < 15; k++) { const s = key(); assert.equal((await w(ev(s, 30078, [['d', 'fill']])))[2], true); }
    for (let k = 0; k < 5; k++) { const s = key(); await w(ev(s, 30078, [['d', 'junk-' + k]])); }
    const ws = await open(r.port); socks.push(ws);
    const kept = await has(ws, results);
    assert.equal(kept.length, 5, `strangers deleted ${5 - kept.length} of the node's 5 round results`);
  } finally { for (const s of socks) s.terminate(); await r.close(); }
});
