// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// ONE COMMITTEE AND ONE KEY PER TABLE (2026-10-13 pick (c)): a v2 round of a game seated per table (RPS v2) draws on
// its table's first round - its series' round 0 - so every round of the table has the same seed, the same draw and so the same claim
// key; every other round (Up/Down, a v1 round, a round of no series) draws on itself, as before.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tableAnchorOf } from '../src/known-game.js';
import { committeeSeedFrom } from '../src/beacon.js';
import { taggedHash, toHex, fromHex } from '../src/hash.js';
import { TAG } from '../src/constants.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const RPS_V2 = fromHex('a75f54fd4f978a29ab6d39d9ef85c7adbe0576614634c679ae33d3e1c06164ea');
const RPS_V1 = fromHex('1e9ab4b7d402d51f46def727e6db58da0ad70c4afafc295c82357d612543cd50');
const UPDOWN_V2 = fromHex('f5f3f18753b4167fe36d2e18f72c72b6e5cfea93cd5ef98c716d3b9137890375');
const roundIdOf = (series, i) => { const b = new Uint8Array(36); b.set(series, 0); new DataView(b.buffer).setUint32(32, i, false); return taggedHash(TAG.seriesRound, b); };

test('an RPS v2 table round anchors on its series round 0; Up/Down, v1 and series-less rounds anchor on nothing', () => {
  const series = b32(0x51);
  const r = (gameId, i, v = 2, extra = {}) => ({ gameId, seriesId: series, roundIndex: i, protocolVersion: v, ...extra });
  const a0 = tableAnchorOf(r(RPS_V2, 0)), a7 = tableAnchorOf(r(RPS_V2, 7));
  assert.equal(toHex(a0.anchorId), toHex(roundIdOf(series, 0))); assert.equal(a0.first, true);
  assert.equal(toHex(a7.anchorId), toHex(roundIdOf(series, 0))); assert.equal(a7.first, false);
  assert.equal(tableAnchorOf(r(UPDOWN_V2, 3)), null, 'a market round draws on itself');
  assert.equal(tableAnchorOf(r(RPS_V1, 3, 1)), null, 'a v1 round draws on itself');
  assert.equal(tableAnchorOf({ gameId: RPS_V2, protocolVersion: 2 }), null, 'a round of no series');
});

test('so every round of a table has one committee seed, and two tables two', () => {
  const seedOf = (c, rid) => toHex(committeeSeedFrom({ censusRootGameVerify: b32(2), censusRootSettlement: b32(2), roundId: tableAnchorOf(c) ? tableAnchorOf(c).anchorId : rid, roundRandomness: b32(9) }));
  const t1 = b32(0x61), t2 = b32(0x62);
  const c = (s, i) => ({ gameId: RPS_V2, seriesId: s, roundIndex: i, protocolVersion: 2 });
  const seeds = [0, 1, 2, 224].map((i) => seedOf(c(t1, i), roundIdOf(t1, i)));
  assert.equal(new Set(seeds).size, 1, 'one seed for the whole table');
  assert.notEqual(seedOf(c(t2, 0), roundIdOf(t2, 0)), seeds[0], 'another table draws anew');
  const ud = [0, 1].map((i) => seedOf({ gameId: UPDOWN_V2, seriesId: t1, roundIndex: i, protocolVersion: 2 }, roundIdOf(t1, i)));
  assert.notEqual(ud[0], ud[1], 'Up/Down rounds still draw each on its own');
});
