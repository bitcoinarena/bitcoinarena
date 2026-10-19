// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A ROUND OF A CREATOR-SIGNED SERIES OPENS AT ITS SEAT WITHOUT A SIGNATURE OF ITS OWN (kanban #376, measured 2026-10-16 06:45Z on
// the live page: PLAY opened a duty grid's round at its node - the page's Client.openRound, POST /round - and was refused "that round
// names its creator, and comes without the creator's 64-byte signature over its id"; the creator signs the SERIES, once for all its
// rounds, and the seat held the round with no per-round row). A round the seat holds from a series it writes now stands; a round that
// names a creator and comes from no series still needs the signature.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { openStore } from '../src/store.js';
import { serve } from '../src/server.js';
import { seriesLineOf } from '../src/series-line.js';
import { TRUCK_CORE_HASH, TRUCK_V3_CONFIG_HASH, NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';
import { encodeRoundContract, roundId } from '../../arena-protocol/src/contracts.js';
import { seriesId, seriesRound, GRID_SERIES_LEAD_MIN_MS } from '../../arena-protocol/src/series.js';
import { seriesCreatorMessage } from '../../arena-protocol/src/creator.js';
import { NETWORK_ID_REGTEST } from '../../arena-protocol/src/genesis-ids.js';
import { TEST_FEDERATION_ID } from '../../arena-protocol/src/test-federation.js';
import { TEST_DONATION_SET_REGTEST } from '../../arena-protocol/src/test-donation-sets.js';
import { donationSetId } from '../../arena-protocol/src/donation.js';
import { HOSTED } from './plugins/hosted.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const NOW = 1790600000000;
const START = BigInt(NOW) + 3600000n + 123n;
const creator = schnorr.utils.randomSecretKey();
const gridOf = (nodes, over = {}) => ({
  networkId: NETWORK_ID_REGTEST, configHash: TRUCK_V3_CONFIG_HASH, censusConfirmations: 1, gameVerifySlots: 2, settlementSlots: 2,
  gameId: NEXTBLOCK_GAME_ID, simCoreHash: TRUCK_CORE_HASH, committeeTimeMs: START - GRID_SERIES_LEAD_MIN_MS, randomnessRule: 'bitcoin-block-hash',
  startTimeMs: START, entryCloseMs: START + 80000n, objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20, slashRemainder: 'SPLIT',
  federationId: TEST_FEDERATION_ID, stakeExpiryBlocks: 144, publicationRelays: ['wss://r.example'],
  donationSetId: donationSetId(TEST_DONATION_SET_REGTEST.recipients), censusHeight: 900000, censusRoot: b32(2), stakeMsat: 100000n,
  bondMinSats: 50000n, blockTicks: 4920, exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20,
  timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4, nodes,
  seriesGrid: true, seriesPeriodMs: 8000n, seriesCount: 225, protocolVersion: 3, creatorPubkey: schnorr.getPublicKey(creator), ...over,
});

test('a round of a creator-signed series this seat writes opens without its own signature; a lone creator round still needs one', async () => {
  const probe = await serve(openStore(':memory:'), { plugins: HOSTED, port: 0, funded: () => true });
  const nodes = [probe.round.pubkey, b32(8)]; await probe.close();
  const t = gridOf(nodes);
  const signature = schnorr.sign(seriesCreatorMessage(seriesId(t)), creator);
  const line = seriesLineOf({ ...t, creatorSignature: signature }, encodeRoundContract);
  const s = await serve(openStore(':memory:'), { plugins: HOSTED, port: 0, funded: () => true, roundClock: () => NOW });
  try {
    const url = `http://127.0.0.1:${s.port}`;
    const took = await fetch(`${url}/series`, { method: 'POST', body: line });
    assert.equal(took.status, 200, await took.clone().text());
    await new Promise((r) => setTimeout(r, 300));
    // THE PAGE'S OPEN OF ONE OF ITS ROUNDS: no ?creator=, as Client.openRound sends it
    const r0 = seriesRound(t, 3);
    // (past the creator check this seat - no federation reached, no bonded chain - refuses for its own reasons, 409; what is
    // measured is that the creator's door no longer refuses the round)
    const open = await fetch(`${url}/round`, { method: 'POST', body: encodeRoundContract(r0) });
    const said = await open.text();
    assert.notEqual(open.status, 403, said);
    assert.doesNotMatch(said, /creator/);
    assert.equal(toHex(roundId(r0)).length, 64);
    // A CREATOR ROUND FROM NO SERIES THIS SEAT WRITES: still refused without the creator's signature
    const lone = { ...seriesRound(gridOf(nodes, { startTimeMs: START + 7n, entryCloseMs: START + 80007n }), 0) };
    const refused = await fetch(`${url}/round`, { method: 'POST', body: encodeRoundContract(lone) });
    assert.equal(refused.status, 403);
    assert.match(await refused.text(), /comes without the creator's 64-byte signature/);
  } finally { await s.close(); }
});
