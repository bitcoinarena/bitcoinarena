// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE GAME DEVELOPERS' KEYS INSTALLED ON A NODE (kanban #582, 2026-10-22: "es soll unter donations für game devs erscheinen, wenn ein
// private key eines game devs auf dem Node installiert ist und neue Apps signieren kann. Nur dann."): the owner installs a developer's
// Ed25519 key (the PKCS#8 file arena-donor writes, or its seed); the node keeps it beside its store, readable by the node only, and signs an
// app's next version with it - for the apps whose manifest names that key, and no other. Nothing here ever answers a secret.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, unlinkSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { ed25519 } from '@noble/curves/ed25519.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { devKeyFromText } from './app-version.js';

const PKCS8_ED25519 = Buffer.from('302e020100300506032b657004220420', 'hex');

/** `dir` the folder (<db>.app-keys). Answers { list, add, remove, seedOf }. */
export function createAppDevKeys(dir) {
  const files = () => (dir && existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.pkcs8')) : []);
  const read = () => {
    const out = new Map();
    for (const f of files()) {
      try { const k = devKeyFromText(readFileSync(join(dir, f)).toString('base64')); if (k.ok) out.set(k.pubkey, { seed: k.seed, file: f }); } catch { /* not a key */ }
    }
    return out;
  };
  return {
    /** The developer keys installed: their public keys (hex), never more. */
    list: () => [...read().keys()],
    /** Install a key from the text its developer has: { ok, pubkey } or { ok: false, why }. */
    add(text) {
      if (!dir) return { ok: false, why: 'this node keeps no developer keys (no store folder)' };
      const k = devKeyFromText(text);
      if (!k.ok) return k;
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const file = join(dir, `${k.pubkey.slice(0, 16)}.pkcs8`);
      writeFileSync(file, Buffer.concat([PKCS8_ED25519, Buffer.from(k.seed)]), { mode: 0o600 });
      try { chmodSync(file, 0o600); } catch { /* the mode given at write */ }
      return { ok: true, pubkey: k.pubkey };
    },
    /** Remove an installed key by its public key. */
    remove(pubkey) {
      const want = String(pubkey || '').toLowerCase();
      const hit = read().get(want);
      if (!hit) return { ok: false, why: 'no such developer key on this node' };
      unlinkSync(join(dir, hit.file));
      return { ok: true, pubkey: want, removed: true };
    },
    /** The seed of an installed key, for the node to sign with (never answered over any door). */
    seedOf: (pubkey) => { const hit = read().get(String(pubkey || '').toLowerCase()); return hit ? hit.seed : null; },
  };
}
export const pubkeyOfSeed = (seed) => toHex(ed25519.getPublicKey(seed));
