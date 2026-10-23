// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE MACHINE A NODE RUNS ON (kanban #597): one id for every node of a host, never its name; the load and cores; null on mainnet.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hostname } from 'node:os';
import { machineOf, machineIdOf } from '../src/machine.js';

test('a testnet4 seat names its machine by a hash of the host, with the load and cores; a mainnet seat names none', () => {
  const m = machineOf({ chain: 'bitcoin-testnet4', env: { ARENA_MACHINE_NAME: 'test host' } });
  assert.equal(m.id, machineIdOf(hostname()));
  assert.match(m.id, /^[0-9a-f]{16}$/);
  assert.notEqual(m.id, machineIdOf(hostname() + 'x'));
  assert.equal(JSON.stringify(m).includes(hostname()), false, 'the host name left the machine');
  assert.equal(m.name, 'test host');
  assert.equal(m.load.length, 3);
  assert.ok(m.cores >= 1);
  assert.equal(machineOf({ chain: null, env: {} }).name, null);
  for (const chain of ['mainnet', 'bitcoin-mainnet', 'bitcoin', 'main']) assert.equal(machineOf({ chain, env: {} }), null, chain);
});
