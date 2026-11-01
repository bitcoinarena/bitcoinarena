// A node reads these on its own, so each must be a host that answers, never a placeholder.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ARENA_ESPLORA } from '../src/chain-bridge.js';
import { ARENA_ELECTRUM } from '../src/chain-test.js';
import { FAUCET_URL } from '../src/wizard.js';

test('the built-in chain and faucet addresses are real public hosts', () => {
  for (const host of [new URL(ARENA_ESPLORA).hostname, ARENA_ELECTRUM.host, new URL(FAUCET_URL).hostname]) {
    assert.equal(host, 'tn4.bitcoinarena.io');
  }
});
