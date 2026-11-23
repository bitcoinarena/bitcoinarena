// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 a44-refute-24 (#1620 variant): the #1620 eviction picks "the author holding the most events" - a stranger who
// spreads the fill over many keys with FEWER events each than a node holds makes the NODE the heaviest author, and then every
// stranger parameterized event (30078 under a fresh d, fresh key) on a full relay pushes out the node's own round results.
// Before #1620 a full relay refused; now a stranger deletes a node's kept, signed results.
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

test('#1489 a44-refute-24-1: a stranger on a full relay does not push out a node\'s kept round results', async () => {
  const r = await startRelay({ port: 0, limits: { authorEvents: 10, totalEvents: 20 } });
  const socks = [];
  try {
    const ws = await open(r.port); socks.push(ws);
    const node = key();
    const results = [];
    for (let i = 0; i < 5; i++) { const e = ev(node, 30762, [['d', `arena:result:${String(i).repeat(64)}`], ['t', 'nextblock']], 1700000000 + i, '{"v":1}'); results.push(e.id); assert.equal((await put(ws, e))[2], true); }
    for (let k = 0; k < 15; k++) { const s = key(); assert.equal((await put(ws, ev(s, 8, [['p', s.pub]])))[2], true); }   // full: 20 of 20, one event a stranger key
    for (let k = 0; k < 5; k++) { const s = key(); await put(ws, ev(s, 30078, [['d', 'junk-' + k]], undefined, 'x')); }   // fresh keys, fresh d
    const kept = await has(ws, results);
    assert.equal(kept.length, 5, `the node's round results pushed out by strangers: ${5 - kept.length} of 5 gone`);
  } finally { for (const s of socks) s.terminate(); await r.close(); }
});

// kanban #2146, #2214: strangers who fill with one PARAMETERIZED event a key (no bulk left) still cannot push out a kept node's results
test('#2146 #2214: a node in `keep` keeps its round results when strangers fill with one 30078 a key', async () => {
  const node = key();
  const r = await startRelay({ port: 0, limits: { authorEvents: 10, totalEvents: 20 }, keep: [node.pub] });
  const socks = [];
  try {
    const ws = await open(r.port); socks.push(ws);
    const results = [];
    for (let i = 0; i < 5; i++) { const e = ev(node, 30762, [['d', `arena:result:${String(i).repeat(64)}`]], 1700000000 + i, '{"v":1}'); results.push(e.id); assert.equal((await put(ws, e))[2], true); }
    for (let k = 0; k < 15; k++) { const s = key(); assert.equal((await put(ws, ev(s, 30078, [['d', 'fill']])))[2], true); }
    const player = key();
    // merged onto 1.9 (kanban #2536): room is made by #1943/#1983 fair share - a new author that would hold as much as every other
    // non-kept holder (one event each here) is refused on a tie; the kept node is never the one that gives back
    await put(ws, ev(player, 30078, [['d', 'seed']]));
    for (let k = 0; k < 5; k++) { const s = key(); await put(ws, ev(s, 30078, [['d', 'junk-' + k]])); }
    assert.equal((await has(ws, results)).length, 5, 'the kept node lost round results');
    const next = ev(node, 30762, [['d', `arena:result:${'9'.repeat(64)}`]], 1700000100, '{"v":1}');
    assert.equal((await put(ws, next))[2], true, 'the kept node\'s next result is taken on a full relay');
    assert.equal((await has(ws, [...results, next.id])).length, 6);
  } finally { for (const s of socks) s.terminate(); await r.close(); }
});
