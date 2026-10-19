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
