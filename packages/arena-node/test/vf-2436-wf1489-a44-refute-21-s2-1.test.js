// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 audit44 refute item 21 (#1637 / #2143), skeptic 2: a STRANGER, no money spent. #2143 counts every asked RECEIVING row as
// owed at its want_msat - a number the poster chose. A string the federation cannot decode (the stake-lock tool's decode_prefixed fails,
// the tool exits non-zero, the port throws) leaves its row RECEIVING with receive_asked 1 for good: 503 "ask again", never REFUSED.
// So a stranger who posts garbage e-cash at maxMsat each pins the seat's whole balance in `to` as "owed" forever, and every honest
// exchange into `to` is refused 409 "holds 0 sat free" - while the seat holds every one of those sats.
// kanban #2536 (re-check on 1.9 acbc1948c): since 443500327 (#2384) an undecodable string is refused 400 before any row is written, so
// the garbage post is no longer held 503 - the precondition asserts the refusal now; the attack and the honest exchange are the same.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import * as ex from '../src/ecash-exchange.js';

const A = 'aa'.repeat(32), B = 'bb'.repeat(32);
const HONEST = 'fedimintq'.padEnd(60, 'q');

function seat(holdsB) {
  const sent = new Map();
  const ports = {
    [A]: { ecashBalance: async () => 0n,
      ecashReceive: async (e) => {
        // the real tool: fedimint_core::base32::decode_prefixed(...)? fails on anything but real notes -> exit 1 -> run() rejects
        if (!e.startsWith('fedimintq')) throw new Error('arena-stake-lock: Error: invalid base32 / could not decode ECash');
        return { state: 'Success', msat: 100_000n, carriedMsat: 100_000n };   // kanban #2536: the tool says what the notes carried (#1936)
      } },
    [B]: { ecashBalance: async () => holdsB,
      ecashSend: async (m, { key }) => {
        if (sent.has(key)) return sent.get(key);
        if (m > holdsB) throw new Error('insufficient balance');
        holdsB -= m; const out = { ecash: `fedimintb${key.slice(0, 8)}`, msat: m }; sent.set(key, out); return out;
      },
      ecashSent: async (key) => (sent.has(key) ? { found: true, ...sent.get(key) } : { found: false }) },
  };
  return ex.createEcashExchange({ db: new DatabaseSync(':memory:'), portOf: async (f) => ports[f] || null });
}

test('a44 refute 21 s2-1: garbage e-cash from a stranger pins the seat\'s balance as owed - an honest exchange is refused for good', async () => {
  const x = seat(1_000_000n);   // the seat holds 1000 sat in B
  // the stranger: one garbage string (no notes at all), amountMsat = maxMsat
  const g = await x.exchange({ from: A, to: B, ecash: 'fedimintZZZZ-not-notes-at-all-' + 'x'.repeat(40), amountMsat: '1000000' });
  assert.equal(g.status, 400, `the garbage is refused before a row is written (${g.status} "${g.why}")`);
  // an honest player, 100 sat of real notes, an hour and a day later
  const h = await x.exchange({ from: A, to: B, ecash: HONEST, amountMsat: '100000' });
  assert.ok(h.ok, `an honest 100 sat exchange is refused (${h.status} "${h.why}") while the seat holds 1000 sat: a stranger's undecodable string is counted as owed`);
});

test('a44 refute 21 s2-2: garbage e-cash from a stranger spends the seat\'s hour - honest exchanges get 429', async () => {
  const x = seat(1_000_000_000n);   // plenty in B
  for (let i = 0; i < 20; i++) {
    const g = await x.exchange({ from: A, to: B, ecash: `fedimintZ${i}-garbage-`.padEnd(60, 'x'), amountMsat: '1000000' });
    assert.equal(g.status, 400, g.why);
  }
  const h = await x.exchange({ from: A, to: B, ecash: HONEST, amountMsat: '100000' });
  assert.ok(h.ok, `an honest exchange is refused (${h.status} "${h.why}"): 20 garbage posts, nothing paid out, spent the seat's hour`);
});
