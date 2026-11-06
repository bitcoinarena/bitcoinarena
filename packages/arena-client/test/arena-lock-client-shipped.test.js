// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE SHIPPED 2.0 LOCK CLIENT CARRIES THE ARENA LOCK (kanban #1044 B1, rulings #1131, #1134): the page's lockArenaStake refuses
// a protocol-27 join when the lock client has no arenaLockSubmit / arenaLockAccepted, and its refund and forfeit need
// arenaRedeem. So the wasm dist ships is the build of the fork's arena-lock commit with the arena-lock feature: it carries
// those calls, and its contract id is the fork module's own (the vector 16aaa68a of fedimint-lnv2-common arena_lock/tests.rs,
// the one arena-protocol's encoder is held to). The stock calls a protocol-26 round uses stay.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DIST = new URL('../dist/', import.meta.url);
const wasmModule = async () => {
  if (typeof globalThis.window === 'undefined') globalThis.window = globalThis;
  const esm = join(tmpdir(), `blwp-lock-client-arena-${process.pid}.mjs`);
  copyFileSync(new URL('blwp_lock_client.js', DIST), esm);
  const w = await import(esm);
  await w.default({ module_or_path: readFileSync(new URL('blwp_lock_client_bg.wasm', DIST)) });
  return w;
};
// the fork's reference lock: seats are secrets 1..7, refund secret 8, image sha256(32 x 0x42)
const REFERENCE = {
  paymentImage: { kind: 'hash', bytes: '425ed4e4a36b30ea21b90e21c712c649e8214c29b7eaf68089d1039c6e55384c' }, amountMsat: '1000000', expiration: 500,
  roundId: '11'.repeat(32),
  claimKeys: '79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798,c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5,f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9,e493dbf1c10d80f3581e4904930b1404cc6c13900ee0758474fa94abe8c4cd13,2f8bde4d1a07209355b4a7250a5c5128e88b84bddc619ab7cba8d569b240efe4,fff97bd5755eeea420453a14355235d382f6472f8568a18b2f057a1460297556,5cbdf0646e5db4eaa398f365f2ea7a0e3d419b7e0330e39ce92bddedcac4f9bc'.split(','),
  threshold: 5, refundPk: '022f01e5e15cca351daff3843fb70f3c2f0a1bdd05e5af888a67784ef3e10a2a01',
};

test('the shipped lock client has the Arena calls and hashes the Arena lock as the fork module does', async () => {
  const { LockClient } = await wasmModule();
  const missing = ['arenaLockSubmit', 'arenaLockAccepted', 'arenaRedeem', 'arenaModuleVersion', 'arenaLockStatus', 'arenaLock']
    .filter((name) => typeof LockClient.prototype[name] !== 'function');
  assert.deepEqual(missing, [], 'the shipped wasm lacks Arena calls');
  assert.equal(typeof LockClient.arenaLockContractId, 'function');
  assert.equal(LockClient.arenaLockContractId(JSON.stringify(REFERENCE)), '16aaa68ae146d84f176914b083dfbba9166f0e93ec493a5442cfcbe47e0d10ce');
  assert.notEqual(LockClient.arenaLockContractId(JSON.stringify({ ...REFERENCE, roundId: '12'.repeat(32) })),
    '16aaa68ae146d84f176914b083dfbba9166f0e93ec493a5442cfcbe47e0d10ce');
  // the stock calls a protocol-26 round uses are still there
  const stock = ['lockSubmit', 'lockAccepted', 'redeem', 'refund'].filter((name) => typeof LockClient.prototype[name] !== 'function');
  assert.deepEqual(stock, []);
  assert.equal(typeof LockClient.outgoingContractId, 'function');
});

// E-CASH IN FLIGHT (kanban #1149): the send is tagged with the page's record key and found again by it (sentEcash), the receive says the
// face value it credited, and ecashInfo reads a string with the mint module's own decoder - the same answer as the page's ecashFaceValue
test('the shipped lock client finds a send by its record (sentEcash), and its decoder reads e-cash as the page does', async () => {
  const { LockClient } = await wasmModule();
  const { encodeEcash } = await import('./ecash-1149-rig.js');
  const { ecashFaceValue } = await import('../src/ecash-transfer.js');
  const missing = ['sentEcash', 'sendEcash', 'sendAllEcash', 'receiveEcash'].filter((name) => typeof LockClient.prototype[name] !== 'function');
  assert.deepEqual(missing, []);
  assert.equal(LockClient.prototype.sendEcash.length, 2, 'sendEcash(amount, intent)');
  assert.equal(LockClient.prototype.sendAllEcash.length, 1, 'sendAllEcash(intent)');
  for (const [fed, msat, salt] of [['4d'.repeat(32), 123457n, 4], ['ab'.repeat(32), 1n, 1], ['33'.repeat(32), 2n ** 40n + 5n, 7]]) {
    const ecash = encodeEcash(fed, msat, salt);
    const rust = JSON.parse(LockClient.ecashInfo(ecash));
    const page = ecashFaceValue(ecash);
    assert.deepEqual({ msat: String(rust.msat), federation: rust.federation, notes: rust.notes }, { msat: String(page.msat), federation: page.federation, notes: page.notes });
    assert.equal(String(rust.msat), String(msat));
  }
  assert.throws(() => LockClient.ecashInfo('fedimint0123'));
});
