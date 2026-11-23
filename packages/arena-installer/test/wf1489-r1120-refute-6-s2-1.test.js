// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 refute (skeptic 2) of #3068/#3089: the RE-BOND path. releaseGamesBeforeBond writes the release's games only when
// state.bond.txid is empty - but firstBond (kanban #2098) also posts a NEW first bond over a record whose every output the chain shows
// spent (the bond withdrawn; a seat that missed writing the withdrawal, or one from before it did, keeps naming it). There
// releaseGamesBeforeBond answers [] ("bonded"), refreshHostedGames cannot correct the list either (its advertisement update names a spent
// bond), and the new bond is built from the hostedGames the node had when its OLD bond was posted: a node bonded on an older release,
// withdrawn, updated, bonded again advertises the old games and is never drawn for the newer versions - #3068's exact effect.
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

test('#3068 refute s2: a new first bond over a withdrawn (spent) recorded bond names the release\'s games, not the old bond\'s list', async () => {
  const repo = join(import.meta.dirname, '..', '..', '..');
  const home = mkdtempSync(join(tmpdir(), 'r1120-6-s2-'));
  writeFileSync(join(home, 'seed.hex'), toHex(new Uint8Array(32).fill(9)));
  const db = new DatabaseSync(join(home, 'node.db'));
  db.exec('CREATE TABLE identity (one INTEGER PRIMARY KEY, secret BLOB)');
  db.prepare('INSERT INTO identity (one, secret) VALUES (0, ?)').run(new Uint8Array(32).fill(4));
  db.close();
  const state = nodeState(home);
  const apps = ['nextblock', 'rock-paper-scissors'];
  const want = await hostedGameIdsOf(repo, apps);
  const old = want.slice(0, 2);   // the list the old bond named (an older release)
  const oldBond = { txid: '7c'.repeat(32), vout: 0, fundingTxid: '7d'.repeat(32), sats: '300000', maturity: 150000, advertId: 'aa'.repeat(32), postedAtTip: 140000 };
  state.save({ chain: { kind: 'core' }, owner: { pubkey: 'ab'.repeat(32) }, roles: ['verify', 'settlement'], reach: { url: 'https://node.example.com' },
    apps, hostedGames: old, done: { service: 1, bond: 1 }, bond: oldBond, release: { path: repo } });
  const sent = [];
  const chainKit = { coinsOf: async () => ({ tip: 157070, coins: [{ txid: '5a'.repeat(32), vout: 1, sats: 400000, height: 157060 }] }),
    txOut: async (txid) => (txid === oldBond.txid ? null : { value: 1 }),   // the old bond: spent (withdrawn)
    broadcast: async (_c, hex) => { sent.push(hex); return toHex(Uint8Array.from(parseTransaction(fromHex(hex)).txid).reverse()); } };
  const r = await firstBondOnNode({ home, state, release: repo, post: true, chainKit, askMinimum: null, startAgent: null });
  assert.equal(r.ok, true, r.why);
  assert.equal(sent.length, 2, 'a new first bond is posted over the withdrawn one');
  const named = advertInTransaction(fromHex(sent[1])).hostedGames.map((g) => toHex(g)).sort();
  console.log(`  new bond names ${named.length} games; the release hosts ${want.length}`);
  assert.deepEqual(named, [...want].sort(), 'the new first bond names this release\'s games, not the withdrawn bond\'s list');
});
