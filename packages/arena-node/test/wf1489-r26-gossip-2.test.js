// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// wf1489 r26 gossip-2: POST /node-facts takes ANY key's self-signed record while the seat has no census read (isBonded -> null, the
// first minute after every start, or a seat whose census read fails), keeps it in node_facts for good and serves it in GET /node-facts
// with no bound - nothing drops it once the census is known. A stranger mints throwaway keys during that window and grows every
// seat's table and its public /node-facts listing (each row parsed again on every GET) without limit; each fresh one is also fanned out.
// Safe behaviour: a record of a key the census (once read) does not name is not listed, and the book holds a bounded number of rows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { schnorr } from '@noble/curves/secp256k1.js';
import { createNodeFactsBook, signFacts, FACTS_UNKNOWN_MOST } from '../src/node-facts.js';

const verify = (sig, msg, key) => { try { return schnorr.verify(sig, msg, key); } catch { return false; } };
const T0 = 1_800_000_000_000;

test('records of unbonded keys taken before the census is read are not kept or served once it is', () => {
  const db = new DatabaseSync(':memory:');
  let censusRead = false;
  const bonded = new Set();
  const book = createNodeFactsBook({ db, verify, nowMs: () => T0, isBonded: (hex) => (censusRead ? bonded.has(hex) : null) });
  for (let i = 1; i <= 300; i++) {
    const secret = new Uint8Array(32); secret[31] = i & 255; secret[30] = i >> 8; secret[0] = 7;
    const r = signFacts({ node: schnorr.getPublicKey(secret), atMs: T0, facts: { cores: 1, junk: 'x'.repeat(600) }, sign: (d) => schnorr.sign(d, secret) });
    const got = book.offer(r); assert.equal(got.kept, true, JSON.stringify(got));
  }
  censusRead = true;   // the census is read now: it names none of those keys
  const listed = book.list();
  assert.equal(listed.length, 0, `GET /node-facts still serves ${listed.length} records of keys no census names (${JSON.stringify(listed).length} bytes)`);
});

// kanban #2855: while the census is unread the book holds at most FACTS_UNKNOWN_MOST rows; a bonded node is still taken past it
test('#2855 an unread census holds at most FACTS_UNKNOWN_MOST records; a bonded node is taken past it', () => {
  const db = new DatabaseSync(':memory:');
  const BONDED = new Set();
  const book = createNodeFactsBook({ db, verify, nowMs: () => T0, isBonded: (hex) => (BONDED.has(hex) ? true : null) });
  const rec = (i) => { const secret = new Uint8Array(32); secret[31] = i & 255; secret[30] = (i >> 8) & 255; secret[0] = 9;
    return { r: signFacts({ node: schnorr.getPublicKey(secret), atMs: T0, facts: { cores: 1 }, sign: (d) => schnorr.sign(d, secret) }), hex: Buffer.from(schnorr.getPublicKey(secret)).toString('hex') }; };
  for (let i = 1; i <= FACTS_UNKNOWN_MOST; i++) assert.equal(book.offer(rec(i).r).kept, true);
  const over = book.offer(rec(FACTS_UNKNOWN_MOST + 1).r);
  const b = rec(FACTS_UNKNOWN_MOST + 2); BONDED.add(b.hex);
  const bonded = book.offer(b.r);
  console.log('  FACTS #2855:', JSON.stringify({ over, bonded }));
  assert.equal(over.ok, false); assert.match(over.why, /census is not read/);
  assert.equal(bonded.kept, true);
});
