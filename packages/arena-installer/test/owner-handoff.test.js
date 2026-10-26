// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// The owner key handed to the site's owner page by `bitcoinarena open` (the owner's playtest 2026-10-26: 1.9.8 asked for the 24 words).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { ownerKeyOf, serveHandoff, handedAt } from '../src/owner-handoff.js';

const seed = '1f'.repeat(32);
const ask = (url, { method = 'GET', host } = {}) => new Promise((ok, fail) => {
  const u = new URL(url);
  const r = request({ host: '127.0.0.1', port: u.port, path: u.pathname, method, headers: host ? { host } : {} }, (res) => { let b = ''; res.on('data', (d) => { b += d; }); res.on('end', () => ok({ status: res.statusCode, body: b })); });
  r.on('error', fail); r.end();
});

test('a seed node: the page opens the site with owner-handoff, the key is answered once, the hand-over is recorded', async () => {
  const home = mkdtempSync(join(tmpdir(), 'handoff-'));
  writeFileSync(join(home, 'state.json'), JSON.stringify({ owner: { mode: 'seed' } }));
  writeFileSync(join(home, 'seed.hex'), seed + '\n');
  const key = ownerKeyOf(home);
  assert.deepEqual(key, { kind: 'seed', seed });
  const target = 'https://testnet.bitcoin-arena.io/owner/#node=ab&owner-handoff';
  const { url, done } = await serveHandoff({ home, key, target });
  const page = await ask(url);
  assert.equal(page.status, 200);
  assert.ok(page.body.includes(JSON.stringify(target)) && page.body.includes('"https://testnet.bitcoin-arena.io"'));
  assert.ok(!page.body.includes(seed), 'the page itself never carries the key');
  assert.equal((await ask(url + '/key', { host: 'evil.example:80' })).status, 404, 'another host name gets nothing');
  assert.equal((await ask(url.replace(/\/[^/]+$/, '/wrong') + '/key')).status, 404);
  assert.deepEqual(JSON.parse((await ask(url + '/key')).body), { ok: true, kind: 'seed', seed });
  assert.equal((await ask(url + '/key')).status, 410, 'once');
  assert.equal(handedAt(home), null);
  await ask(url + '/done', { method: 'POST' });
  assert.equal(await done, true);
  assert.ok(handedAt(home) > 0);
});

test('no owner key on disk: nothing to hand over', () => {
  const home = mkdtempSync(join(tmpdir(), 'handoff-'));
  writeFileSync(join(home, 'state.json'), JSON.stringify({ owner: { mode: 'nostr-signer' } }));
  assert.equal(ownerKeyOf(home), null);
});
