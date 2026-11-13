// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 audit44 refute item 21 (#1637 / #2143), skeptic 2: a STRANGER, no money spent. #2143 counts every asked RECEIVING row as
// owed at its want_msat - a number the poster chose. A string the federation cannot decode (the stake-lock tool's decode_prefixed fails,
// the tool exits non-zero, the port throws) leaves its row RECEIVING with receive_asked 1 for good: 503 "ask again", never REFUSED.
// So a stranger who posts garbage e-cash at maxMsat each pins the seat's whole balance in `to` as "owed" forever, and every honest
// exchange into `to` is refused 409 "holds 0 sat free" - while the seat holds every one of those sats.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import * as ex from '../src/ecash-exchange.js';

const A = 'aa'.repeat(32), B = 'bb'.repeat(32);
const HONEST = 'fedimintq'.padEnd(60, 'q');

function seat(holdsB, { db = new DatabaseSync(':memory:'), invalid = new Set() } = {}) {
  const sent = new Map();
  const ports = {
    [A]: { ecashBalance: async () => 0n,
      ecashReceive: async (e) => {
        // the real tool: fedimint_core::base32::decode_prefixed(...)? fails on anything but real notes -> exit 1 -> run() rejects
        // a tool of kanban #2384/#2436: base32 that is not notes of this federation is answered Invalid, exit 0
        if (invalid.has(e)) return { state: 'Invalid', msat: 0n, why: 'does not decode: unexpected end of input' };
        if (!e.startsWith('fedimintq')) throw new Error('arena-stake-lock: Error: invalid base32 / could not decode ECash');
        return { state: 'Success', msat: 100_000n, carriedMsat: 100_000n };   // the notes' own amount (kanban #1936)
      } },
    [B]: { ecashBalance: async () => holdsB,
      ecashSend: async (m, { key }) => {
        if (sent.has(key)) return sent.get(key);
        if (m > holdsB) throw new Error('insufficient balance');
        holdsB -= m; const out = { ecash: `fedimintb${key.slice(0, 8)}`, msat: m }; sent.set(key, out); return out;
      },
      ecashSent: async (key) => (sent.has(key) ? { found: true, ...sent.get(key) } : { found: false }) },
  };
  return ex.createEcashExchange({ db, portOf: async (f) => ports[f] || null });
}

test('a44 refute 21 s2-1: garbage e-cash from a stranger pins the seat\'s balance as owed - an honest exchange is refused for good', async () => {
  const x = seat(1_000_000n);   // the seat holds 1000 sat in B
  // the stranger: one garbage string (no notes at all), amountMsat = maxMsat
  const g = await x.exchange({ from: A, to: B, ecash: 'fedimintZZZZ-not-notes-at-all-' + 'x'.repeat(40), amountMsat: '1000000' });
  // kanban #2384, #2436: refused 400 before any row is written (before the fix: held 503, counted as owed for good)
  assert.ok(g.status === 400 || g.status === 503, `the garbage is answered ${g.status}`);
  // an honest player, 100 sat of real notes, an hour and a day later
  const h = await x.exchange({ from: A, to: B, ecash: HONEST, amountMsat: '100000' });
  assert.ok(h.ok, `an honest 100 sat exchange is refused (${h.status} "${h.why}") while the seat holds 1000 sat: a stranger's undecodable string is counted as owed`);
});

test('a44 refute 21 s2-2: garbage e-cash from a stranger spends the seat\'s hour - honest exchanges get 429', async () => {
  const x = seat(1_000_000_000n);   // plenty in B
  for (let i = 0; i < 20; i++) {
    const g = await x.exchange({ from: A, to: B, ecash: `fedimintZ${i}-garbage-`.padEnd(60, 'x'), amountMsat: '1000000' });
    assert.ok(g.status === 400 || g.status === 503, `garbage ${i} answered ${g.status}`);
  }
  const h = await x.exchange({ from: A, to: B, ecash: HONEST, amountMsat: '100000' });
  assert.ok(h.ok, `an honest exchange is refused (${h.status} "${h.why}"): 20 garbage posts, nothing paid out, spent the seat's hour`);
});

test('a44 refute 21 s2-3 (#2384, #2436): base32 the tool answers Invalid is refused for good, owes nothing and spends no hour', async () => {
  const bogus = Array.from({ length: 30 }, (_, i) => `fedimint${'0123456789abcdefghijklmnopqrstuv'[i]}`.padEnd(60, '0'));
  const x = seat(1_000_000n, { invalid: new Set(bogus) });
  for (const b of bogus) {
    const g = await x.exchange({ from: A, to: B, ecash: b, amountMsat: '1000000' });
    assert.equal(g.status, 400, g.why);
    assert.equal(x.stateOf(ex.noteKey(b)).state, ex.EXCHANGE.REFUSED);
    assert.equal((await x.exchange({ from: A, to: B, ecash: b, amountMsat: '1000000' })).status, 409, 'asked again: refused, not retried');
  }
  const h = await x.exchange({ from: A, to: B, ecash: HONEST, amountMsat: '100000' });
  assert.ok(h.ok, `an honest exchange after 30 Invalid strings: ${h.status} "${h.why}"`);
});

test('a44 refute 21 s2-4 (#2384, #2436): a garbage row left RECEIVING by a build before the fix is closed on its next ask and owes nothing', async () => {
  const db = new DatabaseSync(':memory:');
  const x = seat(1_000_000n, { db });
  const g = 'fedimintZZ-old-garbage-'.padEnd(60, 'x');
  // the row as the build before wrote it: asked, the tool failed, held RECEIVING at the stranger's amount
  db.prepare("INSERT INTO ecash_exchanges (id, from_fed, to_fed, state, why, made_ms, want_msat, receive_asked) VALUES (?, ?, ?, 'receiving', 'the receive did not answer', ?, '1000000', 1)")
    .run(ex.noteKey(g), A, B, Date.now());
  assert.equal((await x.exchange({ from: A, to: B, ecash: HONEST.replace('fedimintq', 'fedimintr'), amountMsat: '100000' })).status, 409, 'counted while open (as before)');
  assert.equal((await x.exchange({ from: A, to: B, ecash: g, amountMsat: '1000000' })).status, 400);
  assert.equal(x.stateOf(ex.noteKey(g)).state, ex.EXCHANGE.REFUSED);
  const h = await x.exchange({ from: A, to: B, ecash: HONEST, amountMsat: '100000' });
  assert.ok(h.ok, `${h.status} "${h.why}"`);
});
