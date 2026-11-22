// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #3068: an installer node updated before it bonded kept its install-time game list, so the bond it posted later advertised old
// games and the node was never drawn for the new versions. refreshHostedGames now writes the release's games into state even with no bond.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nodeState } from '../src/state.js';

test('#3068: with no bond yet, the release\'s hosted games are kept in state for the bond to name; nothing is sent', async () => {
  const { refreshHostedGames } = await import('../src/change-roles.js');
  const { hostedGameIdsOf } = await import('../src/apps.js');
  const repo = join(import.meta.dirname, '..', '..', '..');
  const home = mkdtempSync(join(tmpdir(), 'hosted-3068-'));
  writeFileSync(join(home, 'seed.hex'), '11'.repeat(32));
  const state = nodeState(home);
  const old = ['aa'.repeat(32)];   // the install-time list
  state.save({ roles: ['verify'], chain: { kind: 'core' }, apps: ['nextblock', 'rock-paper-scissors'], hostedGames: old });
  const sent = [];
  const chainKit = { coinsOf: async () => ({ tip: 1, coins: [] }), broadcast: async (_c, hex) => { sent.push(hex); return 'x'; } };
  const r = await refreshHostedGames({ home, release: repo, state, chainKit, post: true });
  assert.equal(r.ok, false); assert.match(r.why, /no bond yet/);
  const want = await hostedGameIdsOf(repo, ['nextblock', 'rock-paper-scissors']);
  assert.ok(want.length > 1);
  assert.deepEqual(state.read().hostedGames, want, 'the bond posted later names the release\'s games');
  assert.equal(sent.length, 0, 'nothing on chain without a bond');
});
