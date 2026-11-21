// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 refute (skeptic 3) of #3068/#3089/#3101: the SECOND DOOR to a first bond. #3089 put releaseGamesBeforeBond where the owner
// page's first bond is built (add-bond.js firstBondOnNode) and #3101 into firstBond - but the installer wizard posts first bonds with its
// own copy of the build (wizard.js 'POST /api/bond/post' -> buildBond({ hostedGames: n.hostedGames })), which never reads the release's
// games. arena-install resumes a set-up node at its next step (state.js nextStep): a node installed, left at the bond step, moved before
// its bond by an older updater (1.9.28 and older returned "no bond yet" without writing the list - #3089's own premise), and finished in
// the installer of the release it now runs, posts its bond with the install-time list - #3068's exact effect through the wizard.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createWizard } from '../src/wizard.js';
import { nodeState } from '../src/state.js';
import { hostedGameIdsOf } from '../src/apps.js';
import { parseTransaction } from '../../arena-protocol/src/tx.js';
import { advertInTransaction } from '../../arena-protocol/src/census.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';

test('#3068 refute s3: the wizard\'s first bond (POST /api/bond/post) names the games of the release the node runs, not a stale list', async () => {
  const repo = join(import.meta.dirname, '..', '..', '..');
  const home = mkdtempSync(join(tmpdir(), 'r1120-6-s3-'));
  writeFileSync(join(home, 'seed.hex'), toHex(new Uint8Array(32).fill(9)));
  const db = new DatabaseSync(join(home, 'node.db'));
  db.exec('CREATE TABLE identity (one INTEGER PRIMARY KEY, secret BLOB)');
  db.prepare('INSERT INTO identity (one, secret) VALUES (0, ?)').run(new Uint8Array(32).fill(4));
  db.close();
  const state = nodeState(home);
  const apps = ['nextblock', 'rock-paper-scissors'];
  const want = await hostedGameIdsOf(repo, apps);
  const old = want.slice(0, 2);   // the install-time list an older updater left when it moved the node here before its bond
  const done = Object.fromEntries(['chain', 'roles', 'seed', 'owner', 'reach', 'service', 'promise'].map((k) => [k, 1]));
  state.save({ chain: { kind: 'core', url: 'http://x/' }, owner: { pubkey: 'ab'.repeat(32) }, roles: ['verify', 'settlement'],
    reach: { mode: 'permanent', url: 'https://node.example.com', port: 1 }, service: { port: 1 }, apps, hostedGames: old, done, bond: null, release: { path: repo } });
  const sent = [];
  const chainKit = { coinsOf: async () => ({ tip: 157070, coins: [{ txid: '5a'.repeat(32), vout: 1, sats: 400000, height: 157060 }] }),
    broadcast: async (_c, hex) => { sent.push(hex); return toHex(Uint8Array.from(parseTransaction(fromHex(hex)).txid).reverse()); } };
  const w = createWizard({ state, release: repo, seatPort: 1, chainKit, gwKit: { installProgram: async () => ({ ok: true }) }, launch: () => ({ files: [] }) });
  try {
    assert.equal(state.read().bond, null);
    const r = await w['POST /api/bond/post']({});
    assert.equal(r.ok, true, r.why);
    assert.equal(sent.length, 2, 'the funding and the bond');
    const named = advertInTransaction(fromHex(sent[1])).hostedGames.map((g) => toHex(g)).sort();
    console.log(`  wizard bond names ${named.length} games; the release hosts ${want.length}`);
    assert.deepEqual(named, [...want].sort(), 'the wizard\'s first bond names the games of the release the node runs');
  } finally { w.close(); }
});
