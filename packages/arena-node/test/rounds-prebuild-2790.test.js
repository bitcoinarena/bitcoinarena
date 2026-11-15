// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE LISTING IS BUILT IN THE BACKGROUND AND A REQUEST SIGNS NOTHING (kanban #2790). Live after the first fix (audit9b, 2026-11-15): the window
// built ahead held the rows the last window was asked for, and requests after each window start still signed ~800 rows; one `all=1` made the next
// build sign all 11,239 rows (116 s) and a normal request waited past 60 s. Now each window is one fixed, bounded build that no ask changes, and a
// request only cuts from it: `all=1` lists what the window holds, a row whose facts changed is listed as signed and signed again in the background.
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

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
test('#2790 a request signs nothing: the window is built in the background, all=1 does not grow it, a changed row is signed again off the request', async () => {
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
    const signs = () => s.listingSignatures();
    const built = () => (typeof s.listingWindowsBuilt === 'function' ? s.listingWindowsBuilt() : 0);
    // the seat's first listing waits for the first build; the build is the window's whole row set
    const lobby = await ask('?next=1');
    const held = signs();
    assert.ok(held >= lobby.body.rounds.length && held < 2000, `the first window signed ${held} rows - not a bounded set`);
    // all=1: what the window holds, nothing signed for it
    const all = await ask('?all=1&probe=a');
    assert.equal(signs(), held, `all=1 signed ${signs() - held} rows while its asker waited`);
    assert.ok(all.body.rounds.length <= held, `all=1 listed ${all.body.rounds.length} rows, more than the window holds (${held})`);
    assert.ok(pageChecks(all.body));
    // THE NEXT WINDOW, built ahead: the same bounded set, however much all=1 asked
    clock = NOW + 31000;
    const b0 = built();
    for (let i = 0; i < 160 && built() <= b0; i++) await delay(250);
    const grew = signs() - held;
    assert.ok(grew <= 1200, `after all=1 the next window signed ${grew} rows: more than a window holds (1,200)`);
    clock = NOW + 45000;
    await delay(5100);   // past the 5 s a small listing is kept in real time (server.js /rounds)
    const before = signs();
    const asks = [await ask('?next=8'), await ask('?ahead=900000'), await ask('?all=1&probe=b'), await ask('?next=1&ahead=50h')];
    assert.equal(signs(), before, `the first asks of the new window signed ${signs() - before} rows while their askers waited`);
    for (const a of asks) {
      assert.equal(BigInt(a.body.nowMs), BigInt(NOW) + 45000n, 'the new window does not carry its own time');
      assert.ok(a.ms < 1000, `a listing of the new window took ${Math.round(a.ms)} ms`);
      assert.ok(pageChecks(a.body), 'a row of the new window does not check the page\'s way');
    }
    // A ROW'S FACTS CHANGE (a player joins): listed as signed, signed again in the background, then listed with the new count
    const pick = asks[2].body.rounds[3];
    const own = s.round.playersOf.bind(s.round);
    s.round.playersOf = (rid) => (Buffer.from(rid).toString('hex') === pick.id ? { joined: 1, playing: 0 } : own(rid));
    const b1 = signs();
    const now1 = await ask('?all=1&probe=c');
    assert.equal(signs(), b1, 'the changed row was signed while its asker waited');
    const row1 = now1.body.rounds.find((x) => x.id === pick.id);
    assert.equal(row1.sig, pick.sig, 'the changed row is listed with the signature it had');
    assert.ok(pageChecks(now1.body), 'the changed row, listed as signed, does not check');
    for (let i = 0; i < 40 && signs() === b1; i++) await delay(100);
    assert.equal(signs(), b1 + 1, 'the background signed more than the changed row');
    await delay(5100);
    const now2 = await ask('?all=1&probe=d');
    const row2 = now2.body.rounds.find((x) => x.id === pick.id);
    assert.equal(row2.joined, 1, 'the changed row still shows its old count');
    assert.notEqual(row2.sig, pick.sig);
    assert.ok(pageChecks(now2.body));
    // A WINDOW NOBODY ASKED IS NOT FOLLOWED BY A BUILD (kanban #2790, live audit9c: every seat signed ~1,600 rows every 45 s, asked or not)
    clock = NOW + 90000;   // window 2 was asked: window 3 is built
    const b3 = built();
    for (let i = 0; i < 160 && built() <= b3; i++) await delay(250);
    assert.equal(built(), b3 + 1, 'the window after an asked one was not built');
    const quiet = signs();
    clock = NOW + 135000;  // window 3 was asked by nobody
    await delay(4000);
    assert.equal(signs(), quiet, `a window nobody asked was followed by a build of ${signs() - quiet} signatures`);
    clock = NOW + 180000;
    await delay(3000);
    assert.equal(signs(), quiet, 'a quiet seat signs on');
    // and the next ask builds one and is answered from it
    const back = await ask('?next=8&probe=e');
    assert.ok(back.body.rounds.length > 0 && pageChecks(back.body), 'the first ask after a quiet spell got no rows that check');
    console.log('  FACTS:', JSON.stringify({ held, all: all.body.rounds.length, grew, firstMs: Math.round(lobby.ms), newWindowMs: asks.map((a) => Math.round(a.ms)) }));
  } finally { await s.close(); }
});
