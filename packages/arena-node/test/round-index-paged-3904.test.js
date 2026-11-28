// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #3904: the seating agent's first tick read the whole rounds table in one .all() (869,467 contracts, 858 MB of BLOBs on a copy
// of Beelink seat 2's store) - glibc's heap reached ~1.3-1.7 GB at every start and kept it, more with every round stored. These fail when
// a round index holds more rows at once than its page, whatever the table holds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { schnorr } from '@noble/curves/secp256k1.js';
import * as seating from '../src/seating-agent.js';
import * as gameLiveMod from '../src/game-live.js';

const { seatingAgent } = seating, { gameLive } = gameLiveMod;
const INDEX_PAGE = seating.INDEX_PAGE ?? 1024, LIVE_PAGE = gameLiveMod.LIVE_PAGE ?? 1024;   // the pages; a build without them is held to 1024
import { encodeRoundContract, roundId as roundIdOf } from '../../arena-protocol/src/contracts.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { contractFor } from './window-fixture.js';

const nodes = Array.from({ length: 9 }, (_, i) => { const secret = new Uint8Array(32).fill(i + 1); return { secret, pubkey: schnorr.getPublicKey(secret), endpoint: `http://seat-${i}` }; });

/** The most rows one .all() over the rounds table answered. */
function watched(db) {
  const most = { rows: 0 };
  const prepare = db.prepare.bind(db);
  db.prepare = (sql) => {
    const st = prepare(sql);
    if (!/FROM rounds/.test(sql)) return st;
    const all = st.all.bind(st);
    st.all = (...a) => { const rows = all(...a); most.rows = Math.max(most.rows, rows.length); return rows; };
    return st;
  };
  return most;
}

test('the seating agent reads the rounds table a page at a time, and still finds the round to seat (kanban #3904)', async () => {
  const START = 30n * 86400000n, now = Number(START) - 150000;   // inside the PRESENT window, before seating_close
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE rounds (round_id BLOB, contract BLOB)');
  const base = contractFor(nodes.slice(0, 7).map((n) => n.pubkey));
  const put = db.prepare('INSERT INTO rounds (round_id, contract) VALUES (?, ?)');
  // 5,000 rounds long started (nothing left to seat), then the one that is seated now - the newest row, read last
  for (let i = 0; i < 5000; i++) { const c = { ...base, startTimeMs: START - 10n * 86400000n - BigInt(i) }; put.run(roundIdOf(c), encodeRoundContract(c)); }
  const c = { ...base, startTimeMs: START };
  const rid = roundIdOf(c), bytes = encodeRoundContract(c);
  put.run(rid, bytes);
  const most = watched(db);
  const round = { db, pubkey: nodes[0].pubkey, get: (id) => (toHex(id) === toHex(rid) ? { contract: bytes } : null) };
  const asked = [];
  const fetcher = async (url, init = {}) => { asked.push(`${init.method || 'GET'} ${new URL(url).pathname}`); return new Response(JSON.stringify({ rounds: {} }), { status: 200 }); };
  const agent = seatingAgent({ round, roster: { committeeFor: () => ({ ok: true, drawn: nodes.map((n) => ({ pubkey: n.pubkey, advert: { endpoint: n.endpoint } })) }) },
    sign: (m) => schnorr.sign(m, nodes[0].secret), verify: (s, m, k) => schnorr.verify(s, m, k), fetcher, nowMs: () => now });
  await agent.tick();
  console.log('  FACTS:', JSON.stringify({ rounds: 5001, mostRowsAtOnce: most.rows, page: INDEX_PAGE, seatingAsks: asked.filter((a) => a.endsWith('/seating-batch')).length }));
  assert.ok(most.rows <= INDEX_PAGE, `one statement held ${most.rows} rounds`);
  assert.ok(asked.some((a) => a.endsWith('/seating-batch')), 'the round after 5,000 old ones was not found to seat');
});

test('the live counts read the rounds table a page at a time and count every live round (kanban #3904)', () => {
  const now = 10 * 86400000;
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE rounds (round_id BLOB, contract BLOB, opened_ms INTEGER, closed_ms INTEGER)');
  db.exec('CREATE TABLE entries (entry_id BLOB, round_id BLOB, joined_ms INTEGER)');
  const base = contractFor(nodes.slice(0, 7).map((n) => n.pubkey));
  const put = db.prepare('INSERT INTO rounds (round_id, contract, opened_ms) VALUES (?, ?, ?)');
  const n = 2 * LIVE_PAGE + 7;
  for (let i = 0; i < n; i++) {
    const c = { ...base, committeeTimeMs: 0n, startTimeMs: BigInt(now + 60000 + i), entryCloseMs: BigInt(now + 100000 + i) };
    put.run(roundIdOf(c), encodeRoundContract(c), now - 1000);
  }
  const most = watched(db);
  const live = gameLive({ db }, { nowMs: () => now })();
  const counted = Object.values(live).reduce((a, g) => a + (g.rounds || 0), 0);
  console.log('  FACTS:', JSON.stringify({ rounds: n, mostRowsAtOnce: most.rows, page: LIVE_PAGE, counted }));
  assert.ok(most.rows <= LIVE_PAGE, `one statement held ${most.rows} rounds`);
  assert.equal(counted, n, 'a round past the first page was not counted');
});
