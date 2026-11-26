// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A STRANGER'S BOND DOES NOT DRAW A NODE (kanban #3743, RULED 2026-11-26 on PR #95's open point 2, protocol 2026.0.34). A stranger's own bond
// to a node's key, under another operator id, stands in the census unsigned by that node (nodeSigned false). PR #95 made the drawn entry the
// node's own; the ticket (lowest outpoint) and the weight (summed sats) still counted the stranger's row, so a stranger could grind whether
// a node is drawn. From 34 an unsigned entry is no part of the draw; below 34 the draw is unchanged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NETWORK_ID_REGTEST } from '../src/genesis-ids.js';
import { selectCommittee, SIGNED_DRAW_VERSION } from '../src/sortition.js';
import { toHex } from '../src/hash.js';
import { NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const row = (key, n, bond = 100000n, more = {}) => { const txid = b32(n); txid[1] = key; return { txid, vout: 0, pubkey: b32(key), bondSats: bond, height: 1, hostedGames: [NEXTBLOCK_GAME_ID], roles: ['game', 'verify', 'settlement'], ...more }; };
const base = { gameVerifySlots: 4, settlementSlots: 4, bondMinSats: 100000n, networkId: NETWORK_ID_REGTEST, gameId: NEXTBLOCK_GAME_ID };
const honest = []; for (let k = 1; k <= 8; k++) honest.push(row(k, 10 * k));
// the stranger's row: bonded to key 1, a low outpoint and ten times the sats, not signed by node 1
const census = honest.concat([row(1, 1, 1000000n, { nodeSigned: false })]);
const seed = (s) => { const b = b32(0); b[0] = s & 255; b[1] = s >> 8; return b; };
const draw = (entries, contract, s) => selectCommittee({ entries, contract, role: 'game', committeeSeed: seed(s) }).map((e) => toHex(e.pubkey)).join();

test('#3743 from protocol 34 a stranger\'s unsigned bond to a node\'s key moves no draw; below 34 it still does', () => {
  let moved = { old: 0, v34: 0 };
  for (let s = 0; s < 300; s++) {
    if (draw(census, base, s) !== draw(honest, base, s)) moved.old++;
    const v = { ...base, protocolVersion: SIGNED_DRAW_VERSION };
    if (draw(census, v, s) !== draw(honest, v, s)) moved.v34++;
  }
  console.log('  FACTS:', JSON.stringify(moved));
  assert.ok(moved.old > 0, 'the stranger row moves no draw below 34 - the census does not reproduce the gap');
  assert.equal(moved.v34, 0, 'a stranger\'s unsigned bond moved a version-34 draw');
});
