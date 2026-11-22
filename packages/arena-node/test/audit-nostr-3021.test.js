// kanban #3021: the card's test (audit nostr r1-1 of 2026-11-19)
// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// audit 2026-11-19 nostr r1 #1 (P11, gap in the #3004 fix): making room in a full pool walks the pool in arrival order (index ev_pool) and
// asks the standing check per candidate - so the walk is still linear in the events of authors WITH standing that sit before the first
// evictable one. Standing comes from a seed this relay kept 7 days (free: #2987), and authors with standing are never evicted, so over time
// they form the front of the pool. 180 such keys x 500 state events each (their own quota: kind 30762 under fresh `d`s) put 90,000
// never-evictable rows before every evictable one, and every later EVENT into the full pool walks all of them on the relay's one loop.
// SAFE: making room for one event costs about the same whether 90,000 standing rows sit at the front of the pool or none.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { startRelay } from '../src/nostr-relay.js';
import { key, ev, open, ask, publish } from './_r22-common.mjs';

const FRONT = 90000, KEYS = 180, TOTAL = FRONT + 200;

// what 180 keys leave after their seeds were kept 8 days ago and each then sent 500 kind-30762 events under fresh `d`s through EVENT
// (rows inserted directly: the relay keeps stored rows as they are; each row is what EVENT keeps)
function parkStanding(dbPath, standing) {
  const db = new DatabaseSync(dbPath);
  const put = db.prepare('INSERT INTO events (id, pubkey, kind, created_at, d, json, size, kept_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  const nowS = Math.floor(Date.now() / 1000), nowMs = Date.now(), oldMs = nowMs - 8 * 86400000;
  const row = (pubkey, kind, d, keptMs, at) => {
    const id = randomBytes(32).toString('hex');
    const e = { id, pubkey, created_at: at, kind, tags: [['d', d]], content: 'x'.repeat(40), sig: 'a'.repeat(128) };
    const json = JSON.stringify(e);
    put.run(id, pubkey, kind, at, d, json, json.length + 340, keptMs);
  };
  db.exec('BEGIN');
  for (let k = 0; k < KEYS; k++) {
    const pubkey = randomBytes(32).toString('hex');
    row(pubkey, 30078, 'bitcoin-arena/seed', standing ? oldMs : nowMs - 1000, nowS - 8 * 86400);
    for (let i = 0; i < FRONT / KEYS; i++) row(pubkey, 30762, `junk:${k}:${i}`, nowMs - 1000, nowS - 2000);
  }
  db.exec('COMMIT');
  db.close();
}

async function msPerWrite(front, standing) {
  const dir = mkdtempSync(join(tmpdir(), 'audit-nostr-r1-1-'));
  const dbPath = join(dir, 'relay.db');
  const limits = { totalEvents: front ? TOTAL : 200 };
  const first = await startRelay({ port: 0, dbPath, limits });
  await first.close();
  if (front) parkStanding(dbPath, standing);
  const r = await startRelay({ port: 0, dbPath, limits });
  const socks = [];
  try {
    const t0 = Math.floor(Date.now() / 1000) - 1000;
    // the rest of the state pool filled by fresh keys (one profile each)
    const fill = Array.from({ length: 200 }, (_, i) => ev(key(), { kind: 0, at: t0 + i, content: '{}' }));
    const oks = await publish(r.port, fill, socks);
    assert.ok(oks.every((m) => m[2] === true), JSON.stringify(oks.find((m) => m[2] !== true)));
    // each new profile now makes room for itself: timed in the relay's own process
    const next = Array.from({ length: 40 }, (_, i) => ev(key(), { kind: 0, at: t0 + 300 + i, content: '{}' }));
    const ws = await open(r.port); socks.push(ws);
    const start = performance.now();
    for (const e of next) { const [ok] = await ask(ws, ['EVENT', e], (m) => m[0] === 'OK'); assert.equal(ok[2], true, ok[3]); }
    return (performance.now() - start) / next.length;
  } finally { for (const w of socks) w.terminate(); await r.close(); }
}

test('audit nostr r1 #1: a write into a full pool costs no more with 90,000 standing rows at its front than with none', async () => {
  const base = await msPerWrite(0, false);
  // the same 90,000 rows, their seeds kept less than 7 days (no standing): the first of them is the victim at once
  const same = await msPerWrite(FRONT, false);
  const parked = await msPerWrite(FRONT, true);
  console.log(`ms per write: empty ${base.toFixed(2)}, 90,000 rows without standing ${same.toFixed(2)}, 90,000 standing rows ${parked.toFixed(2)}`);
  assert.ok(parked < Math.max(5 * same, 5), `${parked.toFixed(1)} ms per write with the 90,000 front rows' authors standing, ${same.toFixed(2)} ms when they do not`);
  assert.ok(parked < Math.max(5 * base, 5), `one write into a full pool took ${parked.toFixed(1)} ms with 90,000 standing rows at the front (${base.toFixed(2)} ms with none): `
    + 'oldestUnstanding walks every standing author\'s event before the first evictable one');
});

