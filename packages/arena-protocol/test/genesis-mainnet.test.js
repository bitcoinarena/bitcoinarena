// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// MAINNET'S GENESIS AND THE COMMITTEES IT BINDS (§27A.6, §5A.7RULED 2026-10-14 ~13:20Z: "Fix it but no
// new series or delays because of it"): the rest of §27A.6 is hashed from mainnet's genesis on, the test networks keep their ids.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { genesisFor, computeNetworkId, donationKeysFor, encodeGenesisParameters, mainnetGenesis, committeesStand } from '../src/genesis.js';
import { NETWORK_ID_TESTNET4, NETWORK_ID_REGTEST } from '../src/genesis-ids.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const hex = (b) => Buffer.from(b).toString('hex');
const parts = () => ({ bondMarker: b32(1), arbitrationKeys: [2, 3, 4, 5, 6, 7, 8].map(b32), authorityPubkey: b32(9), recoveryPubkey: b32(10),
  genesisSeriesStartMs: 1800000000000n, bondMinGuardianSats: 1_000_000n });

test('the test networks keep their genesis bytes and network ids: no new series', () => {
  for (const [net, id] of [['testnet4', NETWORK_ID_TESTNET4], ['regtest', NETWORK_ID_REGTEST]]) {
    const k = donationKeysFor(net);
    assert.equal(hex(computeNetworkId({ genesis: genesisFor(net), authorityPubkey: k.authority, recoveryPubkey: k.recovery })), hex(id), net);
    assert.equal(committeesStand({ gameVerifySlots: 7, settlementSlots: 7 }, genesisFor(net)).bound, false, `${net} leaves a contract its own slots`);
  }
});

test('mainnet genesis: the table\'s values, federation_min, bond_min_guardian and the governance schedule hashed into its id', () => {
  const { genesis, networkId } = mainnetGenesis(parts());
  assert.deepEqual([genesis.gameVerifySlots, genesis.gameVerifyThreshold, genesis.settlementSlots, genesis.settlementThreshold, genesis.censusMinNodes,
    genesis.censusConfirmations, genesis.federationNominal, genesis.federationMin], [7, 5, 7, 5, 10, 6, 10, 7]);
  assert.deepEqual([genesis.abandonBlocks, genesis.departureNotice, genesis.foundingWindow, genesis.drainBlocks, genesis.claimBlocks], [288, 432, 432, 4032, 216]);
  assert.deepEqual(genesis.governanceSchedule.money, { review: 1008, voting: 1440, cooldown: 2016 });
  assert.equal(networkId.length, 32);
  // each named field moves the id: none of them is decoration
  const idWith = (change) => { const g = { ...genesis, ...change }; return hex(computeNetworkId({ genesis: g, authorityPubkey: b32(9), recoveryPubkey: b32(10) })); };
  const base = hex(networkId);
  for (const change of [{ federationMin: 6 }, { bondMinGuardianSats: 2_000_000n }, { committeesBind: false },
    { governanceSchedule: { ...genesis.governanceSchedule, money: { review: 1008, voting: 1441, cooldown: 2016 } } }])
    assert.notEqual(idWith(change), base, JSON.stringify(change, (k, v) => (typeof v === 'bigint' ? String(v) : v)));
  // and the cold recovery key is in the name (§27A.4)
  assert.notEqual(hex(computeNetworkId({ genesis, authorityPubkey: b32(9), recoveryPubkey: b32(11) })), base);
  assert.ok(encodeGenesisParameters(genesis).length > encodeGenesisParameters(genesisFor('testnet4')).length);
});

test('mainnet genesis is built only from what a launch names: no invented marker or keys', () => {
  for (const [k, why] of [['bondMarker', /bond marker/], ['recoveryPubkey', /cold recovery key/], ['arbitrationKeys', /arbitration keys/],
    ['genesisSeriesStartMs', /series 0/], ['bondMinGuardianSats', /bond floor/]]) {
    const p = parts(); delete p[k];
    assert.throws(() => mainnetGenesis(p), why, k);
  }
  assert.throws(() => encodeGenesisParameters({ ...mainnetGenesis(parts()).genesis, federationMin: 11 }), /federation_min/);
});

test('mainnet binds every contract to committees of 7, threshold 5', () => {
  const { genesis } = mainnetGenesis(parts());
  assert.deepEqual(committeesStand({ gameVerifySlots: 7, settlementSlots: 7, censusConfirmations: 6 }, genesis), { ok: true, bound: true });
  const two = committeesStand({ gameVerifySlots: 2, settlementSlots: 2 }, genesis);
  assert.equal(two.ok, false); assert.match(two.why, /names game_verify_slots 2, the genesis binds 7; settlement_slots 2, the genesis binds 7/);
  assert.equal(committeesStand({ gameVerifySlots: 7, settlementSlots: 9 }, genesis).ok, false);
});

// KANBAN SLICE 3 (2026-10-16: "On a test genesis that binds, a deviating contract is refused by the seat and by the client, by
// parameter name"): every bound parameter named - a contract naming mainnet's committees but another confirmation depth is refused for that
test('a binding genesis names each mismatched parameter: slots per role, and census confirmations', () => {
  const { genesis } = mainnetGenesis(parts());
  const conf = committeesStand({ gameVerifySlots: 7, settlementSlots: 7, censusConfirmations: 2 }, genesis);
  assert.deepEqual([conf.ok, conf.off], [false, ['census_confirmations 2, the genesis binds 6']]);
  const game = committeesStand({ gameVerifySlots: 3, settlementSlots: 7, censusConfirmations: 6 }, genesis);
  assert.deepEqual(game.off, ['game_verify_slots 3, the genesis binds 7']);
  assert.match(committeesStand({ gameVerifySlots: 7, settlementSlots: 5, censusConfirmations: 1 }, genesis).why,
    /settlement_slots 5, the genesis binds 7; census_confirmations 1, the genesis binds 6/);
});
