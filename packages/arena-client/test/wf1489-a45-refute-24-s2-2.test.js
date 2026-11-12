// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// wf1489 a45 refute (skeptic 2) of kanban #1864 / #2259 / #2276: namesToCheck now bounds one seat's NAMES for a round over all its entries,
// but every repeated entry of the same round in one seat's /rounds answer is still its own `said` element with its own listing
// signature check (signedNow is per entry, never shared). One signer seat listing its round 5,000 times costs the read 5,000 BIP-340
// checks (on the main thread with `verify`; 5,000 items in the page's verifyMany batch) on every read - the same unbounded cost #1864 closed for names.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { TRUCK_CORE_HASH, TRUCK_V3_CONFIG_HASH, NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';
import { BLOCK_TICKS } from '../../nextblock/src/rules/gate.js';
import { TEST_FEDERATION_ID } from '../../arena-protocol/src/test-federation.js';
import { TEST_DONATION_SET_REGTEST } from '../../arena-protocol/src/test-donation-sets.js';
import { donationSetId as idOfDonationSet } from '../../arena-protocol/src/donation.js';
import { fetchLobby } from '../src/lobby.js';
import { encodeRoundContract, roundId } from '../../arena-protocol/src/contracts.js';
import { lobbyListingId } from '../../arena-protocol/src/lobby-listing.js';
import { encodeLobbyName, lobbyNameId } from '../../arena-protocol/src/lobby-name.js';
import { MIN_ENTRY_WINDOW_MS } from '../../arena-protocol/src/constants.js';
import { NETWORK_ID_REGTEST } from '../../arena-protocol/src/genesis-ids.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const NOW = 1789200000000;
const A = 'http://127.0.0.1:18581', B = 'http://127.0.0.2:18582';
const evilSeat = schnorr.utils.randomSecretKey(), honestSeat = schnorr.utils.randomSecretKey();
const keyOf = (s) => schnorr.getPublicKey(s);

const contractAt = (committeeTimeMs) => ({
  networkId: NETWORK_ID_REGTEST, configHash: TRUCK_V3_CONFIG_HASH, censusConfirmations: 6,
  gameVerifySlots: 2, settlementSlots: 2, gameId: NEXTBLOCK_GAME_ID, simCoreHash: TRUCK_CORE_HASH,
  committeeTimeMs, randomnessRule: 'bitcoin-block-hash',
  startTimeMs: committeeTimeMs + MIN_ENTRY_WINDOW_MS, entryCloseMs: committeeTimeMs + MIN_ENTRY_WINDOW_MS + 120000n,
  objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20,
  slashRemainder: 'SPLIT', federationId: TEST_FEDERATION_ID, stakeExpiryBlocks: 144, publicationRelays: ['wss://r.example'],
  donationSetId: idOfDonationSet(TEST_DONATION_SET_REGTEST.recipients), censusHeight: 900000, censusRoot: b32(2), stakeMsat: 0n, bondMinSats: 50000n,
  blockTicks: BLOCK_TICKS, exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20,
  timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4,
  nodes: [keyOf(evilSeat), keyOf(honestSeat)],
});

function listing(secret, id, names) {
  const signed = { roundId: fromHex(id), nodePubkey: keyOf(secret), nowMs: BigInt(NOW), phase: 'open', assignedHere: true, joined: 1, playing: 0 };
  return { id, phase: 'open', assignedHere: true, joined: 1, playing: 0, free: true, names,
    entryCloseMs: String(NOW + 600000), sig: toHex(schnorr.sign(lobbyListingId(signed), secret)) };
}

// forged records for this round: each decodes, each a new player key and a rising time, a junk signature - the check is the cost
const forgeries = (idHex, n, from = 0) => Array.from({ length: n }, (_, i) => {
  const k = new Uint8Array(32); k[0] = 0xee; k[1] = (from + i) >> 8; k[2] = (from + i) & 255;
  return { record: toHex(encodeLobbyName({ roundId: fromHex(idHex), playerPubkey: k, identityPubkey: b32(0x22), name: 'x', atMs: BigInt(1000 + from + i) })), sig: '00'.repeat(64) };
});

function serve(bySeat, contracts) {
  return async (url) => {
    const u = new URL(url); const seat = bySeat[`${u.protocol}//${u.host}`];
    if (u.pathname === '/rounds') return seat ? new Response(JSON.stringify({ node: toHex(keyOf(seat.secret)), nowMs: String(NOW), rounds: seat.rounds }), { status: 200 }) : new Response('down', { status: 503 });
    if (u.pathname === '/round') { const c = contracts[u.searchParams.get('id')]; return c ? new Response(c, { status: 200 }) : new Response('no', { status: 404 }); }
    return new Response('no', { status: 404 });
  };
}


test('a45-refute-24-s2-2: one seat repeating its round in /rounds does not cost one signature check per repeat', async () => {
  const c = contractAt(BigInt(NOW) - 1000n);
  const id = toHex(roundId(c));
  const one = listing(evilSeat, id, []);
  const rounds = Array.from({ length: 5000 }, () => ({ ...one }));
  let checks = 0, batched = 0;
  const verify = (s, m, k) => { checks++; try { return schnorr.verify(s, m, k); } catch { return false; } };
  const fetcher = serve({ [A]: { secret: evilSeat, rounds }, [B]: { secret: honestSeat, rounds: [listing(honestSeat, id, [])] } }, { [id]: encodeRoundContract(c) });
  const lobby = await fetchLobby({ nodes: [A, B], fetcher, verify, nowMs: NOW });
  const viaMany = await fetchLobby({ nodes: [A, B], fetcher, verify: () => true, nowMs: NOW + 1, verifyMany: async (xs) => { batched += xs.length; return xs.map(() => true); } });
  console.log(`  FACTS: ${rounds.length} repeats from one seat; ${checks} verify calls in one read (${lobby.rows.length} rows); ${batched} items in the verifyMany batch (${viaMany.rows.length} rows)`);
  assert.ok(checks <= 1100, `one seat's repeated listing cost ${checks} signature checks in one read`);
  assert.ok(batched <= 1100, `one seat's repeated listing put ${batched} checks in the page's batch`);
});
