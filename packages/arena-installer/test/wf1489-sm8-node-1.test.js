// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 state machine audit round 8 (node): the update's games refresh (update.js moveNode -> refreshHostedGames, run by the updater
// process after KEPT) reads the node's roles from state.json BEFORE it loads the new release's apps, and builds its advertisement update with
// those roles inside onchainAction's build(s2) - not with s2's. A roles change the owner page finishes in the seat process meanwhile (an
// on-chain action DONE: state.json roles = the new ones) is then advertised away again by the games update, which is broadcast after it and so
// is the one the census reads (newestUpdates: the later block / later position wins). state.json says the new roles; the chain the old.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { changeRolesOnNode, refreshHostedGames } from '../src/change-roles.js';
import { nodeState } from '../src/state.js';
import { readAdvertUpdate } from '../../arena-protocol/src/advert-update.js';
import { parseTransaction } from '../../arena-protocol/src/tx.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';

test('wf1489-sm8-node-1: a roles change finished while the update refreshes the games is not advertised away by the games update', async () => {
  const home = mkdtempSync(join(tmpdir(), 'sm8-node-1-'));
  const real = nodeState(home);
  writeFileSync(join(home, 'seed.hex'), '11'.repeat(32));
  const db = new DatabaseSync(join(home, 'node.db'));
  db.exec('CREATE TABLE identity (one INTEGER PRIMARY KEY, secret BLOB)'); db.prepare('INSERT INTO identity VALUES (0, ?)').run(new Uint8Array(32).fill(6)); db.close();
  real.save({ roles: ['verify', 'settlement'], apps: ['nextblock'], chain: { kind: 'core' }, owner: { pubkey: 'ab'.repeat(32) },
    reach: { mode: 'permanent', url: 'https://node.example.com' }, bond: { txid: '77'.repeat(32), vout: 0, sats: '50000', maturity: 157057 } });
  const sent = [];
  let coin = 0;
  const chainKit = { coinsOf: async () => ({ tip: 157000, coins: [{ txid: (++coin).toString(16).padStart(2, '0').repeat(32), vout: 1, sats: 20000 }] }),
    broadcast: async (_c, hex) => { sent.push(hex); return toHex(Uint8Array.from(parseTransaction(fromHex(hex)).txid).reverse()); } };

  // the updater process's view of state.json: the same file; the owner page's roles change (the seat process) lands right after the
  // games refresh read its state (its second read: the first is resumeOpen's), while it loads the new release's apps
  let reads = 0, rolesDone = null;
  const updaterState = Object.create(real);
  updaterState.read = () => {
    const s = real.read();
    if (++reads === 2) rolesDone = changeRolesOnNode({ home, release: home, state: real, roles: ['settlement'], post: true, chainKit });
    return s;
  };
  const repo = join(import.meta.dirname, '..', '..', '..');
  const games = await refreshHostedGames({ home, release: repo, state: updaterState, chainKit, post: true });
  const roles = await rolesDone;
  assert.equal(roles.ok, true, roles.why);
  assert.equal(games.ok, true, games.why);
  const st = real.read();
  // the order the two actions took: the roles action closed before the games action was built (seq), so the games one is sent last
  assert.ok(st.onchain.last.roles.closedMs <= st.onchain.last.games.atMs, 'the roles change finished before the games update was built');
  const rolesTx = readAdvertUpdate(fromHex(sent[1]), { network: 'testnet4' });
  const gamesTx = readAdvertUpdate(fromHex(sent[3]), { network: 'testnet4' });
  console.log(`  MEASURED: state.json roles ${JSON.stringify(st.roles)}; roles update advertises ${JSON.stringify([...rolesTx.advert.roles].sort())}; the games update sent after it advertises ${JSON.stringify([...gamesTx.advert.roles].sort())}`);
  assert.deepEqual([...rolesTx.advert.roles].sort(), ['relay', 'settlement']);
  // THE INVARIANT: the advertisement the census will read (the one sent last) says what state.json says the node advertises
  assert.deepEqual([...gamesTx.advert.roles].sort(), ['relay', 'settlement'], 'the games update re-advertised the roles from before the owner\'s change');
});
