// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE DAILY'S PAYING ROUND IS A FEDERATION ROUND, ON ITS OWN SEVEN (HARD, 2026-09-23 10:19: "New paying
// rounds are FEDERATION now"; ruled 2026-09-21: the committee is the 5-of-7 already in the protocol).
//
// `run-2of2.mjs` used to open its paying kind as THRESHOLD_LN on the free pair, with the committee's own
// Lightning holding the stakes. That custody is withdrawn and no longer encodes, so the launcher's paying
// round names the federation it locks into, and it refuses to start one without that federation - by name,
// before it creates or binds anything. What it opens with a federation was measured against a real one
// (TASKBOOK, 2026-09-23); this pins the refusals, which a launcher reaches with no federation at all.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const LAUNCHER = new URL('../tools/run-2of2.mjs', import.meta.url).pathname;

function launch(extra) {
  const dir = mkdtempSync(join(tmpdir(), 'blwp-daily-paid-'));
  const store = join(dir, 'store');
  try {
    const got = spawnSync(process.execPath, [LAUNCHER], {
      env: { PATH: process.env.PATH, RT: join(dir, 'no-chain'), ARENA_BIND: '127.0.0.1', ARENA_2OF2_DIR: store,
        ARENA_PORT_A: '18691', ARENA_PORT_B: '18692', ...extra },
      encoding: 'utf8', timeout: 30000,
    });
    return { status: got.status, stderr: got.stderr, created: existsSync(store) };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

const SEVEN = '18671,18672,18673,18674,18675,18676,18677';
const FEDERATION = { ARENA_STAKE_LOCK_BIN: '/nowhere/blwp-stake-lock', ARENA_FEDERATION_CLIENT_DIR: '/nowhere/client',
  ARENA_FEDERATION_INVITE: 'fed11nowhere', ARENA_PAID_PORTS: SEVEN };

test('a paying Daily round without its federation is refused by name, and nothing is created', () => {
  const got = launch({ ARENA_PAID_STAKE_MSAT: '100000' });
  assert.equal(got.status, 2, got.stderr);
  assert.match(got.stderr, /ARENA_PAID_STAKE_MSAT opens FEDERATION rounds and needs their federation: set ARENA_STAKE_LOCK_BIN, ARENA_FEDERATION_CLIENT_DIR, ARENA_PAID_PORTS, ARENA_FEDERATION_INVITE/);
  assert.equal(got.created, false, 'the launcher created its store before refusing');
  // and it no longer asks for the committee's Lightning, which is the withdrawn custody's
  assert.doesNotMatch(got.stderr, /ARENA_LNCLI|Lightning/);
});

test('the paying committee is seven signer nodes of its own: six ports, a free round\'s port or 8080 are refused', () => {
  const six = launch({ ARENA_PAID_STAKE_MSAT: '100000', ...FEDERATION, ARENA_PAID_PORTS: SEVEN.split(',').slice(0, 6).join(',') });
  assert.equal(six.status, 2, six.stderr);
  assert.match(six.stderr, /ARENA_PAID_PORTS names 6 port\(s\): a paying round's committee is seven signer nodes \(5-of-7\)/);
  const shared = launch({ ARENA_PAID_STAKE_MSAT: '100000', ...FEDERATION, ARENA_PAID_PORTS: `18691,${SEVEN.split(',').slice(1).join(',')}` });
  assert.equal(shared.status, 2, shared.stderr);
  assert.match(shared.stderr, /names 8080 \(signal-cli's\) or a free round's port/);
  const signal = launch({ ARENA_PAID_STAKE_MSAT: '100000', ...FEDERATION, ARENA_PAID_PORTS: `8080,${SEVEN.split(',').slice(1).join(',')}` });
  assert.equal(signal.status, 2, signal.stderr);
  assert.match(signal.stderr, /names 8080 \(signal-cli's\) or a free round's port/);
  for (const g of [six, shared, signal]) assert.equal(g.created, false);
});
