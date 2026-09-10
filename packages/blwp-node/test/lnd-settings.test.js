// THE ONE PARSE OF A LAUNCHER'S LIGHTNING SETTINGS. main-settings.test.js
// pins what src/main.js does with the answer; this pins the answer itself, so a
// second launcher reading it cannot accept what the first refuses.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lightningFromEnv, LND_SETTINGS } from '../src/lnd-settings.js';

const all = { BLWP_LNCLI: '/x/lncli', BLWP_LND_DIR: '/x/lnd', BLWP_LND_RPC: '127.0.0.1:1' };

test('no settings is a daemon with no Lightning, and says so', () => {
  assert.deepEqual(lightningFromEnv({}), { ok: true, given: false });
});

test('each of the four missing alone is refused, naming it', () => {
  const full = { ...all, BLWP_LND_NETWORK: 'regtest' };
  for (const k of LND_SETTINGS) {
    const env = { ...full }; delete env[k];
    const got = lightningFromEnv(env);
    assert.equal(got.ok, false, k);
    assert.match(got.why, new RegExp(`missing: ${k}`));
  }
});

test('mainnet, or a network spelled wrong, is refused', () => {
  for (const net of ['mainnet', 'testnet', 'Testnet4']) {
    const got = lightningFromEnv({ ...all, BLWP_LND_NETWORK: net });
    assert.equal(got.ok, false, net);
    assert.match(got.why, /is not a network a round may hold stakes on/);
  }
});

test('regtest and testnet4 each get a port and a preflight', () => {
  // A regtest daemon given Lightning and NO preflight opened no paying round:
  // measured 503 "this node holds stakes and has no preflight". It gets the
  // regtest ask now, with the same flags the port uses.
  const reg = lightningFromEnv({ ...all, BLWP_LND_NETWORK: 'regtest' });
  assert.equal(reg.ok, true);
  assert.equal(typeof reg.lightning.look, 'function');
  assert.equal(typeof reg.preflight, 'function', 'a regtest daemon with Lightning can open no paying round');
  const t4 = lightningFromEnv({ ...all, BLWP_LND_NETWORK: 'testnet4' });
  assert.equal(typeof t4.lightning.settle, 'function');
  assert.equal(typeof t4.preflight, 'function');
});
