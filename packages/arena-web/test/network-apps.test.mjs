// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE NETWORK'S APPS IN REACT (kanban #564): a package is checked in the browser with the page's own client before the seat is asked;
// a failed check installs nothing; from the network list a passed one is taken at once; an update names the version it replaces; a node
// looked at by address shows the report and waits for Install. The page's client offers the five functions the screen is given.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NetworkAppsPanel, offersOf } from '../dist/test/network-apps.mjs';

const hex = (b) => Buffer.from(b).toString('hex');
const hosted = [{ id: 'aa', name: 'btc-updown', version: 14, devKey: 'dd'.repeat(32) }];
function setup({ pass = true, update = { ok: true } } = {}) {
  const posted = [], fetched = [];
  const client = {
    checkPackage: (pkg, o) => (pass && pkg.id === o.want ? { ok: true, checks: [{ check: 'the game id is the package\'s hash', ok: true }], version: pkg.version }
      : { ok: false, why: 'the developer signature does not verify', checks: [{ check: 'the developer signed it', ok: false }] }),
    checkUpdate: () => update, verifyEd25519: () => true, toHex: hex, fromHex: (h) => Buffer.from(h, 'hex'),
  };
  const api = { get: async (p) => (p === '/owner/plugins' ? { hosted } : { seats: [{ answered: true }], games: [] }), signed: async (a, args) => ({ a, args }),
    post: async (p, b) => { posted.push([p, b.a, b.args]); return { ok: true, checks: [{ check: 'checked again by the seat', ok: true }] }; },
    fetchJson: async (u) => { fetched.push(u); if (u.startsWith('https://gone')) throw new Error('ENOTFOUND'); if (u.includes('/plugin?game=')) return { id: u.split('=')[1], version: 15 }; if (u.endsWith('/games')) return { games: [{ id: 'bb', name: 'btc-updown', version: 15, manifest: ['aa'] }, { id: 'aa' }] }; throw new Error('no'); } };
  const c = new NetworkAppsPanel({ api, client });
  c.setState = (u) => { Object.assign(c.state, typeof u === 'function' ? u(c.state) : u); };
  c.state.hosted = hosted;
  return { c, posted, fetched };
}

test('a failed check in the browser installs nothing; a passed one from the network list is taken at once', async () => {
  const bad = setup({ pass: false });
  assert.equal(await bad.c.check({ g: { id: 'ee', title: 'X', version: 1 }, parent: null, from: 'https://n1', auto: true }), false);
  assert.deepEqual([bad.c.state.checks.ee.state, bad.posted.length], ['failed', 0]);
  const ok = setup();
  assert.equal(await ok.c.check({ g: { id: 'ff', title: 'Y', version: 1 }, parent: null, from: 'https://n1', auto: true }), true);
  assert.deepEqual(ok.fetched[0], 'https://n1/plugin?game=ff');
  assert.deepEqual(ok.posted[0], ['/owner/plugins/install', 'install', { game: 'ff', from: 'https://n1' }]);
  assert.equal(ok.c.state.checks.ff.state, 'taken');
});

test('an update is checked against the version hosted here and names what it replaces; a refused update installs nothing', async () => {
  const ok = setup();
  await ok.c.check({ g: { id: 'bb', title: 'Up/Down', version: 15 }, parent: hosted[0], from: 'https://n1', auto: true });
  assert.deepEqual(ok.posted[0], ['/owner/plugins/update', 'update', { game: 'bb', from: 'https://n1', replaces: 'aa' }]);
  const older = setup({ update: { ok: false, why: 'version 13 is not newer than 14' } });
  await older.c.check({ g: { id: 'bb', version: 13 }, parent: hosted[0], from: 'https://n1', auto: true });
  assert.deepEqual([older.c.state.checks.bb.state, older.c.state.checks.bb.why, older.posted.length], ['failed', 'version 13 is not newer than 14', 0]);
});

test('a node looked at by address: what it offers with the version it would update, the report, Install only on the owner\'s press', async () => {
  const s = setup();
  s.c.setState({ from: ' https://n2.example/ ' });
  await s.c.look();
  assert.deepEqual(s.c.state.look.offers.map((o) => [o.g.id, o.parent && o.parent.id]), [['bb', 'aa']], 'the one this node does not run, an update of aa');
  const { g, parent } = s.c.state.look.offers[0];
  assert.equal(await s.c.check({ g, parent, from: s.c.state.look.from, auto: false }), false);
  assert.deepEqual([s.c.state.checks.bb.state, s.posted.length], ['checked', 0], 'checked, nothing asked of the seat yet');
  await s.c.take(s.c.state.checks.bb.take);
  assert.equal(s.posted[0][0], '/owner/plugins/update');
  assert.deepEqual(offersOf([{ id: 'aa' }], hosted), []);
  const gone = setup(); gone.c.setState({ from: 'https://gone' }); await gone.c.look();
  assert.match(gone.c.state.lookError, /That seat did not answer/);
});

test('the page\'s own client offers the five functions the screen is given', async () => {
  const C = await import('../../arena-node/pages/owner-client.js');
  for (const f of ['checkPackage', 'checkUpdate', 'verifyEd25519', 'toHex', 'fromHex']) assert.equal(typeof C[f], 'function', f);
});
