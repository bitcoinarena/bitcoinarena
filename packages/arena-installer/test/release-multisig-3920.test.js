// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// 2-OF-3 RELEASES (kanban #3920): a release is accepted only with valid signatures over SHA256SUMS from at least 2 distinct keys of
// the trusted set; the set changes only by a change signed by 2 keys of the CURRENT set; the transition release still passes the
// pre-#3920 single-key verifier. The keys here are made by the test (never a real release key); the node's kept set carries them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { checkAsset, sumsVerdict, sumsSigned, keysetChange, keysetBody, resolveKeyset, keepKeyset, keptKeyset, PINNED_KEYSET, RELEASE_KEY_HEX } from '../src/release-verify.js';
import * as pre3920 from './fixtures/release-verify-pre3920.js';
import { checkOnce, assetNameFor } from '../src/auto-update.js';
import { combine, combineKeyset } from '../../../tools/release/combine-sigs.mjs';
import { loadKey, pubHexOf } from '../../../tools/release/sign-part.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const mk = () => { const { publicKey, privateKey } = generateKeyPairSync('ed25519'); return { priv: privateKey, hex: publicKey.export({ format: 'der', type: 'spki' }).subarray(12).toString('hex') }; };
const [k1, k2, k3, stranger, n1, n2] = [mk(), mk(), mk(), mk(), mk(), mk()];
const SET = { seq: 1, threshold: 2, keys: [k1.hex, k2.hex, k3.hex] };
const sig = (k, bytes) => sign(null, Buffer.from(bytes), k.priv).toString('base64');
const line = (k, bytes) => `${k.hex} ${sig(k, bytes)}`;
const NAME = 'bitcoin-arena-node-0.1.1-linux-x64.tar.gz';
function release() {
  const dir = mkdtempSync(join(tmpdir(), 'arena-3920-'));
  const file = join(dir, NAME); writeFileSync(file, 'the asset');
  const sums = Buffer.from(`${createHash('sha256').update('the asset').digest('hex')}  ${NAME}\n`);
  writeFileSync(join(dir, 'SHA256SUMS'), sums);
  return { dir, file, sums };
}
const change = (seq, keys, signers, threshold = 2) => {
  const c = { arenaReleaseKeyset: 1, seq, threshold, keys: keys.map((k) => k.hex) };
  return { ...c, sigs: signers.map((k) => ({ key: k.hex, sig: sig(k, keysetBody(c)) })) };
};

test('the pinned set is the three published keys, 2 of 3, key 1 first', () => {
  assert.deepEqual(PINNED_KEYSET, { seq: 0, threshold: 2, keys: ['ce8d1ee7c371883e7c2e843f243ee6c648d3952a14f9e1eabf71e8cc5a90c892',
    '7ef3d6e6471b36e771da1e6e29432907ef22e35e422e8bf2893d55cec5c4c78e', '5fca22462162d1b75cea8cee12684243eac20ddaba11466c6dc392e5b6c7fe95'] });
  assert.equal(RELEASE_KEY_HEX, PINNED_KEYSET.keys[0]);
});

test('one signature is refused, two from distinct keys are accepted', () => {
  const { dir, file, sums } = release();
  try {
    assert.match(checkAsset({ file, sums, sigs: line(k1, sums), trusted: SET }).why, /signed by 1 of the Arena release keys, 2 are needed/);
    assert.match(checkAsset({ file, sums, sig: sig(k1, sums), trusted: SET }).why, /1 of .* 2 are needed/, 'the legacy .sig alone: one key');
    const ok = checkAsset({ file, sums, sigs: `${line(k1, sums)}\n${line(k3, sums)}\n`, trusted: SET });
    assert.equal(ok.ok, true); assert.deepEqual(ok.keys.sort(), [k1.hex, k3.hex].sort());
    assert.equal(checkAsset({ file, sums, sig: sig(k1, sums), sigs: line(k2, sums), trusted: SET }).ok, true, 'legacy .sig (key 1) + key 2 in .sigs');
    assert.match(checkAsset({ file, sums, sigs: `${k1.hex} ${sig(k1, 'other')}\n${line(k2, sums)}`, trusted: SET }).why, /1 of/, 'a signature over other bytes does not count');
    assert.match(checkAsset({ file, sums, sigs: `${line(k1, sums)}\n${line(k2, sums)}` }).why, /0 of/, 'the pinned set does not know the test keys');
    writeFileSync(file, 'the asset!');
    assert.match(checkAsset({ file, sums, sigs: `${line(k1, sums)}\n${line(k2, sums)}`, trusted: SET }).why, /is not the signed file/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('two signatures from the same key count once', () => {
  const s = Buffer.from('sums');
  const twice = `${line(k2, s)}\n${line(k2, s)}\n${k2.hex.toUpperCase()} ${sig(k2, s)}`;
  assert.equal(sumsVerdict(s, { sigs: twice, keyset: SET }).ok, false);
  assert.deepEqual(sumsVerdict(s, { sigs: twice, keyset: SET }).keys, [k2.hex]);
  assert.equal(sumsVerdict(s, { sig: sig(k2, s), sigs: line(k2, s), keyset: SET }).ok, false, 'the legacy .sig by the key already in .sigs');
});

test('a key outside the set is ignored', () => {
  const s = Buffer.from('sums');
  assert.equal(sumsVerdict(s, { sigs: `${line(stranger, s)}\n${line(k1, s)}`, keyset: SET }).ok, false);
  assert.equal(sumsVerdict(s, { sig: sig(stranger, s), sigs: line(k1, s), keyset: SET }).ok, false, 'not as the legacy .sig either');
  const v = sumsVerdict(s, { sigs: `${line(stranger, s)}\n${line(k1, s)}\n${line(k3, s)}\nnot a line\n# a note`, keyset: SET });
  assert.equal(v.ok, true); assert.equal(v.keys.includes(stranger.hex), false);
  assert.equal(sumsSigned(s, sig(stranger, s), undefined, SET), false); assert.equal(sumsSigned(s, sig(k3, s), undefined, SET), true, 'latest.json: one set key');
});

test('the key set changes only by a change signed by 2 keys of the current set', () => {
  assert.match(keysetChange(SET, change(2, [n1, n2, k3], [k1])).why, /signed by 1 keys of set 1, 2 are needed/);
  assert.match(keysetChange(SET, change(2, [n1, n2, k3], [n1, n2])).why, /0 keys of set 1/, 'the new keys cannot sign themselves in');
  assert.match(keysetChange(SET, change(2, [n1, n2, k3], [k1, stranger])).why, /1 keys/);
  assert.match(keysetChange(SET, change(2, [n1, n2, k3], [k1, k1])).why, /1 keys/, 'one key twice');
  assert.match(keysetChange(SET, change(3, [n1, n2, k3], [k1, k2])).why, /does not follow set 1/);
  assert.match(keysetChange(SET, change(2, [n1], [k1, k2], 1)).why, /not well formed/, 'threshold 1 is never allowed');
  const tampered = change(2, [n1, n2, k3], [k1, k2]); tampered.keys = [n1.hex, stranger.hex, k3.hex];
  assert.match(keysetChange(SET, tampered).why, /0 keys|1 keys/, 'the signatures cover the keys');
  const r = keysetChange(SET, change(2, [n1, n2, k3], [k1, k2]));
  assert.equal(r.ok, true); assert.deepEqual(r.keyset, { seq: 2, threshold: 2, keys: [n1.hex, n2.hex, k3.hex] });
  // through checkAsset: the chain from the kept set, then the sums checked with the NEW set
  const { dir, file, sums } = release();
  try {
    const rot = [change(2, [n1, n2, k3], [k1, k2])];
    assert.equal(checkAsset({ file, sums, sigs: `${line(n1, sums)}\n${line(n2, sums)}`, keysets: rot, trusted: SET }).ok, true);
    assert.match(checkAsset({ file, sums, sigs: `${line(k1, sums)}\n${line(k2, sums)}`, keysets: rot, trusted: SET }).why, /0 of/, 'k1 and k2 rotated out: their signatures no longer count');
    assert.match(checkAsset({ file, sums, sigs: `${line(n1, sums)}\n${line(n2, sums)}`, keysets: [change(2, [n1, n2, k3], [k1])], trusted: SET }).why, /0 of .*\(key-set change 2 is signed by 1 keys/);
    // kept: never back to a lower seq
    const home = mkdtempSync(join(tmpdir(), 'arena-3920-home-'));
    assert.equal(keepKeyset(home, SET), true); assert.equal(keepKeyset(home, r.keyset), true);
    assert.equal(keepKeyset(home, SET), false); assert.equal(keptKeyset(home).seq, 2);
    assert.equal(resolveKeyset([], keptKeyset(home)).keyset.seq, 2, 'a release without the chain is checked with the kept set');
    assert.equal(keepKeyset(home, PINNED_KEYSET), false);
    rmSync(home, { recursive: true, force: true });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the transition release: key 1 in SHA256SUMS.sig for the pre-#3920 verifier, 2 keys in SHA256SUMS.sigs for the new one', async () => {
  const { dir, file, sums } = release();
  try {
    // each holder signs on his own machine (sign-part.mjs), combine-sigs checks and writes both files
    const pem = (k, name) => { const f = join(dir, name); writeFileSync(f, k.priv.export({ format: 'pem', type: 'pkcs8' })); chmodSync(f, 0o600); return f; };
    const p1 = pem(k1, 'k1.pem');
    const enc = join(dir, 'k2.enc.pem'); writeFileSync(enc, k2.priv.export({ format: 'pem', type: 'pkcs8', cipher: 'aes-256-cbc', passphrase: 'a long passphrase here' }));
    assert.equal(pubHexOf(await loadKey(enc, { ask: async () => 'a long passphrase here' })), k2.hex, 'an encrypted pem: the passphrase asked, not stored');
    const out = execFileSync(process.execPath, [join(ROOT, 'tools/release/sign-part.mjs'), join(dir, 'SHA256SUMS'), p1], { encoding: 'utf8' });
    assert.match(out, new RegExp(`SHA256SUMS\\.sig-${k1.hex.slice(0, 16)}: signed by ${k1.hex}`));
    assert.equal(/PRIVATE/.test(out), false);
    writeFileSync(join(dir, `SHA256SUMS.sig-${k2.hex.slice(0, 16)}`), sig(k2, sums) + '\n');   // the second holder's part
    writeFileSync(join(dir, `SHA256SUMS.sig-${stranger.hex.slice(0, 16)}`), sig(stranger, sums) + '\n');
    const logs = [];
    const one = combine(dir, 'SHA256SUMS', { trusted: SET, key1: k1.hex, log: (m) => logs.push(m) });
    assert.equal(one.ok, true); assert.equal(one.oldUpdaters, true);
    const sigs = readFileSync(join(dir, 'SHA256SUMS.sigs'), 'utf8'), legacy = readFileSync(join(dir, 'SHA256SUMS.sig'), 'utf8');
    assert.equal(sigs.trim().split('\n').length, 2, 'the stranger is left out');
    assert.equal(pre3920.checkAsset({ file, sums, sig: legacy, keyHex: k1.hex }).ok, true, 'the pre-#3920 verifier accepts it');
    assert.equal(checkAsset({ file, sums, sig: legacy, sigs, trusted: SET }).ok, true, 'the 2-of-3 verifier accepts it');
    assert.equal(checkAsset({ file, sums, sig: legacy, trusted: SET }).ok, false, 'without .sigs: key 1 alone, refused');
    // without key 1's part: still 2-of-3, but the old updaters refuse it - combine says so
    const d2 = release();
    writeFileSync(join(d2.dir, `SHA256SUMS.sig-${k2.hex.slice(0, 16)}`), sig(k2, d2.sums)); writeFileSync(join(d2.dir, `SHA256SUMS.sig-${k3.hex.slice(0, 16)}`), sig(k3, d2.sums));
    const l2 = []; const two = combine(d2.dir, 'SHA256SUMS', { trusted: SET, key1: k1.hex, log: (m) => l2.push(m) });
    assert.equal(two.ok, true); assert.equal(two.oldUpdaters, false); assert.match(l2.join('\n'), /WARNING: .*refuse this release/);
    // one part only: not enough, exit 1 from the command line
    const d3 = release();
    writeFileSync(join(d3.dir, `SHA256SUMS.sig-${k1.hex.slice(0, 16)}`), sig(k1, d3.sums));
    assert.equal(combine(d3.dir, 'SHA256SUMS', { trusted: SET, key1: k1.hex, log: () => {} }).ok, false);
    assert.throws(() => execFileSync(process.execPath, [join(ROOT, 'tools/release/combine-sigs.mjs'), d3.dir], { stdio: 'pipe' }), (e) => e.status === 1);
    // a key-set change combined the same way
    writeFileSync(join(d3.dir, 'KEYSET-2.json'), JSON.stringify({ arenaReleaseKeyset: 1, seq: 2, threshold: 2, keys: [n1.hex, n2.hex, k3.hex] }));
    const body = keysetBody({ seq: 2, threshold: 2, keys: [n1.hex, n2.hex, k3.hex] });
    writeFileSync(join(d3.dir, `KEYSET-2.json.sig-${k1.hex.slice(0, 16)}`), sig(k1, body));
    assert.equal(combineKeyset(d3.dir, 'KEYSET-2.json', { trusted: SET, log: () => {} }).ok, false, 'one key of the current set');
    writeFileSync(join(d3.dir, `KEYSET-2.json.sig-${k3.hex.slice(0, 16)}`), sig(k3, body));
    assert.equal(combineKeyset(d3.dir, 'KEYSET-2.json', { trusted: SET, log: () => {} }).ok, true);
    for (const d of [d2.dir, d3.dir]) rmSync(d, { recursive: true, force: true });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the auto update reads SHA256SUMS.sigs and the key-set changes, and keeps the new set', async () => {
  const root = mkdtempSync(join(tmpdir(), 'arena-3920-au-'));
  try {
    const home = join(root, 'home'); const rel = join(home, 'releases', 'arena-node-0.1.0-linux-x64');
    mkdirSync(rel, { recursive: true }); writeFileSync(join(rel, 'VERSION'), '0.1.0\n'); writeFileSync(join(home, 'arena.conf'), 'port=8470\n');
    writeFileSync(join(home, 'state.json'), JSON.stringify({ release: { path: rel } }));
    writeFileSync(join(home, 'release-keyset.json'), JSON.stringify(SET));
    const bytes = Buffer.from('the release asset bytes'.repeat(4));
    const name = assetNameFor('0.1.1', 'linux', 'x64');
    const sums = Buffer.from(`${createHash('sha256').update(bytes).digest('hex')}  ${name}\n`);
    const serve = (extra) => {
      const files = new Map([[`${name}.part00`, bytes], ['SHA256SUMS', sums], ['SHA256SUMS.sig', Buffer.from(sig(k1, sums))], ...extra]);
      const base = 'https://testnet.bitcoinarena.io/release/u/f/v0.1.1/';
      return { fetcher: async (url) => { const f = files.get(url.slice(base.length)); return f ? { status: 200, arrayBuffer: async () => f } : { status: 404, arrayBuffer: async () => Buffer.alloc(0) }; },
        latest: async (own) => ({ latest: { version: '0.1.1', assets: { [name]: createHash('sha256').update(bytes).digest('hex') },
          download: { base, parts: { [name]: [`${name}.part00`] }, keysets: [...extra].some(([k]) => k === 'KEYSET-2.json') ? ['KEYSET-2.json'] : undefined } }, newer: own !== '0.1.1' }) };
    };
    const apply = async () => ({ ok: true, backup: '/b' });
    const unpack = (a, d) => mkdirSync(join(d, name.replace(/\.tar\.gz$/, '')), { recursive: true });
    const only1 = serve([]);
    const r1 = await checkOnce({ home, latest: only1.latest, fetcher: only1.fetcher, platform: 'linux', arch: 'x64', unpack, apply });
    assert.equal(r1.ok, false); assert.match(r1.why, /refused: SHA256SUMS is signed by 1 of the Arena release keys/);
    const rot = change(2, [n1, n2, k3], [k2, k3]);
    const good = serve([['SHA256SUMS.sigs', Buffer.from(`${line(n1, sums)}\n${line(k3, sums)}\n`)], ['KEYSET-2.json', Buffer.from(JSON.stringify(rot))]]);
    const r2 = await checkOnce({ home, latest: good.latest, fetcher: good.fetcher, platform: 'linux', arch: 'x64', unpack, apply });
    assert.equal(r2.ok, true, r2.why);
    assert.equal(keptKeyset(home).seq, 2); assert.deepEqual(keptKeyset(home).keys, [n1.hex, n2.hex, k3.hex]);
    assert.equal(existsSync(join(home, 'releases', 'downloads', '0.1.1', 'SHA256SUMS.sigs')), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
