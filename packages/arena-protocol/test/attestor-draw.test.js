// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A ROUND'S ATTESTORS ARE DRAWN (kanban #630, 2026-10-24: "pre deterministic and drawed randomly, not a fixed set of nodes ... 5 of 7"):
// seven node keys of the census per round, the same at every node, different from round to round and from the settlement draw.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NETWORK_ID_REGTEST } from '../src/genesis-ids.js';
import { drawAttestors, selectCommittee, ATTESTORS_DRAWN, ATTEST_DRAW_THRESHOLD } from '../src/sortition.js';
import { toHex } from '../src/hash.js';
import { NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const row = (key) => { const txid = b32(key); return { txid, vout: 0, pubkey: b32(key), bondSats: 100000n, height: 1, hostedGames: [NEXTBLOCK_GAME_ID], roles: ['game', 'settlement'] }; };
const contract = { gameVerifySlots: 7, settlementSlots: 7, bondMinSats: 100000n, networkId: NETWORK_ID_REGTEST, gameId: NEXTBLOCK_GAME_ID };
const census = Array.from({ length: 14 }, (_, i) => row(i + 1));
const seed = (s) => { const b = b32(0); b[0] = s & 255; b[1] = s >> 8; return b; };
const keys = (list) => list.map((e) => toHex(e.pubkey));

test('seven distinct attestors per round, the same at every node, different over rounds and from the settlement committee', () => {
  assert.equal(ATTESTORS_DRAWN, 7);
  assert.equal(ATTEST_DRAW_THRESHOLD, 5);
  const sets = new Set(); let sameAsSettlement = 0; const seen = new Map();
  for (let s = 0; s < 200; s++) {
    const a = keys(drawAttestors({ entries: census, contract, committeeSeed: seed(s) }));
    assert.equal(a.length, 7); assert.equal(new Set(a).size, 7);
    assert.deepEqual(keys(drawAttestors({ entries: [...census].reverse(), contract, committeeSeed: seed(s) })), a, 'the census order moved the draw');
    const st = keys(selectCommittee({ entries: census, contract, role: 'settlement', committeeSeed: seed(s) }));
    if ([...a].sort().join() === [...st].sort().join()) sameAsSettlement++;
    sets.add([...a].sort().join());
    for (const k of a) seen.set(k, (seen.get(k) || 0) + 1);
  }
  console.log(`  FACTS: 14 nodes, 200 rounds - ${sets.size} distinct attestor sets, ${sameAsSettlement} equal to the settlement committee, every node drawn ${Math.min(...seen.values())}-${Math.max(...seen.values())} times`);
  assert.ok(sets.size > 150, 'the draw barely changes from round to round');
  assert.ok(sameAsSettlement < 10, 'the attestors are the settlement committee');
  assert.equal(seen.size, 14, 'some node is never drawn');
});

test('no beacon seed, no draw', () => {
  assert.throws(() => drawAttestors({ entries: census, contract, committeeSeed: null }), /seed its beacon produced/);
});
