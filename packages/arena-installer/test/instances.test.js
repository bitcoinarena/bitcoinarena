// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// HOW MANY NODES ON THIS MACHINE (kanban #596): 1 by default, at most 20, more than one on testnet4 only; from more than 5 Fedimint on a
// RAM disk unless declined; from 10 the note that they found their own federation; each further node its own home and ports.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { instancesChoice, instancesNote, instancesOf, ramAnswer, RAM_QUESTION, nextInstance, prefillFrom } from '../src/instances.js';
import { nodeState } from '../src/state.js';

test('the count: 1 by default, 1..20, more than one on testnet4 only; the RAM disk from more than 5, yes unless declined', () => {
  assert.deepEqual(instancesChoice({}), { ok: true, count: 1, ram: false });
  assert.deepEqual(instancesChoice({ count: 5, ram: true }), { ok: true, count: 5, ram: false }, '5 nodes: no RAM disk offered');
  assert.deepEqual(instancesChoice({ count: 6 }), { ok: true, count: 6, ram: true }, 'more than 5: yes by default');
  assert.deepEqual(instancesChoice({ count: '12', ram: false }), { ok: true, count: 12, ram: false }, 'declined');
  for (const bad of [0, 21, 2.5, 'x']) assert.equal(instancesChoice({ count: bad }).ok, false, String(bad));
  assert.match(instancesChoice({ count: 3, network: 'mainnet' }).why, /testnet4 only/);
  assert.equal(instancesChoice({ count: 1, network: 'mainnet' }).ok, true, 'one node anywhere');
});

test('the note: the bonds in all, and from 10 that they found their own federation', () => {
  assert.equal(instancesNote(1), '');
  assert.equal(instancesNote(3), '3 nodes: each its own seed, owner key and bond (150,000 sat in all).');
  assert.equal(instancesNote(10), '10 nodes: each its own seed, owner key and bond (500,000 sat in all). 10 or more nodes found their own federation.');
});

test('the nodes: the first in its home as before, then b, c ... in <home>-b, -c, ports 100 apart; the console question', () => {
  assert.deepEqual(instancesOf(3, '/h/.arena-node'), [{ instance: '', home: '/h/.arena-node', portOffset: 0 },
    { instance: 'b', home: '/h/.arena-node-b', portOffset: 100 }, { instance: 'c', home: '/h/.arena-node-c', portOffset: 200 }]);
  assert.equal(RAM_QUESTION, 'Enable RAM disk for Fedimint? [Y/n] ');
  assert.deepEqual(['', 'y', 'Yes', 'n', 'No', ' no'].map(ramAnswer), [true, true, true, false, false, false]);
});

test('the next node after each one, none after the last; a further node takes over the first one\'s Bitcoin source, roles and apps', () => {
  assert.deepEqual(nextInstance(3, '/h/n', '/h/n'), { instance: 'b', home: '/h/n-b', portOffset: 100, index: 2, count: 3 });
  assert.deepEqual(nextInstance(3, '/h/n', '/h/n-b'), { instance: 'c', home: '/h/n-c', portOffset: 200, index: 3, count: 3 });
  assert.equal(nextInstance(3, '/h/n', '/h/n-c'), null, 'the last one');
  assert.equal(nextInstance(1, '/h/n', '/h/n'), null, 'one node');
  const root = mkdtempSync(join(tmpdir(), 'arena-inst-'));
  try {
    const base = nodeState(join(root, 'n')), b = nodeState(join(root, 'n-b'));
    base.writeSecret('bitcoind.auth', 'u:p\n');
    base.save({ instances: { count: 3, ram: false }, chain: { kind: 'core', url: 'http://127.0.0.1:48332/', cookiePath: base.path('bitcoind.auth') }, chainTest: { height: 157422 },
      roles: ['verify', 'settlement'], apps: ['nextblock'], owner: { npub: 'mine' }, seedShown: true, done: { chain: 1, roles: 2, apps: 3, seed: 4, owner: 5 } });
    const r = prefillFrom(base, b, 42);
    assert.deepEqual(r, { ok: true, took: ['chain', 'roles', 'apps'] });
    const s = b.read();
    assert.deepEqual([s.roles, s.apps, s.done, s.instances], [['verify', 'settlement'], ['nextblock'], { chain: 42, roles: 42, apps: 42 }, { count: 3, ram: false }]);
    assert.equal(s.chain.cookiePath, b.path('bitcoind.auth'), 'its own copy of the Core login');
    assert.equal(readFileSync(b.path('bitcoind.auth'), 'utf8'), 'u:p\n');
    assert.equal(s.owner, undefined, 'the owner key stays its own'); assert.equal(s.done.seed, undefined, 'the seed stays its own');
    assert.equal(prefillFrom(base, b).ok, false, 'a node that began its steps is left as it is');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
