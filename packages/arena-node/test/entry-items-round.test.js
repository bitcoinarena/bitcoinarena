// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// AN ENTRY PLAYS ONLY WITH ITEMS ITS PLAYER BOUGHT (protocol 10): round.enter checks each against the purchases this
// seat keeps - of this round's game, of an item its manifest sells, signed for this entry by its buyer (the owner's key is
// the same in every round, the entry's is fresh per round) - and only on a round of version 10 or later.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ed25519 } from '@noble/curves/ed25519.js';
import { schnorr } from '@noble/curves/secp256k1.js';
import { openStore } from '../src/store.js';
import { Round } from '../src/round.js';
import { ITEM_PURCHASES_SQL } from '../src/item-purchase-seat.js';
import { assumeAssigned } from './assignment.js';
import { testDevKey } from './plugins/sign.js';
import { signManifest } from '../../arena-donor/src/manifest-sign.js';
import { NEXTBLOCK, TRUCK_CORE_HASH, TRUCK_V3_CONFIG_HASH } from '../../nextblock/plugin/nextblock.js';
import { BLOCK_TICKS } from '../../nextblock/src/rules/gate.js';
import { gameIdOf } from '../../arena-protocol/src/manifest.js';
import { ITEMS_VERSION } from '../../arena-protocol/src/constants.js';
import { entryFeeMsat } from '../../arena-protocol/src/fee.js';
import { TEST_FEDERATION_ID } from '../../arena-protocol/src/test-federation.js';
import { TEST_DONATION_SET_REGTEST } from '../../arena-protocol/src/test-donation-sets.js';
import { donationSetId } from '../../arena-protocol/src/donation.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { entryItemDigest } from '../../arena-protocol/src/contracts.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const DEV = testDevKey('items dev');
const { signature: _s, ...BODY } = NEXTBLOCK.manifest;
const MANIFEST = signManifest({ ...BODY, gameDevPubkey: DEV.pubkey, items: [{ id: 'large-truck', name: 'Larger truck', priceSat: 500n, unlock: b32(0xa1) }],
  requiredProtocolVersion: ITEMS_VERSION }, DEV);
const GAME = { ...NEXTBLOCK, manifest: MANIFEST, gameId: gameIdOf(MANIFEST) };
const peers = Array.from({ length: 6 }, () => schnorr.getPublicKey(ed25519.utils.randomSecretKey()));
const PLAYER = b32(5);                                                     // this entry's per-round key
// THE OWNER: the stable key that bought the item; it signs that this entry plays with it
const OWNER_SECRET = b32(0x33), OWNER = schnorr.getPublicKey(OWNER_SECRET);
const proof = (rid, purchaseId, secret = OWNER_SECRET, player = PLAYER) => schnorr.sign(entryItemDigest({ roundId: rid, playerPubkey: player, purchaseId }), secret);
const item = (rid, itemId, purchaseId, secret) => ({ itemId, purchaseId, ownerSig: proof(rid, purchaseId, secret) });

const contract = (protocolVersion, gameId = GAME.gameId) => ({
  networkId: b32(0x4e), configHash: TRUCK_V3_CONFIG_HASH, censusConfirmations: 6, gameVerifySlots: 7, settlementSlots: 7, gameId, simCoreHash: TRUCK_CORE_HASH,
  startTimeMs: 60500n, entryCloseMs: 2000n, objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20, slashRemainder: 'SPLIT', federationId: TEST_FEDERATION_ID,
  stakeExpiryBlocks: 144, publicationRelays: ['wss://r.example'], donationSetId: donationSetId(TEST_DONATION_SET_REGTEST.recipients), censusHeight: 900000, censusRoot: b32(2),
  committeeTimeMs: 500n, randomnessRule: 'bitcoin-block-hash', stakeMsat: 100000n, bondMinSats: 50000n, blockTicks: BLOCK_TICKS, exposureReference: 1000, corridorHalfWidth: 40,
  spawnFreeRadius: 20, timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4, protocolVersion, nodes: [],
});
const entry = (rid, items) => ({ roundId: rid, playerPubkey: PLAYER, sessionPubkey: ed25519.getPublicKey(ed25519.utils.randomSecretKey()), stakeCommitment: b32(7), stakeMsat: 100000n,
  feeMsat: entryFeeMsat(100000n), donationMsat: 0n, joinTick: 0, worldSecret: new Uint8Array(32), vssSharesRef: new Uint8Array(32), stakePoint: new Uint8Array(33), feePreimage: new Uint8Array(32),
  stakeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, feeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, claimKeyAttestationRef: new Uint8Array(32), ...(items ? { items } : {}) });
const keep = (db, { id, player = OWNER, itemId = 'large-truck', gameDev = DEV.pubkey, gameName = 'nextblock' }) => {
  db.exec(ITEM_PURCHASES_SQL);
  db.prepare('INSERT INTO item_purchases (id, player, game_dev, game_name, item_id, txid, bytes, signature, kept_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(toHex(id), toHex(player), toHex(gameDev), gameName, itemId, toHex(id).split('').reverse().join(''), Buffer.alloc(1), Buffer.alloc(64), 1);
};
const opened = (v, gameId = GAME.gameId) => {
  const round = new Round(openStore(), () => 1234, { plugins: [GAME, NEXTBLOCK] });
  const c = contract(v, gameId);
  const rid = round.open(c);
  assumeAssigned(round, rid, [...peers, round.identity.pubkey]);
  return { round, rid };
};

test('an entry with an item its owner bought and signed for is taken; without the purchase, its proof, or for another item, refused by name', () => {
  const { round, rid } = opened(ITEMS_VERSION);
  const bought = b32(0xd1);
  assert.throws(() => round.enter(entry(rid, [item(rid, 'large-truck', bought)])), /not one this seat keeps for this game: hand it to POST \/item-purchase first/);
  keep(round.db, { id: b32(0xd3), itemId: 'gold-truck' });                  // another item's
  assert.throws(() => round.enter(entry(rid, [item(rid, 'gold-truck', b32(0xd3))])), /sells no item "gold-truck"/);
  keep(round.db, { id: bought });
  // someone else's purchase: kept, but its owner did not sign for this entry
  assert.throws(() => round.enter(entry(rid, [item(rid, 'large-truck', bought, b32(0x44))])), /not signed for this entry by its owner/);
  // the owner's proof for another entry key, replayed on this one
  assert.throws(() => round.enter(entry(rid, [{ itemId: 'large-truck', purchaseId: bought, ownerSig: proof(rid, bought, OWNER_SECRET, b32(6)) }])), /not signed for this entry by its owner/);
  const eid = round.enter(entry(rid, [item(rid, 'large-truck', bought)]));
  assert.equal(eid.length, 32);
  assert.ok(round.enter(entry(rid)).length, 'an entry without items is taken as always');
});

test('items only on a round of version 10 or later: a game that sells them runs no older round, and an older round takes none', () => {
  assert.throws(() => opened(9), /requires protocol version 10; that round runs 9/);
  const { round, rid } = opened(9, NEXTBLOCK.gameId);
  keep(round.db, { id: b32(0xd1) });
  assert.throws(() => round.enter(entry(rid, [item(rid, 'large-truck', b32(0xd1))])), /a round takes items from protocol version 10 on; this round runs 9/);
});
