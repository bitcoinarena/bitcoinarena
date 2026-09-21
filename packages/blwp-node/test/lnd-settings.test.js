// THE ONE PARSE OF A LAUNCHER'S LIGHTNING SETTINGS. main-settings.test.js
// pins what src/main.js does with the answer; this pins the answer itself, so a
// second launcher reading it cannot accept what the first refuses.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lightningFromEnv, gatewaysFromEnv, LND_SETTINGS } from '../src/lnd-settings.js';
import { askGatewaysRegtest } from '../src/preflight.js';

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

// THE GATEWAYS A LAUNCHER NAMES (§23.6). Measured on the Daily before this existed: the gate was live, no
// launcher could name a second node, and every paying round was refused "1 of 1 gateways can actually
// receive; the round needs 2" - a keeper trying twice a minute against a rule it had no way to satisfy.
test('no gateways named is an empty list, not an opinion', () => {
  assert.deepEqual(gatewaysFromEnv({}), { ok: true, gateways: [] });
  assert.deepEqual(gatewaysFromEnv({ BLWP_LND_GATEWAYS: '  ' }), { ok: true, gateways: [] });
});

test('lnddir@rpc, comma separated, keeps its order and its rpc', () => {
  const got = gatewaysFromEnv({ BLWP_LND_GATEWAYS: '/x/one@127.0.0.1:1, /x/two@127.0.0.1:2' });
  assert.deepEqual(got, { ok: true, gateways: [
    { lnddir: '/x/one', rpc: '127.0.0.1:1' }, { lnddir: '/x/two', rpc: '127.0.0.1:2' }] });
});

test('a gateway may be named by its directory alone - its own lnd.conf says where it answers', () => {
  assert.deepEqual(gatewaysFromEnv({ BLWP_LND_GATEWAYS: '/x/one,/x/two' }),
    { ok: true, gateways: [{ lnddir: '/x/one', rpc: '' }, { lnddir: '/x/two', rpc: '' }] });
});

test('a gateway with no directory is refused, naming it', () => {
  const got = gatewaysFromEnv({ BLWP_LND_GATEWAYS: '/x/one,@127.0.0.1:2' });
  assert.equal(got.ok, false);
  assert.match(got.why, /names a gateway with no lnd directory: "@127\.0\.0\.1:2"/);
});

test('a bad gateway list refuses the whole parse, so no daemon starts on half of it', () => {
  const got = lightningFromEnv({ ...all, BLWP_LND_NETWORK: 'regtest', BLWP_LND_GATEWAYS: '@x' });
  assert.equal(got.ok, false);
  assert.match(got.why, /BLWP_LND_GATEWAYS/);
});

test('the named gateways reach the preflight, on both networks', () => {
  // Not "a preflight came back": THESE nodes must be the ones asked. Each preflight is given a `run` it
  // cannot help but use, and the lnd directories it shells out for are read back off the calls.
  const asked = [];
  const run = (bin, argv) => {
    const dir = (argv.find((a) => a.startsWith('--lnddir=')) || '').slice('--lnddir='.length);
    if (argv.includes('getinfo')) { asked.push(dir); return JSON.stringify({ identity_pubkey: '02'.padEnd(66, '0'),
      synced_to_chain: true, chains: [{ network: 'regtest' }] }); }
    return JSON.stringify({ channels: [] });
  };
  const two = '/x/one@127.0.0.1:1,/x/two@127.0.0.1:2';
  const reg = lightningFromEnv({ ...all, BLWP_LND_NETWORK: 'regtest', BLWP_LND_GATEWAYS: two });
  assert.equal(reg.ok, true);
  askGatewaysRegtest({ lncli: '/x/lncli', gateways: gatewaysFromEnv({ BLWP_LND_GATEWAYS: two }).gateways, run });
  assert.deepEqual(asked, ['/x/one', '/x/two'], 'the gateways named are the gateways asked');

  const t4 = lightningFromEnv({ ...all, BLWP_LND_NETWORK: 'testnet4', BLWP_LND_GATEWAYS: two });
  assert.equal(t4.ok, true);
  assert.equal(typeof t4.preflight, 'function');
});
