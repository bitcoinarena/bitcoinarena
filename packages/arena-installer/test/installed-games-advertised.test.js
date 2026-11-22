// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #3068 follow-up (measured 2026-11-22 on a live installer node on 2026.1.9.29): the node served 43 games and advertised 37 - the
// rock-paper-scissors versions it had taken from the network as installed packages (node.db.plugins) were never named, because the games
// refresh read the release's apps alone and ran only inside a release update. The census draws a node only for the games its advertisement
// names, so the node was never drawn for the live RPS game.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { nodeState } from '../src/state.js';
import { readAdvertUpdate } from '../../arena-protocol/src/advert-update.js';
import { parseTransaction } from '../../arena-protocol/src/tx.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { packageOf, installPackage } from '../../arena-node/src/plugin-package.js';
import { ROCK_PAPER_SCISSORS } from '../../rock-paper-scissors/plugin/rock-paper-scissors.js';

const repo = join(import.meta.dirname, '..', '..', '..');
const RPS_ID = toHex(ROCK_PAPER_SCISSORS.gameId);

// a bonded installer node whose chosen apps are Next Block alone, with Rock Paper Scissors installed as a package beside its database
function node({ installed = true } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'installed-games-'));
  const state = nodeState(home);
  writeFileSync(join(home, 'seed.hex'), '11'.repeat(32));
  const db = new DatabaseSync(join(home, 'node.db'));
  db.exec('CREATE TABLE identity (one INTEGER PRIMARY KEY, secret BLOB)'); db.prepare('INSERT INTO identity VALUES (0, ?)').run(new Uint8Array(32).fill(6)); db.close();
  state.save({ roles: ['verify', 'settlement'], chain: { kind: 'core' }, owner: { pubkey: 'ab'.repeat(32) }, reach: { mode: 'permanent', url: 'https://node.example.com' },
    apps: ['nextblock'], bond: { txid: '77'.repeat(32), vout: 0, sats: '50000', maturity: 157057 } });
  if (installed) {
    const pkg = packageOf(ROCK_PAPER_SCISSORS);
    assert.ok(pkg, 'the RPS registration packages');
    mkdirSync(join(home, 'node.db.plugins'), { recursive: true });
    installPackage(join(home, 'node.db.plugins'), pkg, RPS_ID);
  }
  const sent = [];
  const chainKit = { coinsOf: async () => ({ tip: 157000, coins: [{ txid: '5a'.repeat(32), vout: 1, sats: 20000 }] }),
    broadcast: async (_c, hex) => { sent.push(hex); return toHex(Uint8Array.from(parseTransaction(fromHex(hex)).txid).reverse()); } };
  return { home, state, sent, chainKit };
}

test('the games a node hosts include the packages it installed, as the seat loads them', async () => {
  const { hostedGameIdsOf } = await import('../src/apps.js');
  const n = node();
  const release = await hostedGameIdsOf(repo, ['nextblock']);
  assert.ok(!release.includes(RPS_ID), 'the release\'s Next Block app alone does not host RPS');
  const refused = [];
  const all = await hostedGameIdsOf(repo, ['nextblock'], undefined, { pluginsDir: join(n.home, 'node.db.plugins'), refused });
  assert.deepEqual(refused, []);
  assert.deepEqual(all, [...release, RPS_ID].sort(), 'the installed RPS is named beside the release\'s games, once');
});

test('a bonded node posts the games update naming its installed package, and nothing more once it is named', async () => {
  const { refreshHostedGames } = await import('../src/change-roles.js');
  const { hostedGameIdsOf } = await import('../src/apps.js');
  const n = node();
  const release = await hostedGameIdsOf(repo, ['nextblock']);
  n.state.save({ hostedGames: release, advertProtocols: (await import('../../arena-protocol/src/constants.js')).SUPPORTED_PROTOCOL_VERSIONS });
  const r = await refreshHostedGames({ home: n.home, release: repo, state: n.state, chainKit: n.chainKit, post: true });
  assert.equal(r.ok, true, r.why);
  assert.deepEqual([r.plan.before, r.plan.after, r.plan.added], [release.length, release.length + 1, 1]);
  const read = readAdvertUpdate(fromHex(n.sent[1]), { network: 'testnet4' });
  assert.ok(read.advert.hostedGames.map((g) => toHex(g)).includes(RPS_ID), 'the advertisement names the installed RPS');
  assert.ok(n.state.read().hostedGames.includes(RPS_ID));
  assert.deepEqual(await refreshHostedGames({ home: n.home, release: repo, state: n.state, chainKit: n.chainKit, post: true }), { ok: true, unchanged: true });
  assert.equal(n.sent.length, 2, 'nothing more sent');
});

test('an installed package refused this once is not advertised away', async () => {
  const { refreshHostedGames } = await import('../src/change-roles.js');
  const { hostedGameIdsOf } = await import('../src/apps.js');
  const n = node();
  const named = [...await hostedGameIdsOf(repo, ['nextblock']), RPS_ID].sort();
  // 2.0: the audit role already granted (auditGrantDue), so the only reason for an update would be the refused package
  n.state.save({ hostedGames: named, auditGranted: true, advertProtocols: (await import('../../arena-protocol/src/constants.js')).SUPPORTED_PROTOCOL_VERSIONS });
  writeFileSync(join(n.home, 'node.db.plugins', RPS_ID, 'package.json'), '{ half written');   // the check fails this once
  assert.deepEqual(await refreshHostedGames({ home: n.home, release: repo, state: n.state, chainKit: n.chainKit, post: true }), { ok: true, unchanged: true });
  assert.equal(n.sent.length, 0, 'no update dropping the game');
});

test('the auto update check asks for the games refresh when the node is up to date, under the update lock', async () => {
  const { runAutoUpdate, refreshGamesNow } = await import('../src/auto-update.js');
  const n = node({ installed: false });
  n.state.save({ release: { path: repo } });
  const asked = [], locks = [];
  const got = await refreshGamesNow({ home: n.home, refresh: async (o) => { asked.push(o); return { ok: true, unchanged: true }; },
    lock: async () => { locks.push('take'); return { release: () => locks.push('release') }; } });
  assert.deepEqual(got, { ok: true, unchanged: true });
  assert.deepEqual(asked, [{ home: n.home, release: repo, post: true }]);
  assert.deepEqual(locks, ['take', 'release']);
  assert.equal(await refreshGamesNow({ home: join(tmpdir(), 'no-such-home-' + process.pid) }), null, 'no installer home: left alone');
  // the loop: asked at each up-to-date check, said once per reason, not asked after a check that updated
  const logs = [], calls = [];
  const games = async () => { calls.push(1); return { ok: false, why: 'the wallet holds 0 sat' }; };
  await runAutoUpdate({ home: n.home, latest: null, log: (l) => logs.push(l), sleep: async () => {}, exit: (c) => c, rounds: 3, firstMs: 0,
    interactive: async () => null, resume: async () => null, once: async () => ({ ok: true, upToDate: true, version: 'x' }), games });
  assert.equal(calls.length, 3);
  assert.equal(logs.filter((l) => /games were not updated: the wallet holds 0 sat/.test(l)).length, 1, 'said once');
  calls.length = 0;
  await runAutoUpdate({ home: n.home, latest: null, log: () => {}, sleep: async () => {}, exit: (c) => c, rounds: 1, firstMs: 0,
    interactive: async () => null, resume: async () => null, once: async () => ({ ok: true, from: 'a', to: 'b' }), games });
  assert.equal(calls.length, 0, 'an update moved the node: its own refresh ran there');
});
