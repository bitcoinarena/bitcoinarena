// kanban #2570 (feedback #021): node.db holds the node's secrets, so it is owner-only (0600) like seed.hex - its -wal too.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, statSync, writeFileSync, chmodSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openStore } from '../src/store.js';

test('node.db is 0600 on open, also when it was 0644 before', { skip: process.platform === 'win32' }, () => {
  const dir = mkdtempSync(join(process.env.ARENA_TEST_TMP || tmpdir(), 'store-mode-'));
  const p = join(dir, 'node.db');
  writeFileSync(p, ''); chmodSync(p, 0o644);
  const s = openStore(p);
  assert.equal(statSync(p).mode & 0o777, 0o600);
  if (existsSync(p + '-wal')) assert.equal(statSync(p + '-wal').mode & 0o077, 0, 'the WAL is owner-only too');
  s.db?.close?.();
});
