// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE DEVELOPER'S TWO COMMANDS (the page's guide): `arena-donor game-key <dir>` makes the Ed25519 key and never
// replaces it; `arena-donor sign <dir> <body.mjs>` signs the body a module exports as BODY, checks it as a node does, and
// writes the manifest whose id it prints.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeManifest, gameIdOf, manifestStands } from '../../arena-protocol/src/manifest.js';
import { verifyEd25519 } from '../../arena-node/src/ed25519.js';

const BIN = new URL('../bin/arena-donor.mjs', import.meta.url).pathname;
const run = (...a) => JSON.parse(execFileSync(process.execPath, [BIN, ...a], { encoding: 'utf8' }).trim().split('\n').pop());

test('game-key makes the key once; sign writes a manifest a node accepts, under the id it prints', () => {
  const dir = mkdtempSync(join(tmpdir(), 'game-dev-'));
  const key = run('game-key', dir);
  assert.match(key.gameDevPubkey, /^[0-9a-f]{64}$/);
  assert.equal(statSync(join(dir, 'game-dev.pkcs8')).mode & 0o777, 0o600);
  assert.notEqual(spawnSync(process.execPath, [BIN, 'game-key', dir]).status, 0, 'a key was replaced');
  const body = join(dir, 'body.mjs');
  const proto = new URL('../../arena-protocol/src/', import.meta.url).href;
  writeFileSync(body, `import { RESULT_TYPE, PAYOUT_RULE, NO_PARENT } from '${proto}manifest.js';
import { donationSetId } from '${proto}donation.js';
const H = (b) => new Uint8Array(32).fill(b);
export const BODY = { gameName: 'coin-count', version: 1, parentManifestId: NO_PARENT, resultType: RESULT_TYPE.REPLAY,
  cores: [{ hash: H(1), configs: [H(2)] }], runTicksMax: 600, roundPeriodMs: 0n, payoutRule: PAYOUT_RULE.RANK_CURVE,
  rankNumerator: 3, rankDenominator: 4, minScore: 1, clients: [H(3)],
  gameDonationSetId: donationSetId([{ recipientPk: new Uint8Array([2, ...H(7)]), label: 'dev', shareBps: 10000 }]) };
`);
  const signed = run('sign', dir, body);
  const m = decodeManifest(Buffer.from(readFileSync(signed.file, 'utf8').trim(), 'hex'));
  assert.equal(signed.gameId, Buffer.from(gameIdOf(m)).toString('hex'));
  assert.equal(Buffer.from(m.gameDevPubkey).toString('hex'), key.gameDevPubkey);
  assert.equal(manifestStands(m, { verify: verifyEd25519 }).ok, true);
  assert.equal(m.gameName, 'coin-count');
});
