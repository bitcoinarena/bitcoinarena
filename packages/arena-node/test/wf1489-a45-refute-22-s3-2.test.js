// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 a45-refute-22-s3: #1856's other copy. tools/night-recap.mjs reads every seat's GET /season-rounds with a bare
// `await r.json()` (60 s), the read #1856 replaced in server.js. A seat answering past PEER_LISTING_BYTES (4 MB) is read whole.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const TOOL = join(dirname(fileURLToPath(import.meta.url)), '..', 'tools', 'night-recap.mjs');

test('a45-refute-22-s3-2: night-recap does not read a seat\'s 12 MB /season-rounds whole', async () => {
  const pad = 'x'.repeat(12 * 1024 * 1024);
  let sent = 0;
  const srv = http.createServer((req, res) => {
    const body = JSON.stringify({ node: 'ab'.repeat(32), game: { ids: ['9a'.repeat(32)] }, rounds: [], pad });
    sent += body.length;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(body);
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const seat = `http://127.0.0.1:${srv.address().port}`;
  const out = await new Promise((resolve) => {
    const p = spawn(process.execPath, [TOOL], { env: { ...process.env, FROM: new Date(Date.now() - 3600000).toISOString(), TO: new Date().toISOString(),
      SEATS: seat, GAMES: 'nextblock', JSON: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let o = ''; p.stdout.on('data', (d) => { o += d; }); p.stderr.on('data', (d) => { o += d; });
    p.on('close', () => resolve(o));
  });
  srv.close();
  const j = JSON.parse(out.trim().split('\n').pop());
  const counted = j.seats.find(([g]) => g === 'nextblock')[1];
  console.log(`a45-refute-22-s3-2: ${sent} bytes served, seats counted ${counted}`);
  assert.equal(counted, 0, `a ${sent}-byte answer (past the 4 MB peer bound) was read whole and counted`);
});
