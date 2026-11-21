// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// Audit #1489 r13 (client): ONE STRANGER SEAT PUTS A WARNING ON EVERY PAID ROUND. fetchLobby collects a row's `warnings` from every
// listing of it (counts.flatMap(c => c.warnings)) - any seat that lists the round, not only its signer nodes, its listing unsigned - and
// the page shows them in the 'Before you stake' dialog every paid join must pass. So one seat outside the committee names
// 'census_objected' ("Its seats take no new entry") on every paid round: every player is told the round is refused and asked to confirm
// against it, though no signer node said so.
// Safe: a warning only the round's signer nodes did not name is not shown.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { fetchLobby } from '../src/lobby.js';
import { encodeRoundContract, roundId } from '../../arena-protocol/src/contracts.js';
import { lobbyListingId } from '../../arena-protocol/src/lobby-listing.js';
import { TRUCK_CORE_HASH, TRUCK_V3_CONFIG_HASH, NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';
import { BLOCK_TICKS } from '../../nextblock/src/rules/gate.js';
import { TEST_FEDERATION_ID } from '../../arena-protocol/src/test-federation.js';
import { TEST_DONATION_SET_REGTEST } from '../../arena-protocol/src/test-donation-sets.js';
import { donationSetId } from '../../arena-protocol/src/donation.js';
import { MIN_ENTRY_WINDOW_MS } from '../../arena-protocol/src/constants.js';
import { NETWORK_ID_REGTEST } from '../../arena-protocol/src/genesis-ids.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';

const NOW = 1789300000000;
const verify = (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } };
const keyOf = (s) => schnorr.getPublicKey(s);
const SEVEN = Array.from({ length: 7 }, () => schnorr.utils.randomSecretKey());
const stranger = schnorr.utils.randomSecretKey();
const at = BigInt(NOW) - 1000n;
const contract = {
  networkId: NETWORK_ID_REGTEST, configHash: TRUCK_V3_CONFIG_HASH, censusConfirmations: 6,
  gameVerifySlots: 7, settlementSlots: 7, gameId: NEXTBLOCK_GAME_ID, simCoreHash: TRUCK_CORE_HASH,
  committeeTimeMs: at, randomnessRule: 'bitcoin-block-hash',
  startTimeMs: at + MIN_ENTRY_WINDOW_MS, entryCloseMs: at + MIN_ENTRY_WINDOW_MS + 120000n,
  objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20,
  slashRemainder: 'SPLIT', federationId: TEST_FEDERATION_ID, stakeExpiryBlocks: 144, publicationRelays: ['wss://r.example'],
  donationSetId: donationSetId(TEST_DONATION_SET_REGTEST.recipients), censusHeight: 900000, censusRoot: new Uint8Array(32).fill(2), stakeMsat: 100000n, bondMinSats: 50000n,
  blockTicks: BLOCK_TICKS, exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20,
  timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4,
  nodes: SEVEN.map(keyOf),
};
const id = toHex(roundId(contract));
const drawn = { drawn: { game: SEVEN.map((s) => toHex(keyOf(s))), settlement: SEVEN.map((s) => toHex(keyOf(s))) } };
const listing = (secret, extra = {}) => {
  const signed = { roundId: fromHex(id), nodePubkey: keyOf(secret), nowMs: BigInt(NOW), phase: 'open', assignedHere: true, joined: 0, playing: 0 };
  return { id, phase: 'open', assignedHere: true, joined: 0, playing: 0, free: false, sig: toHex(schnorr.sign(lobbyListingId(signed), secret)), committee: drawn, ...extra };
};

test('a warning named only by a seat outside the round\'s committee is not put before the player', async () => {
  const seats = Object.fromEntries(SEVEN.slice(0, 5).map((s, i) => [`http://seat${i}`, { secret: s, rounds: [listing(s)] }]));
  seats['http://liar'] = { secret: stranger, rounds: [listing(stranger, { sig: '00'.repeat(64), warnings: ['census_objected', 'flat_rank_curve'] })] };
  const fetcher = async (url) => {
    const u = new URL(url);
    const seat = seats[`${u.protocol}//${u.host}`];
    if (u.pathname === '/rounds') return new Response(JSON.stringify({ node: toHex(keyOf(seat.secret)), nowMs: String(NOW), rounds: seat.rounds }));
    if (u.pathname === '/round') return u.searchParams.get('id') === id ? new Response(encodeRoundContract(contract)) : new Response('no', { status: 404 });
    return new Response('no', { status: 404 });
  };
  const got = await fetchLobby({ nodes: Object.keys(seats), fetcher, verify, nowMs: NOW });
  const row = got.rows.find((r) => r.id === id);
  assert.ok(row && row.joinable, 'its five signer nodes sign it open (precondition)');
  assert.deepEqual(row.warnings, [], `the paid round carries warnings ${JSON.stringify(row.warnings)} that only a non-committee seat's unsigned listing named`);
});
