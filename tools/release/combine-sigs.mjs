#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// COMBINE AND CHECK A RELEASE'S SIGNATURES BEFORE IT IS PUBLISHED (kanban #3920, 2-of-3). Reads the parts tools/release/sign-part.mjs
// wrote (<file>.sig-<key16>), keeps those that verify with a key of the release key set (the pinned set, then the KEYSET-<seq>.json
// changes in <dir>), and writes
//   <file>.sigs   "<public key hex> <signature base64>" per key: what a 2-of-3 updater reads;
//   <file>.sig    key 1's signature alone: what an updater from before #3920 reads (it trusts only key 1).
// It then checks the result as a node does (release-verify.js sumsVerdict) and exits 1 when fewer than the set's threshold of
// distinct keys signed: nothing below that may be published. Without key 1's part it warns that pre-#3920 nodes will refuse it.
//
//     node tools/release/combine-sigs.mjs <dir> [file, SHA256SUMS by default]      combine + check (also latest.json)
//     node tools/release/combine-sigs.mjs <dir> [file] --check                     check what is there, write nothing
//     node tools/release/combine-sigs.mjs <dir> --keyset KEYSET-<seq>.json          merge parts into a key-set change and check it
import { readFileSync, writeFileSync, readdirSync, existsSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { RELEASE_KEY_HEX, sumsSigned, sumsVerdict, parseSigs, resolveKeyset, keysetChange, validKeyset, keysetBody } from '../../packages/arena-installer/src/release-verify.js';

/** The key-set changes in a directory (parsed KEYSET-<seq>.json). */
export const keysetsIn = (dir) => readdirSync(dir).filter((f) => /^KEYSET-\d+\.json$/.test(f))
  .map((f) => { try { return JSON.parse(readFileSync(join(dir, f), 'utf8')); } catch { return null; } }).filter(Boolean);

/** The valid parts for `bytes`: [{ key, sig }] in key-set order, one per key. */
function partsFor(dir, file, bytes, keys, key1 = RELEASE_KEY_HEX) {
  const got = new Map();
  for (const f of readdirSync(dir)) {
    const m = f.startsWith(`${file}.sig-`) ? f.slice(file.length + 5) : null;
    if (!m || !/^[0-9a-f]{16}$/.test(m)) continue;
    const sig = readFileSync(join(dir, f), 'utf8').trim();
    const key = [...keys, key1].find((k) => k.startsWith(m) && sumsSigned(bytes, sig, k));
    if (key) got.set(key, sig); else console.error(`${f}: not a valid signature of a release key: ignored`);
  }
  return got;
}

// `trusted`/`key1`: for tests only (a key set of their own keys); the command line always uses the pinned set and key 1
export function combine(dir, file = 'SHA256SUMS', { check = false, log = console.log, trusted = null, key1 = RELEASE_KEY_HEX } = {}) {
  const { keyset, why } = resolveKeyset(keysetsIn(dir), trusted);
  if (why) log(`key-set chain stops at set ${keyset.seq}: ${why}`);
  const bytes = readFileSync(join(dir, file));
  if (!check) {
    const got = partsFor(dir, file, bytes, keyset.keys, key1);
    if (existsSync(join(dir, `${file}.sigs`))) for (const { key, sig } of parseSigs(readFileSync(join(dir, `${file}.sigs`), 'utf8'))) if (!got.has(key) && sumsSigned(bytes, sig, key)) got.set(key, sig);
    const order = [...keyset.keys, ...[...got.keys()].filter((k) => !keyset.keys.includes(k))];
    writeFileSync(join(dir, `${file}.sigs`), order.filter((k) => got.has(k)).map((k) => `${k} ${got.get(k)}`).join('\n') + '\n');
    if (got.has(key1)) writeFileSync(join(dir, `${file}.sig`), got.get(key1) + '\n');
  }
  const sigs = existsSync(join(dir, `${file}.sigs`)) ? readFileSync(join(dir, `${file}.sigs`), 'utf8') : '';
  const sig = existsSync(join(dir, `${file}.sig`)) ? readFileSync(join(dir, `${file}.sig`), 'utf8') : '';
  const v = sumsVerdict(bytes, { sig, sigs, keyset });
  const old = !!sig && sumsSigned(bytes, sig, key1);
  log(`${file}: signed by ${v.keys.length} of ${keyset.keys.length} release keys (set ${keyset.seq}, ${v.threshold} needed): ${v.ok ? 'OK' : 'NOT ENOUGH'}`);
  for (const k of v.keys) log(`  ${k}${keyset.keys.indexOf(k) >= 0 ? ` (key ${keyset.keys.indexOf(k) + 1})` : ''}`);
  log(old ? `${file}.sig: key 1 - updaters from before #3920 accept it` : `WARNING: ${file}.sig is not key 1's signature - updaters from before #3920 refuse this release`);
  return { ...v, oldUpdaters: old };
}

export function combineKeyset(dir, name, { log = console.log, trusted = null } = {}) {
  const f = join(dir, name);
  const c = JSON.parse(readFileSync(f, 'utf8'));
  const next = validKeyset(c);
  if (!next || c.arenaReleaseKeyset !== 1) { log(`${name}: not a well-formed key-set change`); return { ok: false }; }
  const { keyset: cur } = resolveKeyset(keysetsIn(dir).filter((x) => x.seq < next.seq), trusted);
  const body = keysetBody(next);
  const got = partsFor(dir, name, body, cur.keys);
  for (const s of Array.isArray(c.sigs) ? c.sigs : []) if (s && !got.has(String(s.key).toLowerCase()) && sumsSigned(body, s.sig, String(s.key).toLowerCase())) got.set(String(s.key).toLowerCase(), s.sig);
  const out = { arenaReleaseKeyset: 1, seq: next.seq, threshold: next.threshold, keys: next.keys, sigs: [...got].map(([key, sig]) => ({ key, sig })) };
  writeFileSync(f, JSON.stringify(out, null, 2) + '\n');
  const r = keysetChange(cur, out);
  log(r.ok ? `${name}: set ${cur.seq} -> ${next.seq} accepted (signed by ${r.by.length} keys of set ${cur.seq})` : `${name}: NOT accepted: ${r.why}`);
  return r;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const a = process.argv.slice(2);
  const dir = a[0];
  if (!dir) { console.error('usage: combine-sigs.mjs <dir> [file] [--check] | <dir> --keyset KEYSET-<seq>.json'); process.exit(2); }
  const ks = a.indexOf('--keyset');
  const r = ks > 0 ? combineKeyset(dir, a[ks + 1]) : combine(dir, a.slice(1).find((x) => !x.startsWith('--')) || 'SHA256SUMS', { check: a.includes('--check') });
  process.exit(r.ok ? 0 : 1);
}
