// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// wf1489 r26 census-1: census_min_nodes counts bond ROWS, not node keys. One operator's key with several bond outputs (or
// outputs under the round's floor) fills the network's minimum alone, and selectCommittee then draws a committee of fewer
// keys than the minimum promises. Safe: the minimum counts distinct node keys that can be drawn (at or above the floor).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { meetsCensusMinimum } from '../src/census.js';
import { selectCommittee } from '../src/sortition.js';
import { NETWORK_ID_REGTEST } from '../src/genesis-ids.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const GAME = new Uint8Array(32).fill(0x6e);
const round = { networkId: NETWORK_ID_REGTEST, gameId: GAME, committeeTimeMs: 500n, randomnessRule: 'bitcoin-block-hash', gameVerifySlots: 2, settlementSlots: 2, bondMinSats: 100000n };
const row = (tx, key, sats) => ({ txid: b32(tx), vout: 0, pubkey: b32(key), bondSats: sats, height: 900000, roles: ['settlement'], hostedGames: [GAME], spent: false });

test('one node key with two bond outputs is one node: a regtest census needing 2 is not met', () => {
  const entries = [row(1, 0x40, 200000n), row(2, 0x40, 200000n)];
  assert.equal(meetsCensusMinimum(entries, round, 'settlement').ok, false, 'two rows of ONE key met census_min_nodes = 2');
  let got = null; try { got = selectCommittee({ entries, contract: round, role: 'settlement', committeeSeed: b32(11) }); } catch { got = null; }
  assert.equal(got, null, `a committee of ${got && got.length} key(s) was drawn on a census the network says is too small`);
});

test('a bond row under the round floor counts for nothing toward the minimum', () => {
  const entries = [row(1, 0x40, 200000n), row(2, 0x41, 1n)];
  assert.equal(meetsCensusMinimum(entries, round, 'settlement').ok, false, 'a 1-sat row under bond_min filled the minimum');
});
