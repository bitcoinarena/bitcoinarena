// THE GATEWAY FOR CUSTODY (kanban #471 slice 5 part 2, gateway.js): gatewayd from the release only; its command line on this node's
// LND with an Esplora chain and setup skipped; the admin password kept and only its bcrypt hash on the command line; the mnemonic from
// the seed (its own words); info read; a federation joined by invite. Measured for real in gateway.js's run (see the commit).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import bcrypt from 'bcryptjs';
import { findGatewayd, configureGateway, gatewayMnemonicOf, testGateway, joinFederation, TESTNET4_ESPLORA } from '../src/gateway.js';
import { phraseFromSeed } from '../../arena-client/src/bip39.js';

test('gatewayd only from the release; its command line, password and mnemonic', () => {
  const release = mkdtempSync(join(tmpdir(), 'rel-'));
  assert.match(findGatewayd({ release, platform: 'linux', arch: 'x64' }).why, /no gateway for linux-x64/);
  mkdirSync(join(release, 'runtime', 'custody'), { recursive: true }); writeFileSync(join(release, 'runtime', 'custody', 'gatewayd.exe'), '');
  assert.equal(findGatewayd({ release, platform: 'win32', arch: 'x64' }).ok, true);
  const home = mkdtempSync(join(tmpdir(), 'gw-'));
  const seed = new Uint8Array(32).fill(5);
  const g = configureGateway({ home, gatewayd: '/r/gatewayd', seed, cost: 4, lnd: { tlsCert: '/l/tls.cert', macaroon: '/l/admin.macaroon' } });
  const pw = readFileSync(g.passwordFile, 'utf8');
  assert.equal(statSync(g.passwordFile).mode & 0o777, 0o600);
  const hash = g.args.find((a) => a.startsWith('--bcrypt-password-hash=')).split('=')[1];
  assert.equal(bcrypt.compareSync(pw, hash), true, 'the hash of the kept password');
  assert.ok(!g.args.join(' ').includes(pw), 'the password itself is not on the command line');
  for (const a of ['--network=testnet4', `--esplora-url=${TESTNET4_ESPLORA}`, '--skip-setup', '--listen=127.0.0.1:8476', 'lnd', '--lnd-rpc-host=https://127.0.0.1:10009', '--lnd-tls-cert=/l/tls.cert', '--lnd-macaroon=/l/admin.macaroon'])
    assert.ok(g.args.includes(a), a);
  assert.equal(g.vars.FM_GATEWAY_MNEMONIC, gatewayMnemonicOf(seed));
  assert.equal(g.vars.FM_GATEWAY_MNEMONIC.split(' ').length, 24);
  assert.notEqual(g.vars.FM_GATEWAY_MNEMONIC, phraseFromSeed(seed).words.join(' '), 'not the node\'s own words');
  assert.equal(readFileSync(configureGateway({ home, gatewayd: '/r/gatewayd', seed, cost: 4, lnd: {} }).passwordFile, 'utf8'), pw, 'kept');
});

test('info read (lightning_info as serde writes it), not connected said so; joining by invite', async () => {
  const home = mkdtempSync(join(tmpdir(), 'gw-'));
  const g = configureGateway({ home, gatewayd: '/r/gatewayd', seed: new Uint8Array(32), cost: 4, lnd: {} });
  const pw = readFileSync(g.passwordFile, 'utf8');
  let asked = [];
  const answer = (status, json) => async (url, o) => { asked.push({ url, o }); return { status, text: async () => JSON.stringify(json) }; };
  const info = { gateway_state: 'Running', federations: [{ federation_id: 'aa'.repeat(32), federation_name: 'A', balance_msat: 0 }],
    lightning_info: { connected: { public_key: '02' + 'ab'.repeat(32), alias: 'node', network: 'testnet4', block_height: 156910, synced_to_chain: true } } };
  const t = await testGateway({ ...g, fetcher: answer(200, info) });
  assert.deepEqual([t.ok, t.state, t.network, t.blockHeight, t.federations[0].name], [true, 'Running', 'testnet4', 156910, 'A']);
  assert.equal(asked[0].url, 'http://127.0.0.1:8476/v1/info');
  assert.equal(asked[0].o.headers.authorization, `Bearer ${pw}`);
  assert.match((await testGateway({ ...g, fetcher: answer(200, { gateway_state: 'Connecting', lightning_info: 'not_connected' }) })).why, /no Lightning node yet \(Connecting\)/);
  assert.match((await testGateway({ ...g, fetcher: answer(200, { ...info, lightning_info: { connected: { ...info.lightning_info.connected, network: 'bitcoin' } } }) })).why, /runs on bitcoin, not testnet4/);
  assert.match((await testGateway({ ...g, fetcher: async () => { throw Object.assign(new Error('x'), { cause: { code: 'ECONNREFUSED' } }); } })).why, /does not answer yet \(ECONNREFUSED\)/);
  asked = [];
  const j = await joinFederation({ ...g, invite: 'fed1qqq', fetcher: answer(200, { federation_id: 'bb'.repeat(32) }) });
  assert.deepEqual([j.ok, j.federationId], [true, 'bb'.repeat(32)]);
  assert.deepEqual(JSON.parse(asked[0].o.body), { invite_code: 'fed1qqq', use_tor: false, recover: false });
  assert.match((await joinFederation({ ...g, invite: 'hello' })).why, /starts with fed1/);
  assert.match((await joinFederation({ ...g, invite: 'fed1zz', fetcher: answer(500, { text: 'Failed to create a federation client' }) })).why, /refused: .*federation client/);
});
