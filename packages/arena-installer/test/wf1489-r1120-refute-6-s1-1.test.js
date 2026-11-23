// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 refute of #3068: the fix writes the release's games only inside refreshHostedGames, which runs only from the updater
// (update.js moveNode / resumeUpdate) - and the updater is the OLD release's code (the updater unit runs ~/bin/bitcoinarena, written
// for the running release; update.js imports its own ./change-roles.js). So the first update INTO the fixed release still runs the old
// early return, state keeps the install-time list, and the first bond posted from the owner area of the fixed release (add-bond.js
// firstBondOnNode, which is handed `release`) names the stale list - exactly the live node #3068 was measured on (1.9.27 -> 1.9.28, no bond).
// The bond path itself never reads the release's games.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { firstBondOnNode } from '../src/add-bond.js';
import { nodeState } from '../src/state.js';
import { hostedGameIdsOf } from '../src/apps.js';
import { parseTransaction } from '../../arena-protocol/src/tx.js';
import { advertInTransaction } from '../../arena-protocol/src/census.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';

test('#3068 refute: the first bond posted on the fixed release names the release\'s games, even when the update into it kept the old list', async () => {
  const repo = join(import.meta.dirname, '..', '..', '..');
  const home = mkdtempSync(join(tmpdir(), 'r1120-6-'));
  writeFileSync(join(home, 'seed.hex'), toHex(new Uint8Array(32).fill(9)));
  const db = new DatabaseSync(join(home, 'node.db'));
  db.exec('CREATE TABLE identity (one INTEGER PRIMARY KEY, secret BLOB)');
  db.prepare('INSERT INTO identity (one, secret) VALUES (0, ?)').run(new Uint8Array(32).fill(4));
  db.close();
  const state = nodeState(home);
  const apps = ['nextblock', 'rock-paper-scissors'];
  const want = await hostedGameIdsOf(repo, apps);
  const old = want.slice(0, 2);   // the install-time list the previous release's updater left (its refresh returned "no bond yet")
  state.save({ chain: { kind: 'core' }, owner: { pubkey: 'ab'.repeat(32) }, roles: ['verify', 'settlement'], reach: { url: 'https://node.example.com' },
    apps, hostedGames: old, done: { service: 1 }, bond: null, release: { path: repo } });
  const sent = [];
  const chainKit = { coinsOf: async () => ({ tip: 157070, coins: [{ txid: '5a'.repeat(32), vout: 1, sats: 400000, height: 157060 }] }),
    broadcast: async (_c, hex) => { sent.push(hex); return toHex(Uint8Array.from(parseTransaction(fromHex(hex)).txid).reverse()); } };
  const r = await firstBondOnNode({ home, state, release: repo, post: true, chainKit, askMinimum: null, startAgent: null });
  assert.equal(r.ok, true, r.why);
  assert.equal(sent.length, 2);
  const advert = advertInTransaction(fromHex(sent[1]));
  const named = advert.hostedGames.map((g) => toHex(g)).sort();
  console.log(`  bond names ${named.length} games; the release hosts ${want.length}`);
  assert.deepEqual(named, [...want].sort(), 'the first bond on this release names its games, not the list an older updater left');
});
