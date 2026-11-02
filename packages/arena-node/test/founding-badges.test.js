// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE FOUNDING TESTER BADGE (kanban #926 item 8): finished a round AND gave feedback, once per key.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { dueKeys, readFeedback, FOUNDING_BADGE } from '../tools/founding-badges.mjs';
import { buildAwardEvent } from '../src/nostr-badges.js';
import { feedbackDecide } from '../src/faucet.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const key = (n) => toHex(schnorr.getPublicKey(new Uint8Array(32).fill(n)));
const [a, b, c] = [1, 2, 3].map(key);
const boards = [{ rows: [{ player: a, rounds: 3 }, { player: c, rounds: 0 }] }, { rows: [{ player: b, rounds: 1 }] }];

test('both conditions, once: feedback without a round waits, a round without feedback gets nothing, a holder gets no second', () => {
  const feedback = [{ player: a }, { player: a }, { player: c }, { player: 'zz' }];
  assert.deepEqual(dueKeys({ feedback, boards }), [a]);
  assert.deepEqual(dueKeys({ feedback, boards, awarded: { [a]: { event: 'x' } } }), []);
});

test('a line of the file that does not read is left out', () => {
  assert.deepEqual(readFeedback(`{"player":"${a}"}\nnot json\n`).map((x) => x.player), [a]);
});

test('the award is a NIP-58 kind 8 naming the definition and the player', () => {
  const secret = new Uint8Array(32).fill(9);
  const e = buildAwardEvent({ award: { d: FOUNDING_BADGE.d, player: a, game: 'bitcoin-arena', evidence: null }, secret, atMs: 1_800_000_000_000, catalogue: [FOUNDING_BADGE] });
  assert.equal(e.kind, 8);
  assert.deepEqual(e.tags[0], ['a', `30009:${toHex(schnorr.getPublicKey(secret))}:arena-founding-tester`]);
  assert.deepEqual(e.tags[1], ['p', a]);
});

test('feedback keeps a public key apart from the words, and only a well-formed one', () => {
  const said = feedbackDecide({ text: 'the truck is slow', player: a, build: '525', game: 'nextblock' }, []);
  assert.equal(said.player, a);
  assert.ok(!said.text.includes(a), 'never in the report');
  assert.equal(feedbackDecide({ text: 'the truck is slow', player: 'nope' }, []).player, null);
  assert.equal(feedbackDecide({ text: 'the truck is slow' }, []).player, null);
});
