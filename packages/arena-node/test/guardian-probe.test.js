// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// IS THIS NODE'S GUARDIAN THE ONE THAT ANSWERS? (the 2026.1.9.11 install test: another node's guardian held the API port this node's
// fedimintd could not bind, and a bare TCP connect called it running). A websocket server speaking fedimint's JSON-RPC stands in for a
// guardian: in setup it answers `setup_status` and the admin `get_setup_code`, in consensus the admin `auth`; a wrong password is a 401.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';
import { guardianAnswers, lastErrorLine } from '../src/guardian-probe.js';

function fakeGuardian({ password, setup }) {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  const calls = [];
  wss.on('connection', (ws) => ws.on('message', (m) => {
    const j = JSON.parse(String(m));
    const auth = j.params[0].auth;
    calls.push({ method: j.method, auth });
    const ok = (result) => ws.send(JSON.stringify({ jsonrpc: '2.0', id: j.id, result }));
    const err = (code, message) => ws.send(JSON.stringify({ jsonrpc: '2.0', id: j.id, error: { code, message } }));
    if (j.method === 'setup_status') return ok(setup ? 'AwaitingLocalParams' : 'ConsensusIsRunning');
    if ((setup && j.method === 'get_setup_code') || (!setup && j.method === 'auth')) return auth === password ? ok(null) : err(401, 'Invalid authorization');
    return err(-32601, 'Method not found');
  }));
  return new Promise((ok) => wss.on('listening', () => ok({ port: wss.address().port, calls, close: () => new Promise((r) => { for (const c of wss.clients) c.terminate(); wss.close(r); }) })));
}
const node = (password, log = null) => {
  const root = mkdtempSync(join(tmpdir(), 'guardian-probe-'));
  const dir = join(root, 'node.db.guardian'); mkdirSync(dir);
  if (password) writeFileSync(join(dir, 'admin-password'), `${password}\n`);
  if (log) writeFileSync(join(dir, 'fedimintd.log'), log);
  return { root, dir };
};

test('its own guardian, in setup and running a federation: answers with this node\'s password', async () => {
  for (const setup of [true, false]) {
    const g = await fakeGuardian({ password: 'mine', setup });
    const n = node('mine');
    try {
      const a = await guardianAnswers({ apiPort: g.port, dataDir: n.dir });
      assert.deepEqual([a.ok, a.ours, a.setup], [true, true, setup]);
      assert.match(a.says, setup ? /its API answers on port \d+ \(in setup\)/ : /^its API answers on port \d+$/);
      assert.deepEqual(g.calls.map((c) => c.method), ['setup_status', setup ? 'get_setup_code' : 'auth']);
      assert.equal(g.calls[1].auth, 'mine', 'the admin password from its data dir');
    } finally { await g.close(); rmSync(n.root, { recursive: true, force: true }); }
  }
});

test('another node\'s guardian on its port (the 2026.1.9.11 install test): not ours, and its log\'s last error says why', async () => {
  const g = await fakeGuardian({ password: 'theirs', setup: true });
  const n = node('mine', '2026-10-27T10:00:00Z  INFO fedimintd: Starting\n\x1b[31m2026-10-27T10:00:01Z ERROR\x1b[0m fedimintd: Bind address: 127.0.0.1:12770 ... Address already in use (os error 48)\n');
  try {
    const a = await guardianAnswers({ apiPort: g.port, dataDir: n.dir });
    assert.deepEqual([a.ok, a.ours], [false, false]);
    assert.match(a.says, /another guardian answers on its API port \d+ and refuses this node's password; its log: 2026-10-27T10:00:01Z ERROR fedimintd: Bind address: 127\.0\.0\.1:12770 \.\.\. Address already in use/);
  } finally { await g.close(); rmSync(n.root, { recursive: true, force: true }); }
});

test('nothing on its port: said with the log\'s reason; something there but no password to ask with: not called ours', async () => {
  const g = await fakeGuardian({ password: 'x', setup: true });
  const port = g.port; await g.close();
  const n = node('mine', 'thread main panicked at fedimintd: could not open the database\n');
  try {
    const a = await guardianAnswers({ apiPort: port, dataDir: n.dir });
    assert.deepEqual([a.ok, a.ours], [false, null]);
    assert.match(a.says, new RegExp(`nothing listens on its API port ${port}; its log: thread main panicked`));
  } finally { rmSync(n.root, { recursive: true, force: true }); }
  const g2 = await fakeGuardian({ password: 'x', setup: false });
  try {
    const b = await guardianAnswers({ apiPort: g2.port, dataDir: null });
    assert.equal(b.ok, false); assert.match(b.says, /holds no admin password/);
  } finally { await g2.close(); }
});

test('the last error line: the newest one, colours out; none in a quiet log or no log', () => {
  const n = node(null, 'a ERROR first\nINFO fine\nWARN x\nERROR second one\nINFO after\n');
  try {
    assert.equal(lastErrorLine(join(n.dir, 'fedimintd.log')), 'ERROR second one');
    writeFileSync(join(n.dir, 'fedimintd.log'), 'INFO all fine\n');
    assert.equal(lastErrorLine(join(n.dir, 'fedimintd.log')), null);
    assert.equal(lastErrorLine(join(n.dir, 'none.log')), null);
  } finally { rmSync(n.root, { recursive: true, force: true }); }
});
