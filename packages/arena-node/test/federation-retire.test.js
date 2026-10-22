// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// RETIRING A FEDERATION THAT HOLDS NOTHING (kanban #577): the audit read, the consents kept, the guardian's federation named.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { holdsNothing, createRetireBook, guardedFederationOf } from '../src/federation-retire.js';

// the shape of `fedimint-cli admin audit` (measured 2026-10-22 on federation 89ce310e)
const audit = (mint, wallet) => ({ module_summaries: { 0: { kind: 'lnv2', net_assets: 0 }, 1: { kind: 'meta', net_assets: 0 }, 2: { kind: 'mintv2', net_assets: mint },
  3: { kind: 'wallet', net_assets: wallet } }, net_assets: mint + wallet });

test('holds nothing: every module at 0; e-cash issued or coins held, and it is said what', () => {
  assert.equal(holdsNothing(audit(0, 0)).ok, true);
  const issued = holdsNothing(audit(-50000000, 50000000));
  assert.equal(issued.ok, false);
  assert.match(issued.why, /mintv2 -50000000 msat/);
  assert.match(issued.why, /wallet 50000000 msat/);
  assert.equal(holdsNothing(null).ok, false);
});

test('the consents outlive a restart, by federation, any case; done is marked', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'retire-')), 'node.db.retire.json');
  const a = createRetireBook(file);
  a.add('89CE310E'.padEnd(64, '0'));
  const b = createRetireBook(file);
  assert.equal(b.has('89ce310e'.padEnd(64, '0')), true);
  assert.equal(b.has('ab'.repeat(32)), false);
  b.done('89ce310e'.padEnd(64, '0'));
  assert.ok(createRetireBook(file).list()[0].retiredAtMs > 0);
});

test('the federation a guardian guards is its invite-code\'s; none without one', () => {
  const dir = mkdtempSync(join(tmpdir(), 'g-'));
  assert.equal(guardedFederationOf(dir, () => ({ federationId: 'X' })), null);
  writeFileSync(join(dir, 'invite-code'), '"fed11abc"\n');
  assert.equal(guardedFederationOf(dir, (inv) => ({ federationId: inv === 'fed11abc' ? 'AB'.repeat(32) : '' })), 'ab'.repeat(32));
});
