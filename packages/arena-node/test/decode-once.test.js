// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// AN OPEN ROUND'S CONTRACT IS DECODED ONCE (kanban #742, test host seat 6 idle 2026-10-28: 1,391.8 MB allocated in 30 s, 21 % of the
// seat in the garbage collector - the committee draws, the listing, the price feed and the held scans each decoded every one of
// ~11,400 open rounds' contracts again on every pass). The store keeps one decoded contract per open round: every pass - the store's
// own reads, the roster's census and committee asks, the price feed's scan - is handed that one object, and the open list hands out
// the same id objects while it has not moved. A closed, rewritten or deleted round's is let go.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Round } from '../src/round.js';
import { Roster } from '../src/roster.js';
import { PriceFeed } from '../src/price-feed.js';
import { openStore } from '../src/store.js';
import { encodeRoundContract, roundId } from '../../arena-protocol/src/contracts.js';
import { TRUCK_CORE_HASH, TRUCK_V3_CONFIG_HASH, NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';
import { TEST_FEDERATION_ID } from '../../arena-protocol/src/test-federation.js';
import { NETWORK_ID_REGTEST } from '../../arena-protocol/src/genesis-ids.js';
import { TEST_DONATION_SET_REGTEST } from '../../arena-protocol/src/test-donation-sets.js';
import { donationSetId } from '../../arena-protocol/src/donation.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const contractAt = (startMs) => ({
  networkId: NETWORK_ID_REGTEST, configHash: TRUCK_V3_CONFIG_HASH, censusConfirmations: 1,
  gameVerifySlots: 7, settlementSlots: 7, gameId: NEXTBLOCK_GAME_ID, simCoreHash: TRUCK_CORE_HASH,
  committeeTimeMs: BigInt(startMs) - 60000n, randomnessRule: 'bitcoin-block-hash', startTimeMs: BigInt(startMs), entryCloseMs: BigInt(startMs) + 60000n,
  objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20, slashRemainder: 'SPLIT',
  federationId: TEST_FEDERATION_ID, stakeExpiryBlocks: 144, publicationRelays: ['wss://r.example'],
  donationSetId: donationSetId(TEST_DONATION_SET_REGTEST.recipients),
  censusHeight: 900000, censusRoot: b32(2), stakeMsat: 0n, bondMinSats: 50000n, blockTicks: 4920,
  exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20, timeFloor: 30, timeCeil: 150,
  minScore: 1, rankNumerator: 3, rankDenominator: 4, nodes: [b32(9)],
});

const held = () => {
  const round = new Round(openStore(), () => 1790600000000);
  const ids = [0, 1, 2].map((i) => {
    const c = contractAt(1790600000000 + i * 600000);
    const id = roundId(c);
    round.db.prepare('INSERT INTO rounds (round_id, contract, state, opened_ms) VALUES (?, ?, 0, ?)').run(id, encodeRoundContract(c), i);
    return new Uint8Array(id);
  });
  return { round, ids };
};

test('every pass over an open round is handed the one contract the store decoded: the store, the roster, the price feed', async () => {
  const { round, ids } = held();
  const listed = round.openHeld();
  assert.equal(listed.length, 3);
  assert.equal(round.openHeld(), listed, 'the open list unmoved: the same list, the same id objects');
  const [id] = listed;
  const c = round.contractOf(id);
  assert.ok(c && c.startTimeMs === 1790600000000n);
  assert.ok(round.get(ids[0]), 'get still answers the row');
  assert.equal(round.contractOf(ids[0]), c, 'the store reads it again: the same object, nothing decoded again');
  assert.equal(round.contractOf(new Uint8Array(ids[0])), c, 'asked by another copy of the id: the same object');
  // THE ROSTER: the census, the committee and the attestor asks hand the chain the store's object
  const seen = [];
  const roster = new Roster(round, { chainFor: ({ contract }) => { seen.push(contract); return undefined; } });
  for (let pass = 0; pass < 3; pass++) { roster.censusFor(id); roster.committeeFor(id, 'game'); roster.committeeFor(id, 'settlement'); roster.attestorsFor(id); }
  assert.ok(seen.length >= 6, `the roster asked the chain ${seen.length} times`);
  assert.ok(seen.every((x) => x === c), 'every roster ask was made on the store\'s one decoded contract');
  // THE PRICE FEED: its scan is handed the store's object
  const priced = [];
  const feed = new PriceFeed(round, { priceRound: (x) => { priced.push(x); return false; }, readPrice: async () => null, now: () => 0 });
  await feed.beat();
  assert.equal(priced.length, 3);
  assert.ok(priced.includes(c), 'the price feed classified the store\'s own object');
  assert.equal(round.contracts.size, 3, 'one decoded contract per open round, and no more');
});

test('a closed, rewritten or deleted round\'s contract is let go; the open list follows the store', () => {
  const { round, ids } = held();
  round.openHeld();
  const c0 = round.contractOf(ids[0]), c1 = round.contractOf(ids[1]), c2 = round.contractOf(ids[2]);
  assert.equal(round.close(ids[0]), true);
  assert.equal(round.contracts.has(round.hexOf(ids[0])), false, 'closed: let go');
  const again = round.contractOf(ids[0]);
  assert.ok(again && again !== c0 && again.startTimeMs === c0.startTimeMs, 'a closed round is still read - decoded on the ask, not kept');
  assert.equal(round.contracts.has(round.hexOf(ids[0])), false);
  // DELETED BEHIND THE STORE'S BACK (the unused-round prune): forgotten when told, and in any case at the next read of the open list
  round.db.prepare('DELETE FROM rounds WHERE round_id = ?').run(ids[1]);
  round.forget(ids[1]);
  assert.equal(round.contractOf(ids[1]), null);
  round.db.prepare('DELETE FROM rounds WHERE round_id = ?').run(ids[2]);
  assert.equal(round.contractOf(ids[2]), c2, 'not yet told');
  assert.deepEqual(round.openHeld(), [], 'the open list moved');
  assert.equal(round.contracts.size, 0, 'and nothing of a round no longer open is kept');
  assert.equal(round.contractOf(ids[2]), null);
  assert.ok(c1);
});

// kanban #791: an RPS grid closes a round every few seconds; each close made the next ask read every open row again
test('a round this store closed is taken out of the kept open list, a new one appended, and the open rows are not all read again', () => {
  const { round, ids } = held();
  const listed = round.openHeld();
  const asked = [];
  const prepare = round.db.prepare.bind(round.db);
  round.db.prepare = (sql) => { asked.push(sql); return prepare(sql); };
  assert.equal(round.close(ids[0]), true);
  const c = contractAt(1790600000000 + 3 * 600000);
  prepare('INSERT INTO rounds (round_id, contract, state, opened_ms) VALUES (?, ?, 0, ?)').run(roundId(c), encodeRoundContract(c), 3);
  round.openList.askedMs = 0;
  const now = round.openHeld();
  assert.deepEqual(now.map((id) => round.hexOf(id)), [ids[1], ids[2], new Uint8Array(roundId(c))].map((id) => round.hexOf(id)));
  assert.equal(now[0], listed[1], 'the kept ids are the same objects');
  assert.ok(!asked.some((q) => /WHERE state = \? ORDER BY opened_ms/.test(q)), `no full read of the open rows: ${asked.join(' | ')}`);
  // and a round closed behind the store's back still reads the whole list (the count disagrees)
  prepare('UPDATE rounds SET state = 1 WHERE round_id = ?').run(ids[1]);
  round.openList.askedMs = 0;
  assert.deepEqual(round.openHeld().map((id) => round.hexOf(id)), [ids[2], new Uint8Array(roundId(c))].map((id) => round.hexOf(id)));
  assert.ok(asked.some((q) => /WHERE state = \? ORDER BY opened_ms/.test(q)), 'the full read');
});
