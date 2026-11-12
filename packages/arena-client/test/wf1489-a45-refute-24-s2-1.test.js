// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// wf1489 a45 refute (skeptic 2) of kanban #1864 / #2259 / #2276: the read-wide name budget (LOBBY_NAME_CHECKS_PER_READ) is a NEW shared
// resource. Two colluding seats (two signer keys, so their made-up rounds are joinable and rank 0 like the honest one) make up 8 rounds
// that close sooner, 128 forged names each = 1024 checks: the whole read's budget. The honest round's real name is never checked on any
// read - row.names [] every paint. Before 9110807da a round's checks were its own (NAME_CHECKS_MAX per round), so this could not happen.
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


const evil2 = schnorr.utils.randomSecretKey(), honest2 = schnorr.utils.randomSecretKey();
test('a45-refute-24-s2-1: two colluding seats\' made-up rounds cannot spend the read\'s name budget before the honest round', async () => {
  const contracts = {};
  // the honest round: honest seats only, closes later than the made-up ones
  const hc = { ...contractAt(BigInt(NOW) - 1000n), nodes: [keyOf(honestSeat), keyOf(honest2)] };
  const hid = toHex(roundId(hc)); contracts[hid] = encodeRoundContract(hc);
  const player = schnorr.utils.randomSecretKey();
  const rec = { roundId: fromHex(hid), playerPubkey: keyOf(player), identityPubkey: b32(0x33), name: 'Road Owl 42', atMs: 5000n };
  const real = { record: toHex(encodeLobbyName(rec)), sig: toHex(schnorr.sign(lobbyNameId(rec), player)) };
  const evilA = [], evilB = [];
  for (let i = 0; i < 8; i++) {
    // made up: the colluders' own keys, entry closing 60 s sooner than the honest round's
    const c = { ...contractAt(BigInt(NOW) - 1000n - 60000n - BigInt(i)), nodes: [keyOf(evilSeat), keyOf(evil2)] };
    const id = toHex(roundId(c)); contracts[id] = encodeRoundContract(c);
    evilA.push(listing(evilSeat, id, forgeries(id, 128, i * 256)));
    evilB.push(listing(evil2, id, []));
  }
  const C = 'http://127.0.0.3:18583', D = 'http://127.0.0.4:18584';
  let checks = 0;
  const verify = (s, m, k) => { checks++; try { return schnorr.verify(s, m, k); } catch { return false; } };
  const fetcher = serve({ [A]: { secret: evilSeat, rounds: evilA }, [C]: { secret: evil2, rounds: evilB },
    [B]: { secret: honestSeat, rounds: [listing(honestSeat, hid, [real])] }, [D]: { secret: honest2, rounds: [listing(honest2, hid, [real])] } }, contracts);
  for (let read = 1; read <= 3; read++) {
    checks = 0;
    const lobby = await fetchLobby({ nodes: [A, C, B, D], fetcher, verify, nowMs: NOW + read });
    const row = lobby.rows.find((r) => r.id === hid);
    assert.ok(row && row.joinable, 'the honest round has a joinable row');
    console.log(`  FACTS read ${read}: ${lobby.rows.length} rows (${lobby.rows.filter((r) => r.joinable).length} joinable), ${checks} verify calls, honest row.names ${JSON.stringify(row.names.map((n) => n.name))}`);
    assert.deepEqual(row.names.map((n) => n.name), ['Road Owl 42'],
      `read ${read}: the colluders' made-up rounds spent LOBBY_NAME_CHECKS_PER_READ before the honest round's real name was checked`);
  }
});
