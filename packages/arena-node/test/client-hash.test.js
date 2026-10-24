// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE PAGE A PLAYER IS SERVED IS CHECKED AGAINST A LIST THE PAGE NEVER SUPPLIES
// (§24, v4.6.2; F2's second clause). The list lives outside the bundle it
// pins, and the check runs outside the page, over what is actually served.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, mkdtempSync, copyFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const at = (p) => fileURLToPath(new URL(p, import.meta.url));
const TOOL = at('../tools/client-hash.mjs');
const LIST = JSON.parse(readFileSync(at('../../arena-client/known-good-clients.json'), 'utf8'));
const TEMPLATE = at('../../../src/arena-ui');
// The lock client (W1b) makes the player's stake lock, so it is pinned too.
const SCRIPTS = ['arena-client.js', 'arena-curve.js', 'blwp_lock_client.js', 'blwp_lock_client_bg.wasm'];
// AND EACH GAME'S OWN (one list per game): nextblock's core bundle, and its mark
const MARK = ['nextblock-icon.svg', 'nextblock-wordmark.svg', 'favicon.ico', 'apple-touch-icon.png', 'nextblock-icon-192.png',
  'nextblock-icon-512.png', 'nextblock-og.png', 'site.webmanifest'];
const GAME_SCRIPTS = { nextblock: ['blwp-core.js', ...MARK] };
// a file is pinned when the page's own list or any list of a game names it - a game's later versions keep lists of their own (markV6)
const pinsOf = (name) => [...(LIST.pinned[name] || []), ...Object.values(LIST.games).flatMap((g) => Object.values(g).filter((l) => l && typeof l === 'object' && !Array.isArray(l)).flatMap((l) => l[name] || []))];
const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
const run = (arg) => new Promise((done) => {
  execFile(process.execPath, [TOOL, arg], { encoding: 'utf8' }, (err, stdout) =>
    done({ code: err ? err.code : 0, out: stdout }));
});
const lineOf = (out, name) => (out.split('\n').find((l) => l.startsWith(name + ' ')) || '').replace(/\s+/g, ' ');

test('the list pins the scripts the rebuilt bundle and the template carry, and not index.html', () => {
  assert.deepEqual(Object.keys(LIST.pinned).sort(), [...SCRIPTS].sort());
  for (const [game, names] of Object.entries(GAME_SCRIPTS)) assert.deepEqual(Object.keys(LIST.games[game].pinned).sort(), [...names].sort(), game);
  for (const [name, source] of [['arena-client.js', '../../arena-client/dist/arena-client.js'],
    ['arena-curve.js', '../../arena-client/dist/arena-curve.js'], ['blwp-core.js', '../../nextblock/dist/blwp-core.js'],
    ['blwp_lock_client.js', '../../arena-client/dist/blwp_lock_client.js'],
    ['blwp_lock_client_bg.wasm', '../../arena-client/dist/blwp_lock_client_bg.wasm'],
    ...MARK.map((f) => [f, `../../nextblock/brand/${f}`])]) {
    assert.ok(pinsOf(name).includes(sha(at(source))), `${name}: the built file is not on the list`);
    assert.equal(sha(join(TEMPLATE, name)), sha(at(source)), `${name}: the template is not the built file`);
  }
  assert.ok(LIST.notPinned['index.html']);
  // and the bundle it pins is not where the list lives
  assert.ok(!readFileSync(at('../../arena-client/dist/arena-client.js'), 'utf8').includes('known-good-clients'));
});

test('the tool, over HTTP, finds the served template a known-good client, and says index.html is not pinned', async () => {
  const server = createServer((req, res) => {
    try { res.end(readFileSync(join(TEMPLATE, decodeURIComponent(req.url.slice(1))))); }
    catch { res.statusCode = 404; res.end(); }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const { code, out } = await run(`http://127.0.0.1:${server.address().port}/`);
    for (const name of SCRIPTS) assert.match(lineOf(out, name), / match /, out);
    assert.match(lineOf(out, 'index.html'), /not pinned/);
    assert.equal(code, 0);
  } finally { server.close(); }
});

test('a served script that differs by one byte is a MISMATCH, and a missing one is missing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'client-hash-'));
  // the engine's scripts and each game's, as the page serves both
  for (const name of [...SCRIPTS, ...Object.values(GAME_SCRIPTS).flat()]) copyFileSync(join(TEMPLATE, name), join(dir, name));
  const bytes = readFileSync(join(dir, 'arena-client.js'));
  bytes[bytes.length - 1] ^= 1;
  writeFileSync(join(dir, 'arena-client.js'), bytes);
  const tampered = await run(dir);
  assert.match(lineOf(tampered.out, 'arena-client.js'), /MISMATCH/);
  assert.match(lineOf(tampered.out, 'blwp-core.js'), / match /);
  assert.equal(tampered.code, 1);

  const gone = mkdtempSync(join(tmpdir(), 'client-hash-'));
  copyFileSync(join(TEMPLATE, 'arena-curve.js'), join(gone, 'arena-curve.js'));
  const partial = await run(gone);
  assert.match(lineOf(partial.out, 'arena-client.js'), /missing/);
  assert.equal(partial.code, 1);
});
