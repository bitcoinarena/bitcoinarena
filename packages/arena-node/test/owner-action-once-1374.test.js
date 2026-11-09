// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1374 (audit 2 #1204 FED-C4 / INSTALLER-DOORS-15): an add-bond or roles change asked again while the one sent is unconfirmed answers that one
// Run with --experimental-test-module-mocks (the bond tool is stubbed: its chain reads are the wallet's).
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

const B1 = { txid: 'a1'.repeat(32), vout: 0, sats: 100000, advert: { roles: ['game'], guardianCapable: false, protocolVersions: [1], operatorId: 'op' } };
mock.module('../tools/regtest-bond.mjs', { namedExports: { regtest: () => ({ bondsOf: () => [...BONDS], newestUpdateOf: () => null,
  postBond: () => { throw new Error('BUILD: a second bond would be funded'); }, prepareAdvertUpdate: () => { throw new Error('BUILD: a second update would be funded'); } }) } });
let BONDS = [B1];
const { addBondFromWallet, changeRolesFromWallet, SAME_ACTION_MS } = await import('../src/add-bond-wallet.js');

const world = () => {
  const calls = [], store = new Map();
  const cli = (m, ...a) => { calls.push([m, ...a]); if (m === 'getblockcount') return '100'; throw new Error(`no ${m}`); };
  const journal = { last: (k) => store.get(k) || null, keep: (k, r) => store.set(k, r) };
  return { calls, store, cli, journal, sent: () => calls.filter((c) => c[0] === 'sendrawtransaction').map((c) => c[1]) };
};

test('#1374 the same add again while its bond is unconfirmed: the kept one answered and re-sent, nothing funded', async () => {
  const w = world();
  const now = 1_800_000_000_000;
  // what a first post kept before its lost answer
  w.journal.keep('add-bond', { key: null, what: '50000', atMs: now - 60_000, hexes: ['f00d', 'b0nd'], bondTxid: 'b2'.repeat(32), bond: { txid: 'b2'.repeat(32) }, plan: { addSats: '50000' } });
  const r = await addBondFromWallet({ cli: w.cli, network: 'regtest', secret: new Uint8Array(32).fill(1), pubkey: new Uint8Array(32), addSats: '50000', post: true, now, journal: w.journal });
  assert.equal(r.ok, true, r.why);
  assert.equal(r.already, true);
  assert.equal(r.bond.txid, 'b2'.repeat(32));
  assert.deepEqual(w.sent(), ['f00d', 'b0nd'], 'only the kept bytes broadcast again');
  // another amount, the same amount after the window, or once the kept bond confirmed: built anew (here the stub refuses to build)
  for (const [what, at, confirmed] of [['60000', now, false], ['50000', now + SAME_ACTION_MS + 120_000, false], ['50000', now, true]]) {
    BONDS = confirmed ? [B1, { ...B1, txid: 'b2'.repeat(32) }] : [B1];
    await assert.rejects(addBondFromWallet({ cli: w.cli, network: 'regtest', secret: new Uint8Array(32).fill(1), pubkey: new Uint8Array(32), addSats: what, post: true, now: at, journal: w.journal }), /BUILD: a second bond/);
  }
  BONDS = [B1];
  // the page's key, when it sends one, decides: the same key answers whatever the amount
  w.journal.keep('add-bond', { key: 'k1', what: '50000', atMs: now, hexes: ['aa'], bondTxid: 'b3'.repeat(32), bond: { txid: 'b3'.repeat(32) }, plan: {} });
  const byKey = await addBondFromWallet({ cli: w.cli, network: 'regtest', secret: new Uint8Array(32).fill(1), pubkey: new Uint8Array(32), addSats: '70000', post: true, now: now + 3 * SAME_ACTION_MS, key: 'k1', journal: w.journal });
  assert.equal(byKey.already, true);
});

test('#1374 the same roles change again while its update is unconfirmed: answered, not paid twice', async () => {
  const w = world();
  const after = { roles: ['game', 'verify'], custody: false };
  w.journal.keep('roles', { key: null, what: JSON.stringify(after), atMs: 1000, hexes: ['c0', 'de'], txid: 'u1'.repeat(32), plan: { after } });
  const r = await changeRolesFromWallet({ cli: w.cli, network: 'regtest', secret: new Uint8Array(32).fill(1), pubkey: new Uint8Array(32), roles: ['verify', 'game'], post: true, journal: w.journal, nowMs: 2000 });
  assert.equal(r.already, true, r.why);
  assert.equal(r.update.txid, 'u1'.repeat(32));
  assert.deepEqual(w.sent(), ['c0', 'de']);
  await assert.rejects(changeRolesFromWallet({ cli: w.cli, network: 'regtest', secret: new Uint8Array(32).fill(1), pubkey: new Uint8Array(32), roles: ['settlement'], post: true, journal: w.journal, nowMs: 2000 }), /BUILD: a second update/);
});
