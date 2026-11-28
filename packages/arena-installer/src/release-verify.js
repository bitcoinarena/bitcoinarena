// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// IS THIS RELEASE OURS? (A.3, ruling 6; 2-of-3 since kanban #3920). SHA256SUMS signed with the Arena release keys (Ed25519,
// tools/release/sign-part.mjs, one key each, combined by tools/release/combine-sigs.mjs); the installer and the updater accept an
// asset only when SHA256SUMS carries valid signatures from at least `threshold` (2) distinct keys of the trusted key set, and the
// asset's SHA-256 is the line SHA256SUMS names for it.
//
// Where the signatures are:
//   SHA256SUMS.sigs  one line per key: "<public key hex> <signature base64>" (lines starting with # are notes). Keys outside the set
//                    are ignored, a key named twice counts once.
//   SHA256SUMS.sig   the single base64 signature an updater from before #3920 reads: it trusts only key 1 (RELEASE_KEY_HEX), so every
//                    release a pre-#3920 node must accept carries key 1's signature there. Here it counts as one more signature, for
//                    whichever key of the set it verifies with.
// The key set: PINNED_KEYSET below (seq 0). It changes only by a key-set change file (KEYSET-<seq>.json, keysetChange) signed by at
// least `threshold` keys of the CURRENT set; a node keeps the newest set it has accepted (release-keyset.json in its home) and never
// goes back to a lower seq.
import { createPublicKey, verify, createHash } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { basename, join } from 'node:path';

/** Key 1: the one key a node from before #3920 trusts (deploy/release/arena-release-key.pub.pem, https://testnet.bitcoinarena.io/release-key.txt). */
export const RELEASE_KEY_HEX = 'ce8d1ee7c371883e7c2e843f243ee6c648d3952a14f9e1eabf71e8cc5a90c892';
/** The pinned set (kanban #3920): key 1 (the owner's, encrypted), key 2 (the code session's signer), key 3 (the third key holder). */
export const PINNED_KEYSET = Object.freeze({ seq: 0, threshold: 2, keys: Object.freeze([
  RELEASE_KEY_HEX,
  '7ef3d6e6471b36e771da1e6e29432907ef22e35e422e8bf2893d55cec5c4c78e',
  '5fca22462162d1b75cea8cee12684243eac20ddaba11466c6dc392e5b6c7fe95',
]) });
/** What a key-set change signs: this prefix, then keysetBody(change). Never the bytes of a SHA256SUMS. */
export const KEYSET_DOMAIN = 'arena-release-keyset/1\n';

const HEX64 = /^[0-9a-f]{64}$/;
const keyOf = (hex) => createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(hex, 'hex')]), format: 'der', type: 'spki' });
const sigOk = (bytes, sigB64, keyHex) => {
  try { return HEX64.test(keyHex) && verify(null, Buffer.from(bytes), keyOf(keyHex), Buffer.from(String(sigB64).trim(), 'base64')); } catch { return false; }
};

/** A well-formed key set: { seq >= 0, 2 <= threshold <= keys, distinct 64-hex keys }; or null. */
export function validKeyset(s) {
  if (!s || typeof s !== 'object' || !Number.isSafeInteger(s.seq) || s.seq < 0 || !Array.isArray(s.keys)) return null;
  const keys = s.keys.map((k) => String(k).toLowerCase());
  if (!keys.every((k) => HEX64.test(k)) || new Set(keys).size !== keys.length) return null;
  if (!Number.isSafeInteger(s.threshold) || s.threshold < 2 || s.threshold > keys.length) return null;
  return { seq: s.seq, threshold: s.threshold, keys };
}

/**
 * Does `sigB64` sign `bytes` (SHA256SUMS, latest.json) with `keyHex`; without a key, with any key of `keyset` (the pinned set)?
 * One signature: enough for latest.json (an offer only; the install itself needs sumsVerdict's threshold), never for an asset.
 */
export function sumsSigned(bytes, sigB64, keyHex, keyset = PINNED_KEYSET) {
  return keyHex ? sigOk(bytes, sigB64, keyHex) : (validKeyset(keyset)?.keys || []).some((k) => sigOk(bytes, sigB64, k));
}

/** The lines of a SHA256SUMS.sigs: [{ key, sig }] (malformed lines skipped). */
export function parseSigs(text) {
  return String(text || '').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
    .map((l) => l.split(/\s+/)).filter((p) => p.length === 2 && HEX64.test(p[0].toLowerCase())).map(([key, sig]) => ({ key: key.toLowerCase(), sig }));
}

/**
 * The signatures over `bytes` that count: { ok, keys (distinct set keys with a valid signature), threshold, why }.
 * `sigs`: the SHA256SUMS.sigs text; `sig`: the single legacy SHA256SUMS.sig (tried with every key of the set).
 */
export function sumsVerdict(bytes, { sig, sigs, keyset = PINNED_KEYSET } = {}) {
  const set = validKeyset(keyset);
  if (!set) return { ok: false, keys: [], threshold: 2, why: 'no valid release key set' };
  const good = new Set();
  for (const { key, sig: s } of parseSigs(sigs)) if (set.keys.includes(key) && !good.has(key) && sigOk(bytes, s, key)) good.add(key);
  if (sig) for (const k of set.keys) if (!good.has(k) && sigOk(bytes, sig, k)) { good.add(k); break; }
  const keys = [...good];
  return keys.length >= set.threshold ? { ok: true, keys, threshold: set.threshold }
    : { ok: false, keys, threshold: set.threshold, why: `SHA256SUMS is signed by ${keys.length} of the Arena release keys, ${set.threshold} are needed` };
}

/** The bytes a key-set change's signatures sign. */
export function keysetBody(c) {
  return Buffer.from(KEYSET_DOMAIN + JSON.stringify({ arenaReleaseKeyset: 1, seq: c.seq, threshold: c.threshold, keys: c.keys }));
}

/**
 * Apply one key-set change (a parsed KEYSET-<seq>.json: { arenaReleaseKeyset: 1, seq, threshold, keys, sigs: [{ key, sig }] }) to
 * `current`: { ok, keyset } when its seq is current.seq + 1, the new set is well formed and at least current.threshold distinct keys
 * of the CURRENT set signed it; else { ok: false, why }.
 */
export function keysetChange(current, change) {
  const cur = validKeyset(current);
  if (!cur) return { ok: false, why: 'the current key set is not valid' };
  if (!change || change.arenaReleaseKeyset !== 1) return { ok: false, why: 'not a key-set change' };
  const next = validKeyset(change);
  if (!next) return { ok: false, why: 'the new key set is not well formed (distinct 64-hex keys, 2 <= threshold <= keys)' };
  if (next.seq !== cur.seq + 1) return { ok: false, why: `key-set change ${next.seq} does not follow set ${cur.seq}` };
  const body = keysetBody(next);
  const good = new Set();
  for (const { key, sig } of Array.isArray(change.sigs) ? change.sigs : []) {
    const k = String(key || '').toLowerCase();
    if (cur.keys.includes(k) && sigOk(body, sig, k)) good.add(k);
  }
  return good.size >= cur.threshold ? { ok: true, keyset: next, by: [...good] }
    : { ok: false, why: `key-set change ${next.seq} is signed by ${good.size} keys of set ${cur.seq}, ${cur.threshold} are needed` };
}

/**
 * The key set to check a release with: the newer of `trusted` (what this node kept) and the pinned one, then every change in
 * `changes` (parsed, any order) that follows it. A change that does not follow or is not signed by the set before it stops the chain
 * there (the set reached so far stands). Answers { keyset, applied, why }.
 */
export function resolveKeyset(changes = [], trusted = null) {
  const kept = validKeyset(trusted);
  let set = kept && kept.seq > PINNED_KEYSET.seq ? kept : validKeyset(PINNED_KEYSET);
  const bySeq = new Map((changes || []).filter((c) => c && Number.isSafeInteger(c.seq)).map((c) => [c.seq, c]));
  let applied = 0, why = null;
  for (;;) {
    const c = bySeq.get(set.seq + 1);
    if (!c) break;
    const r = keysetChange(set, c);
    if (!r.ok) { why = r.why; break; }
    set = r.keyset; applied++;
  }
  return { keyset: set, applied, why };
}

/** The set a node kept (release-keyset.json in its home), or null. */
export function keptKeyset(home) {
  try { return validKeyset(JSON.parse(readFileSync(join(home, 'release-keyset.json'), 'utf8'))); } catch { return null; }
}
/** Keep `set` in the node's home when it is newer than what it kept (never back to a lower seq). */
export function keepKeyset(home, set) {
  const s = validKeyset(set), had = keptKeyset(home);
  if (!home || !s || (had && had.seq >= s.seq) || s.seq <= PINNED_KEYSET.seq) return false;
  const f = join(home, 'release-keyset.json');
  try { writeFileSync(`${f}.tmp`, JSON.stringify(s, null, 2) + '\n', { mode: 0o644 }); renameSync(`${f}.tmp`, f); return true; } catch { return false; }
}

/**
 * Check an asset file against signed sums. Answers { ok, why, sha256, keys, keyset }.
 * `sig`: SHA256SUMS.sig; `sigs`: SHA256SUMS.sigs; `keysets`: parsed key-set change files; `trusted`: the set this node kept.
 */
export function checkAsset({ file, sums, sig, sigs, keysets = [], trusted = null }) {
  const { keyset, why: chainWhy } = resolveKeyset(keysets, trusted);
  const v = sumsVerdict(sums, { sig, sigs, keyset });
  if (!v.ok) return { ok: false, why: `${v.why}${chainWhy ? ` (${chainWhy})` : ''}`, keys: v.keys, keyset };
  const name = basename(file);
  const line = String(sums).split('\n').map((l) => l.trim().split(/\s+\*?/)).find((p) => p.length === 2 && p[1] === name);
  if (!line) return { ok: false, why: `SHA256SUMS names no ${name}`, keys: v.keys, keyset };
  const sha256 = createHash('sha256').update(readFileSync(file)).digest('hex');
  return sha256 === line[0] ? { ok: true, sha256, keys: v.keys, keyset }
    : { ok: false, why: `${name} is not the signed file (sha256 ${sha256.slice(0, 16)}, signed ${line[0].slice(0, 16)})`, sha256, keys: v.keys, keyset };
}
