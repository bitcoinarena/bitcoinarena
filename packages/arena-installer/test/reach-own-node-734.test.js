// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE DIRECT CHECK ON AN INSTALLED NODE (kanban #734, measured 2026-10-29 on the VM's ~/.arena-node-730: the installer run again, reach
// "direct", and the check said "port-busy: port 8670 is in use on this machine" - the node itself held the port, so direct could never be
// chosen on a run again). The node now answers the check from its home; another program on the port is still busy.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync, existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as reachKit from '../src/reach.js';
import { createReachCheck } from '../../arena-node/src/reach-check.js';

// an Arena seat's reach door, the real one, on loopback (as installer.test.js)
async function reachSeat() {
  const check = createReachCheck({ allowPrivate: true });
  const server = http.createServer((q, s) => { let b = ''; q.on('data', (d) => { b += d; }); q.on('end', async () => {
    const r = await check(q, JSON.parse(b || '{}')); s.writeHead(r.status, { 'content-type': 'application/json' }); s.end(JSON.stringify(r.body)); }); });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((ok) => server.close(ok)) };
}
/** A program on a port: the node (answers GET /reach-nonce from <home>/reach-nonce while fresh, as server.js does) or another one (404). */
async function onPort({ home = null } = {}) {
  const server = http.createServer((q, s) => {
    let nonce = null;
    try { if (home && q.url === '/reach-nonce' && Date.now() - statSync(join(home, 'reach-nonce')).mtimeMs < 300000) nonce = readFileSync(join(home, 'reach-nonce'), 'utf8').trim(); } catch { nonce = null; }
    s.writeHead(nonce ? 200 : 404, { 'content-type': 'text/plain' }); s.end(nonce || '');
  });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  return { port: server.address().port, close: () => new Promise((ok) => server.close(ok)) };
}
const sh = async () => ({ ok: false, out: '', err: '' });

test('an installed node on its own port answers the direct check itself: the seats reach it, and the nonce file is gone afterwards', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'arena-734-')); t.after(() => rmSync(home, { recursive: true, force: true }));
  const node = await onPort({ home }); t.after(node.close);
  const seat = await reachSeat(); t.after(seat.close);
  const r = await reachKit.checkDirect({ port: node.port, seats: [seat.url, seat.url], home, sh });
  assert.equal(r.ok, true);
  assert.equal(r.reached, true, 'the seats got the nonce from the node itself');
  assert.equal(r.diagnosis.cause, 'reachable');
  assert.equal(existsSync(join(home, 'reach-nonce')), false, 'the nonce is not left in the node\'s home');
});

test('another program on the port is still "port-busy", with or without a home', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'arena-734-')); t.after(() => rmSync(home, { recursive: true, force: true }));
  const other = await onPort(); t.after(other.close);
  const withHome = await reachKit.checkDirect({ port: other.port, seats: ['http://127.0.0.1:1'], home, sh });
  assert.equal(withHome.diagnosis.cause, 'port-busy');
  assert.equal(existsSync(join(home, 'reach-nonce')), false, 'and the nonce file is removed');
  const noHome = await reachKit.checkDirect({ port: other.port, seats: ['http://127.0.0.1:1'], sh });
  assert.equal(noHome.diagnosis.cause, 'port-busy', 'no home: as before');
});
