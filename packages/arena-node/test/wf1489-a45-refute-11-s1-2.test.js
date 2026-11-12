// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// #1489 a45-refute-11-s1-2 (kanban #1826): the drive count of a #<letter> condition is SELECT DISTINCT id ... LIMIT 2001, so it reads every
// tag ROW until 2001 distinct ids - an event may repeat one tag a thousand times (12 KB, under the 64 KB cap; ~330 per 4 MB author quota).
// 2100 such events (7 keys) and ten {"#a":["dup"],"#p":["nobody"]} read ~20 million index rows in one REQ.
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

test('#1489 a45-refute-11-s1-2: duplicate tags do not make the drive count read millions of rows', async () => {
  const r = await store((add) => {
    const tags = Array(1000).fill(['a', 'dup']);
    for (let i = 0; i < 2100; i++) add(8, 1650000000 + i, `d${i % 7}`, tags);
  });
  try {
    const at = await stall(r, Array(10).fill({ '#a': ['dup'], '#p': ['nobody'] }));
    assert.ok(at < 1000, `ten {"#a":["dup"],"#p":["nobody"]} filters held the event loop: a player asking 20 ms later was answered after ${Math.round(at)} ms`);
  } finally { await r.close(); }
});
