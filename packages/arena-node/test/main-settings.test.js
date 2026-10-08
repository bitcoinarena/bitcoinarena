// WHAT THE REAL LAUNCHER TAKES, AND WHAT IT REFUSES BEFORE IT OPENS ANYTHING.
//
// `src/main.js` is how a daemon is started and restarted, so a setting it does
// not read is a capability no restarted daemon has. Measured on an isolated
// regtest (tools/custody-restart-lnd.mjs): a custodian killed inside a settle
// and started again as main.js left its stake ACTING, because no launch path
// handed a daemon its Lightning node.
//
// Half a chain or half a Lightning node is refused by name, exit 2, rather than
// started as a daemon that silently reaches neither.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const MAIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'main.js');
const launch = (env) => spawnSync(process.execPath, [MAIN, '0', ':memory:'], {
  env: { PATH: process.env.PATH, ...env }, encoding: 'utf8', timeout: 20000,
});

test('half a chain is refused by name before anything starts', () => {
  const got = launch({ ARENA_BITCOIND_URL: 'http://127.0.0.1:1/' });
  assert.equal(got.status, 2, got.stderr);
  assert.match(got.stderr, /ARENA_BITCOIND_URL and ARENA_BITCOIND_COOKIE go together/);
});

test('half a Lightning node is refused by name, and each missing setting is named', () => {
  for (const env of [
    { ARENA_LND_DIR: '/nowhere' },
    { ARENA_LNCLI: '/nowhere/lncli', ARENA_LND_DIR: '/nowhere', ARENA_LND_RPC: '127.0.0.1:1' },
  ]) {
    const got = launch(env);
    assert.equal(got.status, 2, `${JSON.stringify(env)}: ${got.stderr}`);
    assert.match(got.stderr, /ARENA_LNCLI, ARENA_LND_DIR, ARENA_LND_RPC and ARENA_LND_NETWORK go together/);
    assert.match(got.stderr, /missing: .*ARENA_LND_NETWORK/);
  }
});

test('a Lightning network a round may not run on is refused', () => {
  const got = launch({ ARENA_LNCLI: '/nowhere/lncli', ARENA_LND_DIR: '/nowhere',
    ARENA_LND_RPC: '127.0.0.1:1', ARENA_LND_NETWORK: 'mainnet' });
  assert.equal(got.status, 2, got.stderr);
  assert.match(got.stderr, /mainnet is not a network a round may run on here/);
});
