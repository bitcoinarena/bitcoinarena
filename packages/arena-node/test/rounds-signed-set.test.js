// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE LISTING'S ROW SIGNATURES, SIGNED ON DEMAND ONE WINDOW AT A TIME (2026-10-08; it was 's
// background set). Measured live before: every ~45 s each testnet4 seat signed every announced row - 1,857, ~6.5 s of
// BIP-340 in a new worker - about 23 of its 29 % CPU, while the lobby asks for a handful. Now a row is signed the first time
// a listing in the window names it and served from that signature for the rest of the window; nothing asked, nothing
// signed. Every row still checks the page's way (lobby.js: one nowMs for the listing, the row's own facts), a row whose
// signed facts changed is signed again at once, and a new window (45 s) signs again what it is asked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../src/store.js';
import { serve } from '../src/server.js';
import { TRUCK_CORE_HASH, TRUCK_V3_CONFIG_HASH } from '../../nextblock/plugin/nextblock.js';
import { TEST_FEDERATION_ID } from '../../arena-protocol/src/test-federation.js';
import { NETWORK_ID_REGTEST } from '../../arena-protocol/src/genesis-ids.js';
import { TEST_DONATION_SET_REGTEST } from '../../arena-protocol/src/test-donation-sets.js';
import { donationSetId } from '../../arena-protocol/src/donation.js';
import { seriesTemplate, seriesIndexAt } from '../../arena-protocol/src/series.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const NOW = 1790600000000;
const base = (nodes) => ({
  networkId: NETWORK_ID_REGTEST, configHash: TRUCK_V3_CONFIG_HASH, censusConfirmations: 1,
  gameVerifySlots: 7, settlementSlots: 7, gameId: NEXTBLOCK_GAME_ID, simCoreHash: TRUCK_CORE_HASH,
  committeeTimeMs: 0n, randomnessRule: 'bitcoin-block-hash', startTimeMs: 0n, entryCloseMs: 0n,
  objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20, slashRemainder: 'SPLIT',
  federationId: TEST_FEDERATION_ID, stakeExpiryBlocks: 144, publicationRelays: ['wss://r.example'],
  donationSetId: donationSetId(TEST_DONATION_SET_REGTEST.recipients),
  censusHeight: 900000, censusRoot: b32(2), stakeMsat: 0n, bondMinSats: 50000n, blockTicks: 4920,
  exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20, timeFloor: 30, timeCeil: 150,
  minScore: 1, rankNumerator: 3, rankDenominator: 4, nodes,
});

import { schnorr } from '@noble/curves/secp256k1.js';
import { lobbyListingId } from '../../arena-protocol/src/lobby-listing.js';
import { fromHex } from '../../arena-protocol/src/hash.js';
import { HOSTED } from './plugins/hosted.js';
import { NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';

const pageChecks = (body) => body.rounds.every((x) => schnorr.verify(fromHex(x.sig), lobbyListingId({ roundId: fromHex(x.id),
  nodePubkey: fromHex(body.node), nowMs: BigInt(body.nowMs), phase: x.phase, assignedHere: !!x.assignedHere,
  joined: Number(x.joined), playing: Number(x.playing) }), fromHex(body.node)));

test('rows are signed when a listing asks, once a window: nothing unasked, next=1 signs its rows, a full listing the rest, a second costs nothing, a change one row, a new window again', async () => {
  const first = await serve(openStore(':memory:'), { plugins: HOSTED, port: 0, funded: () => true, now: () => NOW });
  const nodes = [first.round.pubkey];
  await first.close();
  const k0 = seriesIndexAt(NETWORK_ID_REGTEST, NOW) - 1;
  const series = [0, 1, 2, 3].map((j) => seriesTemplate(base(nodes), k0 + j));
  let clock = NOW;
  const s = await serve(openStore(':memory:'), { plugins: HOSTED, port: 0, funded: () => true, roundClock: () => clock, series });
  try {
    const at = `http://127.0.0.1:${s.port}`;
    const ask = async (q) => { const t = performance.now(); const body = await (await fetch(`${at}/rounds${q}`)).json(); return { ms: performance.now() - t, body }; };
    // NOTHING ASKED, NOTHING SIGNED (the background set signed every row every 45 s)
    await new Promise((r) => setTimeout(r, 4000));
    assert.equal(s.listingSignatures(), 0, 'the node signed rows nobody asked for');
    // THE LOBBY'S ASK: one upcoming round of each series - only those rows are signed
    const next = await ask('?next=1');
    const nextRows = next.body.rounds.length;
    assert.ok(nextRows >= 1 && nextRows <= series.length, `next=1 listed ${nextRows} rows`);
    assert.equal(s.listingSignatures(), nextRows, 'next=1 signed more than it listed');
    assert.ok(pageChecks(next.body), 'a next=1 row does not check the page\'s way');
    // THE FULL LISTING: every announced row, the ones next=1 signed served from the window, the rest signed now
    const full = await ask('?probe=a');
    const rows = full.body.rounds.length;
    assert.ok(rows > 2000, `the node lists ${rows} rounds - not a large listing`);
    assert.equal(full.body.nowMs, next.body.nowMs, 'two listings of one window carry different times');
    assert.equal(s.listingSignatures(), rows, `the full listing of ${rows} rows made ${s.listingSignatures()} signatures in all`);
    // A SECOND FULL LISTING IN THE WINDOW: no signature, the same rows, quick
    // (asked before the first listing's signatures are checked: on a loaded machine that check outlasted the test
    // server's 5 s keep-alive, and fetch reused the closed connection - ECONNRESET, measured on the test host 2026-10-06)
    const again = await ask('?probe=b');
    assert.equal(s.listingSignatures(), rows, 'a second listing in the window signed again');
    assert.deepEqual(again.body.rounds.map((x) => x.sig), full.body.rounds.map((x) => x.sig));
    // ONE ROW'S SIGNED FACTS CHANGE: a player joins it - signed again at once, for the same time, and nothing else
    const pick = full.body.rounds[5];
    const own = s.round.playersOf.bind(s.round);
    s.round.playersOf = (rid) => (Buffer.from(rid).toString('hex') === pick.id ? { joined: 1, playing: 0 } : own(rid));
    const after = await ask('?probe=c');
    const row = after.body.rounds.find((x) => x.id === pick.id);
    assert.equal(row.joined, 1, 'the changed row still shows its old count');
    assert.notEqual(row.sig, pick.sig, 'the changed row kept its old signature');
    assert.equal(s.listingSignatures(), rows + 1, 'a change of one row signed more than that row');
    assert.equal(after.body.nowMs, full.body.nowMs);
    // A NEW WINDOW, 45 s on: the lobby's ask is signed for the new time, and only its rows
    clock = NOW + 45000;
    // and the real seconds with it: a small listing is kept 5 s of real time (server.js /rounds), and on a quick machine the
    // asks above take less than that (measured on the test host 2026-10-13 22:50Z: the kept next=1 came back, red every run)
    await new Promise((r) => setTimeout(r, 5100));
    const later = await ask('?next=1');
    assert.equal(BigInt(later.body.nowMs), BigInt(next.body.nowMs) + 45000n, 'the new window does not carry the new time');
    assert.equal(s.listingSignatures(), rows + 1 + later.body.rounds.length, 'a new window signed more than it was asked');
    assert.ok(pageChecks(later.body));
    // the signatures checked last, every request made: checking 2,880 rows outlasts the test server's keep-alive
    assert.ok(pageChecks(full.body), 'a row of the full listing does not check the page\'s way');
    assert.ok(pageChecks(after.body), 'after the change a row does not check the page\'s way');
    console.log('  FACTS:', JSON.stringify({ rows, nextRows, fullMs: Math.round(full.ms), againMs: Math.round(again.ms), changedMs: Math.round(after.ms),
      signatures: s.listingSignatures() }));
    assert.ok(again.ms < 1000, `a second full listing in the window took ${Math.round(again.ms)} ms`);
  } finally { await s.close(); }
});
