// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 v1 refute 48 (#1543): a REQ's cost must not grow with the whole store. The fix stops JSON.parse of every row, but
// the SQL it builds still reads every matching row (json column included) into a temp B-tree for ORDER BY before LIMIT applies,
// for a filter the indexes cannot answer in created_at order: two kinds, an author prefix, a kind + an unknown tag, a common tag.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import WebSocket from 'ws';
import { startRelay } from '../src/nostr-relay.js';

const COMMON = 'cc'.repeat(32);
const fill = (path, n) => {
  const db = new DatabaseSync(path);
  db.exec('CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, pubkey TEXT, kind INTEGER, created_at INTEGER, d TEXT, json TEXT)');
  const put = db.prepare('INSERT INTO events (id, pubkey, kind, created_at, d, json) VALUES (?, ?, ?, ?, ?, ?)');
  const content = 'x'.repeat(2000);
  db.exec('BEGIN');
  for (let i = 0; i < n; i++) {
    const e = { id: randomBytes(32).toString('hex'), pubkey: randomBytes(32).toString('hex'), created_at: 1700000000 + i, kind: i % 50 === 0 ? 0 : 8,
      tags: [['p', COMMON]], content, sig: '00'.repeat(64) };
    put.run(e.id, e.pubkey, e.kind, e.created_at, '', JSON.stringify(e));
  }
  db.exec('COMMIT');
  console.log('  sqlite', db.prepare('select sqlite_version() v').get().v);
  db.close();
};
const timeReq = async (port, filters) => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`); await new Promise((r) => ws.on('open', r));
  const t = performance.now(); let n = 0;
  await new Promise((r) => ws.on('message', (m) => { const x = JSON.parse(String(m)); if (x[0] === 'EVENT') n++; if (x[0] === 'EOSE' || x[0] === 'CLOSED') r(); }) && ws.send(JSON.stringify(['REQ', 's', ...filters])));
  const ms = performance.now() - t; ws.terminate(); return { ms, n };
};
const SHAPES = {
  twoKinds: { kinds: [8, 0], limit: 1 },
  authorPrefix: { authors: '0123456789abcdef'.split(''), limit: 1 },
  kindUnknownTag: { kinds: [8], '#p': ['dd'.repeat(32)], limit: 1 },
  commonTag: { '#p': [COMMON], limit: 1 },
  oneKind: { kinds: [8], limit: 1 },   // baseline: answered in index order
};

test('#1489-v1-refute-48 a REQ of limit-1 filters costs the same on a small and on a large store', async () => {
  const dir = mkdtempSync(join(process.cwd(), 'wf48-'));
  const sizes = { small: 1000, large: 40000 }, res = {};
  for (const [name, n] of Object.entries(sizes)) {
    const path = join(dir, `${name}.db`); fill(path, n);
    const r = await startRelay({ port: 0, dbPath: path });
    try {
      res[name] = {};
      for (const [k, f] of Object.entries(SHAPES)) { await timeReq(r.port, [f]); res[name][k] = await timeReq(r.port, Array(10).fill(f)); }
    } finally { await r.close(); }
  }
  const bad = [];
  for (const k of Object.keys(SHAPES)) {
    const s = res.small[k].ms, l = res.large[k].ms;
    console.log(`  FACTS ${k}: ${sizes.small} events ${s.toFixed(1)} ms, ${sizes.large} events ${l.toFixed(1)} ms (x${(l / s).toFixed(1)}), events sent ${res.large[k].n}`);
    if (l > 5 * s + 50) bad.push(`${k} ${s.toFixed(0)} -> ${l.toFixed(0)} ms`);
  }
  assert.deepEqual(bad, [], 'one REQ of 10 limit-1 filters grew with the store');
});
