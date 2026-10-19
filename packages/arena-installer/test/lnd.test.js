// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// LIGHTNING FOR CUSTODY (lnd.js): the pinned release per system, lnd.conf for testnet4 on the node's Core, the
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

test('channels for a gateway seat: LND\'s deposit address and balances, a public channel to a named peer, the public capacity counted', async () => {
  const { lndFunds, lndOpenChannel, lndChannels } = await import('../src/lnd.js');
  const cfg = { restUrl: 'https://127.0.0.1:10080', tlsCertPem: 'CERT', macaroonHex: 'aabb' };
  const asked = [];
  const rest = async (o) => {
    asked.push(o);
    const map = { '/v1/newaddress?type=4': { address: 'tb1pdeposit' }, '/v1/balance/blockchain': { confirmed_balance: '250000', unconfirmed_balance: '1000' },
      '/v1/balance/channels': { local_balance: { sat: '150000' } }, '/v1/peers': {}, '/v1/channels/pending': { pending_open_channels: [{ channel: { remote_node_pub: '03bb', capacity: '100000' } }] },
      '/v1/channels': o.method === 'POST' ? { funding_txid_bytes: Buffer.from('11'.repeat(31) + '22', 'hex').toString('base64') }
        : { channels: [{ remote_pubkey: '02aa', capacity: '150000', active: true, private: false }, { remote_pubkey: '02cc', capacity: '90000', active: true, private: true }] } };
    return { status: 200, json: map[o.path] };
  };
  const f = await lndFunds(cfg, { rest });
  assert.deepEqual([f.address, f.onchainSats, f.unconfirmedSats, f.channelSats], ['tb1pdeposit', 250000, 1000, 150000]);
  assert.equal(asked[0].macaroonHex, 'aabb');
  const ch = await lndChannels(cfg, { rest });
  assert.deepEqual([ch.open.length, ch.pending.length, ch.publicCapacitySats], [2, 1, 150000], 'a private channel does not count for a gateway seat');
  assert.match((await lndOpenChannel(cfg, { peer: 'nonsense', sats: 200000 }, { rest })).why, /pubkey@host:port/);
  assert.match((await lndOpenChannel(cfg, { peer: '02' + 'ab'.repeat(32) + '@node.example.com:9735', sats: 1000 }, { rest })).why, /at least 20,000/);
  asked.length = 0;
  const o = await lndOpenChannel(cfg, { peer: '02' + 'AB'.repeat(32) + '@node.example.com:9735', sats: 200000 }, { rest });
  assert.deepEqual([o.ok, o.fundingTxid], [true, '22' + '11'.repeat(31)], 'the funding txid as Bitcoin shows it');
  assert.deepEqual(asked[0].body.addr, { pubkey: '02' + 'ab'.repeat(32), host: 'node.example.com:9735' });
  assert.deepEqual([asked[1].body.local_funding_amount, asked[1].body.private, asked[1].body.node_pubkey], ['200000', false, Buffer.from('02' + 'ab'.repeat(32), 'hex').toString('base64')]);
});
