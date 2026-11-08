// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// KANBAN #1323 (§23A.2 RULED 2026-11-07, #1297): "no federation younger than drain_blocks receives first deposits by default".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { depositFederation, tooYoung, drainBlocksOf } from '../src/federations.js';

const fed = (id, { load, height, firstHeight }) => ({ federation: id.repeat(64), status: 'OPEN', invite: `fed1${id}`, load, height, firstHeight, network: 'mainnet', allows: { deposit: true } });
test('#1323 a first deposit skips a federation younger than drain_blocks unless the player picks it', () => {
  const old = fed('a', { load: 0.6, height: 900000, firstHeight: 890000 });       // 10,000 blocks old
  const young = fed('b', { load: 0.1, height: 900000, firstHeight: 899000 });     // 1,000 blocks: under mainnet's 4,032
  const unknownAge = fed('c', { load: 0.3, height: 900000 });                     // no seat says its first height
  const d = drainBlocksOf('mainnet');
  const byDefault = depositFederation({ lobbyInvite: 'lobby', statuses: [old, young] });
  const picked = depositFederation({ lobbyInvite: 'lobby', statuses: [old, young], chosen: 'b'.repeat(64) });
  const withUnknown = depositFederation({ lobbyInvite: 'lobby', statuses: [old, unknownAge] });
  const got = { drainBlocks: d, young: tooYoung(young), old: tooYoung(old), byDefault: byDefault.federation.slice(0, 4), picked: picked.federation.slice(0, 4), unknown: withUnknown.federation.slice(0, 4),
    testnetDrain: drainBlocksOf('testnet4') };
  console.log('  MEASURED #1323 deposit:', JSON.stringify(got));
  assert.equal(d, 4032);
  assert.equal(got.young, true); assert.equal(got.old, false);
  assert.equal(byDefault.federation, 'a'.repeat(64), 'the lowest load (b) is too young: the older one takes the deposit');
  assert.equal(picked.federation, 'b'.repeat(64), 'the player picked the young one');
  assert.equal(withUnknown.federation, 'c'.repeat(64), 'no seat says its age: not held back, the lowest load wins');
});
