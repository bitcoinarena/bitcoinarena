// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE CLOSED ROUNDS ARE READ PAGE BY PAGE (kanban #3238, measured on a copy of a fed2 seat's store with ~600,000 closed rounds: the
// start's close resume read every closed round's contract in one statement run - JS heap 1.3 GB, malloc 1.5 GB in the first 40 s, and
// glibc keeps that high-water for the life of the seat). The same rounds, in the order they opened, none twice, and no read of the
// rounds table hands back more than one page of rows.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { openStore, OPEN, CLOSED } from '../src/store.js';
import { Round } from '../src/round.js';
import { contractFor, b32 } from './window-fixture.js';
import { encodeRoundContract } from '../../arena-protocol/src/contracts.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const id = (n) => { const b = new Uint8Array(32); b[0] = 0x5a; b[28] = n >>> 24; b[29] = (n >>> 16) & 255; b[30] = (n >>> 8) & 255; b[31] = n & 255; return b; };

test('#3238 closedRounds: every closed round that decodes, in opened order, read at most a page of rows at a time', () => {
  const db = openStore(':memory:');
  const contract = encodeRoundContract(contractFor([b32(0x11), b32(0x33)], 3000n, ['wss://r.example']));
  const put = db.prepare('INSERT INTO rounds (round_id, contract, state, opened_ms) VALUES (?, ?, ?, ?)');
  const want = [];
  for (let n = 0; n < 1300; n++) {
    // opened_ms repeats (ties broken by the id), some rows open, some contracts that do not decode
    const openedMs = 1000 + Math.floor(n / 3), state = n % 11 === 0 ? OPEN : CLOSED, bad = n % 17 === 0;
    put.run(id(n), bad ? Uint8Array.of(0, 1, 2) : contract, state, openedMs);
    if (state === CLOSED && !bad) want.push({ openedMs, hex: toHex(id(n)) });
  }
  want.sort((a, b) => a.openedMs - b.openedMs || (a.hex < b.hex ? -1 : a.hex > b.hex ? 1 : 0));

  // every statement run over the rounds table, by the rows it handed back
  let most = 0;
  const prepare = db.prepare;
  db.prepare = (sql) => {
    const st = prepare(sql);
    if (!/FROM rounds WHERE state/.test(sql)) return st;
    return { all: (...a) => { const rows = st.all(...a); most = Math.max(most, rows.length); return rows; }, get: (...a) => st.get(...a), run: (...a) => st.run(...a), iterate: (...a) => st.iterate(...a) };
  };
  const round = new Round(db);
  const got = round.closedRounds().map(toHex);
  assert.deepEqual(got, want.map((w) => w.hex));
  assert.equal(new Set(got).size, got.length);
  assert.ok(most > 0 && most <= 512, `one read handed back ${most} rows`);
  // and the generator a start walks gives the same, lazily: the first id comes before the rest are read
  most = 0;
  const it = round.eachClosedRound({ page: 100 });
  assert.equal(toHex(it.next().value), want[0].hex);
  assert.equal(most, 100);
  assert.deepEqual([want[0].hex, ...[...it].map(toHex)], want.map((w) => w.hex));
  db.close();
});
