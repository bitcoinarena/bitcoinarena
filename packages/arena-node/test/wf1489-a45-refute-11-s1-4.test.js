// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// #1489 a45-refute-11-s1-4 (kanban #2246, #2275): the walk over several streams (several kinds, several tag values) is bounded, newest first, and says when it stopped early.
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
test('#1489 a45-refute-11-s1-4: several big disjoint conditions do not stall; a multi-kind read is newest first and complete', async () => {
  const R = H('node');
  const r = await store((add) => {
    for (let i = 0; i < 2500; i++) add(9735, 1650000000 + 2 * i, `z${i % 10}`, [['p', R]]);
    for (let i = 0; i < 2500; i++) add(8, 1650000001 + 2 * i, `b${i % 10}`, [['p', R]]);
    for (let i = 0; i < 60000; i++) add(8, 1700000000 + i, `k${i % 120}`, [['a', `x${i % 5}`], ['p', `q${i % 5}`], ...'bcdefghijk'.split('').map((l) => [l, 'v'])]);
    for (let i = 0; i < 60000; i++) add(0, 1700000000 + i, `m${i % 120}`, [['a', `y${i % 5}`], ['p', `p${i % 5}`]]);
  });
  const ws = await open(r.port);
  try {
    const got = await ask(ws, ['REQ', 'r', { kinds: [9735, 8], '#p': [R, 'nobody-else'], limit: 500 }], (m) => m[0] === 'EOSE' || m[0] === 'CLOSED');
    const ev = got.filter((m) => m[0] === 'EVENT').map((m) => m[2]);
    assert.equal(ev.length, 500, `5000 events match, the read answered ${ev.length}`);
    assert.equal(ev[0].created_at, 1650000000 + 4999, 'the newest match first');
    assert.equal(ev[499].created_at, 1650000000 + 4500, 'the 500 newest');
    assert.ok(!got.some((m) => m[0] === 'NOTICE'), 'a complete answer has no notice');
    const filt = { '#a': ['x0', 'x1', 'x2', 'x3', 'x4'], '#p': ['p0', 'p1', 'p2', 'p3', 'p4'] };
    const at = await stall(r, Array(10).fill(filt));
    assert.ok(at < 1000, `ten disjoint big filters held the event loop: answered after ${Math.round(at)} ms`);
    const told = await ask(ws, ['REQ', 'b', filt], (m) => m[0] === 'EOSE' || m[0] === 'CLOSED');
    assert.ok(told.some((m) => m[0] === 'NOTICE' && /too broad/.test(m[1])), 'a walk out of budget says so');
    // eleven big conditions in each of ten filters: choosing the walk is bounded too
    const many = { ...Object.fromEntries('bcdefghijk'.split('').map((l) => [`#${l}`, ['v']])), '#p': ['p0', 'p1', 'p2', 'p3', 'p4'] };
    const at3 = await stall(r, Array(10).fill(many));
    assert.ok(at3 < 1000, `ten filters of eleven big conditions held the event loop: answered after ${Math.round(at3)} ms`);
  } finally { ws.terminate(); await r.close(); }
});
