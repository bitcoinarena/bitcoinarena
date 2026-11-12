// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// kanban #1489 (merge onto 1.9): TODO - see the test's todo note; the attestor kept here is item 15's (close from the round's contract).
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1995 (#1489 v1-refute-31 s3, #1515): the same attack as s3-1 with a close ON the market's grid (the window before the round's own)
// and two attestors at threshold 2, who trade words: each offers the round's own window too, the peers' words are asked by window end
// (GET /attestation?round=&end=), and the honest seat holds an attestation of its round's own window signed by both.
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

test('wf1489 v1-refute-31 s3-2: a lying seat naming the window before (on the grid) still leaves 2 of 2 attestors signing the round\'s own window', { todo: 'kanban #1489 merge19v1: the 1.9 line keeps item 15 (#1705/#1891), which takes a round\'s close from its contract (GET /round) - these stub seats serve no contract; the candidate-close design of #1995 that this test drives was not merged (same hole as #1705)' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wf1489-s3b-'));
  const now = BigInt(Date.now());
  const realClose = (now / P) * P - P;
  const fakeClose = realClose - P;                // on the grid, the window before
  const samples = [];
  for (let t = fakeClose - P - 300000n; t <= now; t += 10000n) samples.push({ atMs: String(t), price: String(t < realClose - 300000n ? 10000000n : 9000000n), big: true });
  writeFileSync(join(dir, 'samples-a'), JSON.stringify(samples));
  writeFileSync(join(dir, 'samples-b'), JSON.stringify(samples));
  const keys = [new Uint8Array(32).fill(7), new Uint8Array(32).fill(9)];
  keys.forEach((k, i) => writeFileSync(join(dir, `key-${i}`), k));
  const pubs = keys.map((k) => toHex(attestorKey(k).pubkey));
  const gid = 'ab'.repeat(32), rid = 'cd'.repeat(32);
  const posts = [];
  const seat = (close, name) => listen((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (req.method === 'GET' && u.pathname === '/rounds') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ rounds: [{ id: rid, game: { id: gid, name: 'btc-updown-15m' }, entryCloseMs: String(close) }] })); }
    if (req.method === 'POST' && u.pathname === '/outcome') {
      const chunks = []; req.on('data', (c) => chunks.push(c)); req.on('end', () => {
        const a = decodeAttestation(new Uint8Array(Buffer.concat(chunks)));
        posts.push({ seat: name, observedAtMs: a.observedAtMs, signers: a.signatures.length });
        if (a.observedAtMs === realClose) { res.writeHead(201); res.end('{}'); } else { res.writeHead(409); res.end('observed at another moment'); }
      });
      return;
    }
    res.writeHead(404); res.end();
  });
  const liar = await seat(fakeClose, 'liar'), honest = await seat(realClose, 'honest');
  const seats = `http://127.0.0.1:${liar.address().port},http://127.0.0.1:${honest.address().port}`;
  const ports = [await freePort(), await freePort()];
  let out = '';
  const kids = [0, 1].map((i) => {
    const c = spawn(process.execPath, [BIN, '--name', 'AB'[i], '--key', join(dir, `key-${i}`), '--sources', 'none,none2', '--game', 'btc-updown-15m', '--game-id', gid,
      '--seats', seats, '--peers', `http://127.0.0.1:${ports[1 - i]}`, '--attestors', pubs.join(','), '--threshold', '2',
      '--port', String(ports[i]), '--samples-file', join(dir, `samples-${'ab'[i]}`), '--markets-every-ms', '999999999'], { stdio: ['ignore', 'pipe', 'pipe'] });
    c.stdout.on('data', (d) => { out += d; }); c.stderr.on('data', (d) => { out += d; });
    return c;
  });
  try {
    for (let i = 0; i < 80 && !posts.some((p) => p.observedAtMs === realClose && p.seat === 'honest'); i++) await new Promise((r) => setTimeout(r, 500));
  } finally { kids.forEach((c) => c.kill('SIGKILL')); liar.close(); honest.close(); }
  const at = (x) => new Date(Number(x)).toISOString();
  console.log('wf1489 v1-refute-31 s3-2:', JSON.stringify({ realEnd: at(realClose), liarEnd: at(fakeClose), posts: posts.slice(0, 12).map((p) => ({ seat: p.seat, observedAt: at(p.observedAtMs), signers: p.signers })) }));
  const good = posts.find((p) => p.observedAtMs === realClose && p.seat === 'honest');
  assert.ok(good, `the honest seat never got an attestation of the round's own window (ends ${at(realClose)}): ${out.slice(-1200)}`);
  assert.equal(good.signers, 2);
});
