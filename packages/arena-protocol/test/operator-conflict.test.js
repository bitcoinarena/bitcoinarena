// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// PLAYER-NODE SEPARATION AT RUN TIME (§5A.13). An entry may declare the operator its player is (§7
// `operator_id_declaration`), after its own marker so every older entry keeps its bytes; a committee node whose advertised
// operator plays the round is conflicted: it signs nothing, earns no fee share, and a committee left under its threshold voids.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeEntryContract, decodeEntryContract, entryId, OPERATOR_MARKER, FEDERATION_MARKER } from '../src/contracts.js';
import { roundOperators, conflictedNodes, servingAfterConflicts, selfConflict } from '../src/operator-conflict.js';
import { lockSettlement } from '../src/lock-settlement.js';
import { DELIVERED, FAILED } from '../src/payout.js';
import { toHex } from '../src/hash.js';
import { entryFeeMsat } from '../src/fee.js';
import { TEST_FEDERATION_ID } from '../src/test-federation.js';
import { NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const entry = {
  roundId: b32(9), playerPubkey: b32(1), sessionPubkey: b32(2), stakeCommitment: b32(3), stakeMsat: 1000000n, feeMsat: 50000n, donationMsat: 0n,
  joinTick: 0, worldSecret: b32(0), vssSharesRef: b32(4), stakePoint: new Uint8Array(33).fill(2), feePreimage: b32(5),
  stakeLockOutpoint: { txid: b32(6), outIdx: 0n }, feeLockOutpoint: { txid: b32(7), outIdx: 1n }, claimKeyAttestationRef: b32(8),
};
const OP = b32(0x0e);
const advertOf = (op) => ({ operatorId: op ? toHex(op) : '' });

test('an entry declares its operator last, after its marker; "none" is no bytes, so every other entry keeps its bytes and id', () => {
  const plain = encodeEntryContract(entry);
  const declared = encodeEntryContract({ ...entry, operatorId: OP });
  assert.deepEqual(declared.subarray(0, plain.length), plain);
  assert.equal(declared[plain.length], OPERATOR_MARKER);
  assert.deepEqual(decodeEntryContract(declared).operatorId, OP);
  assert.equal(decodeEntryContract(plain).operatorId, undefined);
  assert.notDeepEqual(entryId({ ...entry, operatorId: OP }), entryId(entry));
  // after a federation, a pick and order, a move, donations: both read back, the federation first
  const fed = b32(0xfe);
  for (const more of [{}, { federationId: fed }, { pick: 1 }, { pick: 0, limitPrice: 6200, orderExpiryMs: 99n, federationId: fed }, { commit: b32(0x33) },
    { donationOutpoints: [{ txid: b32(0x0d), outIdx: 3n }] }, { donationOutpoints: [{ txid: b32(0x0d), outIdx: 3n }], pick: 1, limitPrice: 1, orderExpiryMs: 0n, federationId: fed }]) {
    const bytes = encodeEntryContract({ ...entry, ...more, operatorId: OP });
    const e = decodeEntryContract(bytes);
    assert.deepEqual(e.operatorId, OP, JSON.stringify(Object.keys(more)));
    if (more.federationId) { assert.deepEqual(e.federationId, fed); assert.equal(bytes[bytes.length - 33 - 33], FEDERATION_MARKER); }
    assert.deepEqual(encodeEntryContract(e), bytes, 'one encoding');
  }
  // a federation alone still reads (2026.0.3 step 3), and zero or a stray byte is refused
  assert.deepEqual(decodeEntryContract(encodeEntryContract({ ...entry, federationId: fed })).federationId, fed);
  assert.throws(() => encodeEntryContract({ ...entry, operatorId: new Uint8Array(32) }), /not zero/);
  assert.throws(() => decodeEntryContract(Uint8Array.from([...plain, 0xab, ...new Uint8Array(32)])), /not zero/);
  assert.throws(() => decodeEntryContract(Uint8Array.from([...plain, FEDERATION_MARKER, ...fed, 0x01])), /neither its federation, its operator, its website, its items, its reserve lock nor the bot mark/);
});

test('a node is conflicted when its advertised operator is a player key or a declared operator of the round; none declared conflicts with nobody', () => {
  const players = [{ ...entry, playerPubkey: b32(0x21) }, { ...entry, playerPubkey: b32(0x22), operatorId: OP }];
  assert.deepEqual([...roundOperators(players)].sort(), [toHex(b32(0x21)), toHex(b32(0x22)), toHex(OP)].sort());
  const nodes = [
    { pubkey: b32(0xa1), advert: advertOf(OP) },          // its operator declared on an entry
    { pubkey: b32(0xa2), advert: advertOf(b32(0x21)) },   // its operator is a player's own key
    { pubkey: b32(0xa3), advert: advertOf(b32(0x77)) },   // another operator
    { pubkey: b32(0xa4), advert: advertOf(null) },        // declares no key
    { pubkey: b32(0xa5), advert: { operatorId: 'Bob' } }, // a name, not a key
  ];
  const c = conflictedNodes({ nodes, entries: players });
  assert.deepEqual([...c.keys()].sort(), [toHex(b32(0xa1)), toHex(b32(0xa2))]);
  assert.equal(c.get(toHex(b32(0xa1))), toHex(OP));
  assert.equal(selfConflict({ advert: advertOf(OP), entries: players }).conflicted, true);
  assert.equal(selfConflict({ advert: advertOf(b32(0x77)), entries: players }).conflicted, false);
  assert.equal(selfConflict({ advert: advertOf(null), entries: players }).conflicted, false);
});

test('a committee keeps serving without its conflicted nodes down to 5 of 7; under it the round is ENTRY_VOID', () => {
  const committee = [1, 2, 3, 4, 5, 6, 7].map((n) => b32(0xb0 + n));
  const two = servingAfterConflicts({ committee, conflicted: new Set([toHex(committee[0]), toHex(committee[1])]) });
  assert.equal(two.voids, false); assert.equal(two.serving.length, 5); assert.match(two.why, /2 conflicted nodes left out; 5 serve/);
  const three = servingAfterConflicts({ committee, conflicted: new Set(committee.slice(0, 3).map(toHex)) });
  assert.equal(three.voids, true); assert.match(three.why, /ENTRY_VOID/);
  // only conflicts void: a 2-seat committee nobody is conflicted in is not "under 5", and its own threshold is 2 of 2
  const small = [b32(0xc1), b32(0xc2)];
  assert.equal(servingAfterConflicts({ committee: small, conflicted: new Set() }).voids, false);
  assert.equal(servingAfterConflicts({ committee: small, conflicted: new Set([toHex(small[0])]), threshold: 2 }).voids, true);
  console.log('  ' + two.why + '\n  ' + three.why);
});

test('a conflicted node earns no fee share: its pool share goes to the rest of its pool', () => {
  const pk = (n) => { const k = new Uint8Array(32); k[0] = n; k[31] = n; return k; };
  const refund = (n) => { const k = new Uint8Array(33); k[0] = 0x02; k[1] = n; k[32] = n; return k; };
  const STAKE = 100000n; const FEE = entryFeeMsat(STAKE);
  const e = (n, outcome, score) => ({ pubkey: pk(n), stakeMsat: STAKE, feeMsat: FEE, donationMsat: 0n, outcome, score });
  const N = (n) => { const k = new Uint8Array(32); k[0] = 0xa0 + n; k[31] = n; return k; };
  const W = e(1, DELIVERED, 5), L = e(2, FAILED, 0);
  const locks = new Map([W, L].map((x, i) => [toHex(x.pubkey), { outpoint: { txid: b32(0x40 + i), outIdx: BigInt(i) }, amountMsat: STAKE - FEE, refundPk: refund(i + 1) }]));
  const feeLocks = new Map([W, L].map((x, i) => [toHex(x.pubkey), { outpoint: { txid: b32(0x80 + i), outIdx: BigInt(i) }, amountMsat: FEE, preimage: b32(0xf0 + i) }]));
  const nodes = [N(1), N(2), N(3)];
  const contract = {
    networkId: b32(0x4e), configHash: b32(0x43), censusConfirmations: 1, gameVerifySlots: 3, settlementSlots: 3, gameId: NEXTBLOCK_GAME_ID, simCoreHash: b32(1),
    startTimeMs: 60500n, entryCloseMs: 2000n, objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20, slashRemainder: 'SPLIT',
    federationId: TEST_FEDERATION_ID, stakeExpiryBlocks: 144, publicationRelays: [], donationSetId: b32(0xd0), censusHeight: 900000, censusRoot: b32(2),
    committeeTimeMs: 500n, randomnessRule: 'bitcoin-block-hash', stakeMsat: STAKE, bondMinSats: 50000n, blockTicks: 9000,
    exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20, timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4, nodes,
  };
  const plan = (conflicted) => lockSettlement({ roundId: b32(0x5f), entries: [W, L], minScore: 1, locks, feeLocks, fees: { ppm: 0n, baseMsat: 0n }, contract,
    signerNodes: { gameVerify: nodes, settlement: nodes, ...(conflicted ? { conflicted } : {}) } });
  const all = plan(null), less = plan([toHex(N(2))]);
  assert.equal(all.ok, true, all.why); assert.equal(less.ok, true, less.why);
  const paid = (p) => new Map(p.signerNodePayouts.map((x) => [toHex(x.pubkey), x.msat]));
  assert.equal(paid(all).size, 3);
  assert.equal(paid(less).has(toHex(N(2))), false, 'the conflicted node is paid nothing');
  const sum = (m) => [...m.values()].reduce((a, b) => a + b, 0n);
  assert.equal(sum(paid(less)), sum(paid(all)), 'its share stays with the other nodes, none lost');
  console.log('  fee shares, all:', [...paid(all)].map(([k, v]) => `${k.slice(0, 4)} ${v}`).join(', '), '| N2 conflicted:', [...paid(less)].map(([k, v]) => `${k.slice(0, 4)} ${v}`).join(', '));
});
