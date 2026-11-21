// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #2227 (#1489 a44 refute of #1630, the fix idea's second half): an update's backup and its rollback keep the owner pair in
// step. The rollback put owner.json back by a plain copy and left <db>.owner.json.bak at what the newer release wrote: a torn copy
// then read back as that other owner. Now the backup holds the .bak too, and a restore writes one value into both, .bak first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { backupNode, restoreNode, NODE_FILES, SEAT_DATA_FILES } from '../src/update.js';
import { readDurableJson, writeDurableJson } from '../../arena-node/src/durable-json.js';

test('#2227: backup holds the owner .bak, and a restore writes the owner pair as one value', async () => {
  const home = mkdtempSync(join(tmpdir(), 'wf1489-a44-32-s2-2-'));
  const OLD = 'a'.repeat(64), NEW = 'b'.repeat(64);
  for (const f of ['node.db.owner.json.bak', 'node.db.operator-tokens.json.bak']) {
    assert.ok(NODE_FILES.includes(f), `${f} is backed up`);
    assert.ok(SEAT_DATA_FILES.includes(f), `${f} is seat data (kept with its file)`);
  }
  writeDurableJson(join(home, 'node.db.owner.json'), { pubkey: OLD, claimedAtMs: 1 });
  writeDurableJson(join(home, 'node.db.operator-tokens.json'), [{ t: 1 }]);
  const b = backupNode(home, 'stamp');
  assert.ok(b.files.includes('node.db.owner.json.bak'));
  // the newer release then bound another owner, durably
  writeDurableJson(join(home, 'node.db.owner.json'), { pubkey: NEW, claimedAtMs: 2 });
  const r = await restoreNode(home, b, { pause: async () => {} });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(JSON.parse(readFileSync(join(home, 'node.db.owner.json'), 'utf8')).pubkey, OLD);
  assert.equal(JSON.parse(readFileSync(join(home, 'node.db.owner.json.bak'), 'utf8')).pubkey, OLD, 'the .bak is put back with its file');
  writeFileSync(join(home, 'node.db.owner.json'), ''); // a later torn write
  assert.equal(readDurableJson(join(home, 'node.db.owner.json')).pubkey, OLD, 'a torn file reads as the restored owner, never the other one');
  assert.deepEqual(readDurableJson(join(home, 'node.db.operator-tokens.json'), []), [{ t: 1 }]);
});

test('#2227: a backup from an older build (owner.json with a stale or no .bak) restores its file into both', async () => {
  const home = mkdtempSync(join(tmpdir(), 'wf1489-a44-32-s2-2b-'));
  const OLD = 'a'.repeat(64), NEW = 'b'.repeat(64);
  writeFileSync(join(home, 'node.db.owner.json'), JSON.stringify({ pubkey: OLD }) + '\n');
  const b = backupNode(home, 'stamp');
  assert.ok(!b.files.includes('node.db.owner.json.bak'));
  writeDurableJson(join(home, 'node.db.owner.json'), { pubkey: NEW });
  const r = await restoreNode(home, b, { pause: async () => {} });
  assert.equal(r.ok, true);
  assert.ok(existsSync(join(home, 'node.db.owner.json.bak')));
  assert.equal(JSON.parse(readFileSync(join(home, 'node.db.owner.json.bak'), 'utf8')).pubkey, OLD);
});
