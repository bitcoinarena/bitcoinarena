// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// WHAT THE OWNER PAGE CAN DO WITH EACH SERVICE (kanban #563): start / stop / restart and at boot, for a node set up by hand and an installed one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { controlsOf, installerIdOf } from '../src/service-control.js';

const toggle = (running, has = true) => ({ has: () => has, running: () => running, why: 'none here' });
const settings = { atBoot: (id) => id !== 'announcements' };

test('inside the node, on either kind: the guardian, the P2P tunnel and the announcements started, stopped and set at boot by the node', () => {
  for (const installed of [false, true]) {
    assert.deepEqual(controlsOf({ id: 'guardian', installed, toggles: { guardian: toggle(true) }, settings }), { controls: ['stop', 'restart'], atBoot: true, bootSettable: true });
    assert.deepEqual(controlsOf({ id: 'announcements', installed, toggles: { announcements: toggle(false) }, settings }), { controls: ['start'], atBoot: false, bootSettable: true });
  }
  assert.deepEqual(controlsOf({ id: 'p2p-tunnel', toggles: { 'p2p-tunnel': toggle(false, false) }, settings }).controls, [], 'no guardian: nothing to carry');
});

test('a node set up by hand: its chain, gateway, address and seat are started on its machine - said, no buttons', () => {
  for (const id of ['chain', 'gateway', 'address', 'node']) {
    const c = controlsOf({ id, installed: false });
    assert.deepEqual([c.controls, c.bootSettable], [[], false], id); assert.ok(c.why, id);
  }
});

test('an installed node: the installer\'s services started, stopped, restarted and set at boot; the address is its tunnel, the chain its Bitcoin Core; the seat restart only', () => {
  const ids = ['bitcoind-testnet4', 'lnd', 'gateway', 'node', 'tunnel'];
  const boot = { atBoot: true, settable: true };
  assert.deepEqual(controlsOf({ id: 'gateway', installed: true, installedIds: ids, boot }), { controls: ['start', 'stop', 'restart'], atBoot: true, bootSettable: true });
  assert.deepEqual(installerIdOf('address', ids), 'tunnel');
  assert.deepEqual(installerIdOf('chain', ids), 'bitcoind-testnet4');
  assert.deepEqual(controlsOf({ id: 'address', installed: true, installedIds: ids, boot }).controls, ['start', 'stop', 'restart'], 'its state not known: all three');
  assert.deepEqual(controlsOf({ id: 'gateway', installed: true, installedIds: ids, boot, running: false }).controls, ['start'], 'stopped: start');
  assert.deepEqual(controlsOf({ id: 'lnd', installed: true, installedIds: ids, boot, running: true }).controls, ['stop', 'restart'], 'running: stop or restart');
  assert.deepEqual(controlsOf({ id: 'node', installed: true, installedIds: ids, boot }).controls, ['restart']);
  assert.deepEqual(controlsOf({ id: 'chain', installed: true, installedIds: ['node'] }).controls, [], 'an Electrum node without Bitcoin Core here: not its service');
});
