// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// #1489 a45-refute-11-s3-1 (kanban #1826, #2246, #2378): a walk reads its index in keyset pages, WHERE created_at <= t AND (created_at < t
// OR rowid < rid). The rowid half is no index range (tag_value_time is (name, value, created_at)), so every page re-reads, and throws
// away, every row of the same created_at it already returned. A page is max(8, 5000 / streams) rows, and a 500-value list makes 500
// streams: page 10. 20,001 events with p=X all at ONE created_at (allowed: any past second), walked for one REQ's 20,000 candidates, are
// 2,000 pages re-reading 10, 20, ... 20,000 rows each - about 20 million index rows, and the budget counts only the 20,000 returned.
// The same walk over distinct created_at answers the player at ~60 ms (MacBook); one created_at held it ~1,100 ms (tag), ~750 ms (kind).
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
  const path = join(mkdtempSync(join(tmpdir(), 'a45-11s3-')), 'relay.db');
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

const V = Array.from({ length: 499 }, (_, i) => `v${String(i).padStart(3, '0')}`);
const T = 1700000000;
test('#1489 a45-refute-11-s3-1: a tag walk over 20,000 rows of one created_at does not hold the event loop', async () => {
  const r = await store((add) => {
    for (let i = 0; i < 20001; i++) add(8, T, `a${i % 41}`, [['p', 'X']]);
    for (let i = 0; i < 20001; i++) add(9735, T - 100000 + i, `b${i % 41}`, [['e', 'Z']]);
  });
  try {
    const at = await stall(r, [{ '#p': ['X', ...V], '#e': ['Z'] }]);
    assert.ok(at < 500, `one REQ {"#p":[X + 499 values],"#e":["Z"]} over 20,001 p=X events of one created_at held the event loop: a player asking 20 ms later was answered after ${Math.round(at)} ms`);
  } finally { await r.close(); }
});
test('#1489 a45-refute-11-s3-1b: a kind walk (ev_kind_time) over 20,000 rows of one created_at does not hold the event loop', async () => {
  const K = Array.from({ length: 499 }, (_, i) => 20000 + i);
  const r = await store((add) => {
    for (let i = 0; i < 20001; i++) add(8, T, `a${i % 41}`, [['a', 'x']]);
    for (let i = 0; i < 20001; i++) add(9735, T - 100000 + i, `b${i % 41}`, [['e', 'Z']]);
  });
  try {
    const at = await stall(r, [{ kinds: [8, ...K], '#e': ['Z', 'Z2'] }]);
    assert.ok(at < 500, `one REQ {kinds:[8 + 499 kinds],"#e":["Z","Z2"]} over 20,001 kind-8 events of one created_at held the event loop: a player asking 20 ms later was answered after ${Math.round(at)} ms`);
  } finally { await r.close(); }
});
test('#1489 a45-refute-11-s3-1 control: the same walk with distinct created_at', async () => {
  const r = await store((add) => {
    for (let i = 0; i < 20001; i++) add(8, T + i, `a${i % 41}`, [['p', 'X']]);
    for (let i = 0; i < 20001; i++) add(9735, T - 100000 + i, `b${i % 41}`, [['e', 'Z']]);
  });
  try { const at = await stall(r, [{ '#p': ['X', ...V], '#e': ['Z'] }]); console.log(`control (distinct created_at): ${Math.round(at)} ms`); } finally { await r.close(); }
});
