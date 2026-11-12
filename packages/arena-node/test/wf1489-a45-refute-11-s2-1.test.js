// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// #1489 a45-refute-11-s2-1 (kanban #1826, #2246): a walk is bounded in CANDIDATES (SCAN_ROWS for one REQ), not in the work of checking
// each one. Every walked candidate is checked by EXISTS (SELECT 1 FROM tags INDEXED BY tag_id_nv WHERE t.id = e.id AND t.name = ? AND
// t.value IN (...500 values...)): one index seek per listed value. 20,000 kind-8 events tagged a=x (and p=zzz, a value past the list),
// 20,001 others spread over the 500 p values (so #p is not small enough to drive), and one REQ of ten {"#a":["x"],"#p":[500 values]}
// (35 KB) makes ~10 million seeks: the relay's one event loop is held for seconds.
import test from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { startRelay } from '../src/nostr-relay.js';
const open = async (port) => { const ws = new WebSocket(`ws://127.0.0.1:${port}`); await new Promise((x) => ws.on('open', x)); return ws; };
const ask = (ws, m, until) => new Promise((x) => { const got = []; const h = (raw) => { const a = JSON.parse(String(raw)); got.push(a); if (until(a)) { ws.off('message', h); x(got); } }; ws.on('message', h); ws.send(JSON.stringify(m)); });
const H = (s) => createHash('sha256').update(s).digest('hex');
// a store written straight in, as the relay keeps it (rows: [kind, created_at, author seed, tags])
const store = async (fill) => {
  const path = join(mkdtempSync(join(tmpdir(), 'a45-11-')), 'relay.db');
  const r0 = await startRelay({ port: 0, dbPath: path }); await r0.close();
  const db = new DatabaseSync(path); db.exec('BEGIN');
  const put = db.prepare('INSERT INTO events (id, pubkey, kind, created_at, d, json) VALUES (?, ?, ?, ?, ?, ?)');
  const tag = db.prepare('INSERT INTO tags (id, name, value) VALUES (?, ?, ?)');
  let n = 0;
  fill((kind, created_at, who, tags) => {
    const id = H(`ev${n++}`), pubkey = H(who);
    put.run(id, pubkey, kind, created_at, '', JSON.stringify({ id, pubkey, created_at, kind, tags, content: '', sig: '0'.repeat(128) }));
    for (const t of tags) tag.run(id, t[0], t[1]);
  });
  db.exec('COMMIT'); db.close();
  return startRelay({ port: 0, dbPath: path });
};
// the attacker sends one REQ; an honest player asks 20 ms later (its timer fires once the event loop is free)
const stall = async (r, filters) => {
  const attacker = await open(r.port), player = await open(r.port);
  try {
    const t0 = performance.now();
    const heavy = ask(attacker, ['REQ', 'h', ...filters], (m) => m[0] === 'EOSE' || m[0] === 'CLOSED');
    const answered = new Promise((x) => setTimeout(() => ask(player, ['REQ', 'mine', { kinds: [0], authors: ['f'.repeat(64)] }], (m) => m[0] === 'EOSE').then(() => x(performance.now() - t0)), 20));
    await heavy; const at = await answered;
    console.log(`player answered at ${Math.round(at)} ms`);
    return at;
  } finally { attacker.terminate(); player.terminate(); }
};

const V = Array.from({ length: 500 }, (_, i) => `v${String(i).padStart(3, '0')}`);
test('#1489 a45-refute-11-s2-1: a walk checking each candidate against a 500-value tag list does not hold the event loop', async () => {
  const r = await store((add) => {
    for (let i = 0; i < 20000; i++) add(8, 1700000000 + i, `a${i % 40}`, [['a', 'x'], ['p', 'zzz']]);
    for (let i = 0; i < 20001; i++) add(8, 1600000000 + i, `b${i % 41}`, [['p', V[i % 500]]]);
  });
  try {
    const at = await stall(r, Array(10).fill({ '#a': ['x'], '#p': V }));
    assert.ok(at < 1000, `one REQ of ten {"#a":["x"],"#p":[500 values]} held the event loop: a player asking 20 ms later was answered after ${Math.round(at)} ms`);
  } finally { await r.close(); }
});
const L = 'bcdefghijklmnopqrstuvwxy'.split('');
test('#1489 a45-refute-11-s2-1b: candidates passing 24 conditions of 500 values at the last value', async () => {
  const r = await store((add) => {
    for (let i = 0; i < 20001; i++) add(8, 1700000000 + i, `a${i % 41}`, [['a', 'x'], ...L.map((l) => [l, V[499]]), ['z', 'no']]);
    for (let i = 0; i < 2001; i++) add(8, 1600000000 + i, `c${i % 5}`, [['z', V[0]]]);
  });
  try {
    const f = { '#a': ['x'] }; for (const l of L) f[`#${l}`] = V; f['#z'] = V;
    const at = await stall(r, [f]);
    assert.ok(at < 1000, `one filter of 25 conditions held the event loop: a player asking 20 ms later was answered after ${Math.round(at)} ms`);
  } finally { await r.close(); }
});
