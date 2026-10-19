// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// IS THIS RELEASE OURS? (kanban #471 A.3, ruling 6). SHA256SUMS signed with the Arena release key (Ed25519, tools/release/sign.sh);
// the installer and the updater accept an asset only when the signature verifies with the key below and the asset's SHA-256 is the
// line SHA256SUMS names for it. The key's public half is also published on the Arena site (https://testnet.bitcoin-arena.io/release-key.txt) and in
// deploy/release/arena-release-key.pub.pem.
import { createPublicKey, verify, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

export const RELEASE_KEY_HEX = 'ce8d1ee7c371883e7c2e843f243ee6c648d3952a14f9e1eabf71e8cc5a90c892';
const keyOf = (hex) => createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(hex, 'hex')]), format: 'der', type: 'spki' });

/** Does `sigB64` sign `sums` (the SHA256SUMS bytes) with the release key? */
export function sumsSigned(sums, sigB64, keyHex = RELEASE_KEY_HEX) {
  try { return verify(null, Buffer.from(sums), keyOf(keyHex), Buffer.from(String(sigB64).trim(), 'base64')); } catch { return false; }
}

/** Check an asset file against signed sums. Answers { ok, why, sha256 }. */
export function checkAsset({ file, sums, sig, keyHex = RELEASE_KEY_HEX }) {
  if (!sumsSigned(sums, sig, keyHex)) return { ok: false, why: 'SHA256SUMS is not signed by the Arena release key' };
  const name = basename(file);
  const line = String(sums).split('\n').map((l) => l.trim().split(/\s+\*?/)).find((p) => p.length === 2 && p[1] === name);
  if (!line) return { ok: false, why: `SHA256SUMS names no ${name}` };
  const sha256 = createHash('sha256').update(readFileSync(file)).digest('hex');
  return sha256 === line[0] ? { ok: true, sha256 } : { ok: false, why: `${name} is not the signed file (sha256 ${sha256.slice(0, 16)}, signed ${line[0].slice(0, 16)})`, sha256 };
}
