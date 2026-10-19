// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE TOOLS THAT SIGN TESTNET4'S DONATION SETS REFUSE EVERY KEY BUT TESTNET4'S AUTHORITY, AND WRITE NOTHING WHEN THEY DO;
// AND, ON A COPY WHOSE AUTHORITY IS A TEST KEY, WHAT THEY WRITE WHEN THEY SIGN (below)
// (plan comment 222). tools/sign-testnet4-donation-set.mjs and sign-testnet4-key-donation-set.mjs run as they are
// run, with ARENA_GENESIS_KEYS pointing at a temp dir holding a TEST key - never the live authority's. Both write straight into
// src/ (testnet4-donation-set.js, testnet4-donation-set-keys.js) once they sign, so each refusal is checked against those two
// files' bytes, before and after: a refused run changes nothing. Signing itself needs the live authority key, which no test uses.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { generateKeyPairSync, createHash, createPublicKey, createECDH, verify as edVerify } from 'node:crypto';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, mkdirSync, cpSync, symlinkSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const LNURL_TOOL = new URL('../tools/sign-testnet4-donation-set.mjs', import.meta.url).pathname;
const KEY_TOOL = new URL('../tools/sign-testnet4-key-donation-set.mjs', import.meta.url).pathname;
const OUTS = ['../src/testnet4-donation-set.js', '../src/testnet4-donation-set-keys.js'].map((p) => new URL(p, import.meta.url).pathname);
const sums = () => OUTS.map((p) => createHash('sha256').update(readFileSync(p)).digest('hex'));
const run = (tool, env) => new Promise((done) => execFile(process.execPath, [tool], { env: { ...process.env, ...env }, timeout: 30000 },
  (err, stdout, stderr) => done({ code: err ? err.code || 1 : 0, stdout, stderr })));
function keyDir(kind) {
  const dir = mkdtempSync(join(tmpdir(), 'tn4-authority-'));
  const { privateKey } = kind === 'ed25519' ? generateKeyPairSync('ed25519') : generateKeyPairSync('ec', { namedCurve: 'secp256k1' });
  writeFileSync(join(dir, 'testnet4-authority.pkcs8'), privateKey.export({ type: 'pkcs8', format: 'der' }));
  return dir;
}
function donorDirs() {
  return ['a', 'b'].map((x, i) => { const d = mkdtempSync(join(tmpdir(), `donor-${x}-`)); writeFileSync(join(d, 'donor.json'), JSON.stringify({ recipientPkHex: '02' + String(i + 1).repeat(64), label: `dev ${x}` })); return d; }).join(',');
}

test('the LNURL set tool refuses a key that is not testnet4\'s authority, or not Ed25519, and writes nothing', async () => {
  const before = sums();
  const other = await run(LNURL_TOOL, { ARENA_GENESIS_KEYS: keyDir('ed25519') });
  assert.notEqual(other.code, 0);
  assert.match(other.stderr, /that key is not the donation authority testnet4 genesis names/);
  const ec = await run(LNURL_TOOL, { ARENA_GENESIS_KEYS: keyDir('secp256k1') });
  assert.notEqual(ec.code, 0);
  assert.match(ec.stderr, /the testnet4 donation authority key is not Ed25519/);
  const none = await run(LNURL_TOOL, { ARENA_GENESIS_KEYS: mkdtempSync(join(tmpdir(), 'tn4-none-')) });
  assert.notEqual(none.code, 0);
  assert.match(none.stderr, /ENOENT/);
  assert.deepEqual(sums(), before, 'a refused run changed src/');
});

test('the key set tool refuses missing donors, a missing VALID_FROM, and a key that is not testnet4\'s authority, and writes nothing', async () => {
  const before = sums();
  const noDonors = await run(KEY_TOOL, { ARENA_GENESIS_KEYS: keyDir('ed25519'), VALID_FROM: '154960', DONOR_DIRS: '' });
  assert.match(noDonors.stderr, /DONOR_DIRS names the two dev clients, dev a then dev b/);
  const one = await run(KEY_TOOL, { ARENA_GENESIS_KEYS: keyDir('ed25519'), VALID_FROM: '154960', DONOR_DIRS: donorDirs().split(',')[0] });
  assert.match(one.stderr, /DONOR_DIRS names the two dev clients/);
  const noHeight = await run(KEY_TOOL, { ARENA_GENESIS_KEYS: keyDir('ed25519'), DONOR_DIRS: donorDirs(), VALID_FROM: '' });
  assert.match(noHeight.stderr, /VALID_FROM is the block height the set is in force from/);
  const other = await run(KEY_TOOL, { ARENA_GENESIS_KEYS: keyDir('ed25519'), DONOR_DIRS: donorDirs(), VALID_FROM: '154960' });
  assert.notEqual(other.code, 0);
  assert.match(other.stderr, /that key is not the donation authority testnet4 genesis names/);
  const ec = await run(KEY_TOOL, { ARENA_GENESIS_KEYS: keyDir('secp256k1'), DONOR_DIRS: donorDirs(), VALID_FROM: '154960' });
  assert.match(ec.stderr, /the testnet4 donation authority key is not Ed25519/);
  const missing = await run(KEY_TOOL, { ARENA_GENESIS_KEYS: keyDir('ed25519'), DONOR_DIRS: `${mkdtempSync(join(tmpdir(), 'x-'))},${mkdtempSync(join(tmpdir(), 'y-'))}`, VALID_FROM: '154960' });
  assert.match(missing.stderr, /ENOENT/);
  assert.deepEqual(sums(), before, 'a refused run changed src/');
});

// WHAT EACH SIGNER WRITES WHEN IT SIGNS (hole B, plan comment 238, Go 2026-10-05). The tools only sign with the
// key testnet4's genesis names, and no test holds it. So each runs UNCHANGED on a temp copy of packages/protocol in which -
// in the copy only - AUTHORITY_PUBKEY_TESTNET4 is a test key's public key; core sits beside it as the copy imports it. The
// module it writes there is read back: the set, its id, VALID_FROM, and a signature that verifies under the test key and
// under no other (the live authority's included). The real src/ is byte-identical afterwards.
const REAL_AUTHORITY = 'ea65169edd6387d681a3c6b14c5a17243d49fcdcdbf60816b0e2cb2771a8c9bc';
const PROTOCOL = new URL('..', import.meta.url).pathname;
function srcSums() {
  const dir = join(PROTOCOL, 'src');
  return Object.fromEntries(readdirSync(dir).sort().map((f) => [f, createHash('sha256').update(readFileSync(join(dir, f))).digest('hex')]));
}
function copyWithTestAuthority() {
  const root = mkdtempSync(join(tmpdir(), 'tn4-signer-'));
  const p = join(root, 'packages', 'arena-protocol');
  mkdirSync(p, { recursive: true });
  for (const d of ['src', 'tools']) cpSync(join(PROTOCOL, d), join(p, d), { recursive: true });
  cpSync(join(PROTOCOL, 'package.json'), join(p, 'package.json'));
  symlinkSync(join(PROTOCOL, '..', 'core'), join(root, 'packages', 'core'));
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const pubHex = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
  const ids = join(p, 'src', 'genesis-ids.js');
  const before = readFileSync(ids, 'utf8');
  assert.equal(before.split(REAL_AUTHORITY).length, 2, 'the copy names the live authority once');
  writeFileSync(ids, before.replace(REAL_AUTHORITY, pubHex));
  const keys = mkdtempSync(join(tmpdir(), 'tn4-test-authority-'));
  writeFileSync(join(keys, 'testnet4-authority.pkcs8'), privateKey.export({ type: 'pkcs8', format: 'der' }));
  return { p, keys, publicKey };
}
const rawEd = (hex) => createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(hex, 'hex')]), format: 'der', type: 'spki' });
async function readSigned(p, file, name) {
  const mod = await import(`${pathToFileURL(join(p, 'src', file)).href}?${Date.now()}`);
  const { donationSetBodyId } = await import(pathToFileURL(join(p, 'src', 'authority.js')).href);
  const { donationSetId } = await import(pathToFileURL(join(p, 'src', 'donation.js')).href);
  const set = mod[name];
  return { mod, set, digest: Buffer.from(donationSetBodyId(set)), id: Buffer.from(donationSetId(set.recipients)).toString('hex') };
}
function verifiesOnlyUnder(digest, signature, publicKey) {
  assert.equal(edVerify(null, digest, publicKey, Buffer.from(signature)), true, 'verifies under the test key');
  assert.equal(edVerify(null, digest, rawEd(REAL_AUTHORITY), Buffer.from(signature)), false, 'not under the live authority');
  assert.equal(edVerify(null, digest, generateKeyPairSync('ed25519').publicKey, Buffer.from(signature)), false, 'not under another key');
  const flipped = Buffer.from(digest); flipped[0] ^= 1;
  assert.equal(edVerify(null, flipped, publicKey, Buffer.from(signature)), false, 'not over another body');
}

test('the LNURL set tool, signing with the copy\'s authority: serial 2, VALID_FROM, the two endpoints 6667/3333, signed by that key alone', async () => {
  const before = srcSums();
  const { p, keys, publicKey } = copyWithTestAuthority();
  const r = await run(join(p, 'tools', 'sign-testnet4-donation-set.mjs'), { ARENA_GENESIS_KEYS: keys, VALID_FROM: '160001' });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /testnet4 set serial 2 signed by [0-9a-f]{16}: [0-9a-f]{16}\.\.\.; wrote .*tn4-signer-.*\/src\/testnet4-donation-set\.js/);
  const { mod, set, digest, id } = await readSigned(p, 'testnet4-donation-set.js', 'TESTNET4_DONATION_SET');
  const { lnurlFor } = await import(pathToFileURL(join(p, 'src', 'bech32.js')).href);
  const { NETWORK_ID_TESTNET4 } = await import(pathToFileURL(join(p, 'src', 'genesis-ids.js')).href);
  assert.deepEqual(mod.TESTNET4_DONATION_ENDPOINTS, ['https://seat.example.com/lnurlp/blwp-donate-a', 'https://seat.example.com/lnurlp/blwp-donate-b']);
  assert.equal(set.serial, 2n);
  assert.equal(set.validFrom, 160001);
  assert.deepEqual(Buffer.from(set.networkId), Buffer.from(NETWORK_ID_TESTNET4));
  assert.deepEqual(set.recipients.map((x) => [x.lnurl, x.shareBps]), mod.TESTNET4_DONATION_ENDPOINTS.map((e, i) => [lnurlFor(e), [6667, 3333][i]]));
  assert.match(id, /^[0-9a-f]{64}$/);
  verifiesOnlyUnder(digest, set.signature, publicKey);
  assert.deepEqual(srcSums(), before, 'the real src/ is byte-identical');
});

test('the key set tool, signing with the copy\'s authority: serial 3, VALID_FROM, dev a then dev b at 6667/3333, its printed set id, signed by that key alone', async () => {
  const before = srcSums();
  const { p, keys, publicKey } = copyWithTestAuthority();
  const devs = ['dev a', 'dev b'].map((label) => {
    const d = mkdtempSync(join(tmpdir(), 'donor-'));
    const pk = createECDH('secp256k1'); pk.generateKeys();
    const hex = pk.getPublicKey('hex', 'compressed');
    writeFileSync(join(d, 'donor.json'), JSON.stringify({ recipientPkHex: hex, label }));
    return { d, hex, label };
  });
  const r = await run(join(p, 'tools', 'sign-testnet4-key-donation-set.mjs'), { ARENA_GENESIS_KEYS: keys, VALID_FROM: '160002', DONOR_DIRS: devs.map((x) => x.d).join(',') });
  assert.equal(r.code, 0, r.stderr);
  const said = JSON.parse(r.stdout.trim().split('\n').pop());
  const { set, digest, id } = await readSigned(p, 'testnet4-donation-set-keys.js', 'TESTNET4_DONATION_SET_KEYS');
  assert.equal(set.serial, 3n);
  assert.equal(set.validFrom, 160002);
  assert.deepEqual(set.recipients.map((x) => [x.label, Buffer.from(x.recipientPk).toString('hex'), x.shareBps]),
    devs.map((x, i) => [x.label, x.hex, [6667, 3333][i]]), 'dev a then dev b, their public keys, 6667 / 3333');
  assert.equal(said.setId, id, 'the set id it printed is the written set\'s');
  assert.deepEqual(said.recipients, devs.map((x, i) => [x.label, x.hex, [6667, 3333][i]]));
  verifiesOnlyUnder(digest, set.signature, publicKey);
  assert.deepEqual(srcSums(), before, 'the real src/ is byte-identical');
});
