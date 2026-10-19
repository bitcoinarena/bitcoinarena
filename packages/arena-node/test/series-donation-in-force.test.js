// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A SERIES NAMING A DONATION SET THAT IS NOT IN FORCE AT ITS CENSUS HEIGHT IS OFFERED NOWHERE (2026-10-06:
// series d37c1ef1 named serial 2's 79b7f62a where serial 3 was in force; the seats wrote and listed its rounds 7 of 7, the
// page locked a 100 sat stake into one, and only the session then refused it). The check lived at POST /round alone, which
// a series' rounds never pass. Here: a regtest serial-2 set in force from 900100; a series at that height naming the old set
// beside one naming the set in force, its rounds already in the store as the live seats had them. The node does not write or
// hold the old-set series, lists none of its stored rounds, and refuses a re-post and an entry into one by name; the other
// series is held and listed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../src/store.js';
import { Round } from '../src/round.js';
import { seriesWriter } from '../src/series-writer.js';
import { serve } from '../src/server.js';
import { TRUCK_CORE_HASH, TRUCK_V3_CONFIG_HASH } from '../../nextblock/plugin/nextblock.js';
import { encodeRoundContract, encodeEntryContract, roundId } from '../../arena-protocol/src/contracts.js';
import { seriesTemplate, seriesRound, seriesIndexAt, seriesId } from '../../arena-protocol/src/series.js';
import { NETWORK_ID_REGTEST } from '../../arena-protocol/src/genesis-ids.js';
import { TEST_FEDERATION_ID } from '../../arena-protocol/src/test-federation.js';
import { TEST_DONATION_SET_REGTEST } from '../../arena-protocol/src/test-donation-sets.js';
import { donationSetId } from '../../arena-protocol/src/donation.js';
import { decodeDonationSetBody } from '../../arena-protocol/src/authority.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { HOSTED } from './plugins/hosted.js';
import { NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const NOW = 1790600000000;
const SET = TEST_DONATION_SET_REGTEST;
// the regtest serial-2 set of donation-set-door.test.js, valid from 900100, signed by the regtest authority
const SET2 = { ...decodeDonationSetBody(Uint8Array.from(Buffer.from('1400019855e6790b51f0a6ec3ee1a4d83f4de9ad4be7bffb169f0525ad00a59ced5b380000000000000002000dbc040099100001000200466c6e75726c31647036386775726e3867686a376572306465736867656677763475787a6d747364336a6a376d7277773465786375703064656a68736170647679306e387265381a0b00466c6e75726c31647036386775726e3867686a376572306465736867656677763475787a6d747364336a6a376d7277773465786375703064656a687361706476673764706667710d05', 'hex'))),
  signature: Uint8Array.from(Buffer.from('f007229c5185a12eeed3310cd5722b576d39121927ef6cdf9624fb868ac61e200cdf60274fbb68cd6f46425d05ba611c989d06e4f606e9ef3b34f33244332e0b', 'hex')) };
const base = (nodes, set) => ({
  networkId: NETWORK_ID_REGTEST, configHash: TRUCK_V3_CONFIG_HASH, censusConfirmations: 1, gameVerifySlots: 2, settlementSlots: 2,
  gameId: NEXTBLOCK_GAME_ID, simCoreHash: TRUCK_CORE_HASH, committeeTimeMs: 0n, randomnessRule: 'bitcoin-block-hash', startTimeMs: 0n, entryCloseMs: 0n,
  objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20, slashRemainder: 'SPLIT',
  federationId: TEST_FEDERATION_ID, stakeExpiryBlocks: 144, publicationRelays: ['wss://r.example'],
  donationSetId: donationSetId(set.recipients), censusHeight: 900100, censusRoot: b32(2), stakeMsat: 100000n,
  bondMinSats: 50000n, blockTicks: 4920, exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20,
  timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4, nodes,
});

test('a series naming a donation set not in force is not written or held; its stored rounds are listed nowhere and refused at /round and /entry', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'series-in-force-'));
  const path = join(dir, 'node.db');
  const probe = await serve(openStore(':memory:'), { plugins: HOSTED, port: 0, funded: () => true });
  const nodes = [probe.round.pubkey, b32(8)]; await probe.close();
  const k = seriesIndexAt(NETWORK_ID_REGTEST, NOW) + 1;
  const good = seriesTemplate(base(nodes, SET2), k);
  const bad = seriesTemplate(base(nodes, SET), k);          // the old set at a height where serial 2 is in force
  // THE LIVE SEATS' STORE: the old-set series' rounds already written
  { const w = seriesWriter(new Round(openStore(path), () => NOW, { plugins: HOSTED }), bad); w.write(NOW, Date.now() + 60000); }
  const s = await serve(openStore(path), { plugins: HOSTED, port: 0, funded: () => true, roundClock: () => NOW, series: [good, bad], seriesEveryMs: 100, donationSets: [SET, SET2] });
  try {
    const url = `http://127.0.0.1:${s.port}`;
    const badIds = new Set(); for (let i = 0; i < 960; i++) badIds.add(toHex(roundId(seriesRound(bad, i))));
    const stored = s.round.db.prepare('SELECT round_id FROM rounds').all().filter((r) => badIds.has(toHex(new Uint8Array(r.round_id)))).length;
    for (let t = Date.now(); Date.now() - t < 20000; await new Promise((r) => setTimeout(r, 200))) {
      const h = (await (await fetch(`${url}/series`)).json()).series; if (h.some((x) => x.written >= 960)) break; }
    const held = (await (await fetch(`${url}/series`)).json()).series.map((x) => x.series);
    const listed = (await (await fetch(`${url}/rounds?ahead=72h`)).json()).rounds.map((r) => r.id);
    const r5 = seriesRound(bad, 5);
    const repost = await fetch(`${url}/round`, { method: 'POST', body: encodeRoundContract(r5) });
    const repostWhy = await repost.text();
    const entry = encodeEntryContract({ roundId: roundId(r5), playerPubkey: b32(3), sessionPubkey: b32(4),
      stakeMsat: 100000n, feeMsat: 2000n, donationMsat: 0n, joinTick: 0, stakeCommitment: b32(5), vssSharesRef: b32(6), worldSecret: b32(9),
      stakePoint: new Uint8Array(33), feePreimage: b32(0), stakeLockOutpoint: { txid: b32(0), outIdx: 0n }, feeLockOutpoint: { txid: b32(0), outIdx: 0n }, claimKeyAttestationRef: b32(0) });
    const e = await fetch(`${url}/entry`, { method: 'POST', body: entry });
    const eWhy = await e.text();
    console.log('  FACTS:', JSON.stringify({ storedBad: stored, held: held.map((x) => x.slice(0, 8)), good: toHex(seriesId(good)).slice(0, 8), bad: toHex(seriesId(bad)).slice(0, 8),
      listed: listed.length, listedBad: listed.filter((x) => badIds.has(x)).length, repost: [repost.status, repostWhy.slice(0, 110)], entry: [e.status, eWhy.slice(0, 110)] }));
    assert.ok(stored > 0, 'the old-set rounds were not in the store to begin with');
    assert.deepEqual(held, [toHex(seriesId(good))], 'the old-set series is held');
    assert.equal(listed.filter((x) => badIds.has(x)).length, 0, 'an old-set round is listed');
    assert.equal(listed.length, 960, 'the series naming the set in force is not listed whole');
    assert.equal(repost.status, 409); assert.match(repostWhy, /donation set in force is serial 2/);
    assert.equal(e.status, 409); assert.match(eWhy, /entry refused: .*donation set in force is serial 2/);
  } finally { await s.close(); }
});
