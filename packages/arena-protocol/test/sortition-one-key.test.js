// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// ONE NODE KEY, ONE SEAT (RULED 2026-09-30, after testnet4 round 5eaa0966). A census still holding extra bond rows
// under some node keys seated node 7 and node 4 twice (game) and node 2 twice (settlement); the stake's handout could not
// be dealt. Now a key is drawn at most once, all its bonds one entry: its sats summed into its weight, its ticket drawn on
// its lowest outpoint. MEASURED BEFORE (the per-row draw, reproduced below on the same census): duplicates on most seeds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NETWORK_ID_REGTEST } from '../src/genesis-ids.js';
import { selectCommittee, ticketFor, weightOf } from '../src/sortition.js';
import { compareEntries } from '../src/census.js';
import { toHex } from '../src/hash.js';
import { NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const row = (key, n, bond = 100000n) => { const txid = b32(n); txid[1] = key; return { txid, vout: n % 3, pubkey: b32(key), bondSats: bond, height: 1, hostedGames: [NEXTBLOCK_GAME_ID], roles: ['game', 'settlement'], spent: false }; };
const contract = { gameVerifySlots: 7, settlementSlots: 7, bondMinSats: 100000n, networkId: NETWORK_ID_REGTEST, gameId: NEXTBLOCK_GAME_ID };
// THE TESTNET4 SHAPE: seven node keys, three of them holding two extra bond rows each - thirteen census entries
const census = [];
for (let k = 1; k <= 7; k++) census.push(row(k, 10 * k));
for (const k of [2, 4, 7]) for (let x = 1; x <= 2; x++) census.push(row(k, 10 * k + x));
const seed = (s) => { const b = b32(0); b[0] = s & 255; b[1] = s >> 8; return b; };
// THE OLD DRAW, per bond row - what 061193a1 does - to show the census is the testnet4 one
const perRow = (role, s) => census.map((e) => ({ e, t: ticketFor(seed(s), e, role), w: weightOf(e.bondSats, 100000n) }))
  .sort((a, b) => { const l = a.t * b.w, r = b.t * a.w; return l < r ? -1 : l > r ? 1 : compareEntries(a.e, b.e); }).slice(0, 7).map((x) => toHex(x.e.pubkey));

test('a census with extra bond rows under three keys: every draw seats seven distinct keys - each key once - where the per-row draw repeated keys', () => {
  let before = 0; let after = 0; const seated = new Map();
  for (let s = 0; s < 500; s++) for (const role of ['game', 'settlement']) {
    if (new Set(perRow(role, s)).size < 7) before++;
    const got = selectCommittee({ entries: census, contract, role, committeeSeed: seed(s) }).map((e) => toHex(e.pubkey));
    assert.equal(got.length, 7);
    if (new Set(got).size !== 7) after++;
    for (const k of got) seated.set(k, (seated.get(k) || 0) + 1);
  }
  console.log(`  FACTS: 13 entries under 7 keys, 1000 draws - per-row draw repeated a key in ${before}; one key one seat: ${after}`);
  assert.ok(before > 0, 'the census does not reproduce the testnet4 duplicates');
  assert.equal(after, 0, 'a key filled two seats');
  assert.equal(seated.size, 7);
});

test('a key\'s bonds weigh as their sum, drawn on its lowest outpoint; the draw is the same everywhere', () => {
  const merged = census.filter((e) => ![2, 4, 7].includes(e.pubkey[0]))
    .concat([2, 4, 7].map((k) => ({ ...row(k, 10 * k), bondSats: 300000n })));
  for (let s = 0; s < 50; s++) {
    const a = selectCommittee({ entries: census, contract, role: 'game', committeeSeed: seed(s) }).map((e) => toHex(e.txid));
    const b = selectCommittee({ entries: merged, contract, role: 'game', committeeSeed: seed(s) }).map((e) => toHex(e.txid));
    assert.deepEqual(a, b, 'three rows of 100000 are not one entry of 300000 on the lowest outpoint');
  }
  const again = [...census].reverse();
  assert.deepEqual(selectCommittee({ entries: again, contract, role: 'game', committeeSeed: seed(7) }).map((e) => toHex(e.txid)),
    selectCommittee({ entries: census, contract, role: 'game', committeeSeed: seed(7) }).map((e) => toHex(e.txid)), 'the census order moved the draw');
});

test('fewer distinct keys than seats: each key once - a key never fills a second seat; an excluded outpoint excludes its key', () => {
  const six = census.filter((e) => e.pubkey[0] !== 3);          // twelve entries, six keys
  const fewer = selectCommittee({ entries: six, contract, role: 'game', committeeSeed: seed(1) }).map((e) => toHex(e.pubkey));
  assert.equal(fewer.length, 6, 'a key filled the seventh seat');
  assert.equal(new Set(fewer).size, 6);
  const eight = census.concat([row(8, 80)]);
  const got = selectCommittee({ entries: eight, contract, role: 'game', committeeSeed: seed(3), exclude: [row(4, 41)] }).map((e) => e.pubkey[0]);
  assert.ok(!got.includes(4), 'a key whose outpoint was excluded still sits');
  assert.equal(new Set(got).size, 7);
});
