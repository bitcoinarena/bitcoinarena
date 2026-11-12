// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 sm7-faucet-2: a screenshot is kept under its SHA-256 (<shots>/<hash>.<kind>), written in place with writeFileSync, and an upload whose
// hash already has a file writes nothing (`fresh = !shotFile(h)`). A faucet killed (or restarted) while it writes one leaves a cut file under the
// image's name; every later upload of that image is answered 200 with its hash and writes nothing, the report naming it is taken, and the admin is
// served the cut bytes for good - the file under a hash is never that hash's image again (the state "file present, not its bytes" is never left).
// The crash is simulated as it leaves the disk: the first part of the image under its hash, before the faucet starts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const FAUCET = fileURLToPath(new URL('../tools/faucet.mjs', import.meta.url));
const CODE = 'sm7-faucet-2-admin-code';

test('#1489 sm7-faucet-2: a screenshot file cut by a crash mid-write is never written again; its hash serves the cut bytes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wf1489-sm7-faucet-2-')), shots = join(dir, 'shots');
  mkdirSync(shots);
  // a PNG of 600 kB
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(600000, 7)]);
  const h = createHash('sha256').update(png).digest('hex');
  // what a kill inside writeFileSync(<shots>/<h>.png) leaves: the first 64 kB under the image's name
  writeFileSync(join(shots, `${h}.png`), png.subarray(0, 65536));
  const port = 20000 + Math.floor(Math.random() * 9000);
  const faucet = spawn(process.execPath, [FAUCET], { stdio: 'ignore',
    env: { ...process.env, FAUCET_PORT: String(port), FAUCET_FEEDBACK_DB: join(dir, 'fb.db'), FAUCET_FEEDBACK_SHOTS: shots, FAUCET_SHOT_FREE_FLOOR_BYTES: '0',
      FAUCET_BOOK: join(dir, 'book.json'), FAUCET_FOUNDING_FILE: join(dir, 'founding.jsonl'), FAUCET_ADMIN_SHA256: createHash('sha256').update(CODE).digest('hex') } });
  const base = `http://127.0.0.1:${port}`;
  try {
    for (let i = 0; i < 50; i++) { try { await fetch(`${base}/feedback/rewards`); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
    // the player (after the restart) uploads the image again: the faucet answers it as kept
    const r = await fetch(`${base}/feedback/screenshot`, { method: 'POST', headers: { 'content-type': 'image/png', 'x-arena-ip': '10.0.0.8' }, body: png });
    const up = { status: r.status, ...(await r.json()) };
    const served = await fetch(`${base}/feedback/admin/screenshot/${h}`, { headers: { 'x-arena-admin': CODE } });
    const bytes = Buffer.from(await served.arrayBuffer());
    const onDisk = readFileSync(join(shots, `${h}.png`));
    const facts = { upload: [up.status, up.sha256 === h], servedStatus: served.status, servedBytes: bytes.length, imageBytes: png.length,
      servedHashIsTheImage: createHash('sha256').update(bytes).digest('hex') === h, onDiskBytes: onDisk.length };
    console.log('  FACTS sm7-faucet-2:', JSON.stringify(facts));
    assert.deepEqual(facts.upload, [200, true], 'the upload was not answered as kept');
    assert.equal(facts.servedHashIsTheImage, true, `the upload was answered 200 with hash ${h.slice(0, 16)}, but the file under that hash holds ${onDisk.length} of the image's ${png.length} bytes`);
  } finally { faucet.kill(); }
});
