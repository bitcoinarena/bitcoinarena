// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #3238: a Linux seat keeps ~0.8 GB of freed memory for its whole life. Measured read-only on the 7 test-host seats (2026-11-24, glibc
// main-arena chunks walked in /proc/<pid>/mem): [heap] 970-990 MB each, of it 190-250 MB in use and 716-794 MB free - scattered holes that
// glibc never gives back (it trims only the top). The holes come from network bodies: every socket read is a 64 KB malloc, under glibc's
// mmap threshold (128 KB by default), so a few large bodies at once (16 MB getblock batches, peer answers) grow the brk heap; a small
// buffer kept from that time pins each region. With MALLOC_MMAP_THRESHOLD_=16384 those reads are mappings of their own, unmapped when freed.
// The seat's unit (written by the installer) sets it; this test measures the effect with the unit's own environment.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { seatUnit } from '../src/service.js';

const unit = seatUnit({ node: '/opt/node/bin/node', release: '/opt/arena/r1', home: '/home/a/.arena', port: 6221 });
const unitEnv = Object.fromEntries([...unit.matchAll(/^Environment=([A-Z_]+)=(\S+)$/gm)].map((m) => [m[1], m[2]]));

test('#3238: the seat unit sets glibc\'s mmap threshold to 16 KB', () => {
  assert.equal(unitEnv.MALLOC_MMAP_THRESHOLD_, '16384');
});

// six 16 MB bodies fetched at once, three times, while small buffers are kept (what a seat holds on to): the brk heap after a GC
const PROBE = `
import http from 'node:http'; import { readFileSync } from 'node:fs';
const BODY = Buffer.alloc(16 << 20, 0x61);
const srv = http.createServer((q, r) => r.end(BODY)).listen(0, '127.0.0.1'); await new Promise((r) => srv.on('listening', r));
const url = 'http://127.0.0.1:' + srv.address().port + '/'; const keep = [];
for (let k = 0; k < 3; k++) await Promise.all(Array.from({ length: 6 }, async () => { const t = await (await fetch(url)).text();
  for (let i = 0; i < 300; i++) keep.push(Buffer.from(new Uint8Array(200 + (i % 50)))); return t.length; }));
gc(); await new Promise((r) => setTimeout(r, 300)); gc();
const s = readFileSync('/proc/self/smaps', 'utf8'), i = s.indexOf('[heap]');
console.log(i < 0 ? 0 : Math.round(Number(/Rss:\\s+(\\d+)/.exec(s.slice(i))[1]) / 1024)); srv.close(); process.exit(0);`;
const heapMb = (env) => Number(execFileSync(process.execPath, ['--expose-gc', '--input-type=module', '-e', PROBE], { env: { PATH: process.env.PATH, ...env }, timeout: 60000 }).toString().trim());

test('#3238: with the unit\'s environment the brk heap stays small after large bodies (glibc only)', { skip: process.platform !== 'linux' && 'glibc only' }, () => {
  const glibcDefault = heapMb({});
  const seat = heapMb(unitEnv);
  // measured on the test host: default ~140 MB, the unit's environment ~5 MB
  assert.ok(glibcDefault >= 48, `the probe grows the brk heap under glibc's defaults (${glibcDefault} MB)`);
  assert.ok(seat <= 24, `the seat unit's environment keeps it small: ${seat} MB (default ${glibcDefault} MB)`);
});
