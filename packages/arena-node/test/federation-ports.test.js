// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// EVERY NODE SERVES EVERY FEDERATION (RULED 2026-10-13): the lock port is a router - its home federation
// as before, and another federation's own port, joined on first need with the invite its signed record carries.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { federationPorts } from '../src/stake-lock-port.js';

const A = 'aa'.repeat(32); const B = 'bb'.repeat(32);
const portOf = (fid) => ({ id: fid, async guardians() { return { federationId: Uint8Array.from(Buffer.from(fid, 'hex')), keys: [], threshold: 5 }; },
  async gateways() { return { federationId: Uint8Array.from(Buffer.from(fid, 'hex')), gateways: [] }; }, close() {} });

test('the home federation is the home port; another is joined once with its record\'s invite, then served by its own port', async () => {
  const joined = []; const dirs = new Set();
  const r = federationPorts({ home: portOf(A), bin: 'lock', baseDir: '/x/federations', inviteOf: (f) => (f === B ? 'fed11-b' : null),
    exists: (p) => dirs.has(p), makePort: ({ dataDir }) => ({ ...portOf(B), dataDir }),
    runJoin: async (args) => { joined.push(args); dirs.add(`${args[3]}/client.db`); return { mode: 'join', federation_id: B }; } });
  assert.equal(typeof r.gateways, 'function', 'the router answers as the home port');
  assert.equal((await r.forFederation(A)).id, A);
  const [b1, b2] = await Promise.all([r.forFederation(B), r.forFederation(B)]);
  assert.equal(b1.dataDir, `/x/federations/${B}`);
  assert.equal(b1, b2);
  assert.equal(joined.length, 1, 'joined once');
  assert.deepEqual(joined[0], ['--mode', 'join', '--data-dir', `/x/federations/${B}`, '--invite', 'fed11-b']);
});

test('no record, a failed join, or an invite of another federation: null, with the reason', async () => {
  const C = 'cc'.repeat(32);
  const r = federationPorts({ home: portOf(A), bin: 'lock', baseDir: '/x', inviteOf: (f) => (f === B ? 'fed11-b' : f === C ? 'fed11-c' : null), exists: () => false,
    runJoin: async (args) => { if (args[5] === 'fed11-b') return { mode: 'join', federation_id: C }; throw new Error('guardians unreachable'); } });
  assert.equal(await r.forFederation('dd'.repeat(32)), null);
  assert.match(r.whyNot('dd'.repeat(32)), /no signed record/);
  assert.equal(await r.forFederation(B), null);
  assert.match(r.whyNot(B), /that invite joined cccccccc/);
  assert.equal(await r.forFederation(C), null);
  assert.match(r.whyNot(C), /could not join .*guardians unreachable/);
});
