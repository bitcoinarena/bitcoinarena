// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 v1 refute 48 s2 (after #1543, #1720): the #1720 check step reads an event's tags by `tags (id)` only, so each candidate costs
// every tag row its event carries. A stranger publishes events with thousands of single-letter tags (64 KB holds ~6000 ["a","0"]), and a
// REQ of 10 filters {'#p': [common], '#a': [unknown], limit: 1} costs candidates x tags-per-event row reads - far past SCAN_MOST - though it
// sends nothing. Same store size in events, same filter: cost must not grow with the tags the candidates carry.
// -5 (kanban #1915, #1959, #1998, #2010): the same with DISTINCT tag values (['a','0'], ['a','1'], ...), which one-row-per-(event, name, value)
// does not shrink: the check must be an index seek on (id, name, value), not a walk of the event's tag rows.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import WebSocket from 'ws';
import { startRelay } from '../src/nostr-relay.js';

const COMMON = 'cc'.repeat(32);
const junk = (n) => Array.from({ length: n }, (_, i) => ['a', String(i)]);
const fill = (path, n, tagsEach) => {
  const db = new DatabaseSync(path);
  db.exec('CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, pubkey TEXT, kind INTEGER, created_at INTEGER, d TEXT, json TEXT)');
  // the tags table as the relay itself writes it (filled here in one transaction, so the start does not backfill row by row)
  db.exec('CREATE TABLE IF NOT EXISTS tags (id TEXT, name TEXT, value TEXT, kind INTEGER, created_at INTEGER)');
  const put = db.prepare('INSERT INTO events (id, pubkey, kind, created_at, d, json) VALUES (?, ?, ?, ?, ?, ?)');
  const tag = db.prepare('INSERT INTO tags (id, name, value, kind, created_at) VALUES (?, ?, ?, ?, ?)');
  const tags = [...junk(tagsEach), ['p', COMMON]];
  db.exec('BEGIN');
  for (let i = 0; i < n; i++) {
    const e = { id: randomBytes(32).toString('hex'), pubkey: randomBytes(32).toString('hex'), created_at: 1700000000 + i, kind: 8, tags, content: '', sig: '00'.repeat(64) };
    put.run(e.id, e.pubkey, e.kind, e.created_at, '', JSON.stringify(e));
    for (const t of e.tags) tag.run(e.id, t[0], t[1], e.kind, e.created_at);
  }
  db.exec('COMMIT'); db.close();
};
const open = async (port) => { const ws = new WebSocket(`ws://127.0.0.1:${port}`); await new Promise((r) => ws.on('open', r)); return ws; };
const timeReq = async (port, filters) => {
  const ws = await open(port);
  const t = performance.now(); let n = 0;
  await new Promise((r) => { ws.on('message', (m) => { const x = JSON.parse(String(m)); if (x[0] === 'EVENT') n++; if (x[0] === 'EOSE' || x[0] === 'CLOSED') r(); }); ws.send(JSON.stringify(['REQ', 's', ...filters])); });
  const ms = performance.now() - t; ws.terminate(); return { ms, n };
};

test('#1489-v1-refute-48-s2-5 a REQ of 10 matching-nothing filters costs the same whatever many distinct tags the candidate events carry', async () => {
  const dir = mkdtempSync(join(process.cwd(), 'wf48s5-'));
  const N = 600, shapes = { oneTag: 0, manyTags: 2000 }, res = {};
  const F = { '#p': [COMMON], '#a': ['nope'], limit: 1 };
  for (const [name, k] of Object.entries(shapes)) {
    const path = join(dir, `${name}.db`); fill(path, N, k);
    let t0 = performance.now();
    const r = await startRelay({ port: 0, dbPath: path });
    console.log(`  FACTS ${name}: start ${(performance.now() - t0).toFixed(0)} ms`);
    try { await timeReq(r.port, [F]); res[name] = await timeReq(r.port, Array(10).fill(F)); } finally { await r.close(); }
    console.log(`  FACTS ${name}: ${N} events with ${k} junk tags + one #p, REQ of 10 x ${JSON.stringify(F)}: ${res[name].ms.toFixed(1)} ms, ${res[name].n} events sent`);
  }
  const s = res.oneTag.ms, l = res.manyTags.ms;
  assert.ok(l <= 5 * s + 50, `the REQ grew with the tags each candidate carries: ${s.toFixed(0)} -> ${l.toFixed(0)} ms (x${(l / s).toFixed(1)}), nothing sent`);
});
