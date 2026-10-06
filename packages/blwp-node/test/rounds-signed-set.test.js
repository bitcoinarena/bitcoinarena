// THE FULL LISTING FROM ROW SIGNATURES SIGNED IN THE BACKGROUND (kanban #197, the owner 2026-10-06, path A of comment 496).
// Measured live before: one fresh GET /rounds on seat 7 listed 2,291 rounds in 12.75 s, 8.0 s of it a Schnorr signature
// per row. Now the seat signs every announced row for one time every 45 s, off the request path, and serves the full
// listing from the last complete set: a cold GET (a query no kept listing answers) assembles rows from kept signatures.
// Every row still checks the page's way (lobby.js: one nowMs for the listing, the row's own facts), and a row whose
// signed facts changed is signed at once, not 45 s later.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../src/store.js';
import { serve } from '../src/server.js';
import { TRUCK_CORE_HASH, TRUCK_V3_CONFIG_HASH } from '../src/cores.js';
import { TEST_FEDERATION_ID } from '../../protocol/src/test-federation.js';
import { NETWORK_ID_REGTEST } from '../../protocol/src/genesis-ids.js';
import { TEST_DONATION_SET_REGTEST } from '../../protocol/src/test-donation-sets.js';
import { donationSetId } from '../../protocol/src/donation.js';
import { seriesTemplate, seriesIndexAt } from '../../protocol/src/series.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const NOW = 1790600000000;
const base = (nodes) => ({
  networkId: NETWORK_ID_REGTEST, configHash: TRUCK_V3_CONFIG_HASH, censusConfirmations: 1,
  gameVerifySlots: 7, settlementSlots: 7, simCoreHash: TRUCK_CORE_HASH,
  committeeTimeMs: 0n, randomnessRule: 'bitcoin-block-hash', startTimeMs: 0n, entryCloseMs: 0n,
  objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20, slashRemainder: 'SPLIT',
  federationId: TEST_FEDERATION_ID, stakeExpiryBlocks: 144, publicationRelays: ['wss://r.example'],
  donationSetId: donationSetId(TEST_DONATION_SET_REGTEST.recipients),
  censusHeight: 900000, censusRoot: b32(2), stakeMsat: 0n, bondMinSats: 50000n, blockTicks: 4920,
  exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20, timeFloor: 30, timeCeil: 150,
  minScore: 1, rankNumerator: 3, rankDenominator: 4, nodes,
});

import { schnorr } from '@noble/curves/secp256k1.js';
import { lobbyListingId } from '../../protocol/src/lobby-listing.js';
import { fromHex } from '../../protocol/src/hash.js';

const pageChecks = (body) => body.rounds.every((x) => schnorr.verify(fromHex(x.sig), lobbyListingId({ roundId: fromHex(x.id),
  nodePubkey: fromHex(body.node), nowMs: BigInt(body.nowMs), phase: x.phase, assignedHere: !!x.assignedHere,
  joined: Number(x.joined), playing: Number(x.playing) }), fromHex(body.node)));

test('a cold full GET /rounds is served from the background-signed set: under 1 s, every row, every row checks as the page checks, and a changed row is signed at once', async () => {
  const first = await serve(openStore(':memory:'), { port: 0, funded: () => true, now: () => NOW });
  const nodes = [first.round.pubkey];
  await first.close();
  const k0 = seriesIndexAt(NETWORK_ID_REGTEST, NOW) - 1;
  const series = [0, 1, 2, 3].map((j) => seriesTemplate(base(nodes), k0 + j));
  const s = await serve(openStore(':memory:'), { port: 0, funded: () => true, roundClock: () => NOW, series });
  try {
    const at = `http://127.0.0.1:${s.port}`;
    const cold = async (n) => { const t = performance.now(); const body = await (await fetch(`${at}/rounds?probe=${n}`)).json(); return { ms: performance.now() - t, body }; };
    // the first set is signed a few seconds after the start, in slices; until then a cold listing signs on the request
    let got = null;
    for (let i = 0; i < 120; i++) { got = await cold(`warm${i}`); if (got.ms < 500) break; await new Promise((r) => setTimeout(r, 500)); }
    const before = await cold('a');
    const rows = before.body.rounds.length;
    console.log('  FACTS:', JSON.stringify({ rows, coldMs: Math.round(before.ms), nowMs: before.body.nowMs }));
    assert.ok(rows > 2000, `the node lists ${rows} rounds - not a large listing`);
    assert.ok(before.ms < 1000, `a cold full listing of ${rows} rounds took ${Math.round(before.ms)} ms`);
    // ONE ROW'S SIGNED FACTS CHANGE: a player joins it - the next listing says so, signed, without waiting out the cycle.
    // Asked before the first listing's 2,880 signatures are checked: on a loaded machine that check outlasted the test
    // server's 5 s keep-alive, and fetch reused the closed connection (ECONNRESET, measured on the test host 2026-10-06).
    const pick = before.body.rounds[5];
    const own = s.round.playersOf.bind(s.round);
    s.round.playersOf = (rid) => (Buffer.from(rid).toString('hex') === pick.id ? { joined: 1, playing: 0 } : own(rid));
    const after = await cold('b');
    assert.ok(pageChecks(before.body), 'a row of the served set does not check the page\'s way');
    const row = after.body.rounds.find((x) => x.id === pick.id);
    console.log('  FACTS (changed row):', JSON.stringify({ coldMs: Math.round(after.ms), joinedBefore: pick.joined, joinedAfter: row.joined, sameNowMs: after.body.nowMs === before.body.nowMs }));
    assert.equal(row.joined, 1, 'the changed row still shows its old count');
    assert.notEqual(row.sig, pick.sig, 'the changed row kept its old signature');
    assert.equal(after.body.rounds.length, rows);
    assert.ok(pageChecks(after.body), 'after the change a row does not check the page\'s way');
    assert.ok(after.ms < 1000);
  } finally { await s.close(); }
});
