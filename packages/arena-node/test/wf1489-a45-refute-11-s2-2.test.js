// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// #1489 a45-refute-11-s2-2 (kanban #1826, #2275): a recipient's zap read is still censored by strangers, via the WALKED KIND index. When
// every condition is over DRIVE_ROWS nothing drives and one condition is walked newest first, the others checked. The conditions are
// counted in order ids, authors, kinds, then #<letter>, and each later count is capped at the smallest-so-far - so when both kinds and
// #p R are over DRIVE_ROWS, kinds (counted first) is the walk and #p R can never register as smaller. The #2275 fix's own s1-3 buried the
// recipient under 20,000 events of a DIFFERENT kind (8), so walking kind 9735 stayed clean. Here a stranger floods the SAME kind: ~50 free
// keys publish 24,000 kind-9735 zap receipts to OTHER recipients, all newer than R's 2500 real ones. R's {kinds:[9735],"#p":[R],limit:500}
// walks kind 9735 newest first, spends its whole SCAN_ROWS budget on the strangers' newer receipts, and answers 0 of 2500 - #2275 again,
// from a new role (a stranger burying a third party), against a store that still holds every one of R's receipts.
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
const store = async (fill) => {
  const path = join(mkdtempSync(join(tmpdir(), 'a45-11s2-')), 'relay.db');
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

test('#1489 a45-refute-11-s2-2: strangers flooding kind 9735 do not hide a recipient\'s own zap receipts', async () => {
  const R = H('recipient');
  const r = await store((add) => {
    for (let i = 0; i < 2500; i++) add(9735, 1600000000 + i, `zapper${i % 3}`, [['p', R], ['bolt11', 'x']]);
    // pollute BOTH walkable indexes past SCAN_ROWS with NEWER non-matches, so whichever is walked runs out before R's older real zaps:
    for (let i = 0; i < 24000; i++) add(9735, 1700000000 + i, `stranger${i % 50}`, [['p', H(`other${i}`)], ['bolt11', 'x']]);  // kind 9735 to others
    for (let i = 0; i < 24000; i++) add(8, 1700000000 + i, `badge${i % 50}`, [['p', R]]);  // kind 8 tagging R: inflates #p R, not kind 9735
  });
  const ws = await open(r.port);
  try {
    const got = await ask(ws, ['REQ', 'zaps', { kinds: [9735], '#p': [R], limit: 500 }], (m) => m[0] === 'EOSE' || m[0] === 'CLOSED');
    const n = got.filter((m) => m[0] === 'EVENT').length, notice = got.find((m) => m[0] === 'NOTICE');
    console.log(`R's zap read: ${n} events (limit 500, R holds 2500)${notice ? `, NOTICE: ${notice[1]}` : ''}`);
    assert.equal(n, 500, `R's own zap read (limit 500) answered ${n} of the 2500 receipts the relay still holds${notice ? ' (with a filter-too-broad NOTICE)' : ''}`);
  } finally { ws.terminate(); await r.close(); }
});
