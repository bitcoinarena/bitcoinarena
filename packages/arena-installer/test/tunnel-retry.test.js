// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// #704: a quick tunnel whose name never answers is started again; the test goes on with the new name.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testWithNewTunnels } from '../src/reach.js';

const identity = 'ab'.repeat(33);
const answering = (good) => async (u) => {
  if (!u.startsWith(good)) throw Object.assign(new Error('fetch failed'), { cause: { code: 'ENOTFOUND' } });
  return { status: 200, arrayBuffer: async () => Buffer.from(identity, 'hex') };
};

test('a dead quick tunnel name gets a new tunnel, and the new name is tested (#704)', async () => {
  const asked = []; let started = 0;
  const fetcher = async (u) => { asked.push(u); return answering('https://new-two.trycloudflare.com')(u); };
  const names = ['https://new-one.trycloudflare.com', 'https://new-two.trycloudflare.com'];
  const r = await testWithNewTunnels({ url: 'https://dead.trycloudflare.com', identity, fetcher, waitMs: 0, firstTries: 3, laterTries: 2,
    newTunnel: async () => names[started++] });
  assert.equal(r.reachTest.ok, true);
  assert.equal(r.url, 'https://new-two.trycloudflare.com');
  assert.equal(started, 2);
  assert.equal(asked.filter((u) => u.includes('dead')).length, 3);
  assert.equal(asked.filter((u) => u.includes('new-one')).length, 2);
});

test('a name that answers needs no new tunnel', async () => {
  let started = 0;
  const r = await testWithNewTunnels({ url: 'https://fine.trycloudflare.com', identity, fetcher: answering('https://fine'), waitMs: 0,
    newTunnel: async () => { started++; return null; } });
  assert.equal(r.reachTest.ok, true); assert.equal(started, 0);
});

test('after the last tunnel it fails with the reason, not forever', async () => {
  let started = 0;
  const r = await testWithNewTunnels({ url: 'https://dead.trycloudflare.com', identity, fetcher: answering('https://never'), waitMs: 0, firstTries: 2, laterTries: 2,
    newTunnel: async () => { started++; return `https://n${started}.trycloudflare.com`; } });
  assert.equal(r.reachTest.ok, false); assert.equal(started, 2); assert.match(r.reachTest.why, /ENOTFOUND/);
});
