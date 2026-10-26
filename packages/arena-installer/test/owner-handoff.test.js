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

// EVERY NODE AT ONCE (kanban #713, 2026-10-26: "You need to store credentials for *all* owner pages where its needed and provide links")
test('every node\'s key in one hand-over, each named by its node; the links listed on the page; the hand-over recorded in every home', async () => {
  const { allOwnerKeys } = await import('../src/owner-handoff.js');
  const homes = [0, 1, 2].map(() => mkdtempSync(join(tmpdir(), 'handoff-all-')));
  writeFileSync(join(homes[0], 'state.json'), JSON.stringify({ owner: { mode: 'seed' } })); writeFileSync(join(homes[0], 'seed.hex'), seed);
  writeFileSync(join(homes[1], 'state.json'), JSON.stringify({ owner: { mode: 'seed' } })); writeFileSync(join(homes[1], 'seed.hex'), '22'.repeat(32));
  writeFileSync(join(homes[2], 'state.json'), JSON.stringify({ owner: { mode: 'nostr-signer' } }));   // no key on disk: left out
  const nodes = [{ home: homes[0], key: 'a1'.repeat(32), instance: '', port: 8470 }, { home: homes[1], key: 'b2'.repeat(32), instance: 'b', port: 8570 },
    { home: homes[2], key: 'c3'.repeat(32), instance: 'c', port: 8670 }];
  const all = allOwnerKeys(nodes, 'https://testnet.bitcoin-arena.io/owner/');
  assert.deepEqual(all.keys, [{ node: 'a1'.repeat(32), kind: 'seed', seed }, { node: 'b2'.repeat(32), kind: 'seed', seed: '22'.repeat(32) }]);
  assert.deepEqual(all.links.map((l) => [l.label, l.url]), [['Node 1', `https://testnet.bitcoin-arena.io/owner/#node=${'a1'.repeat(32)}&local=http%3A%2F%2F127.0.0.1%3A8470`],
    ['Node b', `https://testnet.bitcoin-arena.io/owner/#node=${'b2'.repeat(32)}&local=http%3A%2F%2F127.0.0.1%3A8570`]]);
  const { url, done } = await serveHandoff({ home: homes[0], key: { keys: all.keys }, target: `${all.links[0].url}&owner-handoff`, links: all.links, homes: all.homes });
  const page = await ask(url);
  assert.ok(page.body.includes('Node b') && page.body.includes(`#node=${'b2'.repeat(32)}`), 'the page lists every owner page');
  assert.ok(!page.body.includes(seed) && !page.body.includes('22'.repeat(32)), 'the page itself never carries a key');
  assert.deepEqual(JSON.parse((await ask(url + '/key')).body), { ok: true, keys: all.keys });
  await ask(url + '/done', { method: 'POST' });
  assert.equal(await done, true);
  assert.deepEqual([handedAt(homes[0]) > 0, handedAt(homes[1]) > 0, handedAt(homes[2])], [true, true, null]);
});

test('no owner key on disk: nothing to hand over', () => {
  const home = mkdtempSync(join(tmpdir(), 'handoff-'));
  writeFileSync(join(home, 'state.json'), JSON.stringify({ owner: { mode: 'nostr-signer' } }));
  assert.equal(ownerKeyOf(home), null);
});
