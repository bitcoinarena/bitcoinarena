// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// WHAT A FILED SLASH OWES, before anything can pay it.
//
// The gap print of 2026-09-22 listed eight things between a filed proof and a paid one. Three were
// rulings and are now made (§5A.3); this covers the four that are arithmetic over what a node already
// holds - the bond's value, the census at the named height, who was harmed, and the split. The last
// two, the escrow output and MuSig2, are not here and are not pretended: nothing in this file spends.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { slashOwing } from '../src/slash-owing.js';
import { REPLAY_CONTRADICTS, TWO_RESULTS } from '../../arena-protocol/src/slash.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const ROUND = b32(0x01);
const ALICE = b32(0xa1), BOB = b32(0xa2);
const SEAT_A = b32(0x22), SEAT_B = b32(0x23);
const OUT_1 = b32(0x31), OUT_2 = b32(0x32), OUT_3 = b32(0x33);

const contract = { censusHeight: 900000, nodes: [SEAT_A, SEAT_B], slashRemainder: 'SPLIT' };
const proof = { nodePubkey: SEAT_A, playerPubkey: ALICE, bondTxid: b32(0xbb), bondVout: 0 };
const row = (pubkey, outcome, score) => ({ playerPubkey: pubkey, pubkey, stakeMsat: 100000n, feeMsat: 0n, donationMsat: 0n, netStakeMsat: 100000n, activated: true, operatorOwn: false, outcome, score });
// the round as it settled: Bob delivered, Alice failed, Carol failed
const CAROL = b32(0xa3);
const entries = [row(ALICE, 'FAILED', 0), row(BOB, 'DELIVERED', 10), row(CAROL, 'FAILED', 0)];
const lowered = { signed: { outcome: 'FAILED', score: 0 }, replayed: { outcome: 'DELIVERED', score: 20 } };
const ask = (over = {}) => slashOwing({
  proof, offence: REPLAY_CONTRADICTS, contract, roundIdBytes: ROUND, entries, ...lowered, settledOnFalse: true,
  slashHeight: 900050, tipHeight: 900100, bondSatsOf: async () => 100000n, ...over,
});

test('a late objection owes the player the real loss and the reserves the rest of the bond', async () => {
  const got = await ask();
  assert.equal(got.ok, true, got.why);
  const o = got.owing;
  const facts = { bondSats: String(o.bondSats), alice: String(o.players.get(toHex(ALICE))), playersMsat: String(o.playersMsat), reservesMsat: String(o.reservesMsat) };
  console.log('  FACTS (what one slash owes):', JSON.stringify(facts));
  // Alice should have had her 100 sat back and Carol's 100; the settlement paid her nothing
  assert.deepEqual(facts, { bondSats: '100000', alice: '200000', playersMsat: '200000', reservesMsat: '99800000' });
  assert.equal(o.playersMsat + o.reservesMsat, 100000000n);
});

test('after an objection in time nobody has a loss: the whole bond is owed to the reserves', async () => {
  const got = await ask({ settledOnFalse: false });
  assert.equal(got.owing.players.size, 0);
  assert.equal(got.owing.reservesMsat, 100000000n);
});

test('a doubled result with no replay shows no loss', async () => {
  const got = await ask({ offence: TWO_RESULTS });
  assert.equal(got.owing.players.size, 0);
});

test('a later proof of the round pays only what is still owed', async () => {
  const first = await ask();
  const second = await ask({ paid: first.owing.players });
  assert.equal(second.owing.players.size, 0);
  assert.equal(second.owing.reservesMsat, 100000000n);
});

test('a height outside the window is refused', async () => {
  const below = await ask({ slashHeight: 899999 });
  const above = await ask({ slashHeight: 900101 });
  assert.equal(below.ok, false); assert.match(below.why, /below the round's census height/);
  assert.equal(above.ok, false); assert.match(above.why, /above the tip/);
});

test('the bond names an outpoint and never a value, so a bond the chain does not hold owes nothing', async () => {
  const got = await ask({ bondSatsOf: async () => 0n });
  assert.equal(got.ok, false);
  assert.match(got.why, /no bond output at/);
});

test('nothing here spends, and nothing here pays a node or a developer: the answer is amounts and names', async () => {
  const got = await ask();
  assert.deepEqual(Object.keys(got.owing).sort(), ['bond', 'bondSats', 'node', 'offence', 'players', 'playersMsat', 'reservesMsat', 'shortMsat', 'slashHeight'].sort());
});
