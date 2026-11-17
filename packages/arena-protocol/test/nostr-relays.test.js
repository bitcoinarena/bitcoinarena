// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE GAME'S RELAY UNDER ITS NEW NAME (kanban #2916): relay.bitcoin-arena.io is an alias of relay.bitcoinarena.io - one relay.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ARENA_RELAY, ARENA_RELAY_OLD, canonicalRelay, relaySet } from '../src/nostr-relays.js';
import { zapRequestTemplate } from '../src/zap.js';

test('the old host of the game\'s relay is read as the new one; every other relay is left as it is', () => {
  assert.equal(ARENA_RELAY, 'wss://relay.bitcoinarena.io');
  assert.equal(canonicalRelay(ARENA_RELAY_OLD), ARENA_RELAY);
  assert.equal(canonicalRelay('wss://RELAY.Bitcoin-Arena.io/'), 'wss://relay.bitcoinarena.io/', 'path and case of the scheme kept');
  assert.equal(canonicalRelay('ws://relay.bitcoin-arena.io:7777'), 'ws://relay.bitcoinarena.io:7777');
  assert.equal(canonicalRelay(ARENA_RELAY), ARENA_RELAY);
  for (const other of ['wss://nos.lol', 'wss://relay.bitcoin-arena.io.evil.example', 'wss://xrelay.bitcoin-arena.io', 'https://relay.bitcoin-arena.io'])
    assert.equal(canonicalRelay(other), other, other);
});

test('a relay list names the game\'s relay once, in the place it was first named', () => {
  assert.deepEqual(relaySet(['wss://nos.lol', ARENA_RELAY_OLD, 'wss://nos.lol', ARENA_RELAY]), ['wss://nos.lol', ARENA_RELAY]);
  assert.deepEqual(relaySet([]), []);
});

test('a zap request naming both hosts of the game\'s relay names it once', () => {
  const t = zapRequestTemplate({ recipient: 'a'.repeat(64), amountMsat: 1000n, relays: [ARENA_RELAY_OLD, ARENA_RELAY, 'wss://nos.lol'] });
  assert.deepEqual(t.tags[0], ['relays', ARENA_RELAY, 'wss://nos.lol']);
});
