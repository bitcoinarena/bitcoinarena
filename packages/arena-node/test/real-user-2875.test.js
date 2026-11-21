// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// KANBAN #2875 (the owner 2026-11-16): the owner marks a reporter key as a real user with the player's name; the mark is kept in the Season 2
// book (who set it, when), read back for every report of the key, and can be cleared (the row stays). It changes no payout share.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openBountySeason } from '../src/bounty-season.js';

test('#2875 a real-user mark is set with a name, read back, survives a reopen, and is cleared', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'real-user-2875-')), 's2.db');
  const k = '9a'.repeat(32);
  let s = openBountySeason(file);
  assert.equal(s.realUserOf(k), null);
  assert.equal(s.markRealUser('nothex', { name: 'x' }).ok, false);
  assert.equal(s.markRealUser(k, { name: '' }).ok, false);
  const m = s.markRealUser(k.toUpperCase(), { name: 'Itsmelee', note: 'X @realamlee', by: 'owner', nowMs: 1000 });
  assert.equal(m.ok, true);
  assert.deepEqual(s.realUserOf(k), { pubkey: k, name: 'Itsmelee', note: 'X @realamlee', setBy: 'owner', setMs: 1000 });
  s.close(); s = openBountySeason(file);
  assert.equal(s.realUserOf(k).name, 'Itsmelee', 'kept across a restart');
  assert.equal(s.clearRealUser(k, { by: 'owner' }).ok, true);
  assert.equal(s.realUserOf(k), null);
  assert.equal(s.clearRealUser(k).ok, false, 'nothing left to clear');
  s.close();
});

test('#2875 a played mark is set per report, read back, and cleared', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'played-2875-')), 's2.db');
  const id = 'ab'.repeat(32);
  const s = openBountySeason(file);
  assert.equal(s.playedMarkOf(id), null);
  assert.equal(s.markPlayed('x').ok, false);
  assert.equal(s.markPlayed(id, { by: 'owner', nowMs: 5 }).ok, true);
  assert.deepEqual(s.playedMarkOf(id), { setBy: 'owner', setMs: 5 });
  assert.equal(s.clearPlayed(id).ok, true);
  assert.equal(s.playedMarkOf(id), null);
  s.close();
});
