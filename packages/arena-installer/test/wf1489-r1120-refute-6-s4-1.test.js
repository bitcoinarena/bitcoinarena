// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 refute (skeptic 4) of #3068/#3089/#3101/#3114: a RESTART BETWEEN TWO WRITES of an update. update.js starts the new release's
// units (STARTED) and only minutes later - after waitHealthy, versionAnswers and the leftovers check - records state.release.path = the new
// release (KEPT). An updater killed in between (a reboot) leaves the node running the new release with state.release naming the old one
// until resumeUpdate runs. #3114's apps.js bondGamesOf reads state.release.path FIRST and only then `release` - the code that is building the
// bond. The owner page's first bond (server.js passes its own release folder) in that window advertises the OLD release's games (non-empty,
// so the right list is never reached), and even overwrites the list #3089's releaseGamesBeforeBond had just written: #3068's exact effect.
// On e829cfbb4 (before #3114) firstBond read `release` and named the running release's games.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { firstBondOnNode } from '../src/add-bond.js';
import { nodeState } from '../src/state.js';
import { hostedGameIdsOf } from '../src/apps.js';
import { parseTransaction } from '../../arena-protocol/src/tx.js';
import { advertInTransaction } from '../../arena-protocol/src/census.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';

// the previous release, still on disk beside the new one (update.js unpacks into <home>/releases/, the old one is the rollback target)
function olderRelease(repo) {
  const rel = mkdtempSync(join(tmpdir(), 'r1120-6-s4-old-'));
  for (const [app, title, files] of [['nextblock', 'Tick Tock, Next Block', ['nextblock.js', 'nextblock-v2.js']], ['rock-paper-scissors', 'Rock Paper Scissors', ['rock-paper-scissors.js']]]) {
    const dir = join(rel, 'packages', app);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'app.json'), JSON.stringify({ id: app, title, registrations: files.map((f) => relative(dir, join(repo, 'packages', app, 'plugin', f))) }));
  }
  return rel;
}

test('#3068 refute s4: the owner page\'s first bond names the running release\'s games while state.release still names the old one (update killed before KEPT)', async () => {
  const repo = join(import.meta.dirname, '..', '..', '..');
  const home = mkdtempSync(join(tmpdir(), 'r1120-6-s4-'));
  writeFileSync(join(home, 'seed.hex'), toHex(new Uint8Array(32).fill(9)));
  const db = new DatabaseSync(join(home, 'node.db'));
  db.exec('CREATE TABLE identity (one INTEGER PRIMARY KEY, secret BLOB)');
  db.prepare('INSERT INTO identity (one, secret) VALUES (0, ?)').run(new Uint8Array(32).fill(4));
  db.close();
  const state = nodeState(home);
  const apps = ['nextblock', 'rock-paper-scissors'];
  const want = await hostedGameIdsOf(repo, apps);
  const oldRel = olderRelease(repo);
  const old = await hostedGameIdsOf(oldRel, apps);
  assert.ok(old.length > 0 && old.length < want.length, `fixture: the old release hosts fewer games (${old.length} of ${want.length})`);
  // the node runs `repo` (its units started by the killed updater); state.release still names the old release
  state.save({ chain: { kind: 'core' }, owner: { pubkey: 'ab'.repeat(32) }, roles: ['verify', 'settlement'], reach: { url: 'https://node.example.com' },
    apps, hostedGames: old, done: { service: 1 }, bond: null, release: { path: oldRel, atMs: 1 } });
  const sent = [];
  const chainKit = { coinsOf: async () => ({ tip: 157070, coins: [{ txid: '5a'.repeat(32), vout: 1, sats: 400000, height: 157060 }] }),
    txOut: async () => ({ value: 1 }),
    broadcast: async (_c, hex) => { sent.push(hex); return toHex(Uint8Array.from(parseTransaction(fromHex(hex)).txid).reverse()); } };
  // server.js: firstBondOnNode({ home, release: <the running server's own release folder>, post })
  const r = await firstBondOnNode({ home, state, release: repo, post: true, chainKit, askMinimum: null, startAgent: null });
  assert.equal(r.ok, true, r.why);
  assert.equal(sent.length, 2, 'the funding and the bond');
  const named = advertInTransaction(fromHex(sent[1])).hostedGames.map((g) => toHex(g)).sort();
  console.log(`  bond names ${named.length} games; the running release hosts ${want.length}, the old one ${old.length}`);
  assert.deepEqual(named, [...want].sort(), 'the first bond names the games of the release that is running and building it');
  assert.deepEqual([...state.read().hostedGames].sort(), [...want].sort(), 'state keeps the running release\'s list');
});
