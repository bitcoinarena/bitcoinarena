// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// #1489 a45-refute-11-s1-1 (kanban #1826): a filter of ONE tag condition bigger than DRIVE_ROWS takes the "reads its index as before" path,
// but that path's WHERE is the correlated EXISTS, not the index: SQLite walks events in created_at order checking EXISTS on each row.
// A stranger's 3000 OLD events tagged a=old (created_at is only checked against the future; 6 keys x 500) under 150,000 newer ones,
// and a REQ of ten {"#a":["old"]} walks the whole store ten times.
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

test('#1489 a45-refute-11-s1-1: a one-tag filter whose matches are the oldest rows does not stall the relay', async () => {
  const r = await store((add) => {
    for (let i = 0; i < 3000; i++) add(8, 1600000000 + i, `o${i % 6}`, [['a', 'old']]);
    for (let i = 0; i < 150000; i++) add(8, 1700000000 + i, `k${i % 300}`, [['a', 'x']]);
  });
  try {
    const at = await stall(r, Array(10).fill({ '#a': ['old'] }));
    assert.ok(at < 1000, `ten {"#a":["old"]} filters held the event loop: a player asking 20 ms later was answered after ${Math.round(at)} ms`);
    const at2 = await stall(r, Array(10).fill({ '#a': ['old'], since: 1700000000 }));
    assert.ok(at2 < 1000, `ten {"#a":["old"],since} filters (matching nothing) held the event loop: answered after ${Math.round(at2)} ms`);
  } finally { await r.close(); }
});
