// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// AN UPDATE KEEPS THE CHAIN BRIDGE ON THE PORT THE NODE CALLS (kanban #734, measured 2026-10-29 in the Linux VM: the machine's third node,
// port_offset 200, updated 2026.1.9.12 -> 2026.1.9.13 - the bridge unit was written for 8471, arena.conf still named 8671, and nothing
// answered the node's chain calls).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bridgePortOf } from '../src/update.js';

const conf = (url) => () => `port=8670\nroles=verify,settlement\n${url ? `bitcoind_url=${url}\n` : ''}port_offset=200\n`;

test('the bridge port is the one arena.conf sends the node to', () => {
  assert.equal(bridgePortOf('/h', {}, { read: conf('http://127.0.0.1:8671/'), offset: 200 }), 8671);
  assert.equal(bridgePortOf('/h', { bridgePort: 9999 }, { read: conf('http://127.0.0.1:8671/'), offset: 0 }), 8671, 'the settings win over the state');
});

test('without a loopback bitcoind_url: the state, else 8471 plus the node\'s port offset', () => {
  assert.equal(bridgePortOf('/h', { bridgePort: 8571 }, { read: conf(null), offset: 200 }), 8571);
  assert.equal(bridgePortOf('/h', {}, { read: conf(null), offset: 200 }), 8671, 'the third node: 8471 + 200');
  assert.equal(bridgePortOf('/h', {}, { read: conf('http://10.0.2.2:48342/'), offset: 0 }), 8471, 'a Bitcoin Core elsewhere is not the bridge');
  assert.equal(bridgePortOf('/h', {}, { read: () => { throw new Error('none'); }, offset: 100 }), 8571, 'no settings file');
});
