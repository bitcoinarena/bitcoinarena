// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #3151 (refute of #3048): round-2of2 servePage decoded the target with decodeURIComponent outside any try; `GET /%` threw a
// URIError in the request handler and ended the process. SAFE: 400, the page server keeps serving.
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import http from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { servePage } from '../tools/round-2of2.mjs';

const raw = (port, target) => new Promise((resolve) => {
  const s = net.connect(port, '127.0.0.1', () => s.write(`GET ${target} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`));
  let got = ''; s.on('data', (d) => { got += d; }); s.on('error', () => resolve(got)); s.on('close', () => resolve(got));
  setTimeout(() => { s.destroy(); resolve(got); }, 2000);
});

test('a bad escape in the target is answered 400 and the page server keeps serving', { timeout: 30000 }, async () => {
  const build = mkdtempSync(join(tmpdir(), 'r2of2-page-'));
  writeFileSync(join(build, 'index.html'), '<p>ok</p>');
  const caught = [];
  const onErr = (e) => caught.push(e);
  process.on('uncaughtException', onErr);
  const { server, port } = await servePage(build, { port: 0 });
  try {
    const bad = await raw(port, '/%');
    assert.match(bad.split('\r\n')[0], /^HTTP\/1\.1 400/, `answer to GET /%: ${JSON.stringify(bad.split('\r\n')[0])}`);
    const good = await new Promise((r) => http.get({ host: '127.0.0.1', port, path: '/' }, (q) => { let b = ''; q.on('data', (d) => { b += d; }); q.on('end', () => r([q.statusCode, b])); }));
    assert.deepEqual(good, [200, '<p>ok</p>']);
    assert.equal(caught.length, 0, `uncaught: ${caught.map(String).join('; ')}`);
  } finally { process.off('uncaughtException', onErr); server.close(); }
});
