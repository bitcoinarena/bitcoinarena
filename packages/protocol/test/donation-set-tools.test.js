// THE TOOLS THAT SIGN TESTNET4'S DONATION SETS REFUSE EVERY KEY BUT TESTNET4'S AUTHORITY, AND WRITE NOTHING WHEN THEY DO
// (kanban #148, plan comment 222). tools/sign-testnet4-donation-set.mjs and sign-testnet4-key-donation-set.mjs run as they are
// run, with BLWP_GENESIS_KEYS pointing at a temp dir holding a TEST key - never the live authority's. Both write straight into
// src/ (testnet4-donation-set.js, testnet4-donation-set-keys.js) once they sign, so each refusal is checked against those two
// files' bytes, before and after: a refused run changes nothing. Signing itself needs the live authority key, which no test uses.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { generateKeyPairSync, createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
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
  const other = await run(LNURL_TOOL, { BLWP_GENESIS_KEYS: keyDir('ed25519') });
  assert.notEqual(other.code, 0);
  assert.match(other.stderr, /that key is not the donation authority testnet4 genesis names/);
  const ec = await run(LNURL_TOOL, { BLWP_GENESIS_KEYS: keyDir('secp256k1') });
  assert.notEqual(ec.code, 0);
  assert.match(ec.stderr, /the testnet4 donation authority key is not Ed25519/);
  const none = await run(LNURL_TOOL, { BLWP_GENESIS_KEYS: mkdtempSync(join(tmpdir(), 'tn4-none-')) });
  assert.notEqual(none.code, 0);
  assert.match(none.stderr, /ENOENT/);
  assert.deepEqual(sums(), before, 'a refused run changed src/');
});

test('the key set tool refuses missing donors, a missing VALID_FROM, and a key that is not testnet4\'s authority, and writes nothing', async () => {
  const before = sums();
  const noDonors = await run(KEY_TOOL, { BLWP_GENESIS_KEYS: keyDir('ed25519'), VALID_FROM: '154960', DONOR_DIRS: '' });
  assert.match(noDonors.stderr, /DONOR_DIRS names the two dev clients, dev a then dev b/);
  const one = await run(KEY_TOOL, { BLWP_GENESIS_KEYS: keyDir('ed25519'), VALID_FROM: '154960', DONOR_DIRS: donorDirs().split(',')[0] });
  assert.match(one.stderr, /DONOR_DIRS names the two dev clients/);
  const noHeight = await run(KEY_TOOL, { BLWP_GENESIS_KEYS: keyDir('ed25519'), DONOR_DIRS: donorDirs(), VALID_FROM: '' });
  assert.match(noHeight.stderr, /VALID_FROM is the block height the set is in force from/);
  const other = await run(KEY_TOOL, { BLWP_GENESIS_KEYS: keyDir('ed25519'), DONOR_DIRS: donorDirs(), VALID_FROM: '154960' });
  assert.notEqual(other.code, 0);
  assert.match(other.stderr, /that key is not the donation authority testnet4 genesis names/);
  const ec = await run(KEY_TOOL, { BLWP_GENESIS_KEYS: keyDir('secp256k1'), DONOR_DIRS: donorDirs(), VALID_FROM: '154960' });
  assert.match(ec.stderr, /the testnet4 donation authority key is not Ed25519/);
  const missing = await run(KEY_TOOL, { BLWP_GENESIS_KEYS: keyDir('ed25519'), DONOR_DIRS: `${mkdtempSync(join(tmpdir(), 'x-'))},${mkdtempSync(join(tmpdir(), 'y-'))}`, VALID_FROM: '154960' });
  assert.match(missing.stderr, /ENOENT/);
  assert.deepEqual(sums(), before, 'a refused run changed src/');
});
