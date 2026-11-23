// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #2842 (finding wf1489-r25-faucet-1, bypass of #2087; ruling 2026-11-16 (a)): the test bot stakes only on a seat's verified stake lock of a
// non-bot entry. A stranger's self-signed tap still marks the want row (a hint), and the bot does not stake on it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { schnorr } from '@noble/curves/secp256k1.js';
import { opponentWant, opponentWants } from '../src/faucet.js';
import { botMayEnter, BOT_LEAD_MS } from '../src/opponent-trigger.js';
import { presenceId } from '../../arena-protocol/src/match.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';

test('#2842: a stranger\'s self-made tap wakes the bot at most - with no entry and no verified lock it does not stake', () => {
  const round = toHex(new Uint8Array(randomBytes(32)));
  const secret = new Uint8Array(randomBytes(32)), key = schnorr.getPublicKey(secret);
  const tap = { key: toHex(key), sig: toHex(schnorr.sign(presenceId({ roundId: fromHex(round), identityKey: key }), secret)) };
  const wants = new Map();
  opponentWant(wants, round, 1000, tap, '203.0.113.7');
  assert.equal(opponentWants(wants, 1000)[0].tapped, true, 'the tap is still a hint on the row');
  const d = botMayEnter({ entries: [], locks: new Map(), closeMs: 60000, nowMs: 1000 });
  assert.equal(d.go, false); assert.match(d.why, /no entry/);
  // a lockless entry (strangers post those): no verified stake lock, no stake
  assert.equal(botMayEnter({ entries: [{ entry: 'e1', player: 'p1' }], locks: new Map(), closeMs: 60000, nowMs: 1000 }).go, false);
});

test('#2842: a verified stake lock of one non-bot player with at least 12 s of lead sends the bot; less lead is not a bot round', () => {
  const entries = [{ entry: 'e1', player: 'p1' }];
  assert.equal(BOT_LEAD_MS, 12000);
  assert.equal(botMayEnter({ entries, locks: new Map([['e1', 40000]]), closeMs: 52000, nowMs: 41000 }).go, true);
  const late = botMayEnter({ entries, locks: new Map([['e1', 45000]]), closeMs: 52000, nowMs: 45500 });
  assert.equal(late.go, false); assert.match(late.why, /not a bot round/);
  assert.equal(botMayEnter({ entries, locks: new Map([['e1', 40000]]), closeMs: 52000, nowMs: 49000 }).go, false, 'too little left');
  assert.equal(botMayEnter({ entries: [...entries, { entry: 'e2', player: 'p2' }], locks: new Map([['e1', 1], ['e2', 1]]), closeMs: 52000, nowMs: 1000 }).go, false, 'a full table');
  assert.equal(botMayEnter({ entries: [{ entry: 'b', player: 'bot' }], locks: new Map([['b', 1]]), botKeys: new Set(['bot']), closeMs: 52000, nowMs: 1000 }).go, false, 'its own entry');
});

test('#2842: the bot reads the decision, never the tap, before it stakes', () => {
  const src = readFileSync(new URL('../tools/rps-opponent.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /if \(w\.tapped\) \{ go\(/, 'a tap sends the bot straight to go()');
  assert.match(src, /botMayEnter\(/);
  assert.match(src, /\/order-locks\?entry=/);
});
