// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE RELEASE IS OURS ONLY WHEN SIGNED (kanban #471 A.3, ruling 6): SHA256SUMS verifies with the release key, and the asset is the file
// its line names. Measured 2026-10-18 on a 0.1.0-test.1 Linux x64 asset signed by tools/release/sign.sh: verified, a changed byte refused.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkAsset, sumsSigned, RELEASE_KEY_HEX } from '../src/release-verify.js';

test('an asset is accepted only with signed sums naming its exact bytes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'arena-release-'));
  try {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const keyHex = publicKey.export({ format: 'der', type: 'spki' }).subarray(12).toString('hex');
    const file = join(dir, 'arena-node-0.1.0-linux-x64.tar.gz');
    writeFileSync(file, 'the asset');
    const sums = Buffer.from(`${createHash('sha256').update('the asset').digest('hex')}  arena-node-0.1.0-linux-x64.tar.gz\n`);
    const sig = sign(null, sums, privateKey).toString('base64');
    assert.equal(checkAsset({ file, sums, sig, keyHex }).ok, true);
    assert.match(checkAsset({ file, sums, sig }).why, /not signed by the Arena release key/, 'another key: refused');
    assert.equal(sumsSigned(Buffer.concat([sums, Buffer.from('x')]), sig, keyHex), false, 'changed sums: refused');
    writeFileSync(file, 'the asset!');
    assert.match(checkAsset({ file, sums, sig, keyHex }).why, /is not the signed file/);
    assert.match(checkAsset({ file: join(dir, 'other.tar.gz'), sums, sig, keyHex }).why, /names no other\.tar\.gz/);
    assert.equal(RELEASE_KEY_HEX, 'ce8d1ee7c371883e7c2e843f243ee6c648d3952a14f9e1eabf71e8cc5a90c892', 'the published key');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
