// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// SIGNED SEASON ACCOUNTS FOR TESTS (kanban #1153): real round contracts (a v2 round, 7 settlement seats: a threshold of 5) whose id is
// the round's id, and seats that sign their account of a round with their node key - what GET /season-rounds hands on.
import { schnorr } from '@noble/curves/secp256k1.js';
import { encodeRoundContract, roundId } from '../../arena-protocol/src/contracts.js';
import { signSeasonAccount, seasonRoundsToJson, seasonRoundsFromJson } from '../../arena-protocol/src/season.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { NETWORK_ID_REGTEST } from '../../arena-protocol/src/genesis-ids.js';
import { TEST_FEDERATION_ID } from '../../arena-protocol/src/test-federation.js';
import { TEST_DONATION_SET_REGTEST } from '../../arena-protocol/src/test-donation-sets.js';
import { donationSetId } from '../../arena-protocol/src/donation.js';
import { receiptsNeeded } from '../../arena-protocol/src/threshold.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const BASE = {
  protocolVersion: 2, networkId: NETWORK_ID_REGTEST, configHash: b32(1), censusConfirmations: 1, gameVerifySlots: 7, settlementSlots: 7,
  simCoreHash: b32(9), committeeTimeMs: 0n, randomnessRule: 'bitcoin-block-hash', entryCloseMs: 2n,
  objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20, slashRemainder: 'SPLIT',
  federationId: TEST_FEDERATION_ID, stakeExpiryBlocks: 144, publicationRelays: ['wss://r.example'],
  donationSetId: donationSetId(TEST_DONATION_SET_REGTEST.recipients), censusRoot: b32(2),
  stakeMsat: 100000n, bondMinSats: 50000n, blockTicks: 4920, exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20,
  timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4, nodes: [],
};

/** Seat n's node secret and key (hex). */
export const seatSecret = (n) => Uint8Array.from({ length: 32 }, (_, j) => (j === 31 ? n : 0x5a));
export const seatKey = (n) => toHex(schnorr.getPublicKey(seatSecret(n)));

/** A round of `gameId` (hex) starting at `startMs`, its contract made here: { roundId, contract (hex), c }. `n` keeps two rounds apart. */
export function roundContract({ gameId, startMs, n }) {
  const c = { ...BASE, gameId: Uint8Array.from(Buffer.from(gameId, 'hex')), startTimeMs: BigInt(startMs), censusHeight: 900000 + n };
  return { roundId: toHex(roundId(c)), contract: toHex(encodeRoundContract(c)), c };
}

/** A round in season()'s shape with its contract: `entries` as season-read.js reads them (round keys in). */
export function contractRound({ gameId, startMs, n, entries }) {
  const k = roundContract({ gameId, startMs, n });
  return { roundId: k.roundId, gameId, startMs: BigInt(startMs), entries, contract: k.contract };
}

/** One seat's GET /season-rounds rounds: each round's wire JSON with its contract and that seat's own signature, read back. */
export function seatAnswer(n, rounds) {
  return seasonRoundsFromJson(rounds.map((r) => {
    const sig = signSeasonAccount(r, seatKey(n), (d) => schnorr.sign(d, seatSecret(n)));
    return { ...seasonRoundsToJson([r])[0], contract: r.contract, sigs: sig ? [sig] : [] };
  }));
}

/** THIS SEAT'S DRAW of each round: roundId -> [seat numbers]; any round not named draws seats `fallback`. Threshold of 7 seats: 5. */
export function drawOf(map, fallback = []) {
  return (rid) => ({ ok: true, seats: (map.get(rid) || fallback).map(seatKey), needed: receiptsNeeded(7) });
}

/** The signed answers of seats `signers` (numbers), each holding `rounds`: what a winners book's `collect` hands it. */
export const answersOf = (rounds, signers = [1, 2, 3, 4, 5]) => new Map(signers.map((n) => [`seat-${n}`, seatAnswer(n, rounds)]));
