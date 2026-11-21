// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// audit nostr r3 #1: every write into a full state/log pool makes room with oldestUnstanding, whose standing check
// `pubkey NOT IN (SELECT pubkey FROM events WHERE kind = 30078 AND COALESCE(kept_ms, ...) <= ?)` reads EVERY kept seed (kept_ms is not
// indexed) once per victim. Seeds are free (one per fresh key, no proof of work below 90 % of the 100,000-seed pool), so a stranger who
// parks ~90,000 seeds makes every later EVENT into a full pool cost a scan of all of them on the relay's one event loop.
// SAFE: making room for one event costs about the same whether the seed pool is empty or holds 90,000 seeds.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { startRelay } from '../src/nostr-relay.js';
import { key, ev, open, ask, publish } from './_r22-common.mjs';

const TOTAL = 200;

// the store a stranger leaves after sending `n` kind-30078 seeds, one per fresh key, through EVENT (inserted directly here: the relay
// keeps stored rows as they are, and signing and sending 90,000 events would only make the test slow; each row is what EVENT keeps)
function parkSeeds(dbPath, n) {
  const db = new DatabaseSync(dbPath);
  const put = db.prepare('INSERT INTO events (id, pubkey, kind, created_at, d, json, size, kept_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  const nowS = Math.floor(Date.now() / 1000), nowMs = Date.now();
  db.exec('BEGIN');
  for (let i = 0; i < n; i++) {
    const id = randomBytes(32).toString('hex'), pubkey = randomBytes(32).toString('hex');
    const e = { id, pubkey, created_at: nowS, kind: 30078, tags: [['d', 'arena-seed']], content: 'x'.repeat(40), sig: 'a'.repeat(128) };
    const json = JSON.stringify(e);
    put.run(id, pubkey, 30078, nowS, 'arena-seed', json, json.length + 340, nowMs);
  }
  db.exec('COMMIT');
  db.close();
}

async function msPerWrite(seeds) {
  const dir = mkdtempSync(join(tmpdir(), 'audit-nostr-r3-1-'));
  const dbPath = join(dir, 'relay.db');
  const first = await startRelay({ port: 0, dbPath, limits: { totalEvents: TOTAL } });
  await first.close();
  if (seeds) parkSeeds(dbPath, seeds);
  const r = await startRelay({ port: 0, dbPath, limits: { totalEvents: TOTAL } });
  const socks = [];
  try {
    const t0 = Math.floor(Date.now() / 1000) - 1000;
    // the state pool filled to its total by fresh keys (one profile each)
    const fill = Array.from({ length: TOTAL }, (_, i) => ev(key(), { kind: 0, at: t0 + i, content: '{}' }));
    const oks = await publish(r.port, fill, socks);
    assert.ok(oks.every((m) => m[2] === true));
    // now each new profile makes room for itself: time it, in the relay's own process (the event loop every player shares)
    const next = Array.from({ length: 40 }, (_, i) => ev(key(), { kind: 0, at: t0 + TOTAL + i, content: '{}' }));
    const ws = await open(r.port); socks.push(ws);
    const start = performance.now();
    for (const e of next) { const [ok] = await ask(ws, ['EVENT', e], (m) => m[0] === 'OK'); assert.equal(ok[2], true, ok[3]); }
    return (performance.now() - start) / next.length;
  } finally { for (const w of socks) w.terminate(); await r.close(); }
}

test('audit nostr r3 #1: a write into a full pool costs no more with 90,000 parked seeds than with none', async () => {
  const base = await msPerWrite(0);
  const parked = await msPerWrite(90000);
  console.log(`ms per write: no seeds ${base.toFixed(2)}, 90,000 seeds ${parked.toFixed(2)}`);
  assert.ok(parked < Math.max(5 * base, 5), `one write into a full pool took ${parked.toFixed(1)} ms with 90,000 parked seeds (${base.toFixed(2)} ms with none): `
    + 'each eviction re-reads every kept seed, so ~60 writes a second per stranger hold the relay\'s event loop');
});

