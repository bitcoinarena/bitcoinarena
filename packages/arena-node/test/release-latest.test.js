// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A NEW RELEASE IS AVAILABLE (release-latest.js): the newest release the Arena site names is offered only when the
// release key signed it and it is newer than this node's; versions compare as releases do (0.1.0-rc.2 < 0.1.0-rc.10 < 0.1.0 < 0.1.1).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { newerVersion, latestReleaseReader } from '../src/release-latest.js';
import { sumsSigned } from '../../arena-installer/src/release-verify.js';

test('versions: a release over its pre-releases, rc.N by number, a bad name never newer', () => {
  assert.equal(newerVersion('0.1.0-rc.3', '0.1.0-rc.2'), true);
  assert.equal(newerVersion('0.1.0-rc.10', '0.1.0-rc.9'), true, 'by number, not by text');
  assert.equal(newerVersion('0.1.0', '0.1.0-rc.10'), true);
  assert.equal(newerVersion('0.1.0-rc.2', '0.1.0'), false);
  assert.equal(newerVersion('0.1.1', '0.1.0'), true);
  assert.equal(newerVersion('0.2.0', '0.10.0'), false);
  assert.equal(newerVersion('v0.1.0', '0.1.0'), false, 'the same release');
  assert.equal(newerVersion('nonsense', '0.1.0'), false);
  assert.equal(newerVersion('0.1.0', null), true, 'a source checkout (no VERSION): any release is newer');
});

test('the newest release: offered when signed and newer, refused unsigned, kept six hours', async () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const keyHex = publicKey.export({ format: 'der', type: 'spki' }).subarray(12).toString('hex');
  const body = Buffer.from(JSON.stringify({ network: 'testnet4', version: '0.1.0-rc.3', tag: 'v0.1.0-rc.3', commit: 'ab'.repeat(20), release: 'https://example.invalid/v0.1.0-rc.3' }));
  const good = sign(null, body, privateKey).toString('base64');
  let asked = 0, sig = good, t = 0;
  const fetcher = async (u) => { asked++; const b = u.endsWith('.sig') ? Buffer.from(sig) : body; return { status: 200, arrayBuffer: async () => b }; };
  const verify = (bytes, s) => sumsSigned(bytes, s, keyHex);
  const r = latestReleaseReader({ url: 'https://example.invalid/latest.json', fetcher, verify, now: () => t });
  const a = await r.read('0.1.0-rc.2');
  assert.deepEqual([a.newer, a.latest.version, a.latest.release], [true, '0.1.0-rc.3', 'https://example.invalid/v0.1.0-rc.3']);
  assert.equal((await r.read('0.1.0-rc.3')).newer, false, 'up to date');
  assert.equal(asked, 2, 'read once (the file and its signature), then kept');
  t = 6 * 3600_000 + 1; sig = sign(null, Buffer.from('other'), privateKey).toString('base64');
  const b = await r.read('0.1.0-rc.2');
  assert.deepEqual([b.newer, b.latest], [false, null]);
  assert.match(b.why, /not signed by the Arena release key/);
  const none = await latestReleaseReader({ url: 'https://example.invalid/latest.json', fetcher, verify: null }).read('0.1.0');
  assert.match(none.why, /no release verifier/);
  const off = await latestReleaseReader({ url: '', fetcher, verify }).read('0.1.0');
  assert.match(off.why, /off on this node/);
  const down = await latestReleaseReader({ url: 'https://example.invalid/latest.json', fetcher: async () => ({ status: 404 }), verify }).read('0.1.0');
  assert.match(down.why, /could not be read: .* answered 404/);
});

test('release versions 2026.xx.yy and a fix 2026.xx.yy.zz (2026-10-19) compare part by part, and above the older 0.1.0-rc.N', async () => {
  const { newerVersion } = await import('../src/release-latest.js');
  for (const [a, b, want] of [['2026.1.0', '0.1.0-rc.25', true], ['2026.1.1', '2026.1.0', true], ['2026.1.1.1', '2026.1.1', true],
    ['2026.1.1', '2026.1.1.1', false], ['2026.2.0', '2026.1.9.9', true], ['2026.1.0', '2026.1.0', false], ['2027.1.0', '2026.9.9.9', true]]) {
    assert.equal(newerVersion(a, b), want, `${a} newer than ${b}: ${want}`);
  }
});

// THE TEST UPDATE CHANNEL (kanban #546): ARENA_LATEST_URL or arena.conf latest_url, only a latest.json on https://testnet.bitcoin-arena.io/
test('the update source: production by default; a test channel only on the Arena testnet site; anything else refused; empty turns checks off', async () => {
  const { latestUrlFrom } = await import('../src/release-latest.js');
  assert.deepEqual(latestUrlFrom({}), { url: 'https://testnet.bitcoin-arena.io/release/latest.json', why: null });
  assert.equal(latestUrlFrom({ ARENA_LATEST_URL: 'https://testnet.bitcoin-arena.io/release-test/latest.json' }).url, 'https://testnet.bitcoin-arena.io/release-test/latest.json');
  assert.equal(latestUrlFrom({}, { latest_url: 'https://testnet.bitcoin-arena.io/release-test/latest.json' }).url, 'https://testnet.bitcoin-arena.io/release-test/latest.json', 'from arena.conf');
  for (const bad of ['https://evil.example/latest.json', 'http://testnet.bitcoin-arena.io/release-test/latest.json', 'https://testnet.bitcoin-arena.io.evil.example/latest.json', 'https://testnet.bitcoin-arena.io/release-test/other.json'])
    { const r = latestUrlFrom({ ARENA_LATEST_URL: bad }); assert.equal(r.url, 'https://testnet.bitcoin-arena.io/release/latest.json', bad); assert.match(r.why, /refused, the production release read/); }
  assert.equal(latestUrlFrom({ ARENA_RELEASE_LATEST_URL: '' }).url, '');
});
