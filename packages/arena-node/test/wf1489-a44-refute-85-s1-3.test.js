// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// kanban #1489 a44 refute #1835 (3): the start scan matches taken/ notes to book rows by the PATH string. A booked row's noteFile is the pool path the
// faucet had then; the same pool named another way at start (a symlink, a moved mount, relative vs absolute) reads as "no welcome booked it" and the
// handed-out note goes back on the shelf. The row's hash (sha256 of the note) names the note whatever its path.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const FAUCET = join(dirname(fileURLToPath(import.meta.url)), '..', 'tools', 'faucet.mjs');
const FED = '33'.repeat(32);

test('#1489 a44-refute-85-3: a booked note stays in taken/ when the pool is named by another path', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wf1489-a44-85-3-')), pool = join(dir, 'pool'), taken = join(pool, FED, 'taken');
  mkdirSync(taken, { recursive: true });
  symlinkSync(pool, join(dir, 'pool-link'));
  const ecash = 'fedimintbooked';
  writeFileSync(join(taken, '3000000-1-booked.json'), JSON.stringify({ msat: '3000000', ecash, federation: FED }));
  writeFileSync(join(dir, 'book.json'), JSON.stringify({ paid: [], players: [{ account: 'ab'.repeat(32), kind: 'welcome', ip: '198.51.100.9', sats: 3000, atMs: Date.now(),
    hash: createHash('sha256').update(ecash).digest('hex'), ecash: true, noteFile: join(taken, '3000000-1-booked.json') }] }));
  const port = 20000 + Math.floor(Math.random() * 9000);
  const child = spawn(process.execPath, [FAUCET], { stdio: 'ignore', env: { ...process.env, FAUCET_PORT: String(port), FAUCET_BOOK: join(dir, 'book.json'), FAUCET_PENDING: join(dir, 'pending.txt'),
    FAUCET_RPC_URL: 'http://127.0.0.1:1/wallet/x', FAUCET_COOKIE: join(dir, 'none'), FAUCET_LNCLI: '/bin/false', FAUCET_PAYERS: `${dir}|127.0.0.1:1`, FAUCET_ECASH_POOL: join(dir, 'pool-link') } });
  try {
    for (let i = 0; i < 50; i++) { try { await fetch(`http://127.0.0.1:${port}/player`); break; } catch { await new Promise((ok) => setTimeout(ok, 100)); } }
    const facts = { taken: readdirSync(taken), shelf: readdirSync(join(pool, FED)).filter((f) => f.endsWith('.json')) };
    console.log('  FACTS a44-refute-85-3:', JSON.stringify(facts));
    assert.deepEqual(facts.taken, ['3000000-1-booked.json'], 'a booked (handed-out) note went back on the shelf');
  } finally { child.kill(); }
});
