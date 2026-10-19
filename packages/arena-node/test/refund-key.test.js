// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE PLAYER CHECKS THE REFUND KEY OUTSIDE THE PAGE (§24, v4.6.2, F2).
//
// `tools/refund-key.mjs` is run as its own process, from a seed and a round id
// and nothing else, and has to print exactly the key and fingerprint the page
// enters the player under. If the two ever disagreed the fingerprint on screen
// would be a promise about a key the player's own check cannot find.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { toHex } from '../../arena-protocol/src/hash.js';
import { refundKeyOf } from '../../arena-protocol/src/stake-lock.js';
import { playerFor, entryFor } from '../../arena-client/src/join.js';
import { feldmanGroup } from '../src/curve.js';

const TOOL = fileURLToPath(new URL('../tools/refund-key.mjs', import.meta.url));
const run = (...args) => execFileSync(process.execPath, [TOOL, ...args], { encoding: 'utf8' });
const lineOf = (out, name) => (out.match(new RegExp(`^${name}\\s+(\\S+)$`, 'm')) || [])[1];

test('the offline tool names the key and fingerprint the page enters the player under', () => {
  const seed = new Uint8Array(32).fill(0x5e);
  const round = { id: new Uint8Array(32).fill(0x11), stakeMsat: 0n };
  const page = playerFor(round, { seed, curve: feldmanGroup });
  const signerNode = entryFor(round, { seed, curve: feldmanGroup, random: (n) => new Uint8Array(n).fill(3) });

  const out = run(toHex(seed), toHex(round.id));
  assert.equal(lineOf(out, 'player key'), toHex(signerNode.playerPubkey));
  assert.equal(lineOf(out, 'refund key'), toHex(refundKeyOf(signerNode.playerPubkey)));
  assert.equal(lineOf(out, 'fingerprint'), page.fingerprint);

  // another round, another key - the tool agrees with the page there too
  const next = run(toHex(seed), 'ab'.repeat(32));
  assert.notEqual(lineOf(next, 'player key'), toHex(signerNode.playerPubkey));
});

test('the offline tool refuses what is not a seed and a round id', () => {
  assert.throws(() => run('zz', 'ab'.repeat(32)), (e) => e.status === 2 && /usage/.test(String(e.stderr)));
});
