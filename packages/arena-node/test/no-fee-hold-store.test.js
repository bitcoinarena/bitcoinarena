// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE §23.5 FEE'S HOLD STORE IS GONE FROM THE NODE (RULED 2026-09-25: "the same dead hold-invoice record as the
// hold-store cut. It does not stay so an old round can decode. Delete it.").
//
// MEASURED before this test (2026-09-25): round.js defined putFeeHold, feeHold and feeHoldsOf over a `fee_holds` table
// every new store created, and nothing in src/, test/ or tools/ called any of the three. There was no drop helper.
// funding.js's node.holds(roundId) is NOT this store - it is server.js's fundingView, which reads the rounds table - and
// stays.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { openStore } from '../src/store.js';

const HERE = new URL('../', import.meta.url).pathname;
const PACKAGES = new URL('../../', import.meta.url).pathname;
const SELF = new URL(import.meta.url).pathname;
const tablesOf = (db) => db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name);

function filesUnder(dir) {
  const out = [];
  let names = [];
  try { names = readdirSync(dir); } catch { return out; }
  for (const name of names) {
    if (name === 'node_modules' || name === 'target' || name.startsWith('.')) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...filesUnder(p));
    else if (/\.(js|mjs|sh)$/.test(name) && p !== SELF) out.push(p);
  }
  return out;
}

test('1. round.js has no fee-hold method and no SQL naming fee_holds', () => {
  const round = readFileSync(HERE + 'src/round.js', 'utf8');
  const methods = ['putFeeHold', 'feeHold', 'feeHoldsOf'].filter((m) => new RegExp(`^  ${m}\\(`, 'm').test(round));
  const sql = /['"`][^'"`\n]*\bfee_holds\b/.test(round);
  assert.deepEqual({ methods, sql }, { methods: [], sql: false });
});

test('2. a new store does not create fee_holds', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fee-holds-new-'));
  try {
    const db = openStore(join(dir, 'new.sqlite'));
    const has = tablesOf(db).includes('fee_holds');
    db.close();
    assert.equal(has, false, 'a new store still creates fee_holds');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('3. a store from before keeps its fee_holds table and its row, unread and unrewritten', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fee-holds-old-'));
  try {
    const path = join(dir, 'old.sqlite');
    const raw = new DatabaseSync(path);
    raw.exec('CREATE TABLE fee_holds (entry_id BLOB PRIMARY KEY, round_id BLOB NOT NULL, payment_hash BLOB NOT NULL, '
      + 'amount_msat INTEGER NOT NULL, state TEXT NOT NULL, why TEXT NOT NULL, updated_ms INTEGER NOT NULL, request TEXT)');
    raw.prepare('INSERT INTO fee_holds VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(Buffer.alloc(32, 1), Buffer.alloc(32, 2), Buffer.alloc(32, 3), 2000, 'HELD', 'from before', 1, null);
    raw.close();
    const db = openStore(path);
    const rows = tablesOf(db).includes('fee_holds') ? db.prepare('SELECT COUNT(*) AS n FROM fee_holds').get().n : null;
    db.close();
    assert.equal(rows, 1, 'a store from before lost its fee_holds table or its row');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// OUTSIDE CALLERS ONLY (RULED 2026-09-25, option a): src/round.js is where the methods are defined, and feeHoldsOf's own
// this.feeHold() sits inside the code assertion 1 covers - so this scan does not read it.
const DEFINING = join(PACKAGES, 'arena-node', 'src', 'round.js');
test('4. nothing in src, test or tools outside src/round.js calls putFeeHold, feeHold or feeHoldsOf', () => {
  const calling = [];
  for (const pkg of ['arena-protocol', 'nextblock', 'arena-node', 'arena-client'])
    for (const sub of ['src', 'test', 'tools'])
      for (const f of filesUnder(join(PACKAGES, pkg, sub)))
        if (f !== DEFINING && /\.(putFeeHold|feeHold|feeHoldsOf)\(/.test(readFileSync(f, 'utf8'))) calling.push(f.slice(PACKAGES.length));
  assert.deepEqual(calling, []);
});
