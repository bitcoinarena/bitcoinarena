// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// kanban #1489 (merge onto 1.9): TODO - see the test's todo note; the attestor kept here is item 15's (close from the round's contract).
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 v1-refute-31 skeptic 3 (#1515, #1852): the seats (server.js holdOutcome) and the page (market.js windowRefusal) now
// refuse an Up/Down attestation observed at another moment than the round's own window end. The ROOT of #1515 is still there: the
// attestor daemon (bin/arena-attestor.mjs roundsOfGame) takes each round's entryCloseMs from the FIRST seat that answers GET /rounds,
// unchecked against the round's contract, and keeps ONE word per round id for good (`words.has(r.id)`). One lying seat first in the
// attestor's --seats lists the real round with a shifted close: the attestor signs the shifted window, every honest seat refuses it
// (409), and the attestor never signs the round's own window - so the round can never be attested and VOIDs. One seat voids every round
// of the market. Safe: the attestor signs a round's own window (its contract's close) and the honest seats get an attestation they hold.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { attestorKey } from '../src/attestor.js';
import { decodeAttestation } from '../../arena-protocol/src/attested.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const BIN = fileURLToPath(new URL('../bin/arena-attestor.mjs', import.meta.url));
const P = 900000n;
const listen = (h) => new Promise((res) => { const s = http.createServer(h); s.listen(0, '127.0.0.1', () => res(s)); });
const freePort = async () => { const s = await listen(() => {}); const p = s.address().port; await new Promise((r) => s.close(r)); return p; };

test('wf1489 v1-refute-31 s3-1: one seat listing a shifted close keeps the attestor from ever signing the round\'s own window', { todo: 'kanban #1489 merge19v1: the 1.9 line keeps item 15 (#1705/#1891), which takes a round\'s close from its contract (GET /round) - these stub seats serve no contract; the candidate-close design of #1995 that this test drives was not merged (same hole as #1705)' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wf1489-s3-'));
  const seed = new Uint8Array(32).fill(7);
  writeFileSync(join(dir, 'key'), seed);
  const me = attestorKey(seed);
  const now = BigInt(Date.now());
  const realClose = (now / P) * P - P;            // its window ended 15-30 min ago
  const fakeClose = realClose + 300000n;          // the lying seat's close, 5 min later (ended too)
  const samples = [];
  for (let t = realClose - P - 300000n; t <= now; t += 10000n) samples.push({ atMs: String(t), price: String(t < realClose + 120000n ? 10000000n : 9000000n), big: true });
  writeFileSync(join(dir, 'samples'), JSON.stringify(samples));
  const gid = 'ab'.repeat(32), rid = 'cd'.repeat(32);
  const posts = [];
  const seat = (close, name) => listen((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (req.method === 'GET' && u.pathname === '/rounds') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ rounds: [{ id: rid, game: { id: gid, name: 'btc-updown-15m' }, entryCloseMs: String(close) }] })); }
    if (req.method === 'POST' && u.pathname === '/outcome') {
      const chunks = []; req.on('data', (c) => chunks.push(c)); req.on('end', () => {
        const a = decodeAttestation(new Uint8Array(Buffer.concat(chunks)));
        posts.push({ seat: name, observedAtMs: a.observedAtMs });
        // an honest seat holds only the round's own window end (server.js holdOutcome)
        if (a.observedAtMs === realClose) { res.writeHead(201); res.end('{}'); } else { res.writeHead(409); res.end('observed at another moment'); }
      });
      return;
    }
    res.writeHead(404); res.end();
  });
  const liar = await seat(fakeClose, 'liar'), honest = await seat(realClose, 'honest');
  const port = await freePort();
  const child = spawn(process.execPath, [BIN, '--name', 'A', '--key', join(dir, 'key'), '--sources', 'none,none2', '--game', 'btc-updown-15m', '--game-id', gid,
    '--seats', `http://127.0.0.1:${liar.address().port},http://127.0.0.1:${honest.address().port}`, '--attestors', toHex(me.pubkey), '--threshold', '1',
    '--port', String(port), '--samples-file', join(dir, 'samples'), '--markets-every-ms', '999999999'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { out += d; });
  try {
    for (let i = 0; i < 60 && !posts.some((p) => p.observedAtMs === realClose) && posts.length < 6; i++) await new Promise((r) => setTimeout(r, 500));
    // one more tick: an attestor that corrects itself would post the round's own window on it
    await new Promise((r) => setTimeout(r, 6000));
  } finally { child.kill('SIGKILL'); liar.close(); honest.close(); }
  const at = (x) => new Date(Number(x)).toISOString();
  console.log('wf1489 v1-refute-31 s3-1:', JSON.stringify({ realEnd: at(realClose), liarEnd: at(fakeClose), posts: posts.map((p) => ({ seat: p.seat, observedAt: at(p.observedAtMs) })) }));
  assert.ok(posts.length > 0, `the attestor posted nothing: ${out.slice(-800)}`);
  assert.ok(posts.some((p) => p.observedAtMs === realClose && p.seat === 'honest'),
    `the honest seat never got an attestation of the round's own window (ends ${at(realClose)}): every one posted was observed at ${[...new Set(posts.map((p) => at(p.observedAtMs)))].join(', ')} - the lying seat's close - and is refused, so the round VOIDs`);
});
