// LIGHTNING FOR CUSTODY (kanban #471 slice 5, lnd.js): the pinned release per system, lnd.conf for testnet4 on the node's Core, the
// wallet from the node's own seed (BIP32 test vector 1), the wallet created once, getinfo read and a wrong network refused.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { LND_FILES, installLnd, configureLnd, lndArgs, bip32Master, lndMasterKey, createLndWallet, testLnd } from '../src/lnd.js';

test('BIP32 master (test vector 1, testnet form) and the LND wallet key of a seed: its own, the same every time', () => {
  assert.equal(bip32Master(Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex')),
    'tprv8ZgxMBicQKsPeDgjzdC36fs6bMjGApWDNLR9erAXMs5skhMv36j9MV5ecvfavji5khqjWaWSFhN3YcCUUdiKH6isR4Pwy3U5y5egddBr16m');
  const seed = new Uint8Array(32).fill(7);
  assert.match(lndMasterKey(seed), /^tprv8ZgxMBicQKsP/);
  assert.equal(lndMasterKey(seed), lndMasterKey(seed));
  assert.notEqual(lndMasterKey(seed), bip32Master(seed), 'not the seed\'s own master: a tagged key of its own');
});

test('install: every system has a pinned file; a download that is not the published file is refused', async () => {
  for (const k of ['linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64', 'win32-x64']) assert.match(LND_FILES[k].sha256, /^[0-9a-f]{64}$/);
  const home = mkdtempSync(join(tmpdir(), 'lnd-'));
  const bad = await installLnd({ home, platform: 'linux', arch: 'x64', fetcher: async () => ({ status: 200, arrayBuffer: async () => Buffer.from('not lnd') }) });
  assert.match(bad.why, /not the published file/);
  assert.match((await installLnd({ home, platform: 'sunos', arch: 'x64' })).why, /no LND release for sunos-x64/);
});

test('lnd.conf: testnet4 on the node\'s Core by cookie, RPC/REST on 127.0.0.1 (REST not 8080), the wallet password 0600', () => {
  const home = mkdtempSync(join(tmpdir(), 'lnd-'));
  const cfg = configureLnd({ home, chain: { url: 'http://127.0.0.1:48342/', cookiePath: '/x/.cookie' } });
  const conf = readFileSync(cfg.conf, 'utf8');
  for (const line of ['bitcoin.testnet4=true', 'bitcoin.node=bitcoind', 'bitcoind.rpchost=127.0.0.1:48342', 'bitcoind.rpccookie=/x/.cookie', 'bitcoind.rpcpolling=true',
    'rpclisten=127.0.0.1:10009', 'restlisten=127.0.0.1:10080', `wallet-unlock-password-file=${cfg.passwordFile}`]) assert.ok(conf.includes(line), line);
  assert.equal(statSync(cfg.passwordFile).mode & 0o777, 0o600);
  assert.equal(readFileSync(cfg.passwordFile, 'utf8'), readFileSync(configureLnd({ home, chain: { url: 'http://127.0.0.1:48342/', cookiePath: '/x/.cookie' } }).passwordFile, 'utf8'), 'kept');
  assert.deepEqual(lndArgs({ lnd: '/b/lnd', lnddir: cfg.lnddir }), ['/b/lnd', `--lnddir=${cfg.lnddir}`, `--configfile=${cfg.conf}`]);
  assert.match(configureLnd({ home, chain: { url: 'http://127.0.0.1:48342/', user: 'u', password: 'p' } }).conf, /lnd\.conf$/);
});

test('the wallet from the seed, created once; getinfo read; another network refused', async () => {
  const home = mkdtempSync(join(tmpdir(), 'lnd-'));
  const cfg = configureLnd({ home, chain: { url: 'http://127.0.0.1:48342/', cookiePath: '/x/.cookie' } });
  const seed = new Uint8Array(32).fill(3);
  assert.match((await createLndWallet({ cfg, seed })).why, /starting/);
  writeFileSync(cfg.tlsCert, 'CERT');
  let asked = null;
  const rest = async (o) => { asked = o; return { status: 200, json: {} }; };
  assert.deepEqual(await createLndWallet({ cfg, seed, nowMs: 1_800_000_000_000, rest }), { ok: true, created: true });
  assert.equal(asked.path, '/v1/initwallet');
  assert.equal(asked.body.extended_master_key, lndMasterKey(seed));
  assert.equal(asked.body.extended_master_key_birthday_timestamp, '1800000000');
  assert.equal(Buffer.from(asked.body.wallet_password, 'base64').toString(), readFileSync(cfg.passwordFile, 'utf8'));
  mkdirSync(dirname(cfg.macaroon), { recursive: true }); writeFileSync(cfg.macaroon, Buffer.from([1, 2, 3]));
  assert.deepEqual(await createLndWallet({ cfg, seed, rest: async () => { throw new Error('not asked'); } }), { ok: true, created: false });
  const info = { identity_pubkey: '02' + 'ab'.repeat(32), alias: 'arena-node', block_height: 156908, synced_to_chain: true, chains: [{ chain: 'bitcoin', network: 'testnet4' }], version: '0.21.4-beta' };
  const t = await testLnd(cfg, { rest: async (o) => { asked = o; return { status: 200, json: info }; } });
  assert.deepEqual([t.ok, t.blockHeight, t.syncedToChain, t.network, asked.macaroonHex], [true, 156908, true, 'testnet4', '010203']);
  const main = await testLnd(cfg, { rest: async () => ({ status: 200, json: { ...info, chains: [{ network: 'mainnet' }] } }) });
  assert.match(main.why, /runs on mainnet, not testnet4/);
  assert.match((await testLnd({ restUrl: 'https://127.0.0.1:1', tlsCert: '/nope', macaroon: '/nope' })).why, /not there yet/);
});
