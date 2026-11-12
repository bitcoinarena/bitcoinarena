// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1720 (#1489 v1 refute 48, after #1543): every filter shape is read through an index, never a walk of events or tags, and the bounded
// two-step answer gives exactly what a full scan gives on a store its streams cover - on a fresh store and on one whose tags table the build
// before wrote (id, name, value only).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import WebSocket from 'ws';
import { startRelay, matches } from '../src/nostr-relay.js';

const h = (s) => createHash('sha256').update(String(s)).digest('hex');
const AUTHORS = [h('a1'), h('a2'), h('a3'), h('a4')], PS = [h('p1'), h('p2'), h('p3')];
const KINDS = [8, 30009, 30762, 9735];
const make = (n) => Array.from({ length: n }, (_, i) => ({ id: h(`ev${i}`), pubkey: AUTHORS[i % 4], created_at: 1700000000 + i * 7 % 997 * 3 + i % 3,
  kind: KINDS[(i >> 2) % 4], tags: [['p', PS[i % 3]], ...(i % 5 === 0 ? [['e', h(`e${i % 10}`)], ['p', PS[(i + 1) % 3]]] : []), ['d', `d${i % 6}`]],
  content: `c${i}`, sig: '00'.repeat(64) }));
const fill = (path, evs, oldTags) => {
  const db = new DatabaseSync(path);
  db.exec('CREATE TABLE events (id TEXT PRIMARY KEY, pubkey TEXT, kind INTEGER, created_at INTEGER, d TEXT, json TEXT)');
  const put = db.prepare('INSERT INTO events (id, pubkey, kind, created_at, d, json) VALUES (?, ?, ?, ?, ?, ?)');
  if (oldTags) db.exec('CREATE TABLE tags (id TEXT, name TEXT, value TEXT); CREATE INDEX tag_value ON tags (name, value)');
  const tag = oldTags && db.prepare('INSERT INTO tags (id, name, value) VALUES (?, ?, ?)');
  for (const e of evs) {
    put.run(e.id, e.pubkey, e.kind, e.created_at, '', JSON.stringify(e));
    if (tag) for (const t of e.tags) if (t[0].length === 1 && t.length > 1) tag.run(e.id, t[0], t[1]);
  }
  db.close();
};
const req = async (port, f) => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`); await new Promise((r) => ws.on('open', r));
  const got = [];
  await new Promise((r) => { ws.on('message', (m) => { const x = JSON.parse(String(m)); if (x[0] === 'EVENT') got.push(x[2].id); if (x[0] === 'EOSE' || x[0] === 'CLOSED') r(); }); ws.send(JSON.stringify(['REQ', 's', f])); });
  ws.terminate(); return got;
};
const naive = (evs, f) => evs.filter((e) => matches(f, e)).sort((a, b) => b.created_at - a.created_at || (a.id < b.id ? -1 : 1))
  .slice(0, Math.min(f.limit ?? 500, 500)).map((e) => e.id);
const FILTERS = [
  { kinds: [8, 30009], limit: 7 }, { kinds: [8], '#p': [PS[0]], limit: 5 }, { '#p': [PS[1]], limit: 9 }, { '#p': [PS[0], PS[2]], kinds: [8, 9735], limit: 20 },
  { authors: [AUTHORS[0], AUTHORS[2]], kinds: [30762], limit: 6 }, { authors: [AUTHORS[1]], '#d': ['d3'] }, { authors: [AUTHORS[3].slice(0, 6)] },
  { authors: [AUTHORS[3].slice(0, 6), AUTHORS[3]], limit: 4 }, { ids: [h('ev3'), h('ev40'), h('ev41').slice(0, 9)] }, { ids: [h('ev5')], kinds: [9] },
  { '#e': [h('e5')], '#p': [PS[1]] }, { since: 1700001000, until: 1700002000, limit: 11 }, { kinds: [30009], since: 1700002500 }, { limit: 3 },
  { '#p': [h('nobody')], kinds: [8], limit: 1 }, { since: 5, until: 4 }, { kinds: [8], limit: 0 },
  { authors: AUTHORS, kinds: KINDS, '#p': PS, limit: 30 },
];

for (const oldTags of [false, true]) {
  test(`#1720 a bounded answer equals the full scan (${oldTags ? 'tags table of the build before' : 'fresh store'})`, async () => {
    const dir = mkdtempSync(join(process.cwd(), 'wf1720-')), path = join(dir, 'r.db'), evs = make(400);
    fill(path, evs, oldTags);
    const r = await startRelay({ port: 0, dbPath: path });
    try {
      for (const f of FILTERS) assert.deepEqual(await req(r.port, f), naive(evs, f), JSON.stringify(f));
    } finally { await r.close(); }
  });
}

test('#1720 every filter shape reads events and tags only through an index', async () => {
  const r = await startRelay({ port: 0 });
  try {
    for (const f of FILTERS.filter((x) => x.limit !== 0 && !(x.since > x.until))) {
      const plans = r.plans(f);
      const none = (f.authors || []).every((a) => a.length < 64) && f.authors;   // only prefixes: matches nothing, runs nothing
      assert.ok(none ? plans.length === 0 : plans.length >= 2, JSON.stringify(f));
      for (const { sql, plan } of plans) {
        const txt = plan.join(' | ');
        assert.doesNotMatch(txt, /\bSCAN (events|tags|e|t)\b(?! USING)/, `${JSON.stringify(f)}: ${sql} -> ${txt}`);
        if (/^SELECT id, created_at FROM/.test(sql)) {   // a stream: one index range, newest first, no sort
          assert.match(txt, /USING (COVERING )?INDEX (ev_time|ev_kind_time|ev_author_time|ev_author_kind_time|tag_value_time|tag_value_kind_time)\b/, `${sql} -> ${txt}`);
          assert.doesNotMatch(txt, /TEMP B-TREE/, `${sql} -> ${txt}`);
        } else {
          assert.match(txt, /SEARCH e USING INDEX sqlite_autoindex_events_1 \(id=\?\)/, `${sql} -> ${txt}`);
        }
      }
    }
  } finally { await r.close(); }
});
