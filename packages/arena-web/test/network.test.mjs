// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE NETWORK SCREEN IN REACT (kanban #564): the four lines in force, a draining federation, the installed packages with Remove, and
// another node's network checked in the browser with the page's client before the seat is asked; a failed check offers no Install.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NetworkPanel, FourRows, setInForce } from '../dist/test/network.mjs';

const own = { chain: 'testnet4', sets: [{ serial: '2', validFrom: 156000 }, { serial: '3', validFrom: 157000 }], series: [{ id: 'aa'.repeat(32), held: true }, { id: 'bb'.repeat(32), held: false }], federationId: '337ae01ad1e9bb35b5628faad3457e62' };
const mine = { chain: 'testnet4', own, installed: [{ network: 'cc'.repeat(32), id: 'dd'.repeat(32), chain: 'testnet4', sets: [{ serial: '3', validFrom: 157000 }], series: [] }],
  draining: [{ federationId: 'b18947f085d40df3aa', successor: '4dc88be70830d361aa', sinceMs: Date.UTC(2026, 9, 20, 4, 0) }] };

test('the four lines in force, a draining federation, an installed package with Remove', () => {
  assert.equal(setInForce(own.sets).serial, '3');
  const four = renderToStaticMarkup(React.createElement(FourRows, { network: own }));
  assert.match(four, /set 3 in force \(since block 157000\)/); assert.match(four, /1 running · 1 not on this node/); assert.match(four, /337ae01ad1e9bb35…/);
  const html = renderToStaticMarkup(React.createElement(NetworkPanel, { initial: { loaded: true, mine, games: [] } }));
  assert.match(html, /Federation b18947f085d4… is being replaced by 4dc88be70830… \(since 2026-10-20 04:00 UTC\)/);
  assert.match(html, /Installed · network cccccccccccc… · package dddddddddddd…/); assert.match(html, />Remove</);
});

function driven({ pass = true, update = { ok: true } } = {}) {
  const posted = [];
  const client = { verifyEd25519: () => true,
    checkNetworkPackage: (pkg, o) => (pass && o.seatChain === 'testnet4' ? { ok: true, checks: [{ check: 'its network id commits to testnet4', ok: true }] } : { ok: false, why: 'the series names a game this node does not host', checks: [{ check: 'series', ok: false }] }),
    checkNetworkUpdate: () => update };
  const api = { get: async (p) => (p === '/owner/network' ? mine : { hosted: [{ id: 'aa'.repeat(32) }] }), signed: async (a, args) => ({ a, args }),
    post: async (p, b) => { posted.push([p, b.a, b.args]); return { ok: true, checks: [{ check: 'checked again by the seat', ok: true }] }; },
    fetchJson: async (u) => { if (u.startsWith('https://gone')) throw new Error('ENOTFOUND'); return { id: 'ee'.repeat(32), title: 'Arena testnet4', manifest: { networkId: u.includes('n2') ? 'cc'.repeat(32) : 'ff'.repeat(32), chain: 'testnet4', donationSets: [], series: [], federationId: '337ae01a' } }; } };
  const c = new NetworkPanel({ api, client }); c.setState = (u) => { Object.assign(c.state, typeof u === 'function' ? u(c.state) : u); };
  return { c, posted };
}

test('another node\'s network: checked in the browser, Install only after the check passed; a failed check offers none; an update checked against the set in force', async () => {
  const bad = driven({ pass: false }); await bad.c.reload(); bad.c.setState({ from: 'https://n1' }); await bad.c.look(); bad.c.check();
  assert.deepEqual([bad.c.state.take, bad.posted.length], [false, 0]);
  const ok = driven(); await ok.c.reload(); ok.c.setState({ from: 'https://n1/' }); await ok.c.look(); ok.c.check();
  assert.equal(ok.c.state.take, true); await ok.c.take();
  assert.deepEqual(ok.posted[0], ['/owner/network/install', 'network-install', { network: 'ff'.repeat(32), from: 'https://n1' }]);
  const up = driven({ update: { ok: false, why: 'set 2 is not newer than 3' } }); await up.c.reload(); up.c.setState({ from: 'https://n2' }); await up.c.look();
  assert.ok(up.c.state.offer.installed, 'an update of the installed network'); up.c.check();
  assert.deepEqual([up.c.state.take, up.c.state.error], [false, 'set 2 is not newer than 3']);
  const up2 = driven(); await up2.c.reload(); up2.c.setState({ from: 'https://n2' }); await up2.c.look(); up2.c.check(); await up2.c.take();
  assert.equal(up2.posted[0][0], '/owner/network/update');
  await ok.c.remove('cc'.repeat(32)); assert.deepEqual(ok.posted.at(-1), ['/owner/network/remove', 'network-remove', { network: 'cc'.repeat(32) }]);
  const gone = driven(); await gone.c.reload(); gone.c.setState({ from: 'https://gone' }); await gone.c.look();
  assert.match(gone.c.state.error, /did not hand its network over: ENOTFOUND/);
});

test('the page\'s client offers the network checks the screen is given', async () => {
  const C = await import('../../arena-node/pages/owner-client.js');
  for (const f of ['checkNetworkPackage', 'checkNetworkUpdate', 'verifyEd25519']) assert.equal(typeof C[f], 'function', f);
});
