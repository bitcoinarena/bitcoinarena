// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// AN ELECTRUM SESSION LIVES PAST ITS OPEN TIMEOUT, AND A DEAD ONE FAILS INSTEAD OF HANGING (kanban #734, measured 2026-10-29 in the Linux
// VM after an installer re-run moved the node to Electrum: every bridge session was torn down 20 s after it opened - "did not answer in
// 20000 ms" from servers that answered - and once one was torn down while idle, the bridge's getblockcount waited for good).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { electrumSession } from '../src/chain-test.js';

const wait = (ms) => new Promise((ok) => setTimeout(ok, ms));

/** A plain-TCP Electrum stand-in: answers each request with { height: 7 }, except the methods in `silent`; `kill()` closes every connection. */
async function server({ silent = [] } = {}) {
  const socks = new Set();
  const srv = net.createServer((s) => {
    socks.add(s); let buf = '';
    s.on('data', (d) => {
      buf += d; let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const m = JSON.parse(buf.slice(0, nl)); buf = buf.slice(nl + 1);
        if (!silent.includes(m.method)) s.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { height: 7 } }) + '\n');
      }
    });
    s.on('close', () => socks.delete(s));
  });
  await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
  // the server's side of a connection is known a moment after the client's connect: kill() waits for it
  return { port: srv.address().port, kill: async () => { while (!socks.size) await wait(10); for (const s of socks) s.destroy(); }, close: () => new Promise((ok) => { for (const s of socks) s.destroy(); srv.close(ok); }) };
}

test('a call made after the open timeout is still answered', async (t) => {
  const srv = await server(); t.after(srv.close);
  const x = await electrumSession({ host: '127.0.0.1', port: srv.port, tls: false, timeoutMs: 200 });
  await wait(500);
  assert.deepEqual(await x.call('blockchain.headers.subscribe'), { height: 7 }, 'the session was not torn down at 200 ms');
  x.close();
});

test('a session the server closed while idle fails the next call at once', async (t) => {
  const srv = await server(); t.after(srv.close);
  const x = await electrumSession({ host: '127.0.0.1', port: srv.port, tls: false, timeoutMs: 5000 });
  await srv.kill(); await wait(100);
  const t0 = Date.now();
  await assert.rejects(x.call('blockchain.headers.subscribe'), /closed the connection/);
  assert.ok(Date.now() - t0 < 1000, 'failed at once, not after the timeout and not never');
});

test('a call the server never answers fails after the session timeout', async (t) => {
  const srv = await server({ silent: ['blockchain.block.header'] }); t.after(srv.close);
  const x = await electrumSession({ host: '127.0.0.1', port: srv.port, tls: false, timeoutMs: 300 });
  await assert.rejects(x.call('blockchain.block.header', [1]), /did not answer blockchain\.block\.header in 300 ms/);
  assert.deepEqual(await x.call('blockchain.headers.subscribe'), { height: 7 }, 'the session still answers its other calls');
  x.close();
});
