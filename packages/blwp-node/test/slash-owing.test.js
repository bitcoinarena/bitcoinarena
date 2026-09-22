// WHAT A FILED SLASH OWES, before anything can pay it.
//
// The gap print of 2026-09-22 listed eight things between a filed proof and a paid one. Three were
// rulings and are now made (§5A.3); this covers the four that are arithmetic over what a node already
// holds - the bond's value, the census at the named height, who was harmed, and the split. The last
// two, the escrow output and MuSig2, are not here and are not pretended: nothing in this file spends.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { slashOwing } from '../src/slash-owing.js';
import { REPLAY_CONTRADICTS, TABLE_IS_NOT_F } from '../../protocol/src/slash.js';
import { toHex } from '../../protocol/src/hash.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const ROUND = b32(0x01);
const ALICE = b32(0xa1), BOB = b32(0xa2);
const SEAT_A = b32(0x22), SEAT_B = b32(0x23);
const OUT_1 = b32(0x31), OUT_2 = b32(0x32), OUT_3 = b32(0x33);

const contract = { censusHeight: 900000, nodes: [SEAT_A, SEAT_B], slashRemainder: 'SPLIT' };
const proof = { nodePubkey: SEAT_A, playerPubkey: ALICE, bondTxid: b32(0xbb), bondVout: 0 };
const entries = [
  { playerPubkey: ALICE, netStakeMsat: 100000n, activated: true, operatorOwn: false },
  { playerPubkey: BOB, netStakeMsat: 300000n, activated: true, operatorOwn: false },
];
// The census at the slashing height: the two seats and three other nodes.
const census = [SEAT_A, SEAT_B, OUT_1, OUT_2, OUT_3];
const ask = (over = {}) => slashOwing({
  proof, offence: TABLE_IS_NOT_F, contract, roundIdBytes: ROUND, entries,
  slashHeight: 900050, tipHeight: 900100,
  censusAt: async () => census,
  bondSatsOf: async () => 100000n,
  ...over,
});

test('a filed slash says what it owes: half the players, three quarters of the rest to the census', async () => {
  const got = await ask();
  assert.equal(got.ok, true, got.why);
  const o = got.owing;
  const facts = {
    bondSats: String(o.bondSats), toPlayers: String(o.toPlayers),
    toNodes: String(o.toNodes), toDevelopers: String(o.toDevelopers),
    alice: String(o.players.get(toHex(ALICE))), bob: String(o.players.get(toHex(BOB))),
    seatA: String(o.nodes.get(toHex(SEAT_A)) || 0n), out1: String(o.nodes.get(toHex(OUT_1)) || 0n),
    censusSeen: o.censusSeen, seatsOut: o.seatsOut,
  };
  console.log('  FACTS (what one slash owes):', JSON.stringify(facts));
  assert.deepEqual(facts, {
    bondSats: '100000', toPlayers: '50000', toNodes: '37500', toDevelopers: '12500',
    // pro rata by net stake, 100000 : 300000 -> a quarter and three quarters of 50000
    alice: '12500', bob: '37500',
    // the seats are subtracted; the three others take the nodes' share evenly
    seatA: '0', out1: '12500',
    censusSeen: 5, seatsOut: 2,
  });
});

test('a height outside the window is refused before any census is read', async () => {
  let asked = 0;
  const below = await ask({ slashHeight: 899999, censusAt: async () => { asked++; return census; } });
  const above = await ask({ slashHeight: 900101, censusAt: async () => { asked++; return census; } });
  assert.equal(below.ok, false); assert.match(below.why, /below the round's census height/);
  assert.equal(above.ok, false); assert.match(above.why, /above the tip/);
  // THE ORDER MATTERS: a height nobody can read yet must not send a node reading a census at it.
  assert.equal(asked, 0, 'a census was read at a height that was never valid');
});

test('the bond names an outpoint and never a value, so a bond the chain does not hold owes nothing', async () => {
  const got = await ask({ bondSatsOf: async () => 0n });
  assert.equal(got.ok, false);
  assert.match(got.why, /no bond output at/);
});

test('a result offence owes one entry and a table offence owes the field, out of the same bond', async () => {
  const one = await ask({ offence: REPLAY_CONTRADICTS });
  const all = await ask({ offence: TABLE_IS_NOT_F });
  const facts = {
    replayNames: [...one.owing.players.keys()].map((k) => k.slice(0, 2)),
    tableNames: [...all.owing.players.keys()].map((k) => k.slice(0, 2)),
    replayAlice: String(one.owing.players.get(toHex(ALICE))),
  };
  console.log('  FACTS (one offence against another):', JSON.stringify(facts));
  // The replay proof names Alice alone, so she takes the WHOLE players' half out of that bond.
  assert.deepEqual(facts, { replayNames: ['a1'], tableNames: ['a1', 'a2'], replayAlice: '50000' });
});

test('with the census empty once the seats come out, it names the satoshis and stops', async () => {
  const got = await ask({ censusAt: async () => [SEAT_A, SEAT_B] });
  assert.equal(got.ok, false);
  assert.match(got.why, /have no recipient/);
});

test('nothing here spends: the answer is a statement of what is owed', async () => {
  const got = await ask();
  // No transaction, no signature, no outpoint spent - the owing carries amounts and names only.
  assert.deepEqual(Object.keys(got.owing).sort(), [
    'bond', 'bondSats', 'censusSeen', 'nodes', 'node', 'offence', 'players', 'seatsOut',
    'slashHeight', 'toDevelopers', 'toNodes', 'toPlayers',
  ].sort());
});
