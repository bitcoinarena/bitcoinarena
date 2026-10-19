// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// The node's own Bitcoin Core's settings (kanban #471): RPC and the peer port on this machine only - listening on every network made
// Windows Firewall ask the user to open bitcoind to public networks (measured in the Windows VM, 2026-10-19).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { configureCore } from '../src/bitcoind.js';

test('bitcoin.conf: RPC and the peer port bound to 127.0.0.1, for testnet4 and mainnet', () => {
  const home = mkdtempSync(join(tmpdir(), 'core-conf-'));
  try {
    for (const network of ['testnet4', 'mainnet']) {
      const c = configureCore({ home, network });
      const text = readFileSync(c.conf, 'utf8');
      const port = /^port=(\d+)$/m.exec(text)[1];
      assert.match(text, /^rpcbind=127\.0\.0\.1$/m);
      assert.match(text, new RegExp(`^bind=127\\.0\\.0\\.1:${port}$`, 'm'), `${network}: the peer port on this machine only`);
      assert.ok(!/^bind=0\.0\.0\.0/m.test(text) && !/^listen=0$/m.test(text), 'outbound peers unchanged: listening, locally');
    }
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('an older install\'s files get the same on update: bitcoind bound locally when it names no bind; LND behind Tor on 127.0.0.1; nothing else touched', async () => {
  const { peerPortsLocal } = await import('../src/update.js');
  const { mkdirSync, writeFileSync } = await import('node:fs');
  const home = mkdtempSync(join(tmpdir(), 'ports-local-'));
  try {
    mkdirSync(join(home, 'bitcoin-testnet4')); mkdirSync(join(home, 'lnd'));
    writeFileSync(join(home, 'bitcoin-testnet4', 'bitcoin.conf'), 'testnet4=1\r\nserver=1\r\n[testnet4]\r\nrpcbind=127.0.0.1\r\nport=48343\r\n');
    writeFileSync(join(home, 'lnd', 'lnd.conf'), '[Application Options]\nlisten=0.0.0.0:9735\nrpclisten=127.0.0.1:10009\n[Tor]\ntor.active=true\n');
    assert.deepEqual(peerPortsLocal(home), ['bitcoind-testnet4', 'lnd']);
    assert.match(readFileSync(join(home, 'bitcoin-testnet4', 'bitcoin.conf'), 'utf8'), /\r\nport=48343\r\nbind=127\.0\.0\.1:48343\r\n/, 'a Windows file keeps CRLF');
    assert.match(readFileSync(join(home, 'lnd', 'lnd.conf'), 'utf8'), /^listen=127\.0\.0\.1:9735$/m);
    assert.deepEqual(peerPortsLocal(home), [], 'a second update changes nothing');
    const out = mkdtempSync(join(tmpdir(), 'ports-out-')); mkdirSync(join(out, 'lnd'));
    writeFileSync(join(out, 'lnd', 'lnd.conf'), 'listen=0.0.0.0:9735\nexternalip=198.51.100.4:9735\n[Tor]\ntor.active=true\n');
    assert.deepEqual(peerPortsLocal(out), [], 'a node reached from outside keeps listening on every interface');
    rmSync(out, { recursive: true, force: true });
  } finally { rmSync(home, { recursive: true, force: true }); }
});
