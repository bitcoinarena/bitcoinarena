// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// #1489 r6-nostr-1: a REQ filter that matches nothing must not walk the store. #1543 moved filters to SQL on indexed columns, but a
// filter with two tag conditions (one common, one matching nothing) - or a kind plus a tag that matches nothing - still makes
// SQLite walk every row of the common tag / kind in created_at order, checking the other IN (SELECT ...) on each. Ten such filters in
// one REQ (60 REQs per 10 s per socket, sockets free) hold the relay's one event loop for seconds: every other client's REQ, EVENT,
// NIP-46 signing and NWC payment waits.
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

test('#1489 r6-nostr-1: a REQ of filters that match nothing does not stall the relay for another client', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wf1489-r6-nostr-1-'));
  const path = join(dir, 'relay.db');
  const r0 = await startRelay({ port: 0, dbPath: path }); await r0.close();   // the relay's own schema
  // a store of 150,000 kind-8 events (under TOTAL_EVENTS, 300 keys x 500 = the per-author quota), each with a common `a` tag
  // (badge awards all name their definition this way); rows written straight in, as the relay keeps them
  const db = new DatabaseSync(path);
  db.exec('BEGIN');
  const put = db.prepare('INSERT INTO events (id, pubkey, kind, created_at, d, json) VALUES (?, ?, ?, ?, ?, ?)');
  const tag = db.prepare('INSERT INTO tags (id, name, value) VALUES (?, ?, ?)');
  const N = 150000;
  for (let i = 0; i < N; i++) {
    const id = createHash('sha256').update(`e${i}`).digest('hex');
    const pk = createHash('sha256').update(`k${i % 300}`).digest('hex');
    const e = { id, pubkey: pk, created_at: 1700000000 + i, kind: 8, tags: [['p', pk], ['a', 'x']], content: '', sig: '0'.repeat(128) };
    put.run(id, pk, 8, e.created_at, '', JSON.stringify(e));
    tag.run(id, 'p', pk); tag.run(id, 'a', 'x');
  }
  db.exec('COMMIT'); db.close();

  const r = await startRelay({ port: 0, dbPath: path });
  const attacker = await open(r.port), player = await open(r.port);
  try {
    // the attacker's REQ: ten filters, each a common tag and a tag nobody has. The relay runs in this process, so the clock
    // starts when the attacker sends, and the honest player asks 20 ms later (its timer fires once the loop is free again)
    const t0 = performance.now();
    const heavy = ask(attacker, ['REQ', 'h', ...Array(10).fill({ '#a': ['x'], '#p': ['nobody'] })], (m) => m[0] === 'EOSE' || m[0] === 'CLOSED');
    const answered = new Promise((x) => setTimeout(() => {
      const asked = performance.now() - t0;
      ask(player, ['REQ', 'mine', { kinds: [0], authors: ['f'.repeat(64)] }], (m) => m[0] === 'EOSE').then(() => x({ asked, at: performance.now() - t0 }));
    }, 20));
    const hv = await heavy;
    const p = await answered;
    console.log(`the attacker's REQ took ${Math.round(performance.now() - t0)} ms (${hv[hv.length - 1][0]}); the player meant to ask at 20 ms, asked at ${Math.round(p.asked)} ms, answered at ${Math.round(p.at)} ms`);
    assert.ok(p.at < 1000, `one stranger's REQ (filters matching nothing) held the relay's event loop: a player asking 20 ms later was answered after ${Math.round(p.at)} ms`);
  } finally { attacker.terminate(); player.terminate(); await r.close(); }
});
