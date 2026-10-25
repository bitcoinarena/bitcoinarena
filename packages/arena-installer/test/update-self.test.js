// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE APP'S OWN RELEASE OVER AN OLDER NODE (the owner's playtest 2026-10-25: "When I execute 2.9.2 it doesn't update the node, it just
// starts the 1.9.1"): arena-install --update-self moves the node to the release it runs from only when that is newer; a node already on
// it, or on a newer one, stays; with no node installed it says so. (The move itself is updateNode, update.test.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const BIN = resolve(dirname(fileURLToPath(import.meta.url)), '../bin/arena-install.mjs');
const RELEASE = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const run = (home) => { try { return execFileSync(process.execPath, [BIN, '--update-self', '--home', home], { encoding: 'utf8', timeout: 60000 }).trim(); } catch (e) { return String(e.stdout || '').trim(); } };

test('--update-self: no node here, the node already on this release, a node on a newer one - nothing moved', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'arena-updself-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home'); mkdirSync(home);
  writeFileSync(join(home, 'state.json'), '{}');
  assert.equal(run(home), 'Not updated: no node is installed here');
  writeFileSync(join(home, 'state.json'), JSON.stringify({ service: { port: 1 }, release: { path: RELEASE } }));
  assert.match(run(home), /^Up to date/, 'the node runs this very release');
  const newer = join(root, 'bitcoin-arena-node-9999.1.0'); mkdirSync(newer); writeFileSync(join(newer, 'VERSION'), '9999.1.0\n');
  writeFileSync(join(home, 'state.json'), JSON.stringify({ service: { port: 1 }, release: { path: newer } }));
  assert.match(run(home), /^Up to date: the node runs 9999\.1\.0/, 'a node on a newer release is never moved back');
});
