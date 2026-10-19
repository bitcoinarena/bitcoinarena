// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A CUSTODY NODE'S GUARDIAN (ruling 3): its settings start the release's fedimintd in setup mode (ARENA_FOUNDING=1)
// at the node's public address /guardian, and its bond advertises it guardian-capable there - so it can be drawn when nodes found a
// federation (guardian-founding.js draws from the census's guardian-capable adverts). No custody, no Core or no binaries: none of it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { seatEnv, guardianSetupOf, guardianUrlOf } from '../src/state.js';
import { buildBond } from '../src/bond.js';
import { walletOf, payoutKeyOf } from '../src/wallet.js';
import { advertInTransaction } from '../../arena-protocol/src/census.js';
import { findFedimintd } from '../../arena-node/src/guardian.js';
import { fromHex } from '../../arena-protocol/src/hash.js';

test('the guardian endpoint: the public address as a websocket, /guardian', () => {
  assert.equal(guardianUrlOf('https://node.example.com'), 'wss://node.example.com/guardian');
  assert.equal(guardianUrlOf('http://46.22.17.30:8470/'), 'ws://46.22.17.30:8470/guardian');
  assert.equal(guardianUrlOf(null), null);
});

test('custody settings: founding, the release\'s fedimintd and fedimint-cli, the endpoint - only with custody, Core and the binaries', () => {
  const release = mkdtempSync(join(tmpdir(), 'rel-'));
  const s = { roles: ['verify', 'custody'], chain: { kind: 'core', url: 'http://127.0.0.1:48342/', cookiePath: '/c' }, reach: { mode: 'permanent', url: 'https://node.example.com' }, port: 8470 };
  assert.equal(guardianSetupOf(s, { release, platform: 'linux' }), null, 'no binaries in this release');
  mkdirSync(join(release, 'runtime', 'custody'), { recursive: true });
  for (const f of ['fedimintd', 'fedimint-cli', 'fedimintd.exe', 'fedimint-cli.exe']) writeFileSync(join(release, 'runtime', 'custody', f), '');
  const env = seatEnv(s, { home: '/h', release });
  for (const l of ['ARENA_FOUNDING=1', `ARENA_FEDIMINTD=${join(release, 'runtime', 'custody', 'fedimintd')}`, `ARENA_FEDIMINT_CLI=${join(release, 'runtime', 'custody', 'fedimint-cli')}`,
    'ARENA_GUARDIAN_ENDPOINT_8470=wss://node.example.com/guardian']) assert.ok(env.split('\n').includes(l), l);
  assert.equal(guardianSetupOf(s, { release, platform: 'win32' }).fedimintd, join(release, 'runtime', 'custody', 'fedimintd.exe'));
  assert.ok(!seatEnv({ ...s, roles: ['verify'] }, { home: '/h', release }).includes('ARENA_FOUNDING'), 'no custody');
  assert.ok(!seatEnv({ ...s, chain: { kind: 'electrum' }, bridgePort: 1 }, { home: '/h', release }).includes('ARENA_FOUNDING'), 'no Core');
});

test('the bond advertises a custody node guardian-capable at its endpoint; any other node not', () => {
  const seed = new Uint8Array(32).fill(8);
  const base = { wallet: walletOf(seed), nodeSecret: new Uint8Array(32).fill(9), coins: [{ txid: '44'.repeat(32), vout: 0, sats: 60000 }], tip: 156900,
    operatorId: 'op-c', roles: ['verify', 'custody'], endpoint: 'https://node.example.com', payoutPubkey: payoutKeyOf(seed) };
  const a = advertInTransaction(fromHex(buildBond({ ...base, guardianEndpoint: 'wss://node.example.com/guardian' }).bond.hex));
  assert.deepEqual([a.guardianCapable, a.guardianEndpoint], [true, 'wss://node.example.com/guardian']);
  const b = advertInTransaction(fromHex(buildBond(base).bond.hex));
  assert.deepEqual([b.guardianCapable, b.guardianEndpoint], [false, '']);
});

test('the node finds fedimintd.exe on Windows', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bin-'));
  writeFileSync(join(dir, 'fedimintd.exe'), '', { mode: 0o755 });
  assert.equal(findFedimintd(`/nope${delimiter}${dir}`, 'win32'), join(dir, 'fedimintd.exe'));
  assert.equal(findFedimintd(dir, 'linux'), null);
});
