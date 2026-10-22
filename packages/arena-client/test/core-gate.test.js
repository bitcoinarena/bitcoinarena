// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A PAYING ROUND ON A CORE THIS CLIENT DOES NOT KNOW GETS NO STAKE AND NO SIGNER NODE
// (§5, v4.6; F2's second clause). Measured before this: `stakeFor` and
// `entryFor` never looked at `simCoreHash`, and every launcher wrote b32(1) -
// a core that does not exist - so a creator could publish a round on any core
// and the page would deal a stake into it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { schnorr } from '@noble/curves/secp256k1.js';
import { TEST_FEDERATION_ID } from '../../arena-protocol/src/test-federation.js';
import { stakeFor, entryFor, playerFor } from '../src/join.js';
import { feldmanGroup } from '../../arena-node/src/curve.js';
import { fromHex } from '../../arena-protocol/src/hash.js';
import { NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';
import { TRUCK_68E2_HASH } from '../../nextblock/plugin/truck-cores.js';   // the truck versions 1-4 name (kanban #523: the tree now builds a5c5766a)

const b32 = (n) => new Uint8Array(32).fill(n);
const rand = (n) => new Uint8Array(randomBytes(n));
const CORE = fromHex(TRUCK_68E2_HASH);
const UNKNOWN = b32(1);            // what every launcher used to write
const seed = b32(0x5e);
// SINCE KANBAN A ROUND NAMES ITS GAME, and a core is known only as a core its game lists (known-game.js)
const paying = (simCoreHash, gameId = NEXTBLOCK_GAME_ID) => ({ id: b32(0x21), stakeMsat: 100000n, settlementSlots: 7, gameId, simCoreHash, federationId: TEST_FEDERATION_ID });
// A PAYING ROUND NAMES ITS FEDERATION, AND ITS ENTRY ITS LOCK (RULED 2026-09-24, the enum slice's fifth cut, as
// join.test's fixtures): this paying fixture used to be hold-shaped - a stake and no federation - and entryFor now refuses
// that shape. It keeps measuring what it measured, on a real FEDERATION entry: an attested claim key and a stake lock with
// a non-zero outpoint, paying to the dealt stake's point where one is dealt.
const lockedFor = (stakePoint = Uint8Array.of(2, ...new Uint8Array(32).fill(0x6c))) => ({
  claimKey: { ok: true, ref: new Uint8Array(32).fill(0x9a) },
  stakeLock: { outpoint: { txid: new Uint8Array(32).fill(0xd8), outIdx: 0 }, fields: { paymentImage: { kind: 'point', bytes: stakePoint } } },
});
const signerNodes = () => Array.from({ length: 7 }, () => schnorr.getPublicKey(rand(32)));
const keyFor = (round) => playerFor(round, { seed, curve: feldmanGroup }).pubkey;

test('stakeFor deals no stake into a paying round on an unknown core', async () => {
  const round = paying(UNKNOWN);
  await assert.rejects(() => stakeFor(round, { signerNodes: signerNodes(), curve: feldmanGroup, random: rand, playerPubkey: keyFor(round) }),
    /nextblock's manifest does not list/);
  // and a round of a game this client does not know, whatever core it names
  const stranger = paying(CORE, b32(0x99));
  await assert.rejects(() => stakeFor(stranger, { signerNodes: signerNodes(), curve: feldmanGroup, random: rand, playerPubkey: keyFor(stranger) }),
    /not on this client's known-good list of games/);
  await assert.rejects(() => stakeFor({ ...round, simCoreHash: undefined },
    { signerNodes: signerNodes(), curve: feldmanGroup, random: rand, playerPubkey: keyFor(round) }), /names no 32-byte core hash/);
});

test('entryFor joins nobody at a paying round on an unknown core', () => {
  assert.throws(() => entryFor(paying(UNKNOWN), { seed, curve: feldmanGroup, random: rand }),
    /nextblock's manifest does not list/);
  assert.throws(() => entryFor(paying(CORE, b32(0x99)), { seed, curve: feldmanGroup, random: rand }),
    /not on this client's known-good list of games/);
});

test('the listed core signer nodes, stake and all', async () => {
  const round = paying(CORE);
  const stake = await stakeFor(round, { signerNodes: signerNodes(), curve: feldmanGroup, random: rand, playerPubkey: keyFor(round) });
  const signerNode = entryFor(round, { seed, curve: feldmanGroup, random: rand, stake, ...lockedFor(stake.stakePoint) });
  assert.deepEqual(signerNode.stakeCommitment, stake.stakeCommitment);
  assert.deepEqual(signerNode.playerPubkey, keyFor(round));
});

test('a free round risks nothing and is joined whatever core it names', () => {
  const free = { id: b32(0x22), stakeMsat: 0n, gameId: NEXTBLOCK_GAME_ID, simCoreHash: UNKNOWN };
  assert.equal(entryFor(free, { seed, curve: feldmanGroup, random: rand }).stakeMsat, 0n);
});
