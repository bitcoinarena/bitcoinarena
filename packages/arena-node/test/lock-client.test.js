// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE LOCK CLIENT (W1a): the player's own client code makes the stake lock -
// a wasm crate on the stock fedimint 0.12.0 client crates, driven from Node -
// and a W2 signer node commits the stake it locks. The real-federation run is
// tools/lock-client-regtest; what is here is what fits the suites.
//
// MEASURED FIRST: what a signer node does today with the only outpoint the shipping
// path writes - zeros (join.js entryFor).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { lockFieldsToJson } from '../src/stake-lock-signer-node.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { CLAIM, joinedWithLock } from './lock-fixture.js';

test('a signer node handed a lock for an entry whose stake_lock_outpoint is zeros refuses it, and the stake stays uncommitted', async () => {
  const s = await joinedWithLock({ claimKeyFor: () => CLAIM }, { outpoint: { txid: new Uint8Array(32), outIdx: 0n } });
  try {
    const r = await fetch(`http://127.0.0.1:${s.d.port}/lock?entry=${toHex(s.eid)}`, { method: 'POST', body: JSON.stringify(lockFieldsToJson(s.fields)) });
    const why = (await r.text()).trim();
    const stake = (await fetch(`http://127.0.0.1:${s.d.port}/stake?entry=${toHex(s.eid)}`)).status;
    const facts = { lockDoor: r.status, stakeCommitted: !!s.d.round.stakeSeen(s.eid), stake, federationAsked: s.port.asked };
    console.log('  FACTS (zero outpoint):', JSON.stringify(facts), '|', why);
    assert.deepEqual(facts, { lockDoor: 409, stakeCommitted: false, stake: 409, federationAsked: 0 });
    assert.match(why, /that entry names no stake lock outpoint/);
  } finally { await s.close(); }
});
