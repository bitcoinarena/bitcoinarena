// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 round 5 (nostr): an event carrying an EMPTY tag ([]) passes eventRefusal (every element of [] is a string), is
// INSERTed, and then tagRows() reads t[0].length of undefined and throws. The throw skips everything after put.run: the
// replaceable drop, the author quota loop (#1513) and the total counter. So one key with `tags: [[]]` keeps any number of
// 64 KB events (the #1513 quota is bypassed), the total counter never moves, and a replaceable kind keeps every copy.
// Safe: the per-author and total quotas hold for such events (or the event is refused), and a restart still starts.
import test from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { schnorr } from '@noble/curves/secp256k1.js';
import { startRelay, eventId } from '../src/nostr-relay.js';

const hex = (b) => Buffer.from(b).toString('hex');
const key = () => { const s = schnorr.utils.randomSecretKey(); return { s, pub: hex(schnorr.getPublicKey(s)) }; };
const ev = (k, i, at, kind = 8, tags = [[]]) => {
  const e = { pubkey: k.pub, created_at: at, kind, tags, content: 'x'.repeat(100) + i };
  e.id = eventId(e); e.sig = hex(schnorr.sign(Buffer.from(e.id, 'hex'), k.s));
  return e;
};
const open = async (port) => { const ws = new WebSocket(`ws://127.0.0.1:${port}`); await new Promise((x) => ws.on('open', x)); return ws; };
const ask = (ws, m, until) => new Promise((x) => { const got = []; const h = (raw) => { const a = JSON.parse(String(raw)); got.push(a); if (until(a)) { ws.off('message', h); x(got); } }; ws.on('message', h); ws.send(JSON.stringify(m)); });

test('r5-nostr-1: an empty tag does not bypass the per-author and total quotas', async () => {
  const r = await startRelay({ port: 0, limits: { authorEvents: 5, totalEvents: 12 } });
  const ws = await open(r.port);
  try {
    const a = key(), t0 = 1_700_000_000;
    for (let i = 0; i < 20; i++) await ask(ws, ['EVENT', ev(a, i, t0 + i)], (m) => m[0] === 'OK' || m[0] === 'NOTICE');
    const kept = r.events().filter((e) => e.pubkey === a.pub).length;
    assert.ok(kept <= 5, `one author keeps ${kept} events past its quota of 5`);
    assert.ok(r.events().length <= 12, `the relay keeps ${r.events().length} events past its total of 12`);
  } finally { ws.terminate(); await r.close(); }
});

test('r5-nostr-1: an empty tag does not keep many copies of a replaceable event', async () => {
  const r = await startRelay({ port: 0 });
  const ws = await open(r.port);
  try {
    const a = key(), t0 = 1_700_000_000;
    for (let i = 0; i < 4; i++) await ask(ws, ['EVENT', ev(a, i, t0 + i, 0)], (m) => m[0] === 'OK' || m[0] === 'NOTICE');
    const profiles = r.events().filter((e) => e.pubkey === a.pub && e.kind === 0).length;
    assert.ok(profiles <= 1, `${profiles} kind-0 profiles kept for one key (replaceable: newest only)`);
  } finally { ws.terminate(); await r.close(); }
});

test('r5-nostr-1: a stored event with an empty tag does not stop the relay from starting again', async () => {
  const dbPath = join(mkdtempSync(join(tmpdir(), 'r5nostr1-')), 'relay.db');
  const r = await startRelay({ port: 0, dbPath });
  const ws = await open(r.port);
  await ask(ws, ['EVENT', ev(key(), 0, 1_700_000_000, 0)], (m) => m[0] === 'OK' || m[0] === 'NOTICE');
  ws.terminate(); await r.close();
  let r2 = null, err = null;
  try { r2 = await startRelay({ port: 0, dbPath }); } catch (e) { err = e; }
  if (r2) await r2.close();
  assert.equal(err, null, `the relay does not start: ${err && err.message}`);
});
