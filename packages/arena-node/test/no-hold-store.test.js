// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE HOLD-INVOICE STORE IS GONE FROM THE NODE (§23.6, RULED 2026-09-22 22:59; cut 2b RULED 2026-09-25: "delete the
// hold methods, the hold= read on the settle log line, and the holds table from new stores only. Old stores keep their
// table. Do not rewrite a store.").
//
// MEASURED before this test (2026-09-25): round.js still had putHold, dropHold, hold, holdsOf and holdsInState over the
// `holds` table every new store created; nothing in src/ wrote a hold any more; server.js read round.hold() into its
// settle log line (`hold=-`). Three tools drove hold invoices: round-rehearsal-lnd.mjs (dead - it still set the deleted
// signing, payouts and poolWatch), remote-signer-probe.sh (addholdinvoice / settleinvoice / cancelinvoice through a
// committee-signed lnd) and swap-into-pool-probe.sh (addholdinvoice / settleinvoice for the superseded submarine swap).
//
// CLASSIFIED FEDERATION-GATEWAY AND KEPT, not a failure here: closed-claim.mjs, closed-line.mjs, outage.mjs,
// settle-live-regtest.mjs, stake-lock-step5.sh, stake-lock-step6.sh (arena-node) and winnings-page-probe.mjs (arena-client)
// - stake locks on a real federation, whose only Lightning is an ordinary invoice looked up. funding.js's node.holds(roundId)
// asks whether this node holds the ROUND and stays.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { openStore } from '../src/store.js';

const HERE = new URL('../', import.meta.url).pathname;
const HOLD_INVOICE_TOOLS = ['tools/round-rehearsal-lnd.mjs', 'tools/remote-signer-probe.sh', 'tools/swap-into-pool-probe.sh',
  'tools/swap-into-pool.mjs'];

test('round.js has no hold store: no putHold, hold, holdsOf or holdsInState', () => {
  const round = readFileSync(HERE + 'src/round.js', 'utf8');
  const still = ['putHold', 'hold', 'holdsOf', 'holdsInState'].filter((m) => new RegExp(`^  ${m}\\(`, 'm').test(round));
  assert.deepEqual(still, [], `round.js still defines ${still.join(', ')}`);
});

test('server.js reads no hold into the settle log', () => {
  const server = readFileSync(HERE + 'src/server.js', 'utf8');
  assert.equal(/round\.hold\(/.test(server), false, 'server.js still reads round.hold()');
  assert.equal(/hold=\$\{/.test(server), false, 'the settle log line still prints hold=');
});

test('no tool classed hold-invoice still calls addholdinvoice, settleinvoice or cancelinvoice', () => {
  const calling = HOLD_INVOICE_TOOLS.filter((t) => existsSync(HERE + t)
    && /\b(addholdinvoice|settleinvoice|cancelinvoice)\b/.test(readFileSync(HERE + t, 'utf8')));
  const dead = HOLD_INVOICE_TOOLS.filter((t) => existsSync(HERE + t) && /\b(poolWatch|\.payouts\.|\.signing\.)/.test(readFileSync(HERE + t, 'utf8')));
  assert.deepEqual({ calling, dead }, { calling: [], dead: [] });
  assert.deepEqual(HOLD_INVOICE_TOOLS.filter((t) => existsSync(HERE + t)), []);
});

test('a new store has no holds table; a store from before keeps its own, rows and all', () => {
  const dir = mkdtempSync(join(tmpdir(), 'holds-'));
  try {
    const fresh = openStore(join(dir, 'new.sqlite'));
    const tablesOf = (db) => db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name);
    const freshHas = tablesOf(fresh).includes('holds');
    fresh.close();
    // A STORE FROM BEFORE: its holds table and one row, then opened by this node.
    const oldPath = join(dir, 'old.sqlite');
    const raw = new DatabaseSync(oldPath);
    raw.exec('CREATE TABLE holds (entry_id BLOB PRIMARY KEY, round_id BLOB NOT NULL, payment_hash BLOB NOT NULL, amount_msat INTEGER NOT NULL, state TEXT NOT NULL, why TEXT NOT NULL, updated_ms INTEGER NOT NULL, request TEXT)');
    raw.prepare('INSERT INTO holds VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(Buffer.alloc(32, 1), Buffer.alloc(32, 2), Buffer.alloc(32, 3), 98000, 'HELD', 'from before', 1, null);
    raw.close();
    const old = openStore(oldPath);
    const oldRows = tablesOf(old).includes('holds') ? old.prepare('SELECT COUNT(*) AS n FROM holds').get().n : null;
    old.close();
    console.log('  FACTS (holds table):', JSON.stringify({ freshHas, oldRows }));
    assert.equal(freshHas, false, 'a new store still creates the holds table');
    assert.equal(oldRows, 1, 'a store from before lost its holds table or its row');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
