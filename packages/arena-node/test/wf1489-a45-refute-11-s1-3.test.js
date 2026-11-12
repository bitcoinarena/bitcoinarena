// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// #1489 a45-refute-11-s1-3 (kanban #1826): the honest path. When both conditions of a filter are bigger than DRIVE_ROWS the relay examines only
// the newest SCAN_ROWS (20000) events, so a filter with plenty of matches answers NONE when they are older than that. The client's zap
// read is { kinds: [9735], '#p': [recipient], limit: 500 } (arena-client relayRead): a node with 2500 zap receipts, then 20,000 newer
// events from anybody (40 free keys x 500), and the node's zaps are gone from every read.
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

test('#1489 a45-refute-11-s1-3: a zap read finds the recipient\'s receipts even under 20,000 newer events', async () => {
  const R = H('node');
  const r = await store((add) => {
    for (let i = 0; i < 2500; i++) add(9735, 1650000000 + i, `z${i % 10}`, [['p', R]]);
    for (let i = 0; i < 20000; i++) add(8, 1700000000 + i, `k${i % 40}`, [['p', H(`k${i % 40}`)]]);
  });
  const ws = await open(r.port);
  try {
    const got = await ask(ws, ['REQ', 'zaps', { kinds: [9735], '#p': [R], limit: 500 }], (m) => m[0] === 'EOSE' || m[0] === 'CLOSED');
    const n = got.filter((m) => m[0] === 'EVENT').length;
    assert.equal(n, 500, `the recipient has 2500 zap receipts, the read answered ${n}`);
  } finally { ws.terminate(); await r.close(); }
});
