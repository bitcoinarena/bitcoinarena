// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE DEVNET'S GAME TEMPLATE (kanban #362, PLATFORM-RESEARCH item 15; tools/devnet-template): its core is a core a node can
// run - its state hash a true SHA-256, its runs the same integers twice - and `devnet.mjs new-game` turns it into a game of the
// developer's own: keys made by the dev client, the manifest signed, and the game hosted as a node hosts it (signature, core
// hash, the core loaded in its sandbox, config, donation set). Run again, it keeps the developer's keys and files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CORE } from '../tools/devnet-template/core.js';

const TOOL = new URL('../tools/devnet.mjs', import.meta.url).pathname;
const run = (args, env = {}) => new Promise((done) => execFile(process.execPath, [TOOL, ...args], { timeout: 110000, env: { ...process.env, ...env } },
  (err, stdout, stderr) => done({ code: err ? err.code : 0, stdout, stderr })));

test('the template core: a SHA-256 state hash, the same run twice, DELIVERED once it has run its length', () => {
  const play = (seed) => {
    const st = CORE.start(seed, {}, { runTicks: 50 });
    for (let t = 0; t < 50; t++) CORE.step(st, [(t * 7 + 3) % 10, 0, 0, 0, 0]);
    return st;
  };
  const a = play(12345), b = play(12345);
  assert.equal(CORE.stateHash(a), CORE.stateHash(b));
  assert.deepEqual(CORE.result(a), { outcome: 'DELIVERED', score: a.sum, heat: 0 });
  assert.notEqual(CORE.stateHash(play(12346)), CORE.stateHash(a), 'the seed decides which ticks are gold');
  const bytes = Buffer.alloc(16);
  [a.seed, a.sum, a.ticks, a.length].forEach((v, i) => bytes.writeInt32BE(v | 0, 4 * i));
  assert.equal(CORE.stateHash(a), createHash('sha256').update(bytes).digest('hex'));
  const short = CORE.start(1, {}, { runTicks: 50 });
  CORE.step(short, [9, 0, 0, 0, 0]);
  assert.equal(CORE.result(short).outcome, null, 'still running');
  assert.equal(CORE.INPUT_WORDS, 5);
  assert.ok(CORE.runTicksFits(600) && !CORE.runTicksFits(601));
});

test('new-game: the template copied, keys made, the manifest signed, the game hosted as a node hosts it; run again it keeps the keys', async () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'devnet-new-game-')), 'my-game');
  const env = { DEVNET_DIR: join(dir, '..', 'devnet-data') };
  const first = await run(['new-game', dir, 'my-game'], env);
  assert.equal(first.code, 0, first.stderr.slice(-600));
  const said = JSON.parse(first.stdout.trim().split('\n').pop());
  assert.equal(said.name, 'my-game');
  assert.match(said.gameId, /^[0-9a-f]{64}$/);
  assert.equal(said.hostedAs, true);
  assert.equal(said.core, createHash('sha256').update(readFileSync(join(dir, 'core.js'))).digest('hex'));
  assert.match(readFileSync(join(dir, 'core.js'), 'utf8'), /name: 'my-game'/);
  for (const f of ['body.mjs', 'game.js']) assert.doesNotMatch(readFileSync(join(dir, f), 'utf8'), /__(NAME|TITLE|PROTOCOL)__/);
  assert.ok(existsSync(join(dir, 'dev', 'my-game-manifest.hex')));
  assert.equal(statSync(join(dir, 'dev', 'game-dev.pkcs8')).mode & 0o077, 0, 'the developer key is the developer\'s alone');
  const key = readFileSync(join(dir, 'dev', 'game-dev.pkcs8'));
  const again = await run(['new-game', dir, 'my-game'], env);
  assert.equal(again.code, 0, again.stderr.slice(-600));
  assert.equal(JSON.parse(again.stdout.trim().split('\n').pop()).gameId, said.gameId, 'the same files and key sign the same game');
  assert.deepEqual(readFileSync(join(dir, 'dev', 'game-dev.pkcs8')), key);
  const bad = await run(['new-game', dir, 'My Game'], env);
  assert.notEqual(bad.code, 0);
  assert.match(bad.stderr, /a game name is lower-case/);
});
