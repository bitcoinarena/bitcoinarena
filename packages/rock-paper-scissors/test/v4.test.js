// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// VERSION 4 (kanban #564, #523): its core decides every combination of moves as the core of versions 1 to 3 does; it carries no names,
// ticket numbers or old project names; and the signed manifest (once tools/sign-manifest-v4.mjs has written it) names that core and the
// version-4 client by their hashes, stands on version 3 as its parent, and its registration loads the same files.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { DECIDE as V1 } from '../plugin/decide.js';
import { DECIDE as V4 } from '../plugin/decide-v4.js';
import { FORBIDDEN } from '../tools/build-client-v4.mjs';

const sha = (u) => createHash('sha256').update(readFileSync(u)).digest('hex');
const GENERATED = new URL('../plugin/rock-paper-scissors-v4.js', import.meta.url);

test('the core of version 4 decides every combination of 1 to 4 players as version 1 does, and refuses the same moves', () => {
  let n = 0;
  for (let players = 1; players <= 4; players++) {
    for (let code = 0; code < 3 ** players; code++) {
      const moves = Array.from({ length: players }, (_, i) => ({ key: `p${i}`, move: Math.floor(code / 3 ** i) % 3 }));
      assert.deepEqual(V4.decide(moves), V1.decide(moves)); n++;
    }
  }
  assert.equal(n, 3 + 9 + 27 + 81);
  assert.equal(V4.name, V1.name, 'the same adapter name: a round names the core by its hash');
  for (const bad of [[{ key: 'a', move: 3 }], [{ key: 'a', move: 1.5 }], [{ key: 'a', move: -1 }]]) assert.throws(() => V4.decide(bad), /0, 1 or 2/);
});

test('the core of version 4 carries no names, ticket numbers or old project names; only its comment differs from version 1', () => {
  const v4 = readFileSync(new URL('../plugin/decide-v4.js', import.meta.url), 'utf8');
  const v1 = readFileSync(new URL('../plugin/decide.js', import.meta.url), 'utf8');
  assert.deepEqual(v4.split('\n').filter((l) => FORBIDDEN.test(l)), []);
  const code = (s) => s.slice(s.indexOf('export const MOVES'));
  assert.equal(code(v4), code(v1));
});

test('the signed manifest names version 4\'s core and client by their hashes, on version 3 (when it is generated)', { skip: !existsSync(GENERATED) && 'plugin/rock-paper-scissors-v4.js not signed yet' }, async () => {
  const { MANIFEST_V4, GAME_ID_V4, GAME, RPS_DECIDE_V4_CORE, RPS_ROUND_FIELDS_V4 } = await import('../plugin/rock-paper-scissors-v4.js');
  const { MANIFEST_V3, GAME_ID_V3 } = await import('../plugin/rock-paper-scissors-v3.js');
  const { manifestStands } = await import('../../arena-protocol/src/manifest.js');
  const { verifyEd25519 } = await import('../../arena-node/src/ed25519.js');
  const hex = (b) => Buffer.from(b).toString('hex');
  assert.equal(MANIFEST_V4.version, 4);
  assert.equal(hex(MANIFEST_V4.parentManifestId), hex(GAME_ID_V3));
  assert.equal(hex(MANIFEST_V4.cores[0].hash), sha(new URL('../plugin/decide-v4.js', import.meta.url)));
  assert.deepEqual(MANIFEST_V4.clients.map(hex), [sha(new URL('../client/index-v4.html', import.meta.url))]);
  assert.equal(MANIFEST_V4.requiredProtocolVersion, MANIFEST_V3.requiredProtocolVersion);
  assert.equal(manifestStands(MANIFEST_V4, { verify: verifyEd25519, parentOf: (id) => (hex(id) === hex(GAME_ID_V3) ? MANIFEST_V3 : null) }).ok, true);
  assert.equal(RPS_DECIDE_V4_CORE.hash, hex(MANIFEST_V4.cores[0].hash), 'the registration loads the file the manifest pins');
  assert.deepEqual([...GAME.cores.keys()], [RPS_DECIDE_V4_CORE.hash]);
  assert.equal(hex(GAME.gameId), hex(GAME_ID_V4)); assert.equal(hex(RPS_ROUND_FIELDS_V4.simCoreHash), RPS_DECIDE_V4_CORE.hash);
  assert.deepEqual(readFileSync(GENERATED, 'utf8').split('\n').filter((l) => FORBIDDEN.test(l)), []);
});
