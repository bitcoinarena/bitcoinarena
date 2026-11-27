// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// PUBLIC_URL AGAINST THE ADVERTISEMENT (kanban #3885, node operators 2026-11): public_url changed in arena.conf and the node restarted - the
// census reads only the on-chain advertisement, so it kept the old address and nothing said so. Now the difference is said and the
// advertisement update naming public_url is offered (the owner page's button) and posted once asked or once the outside check passes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nodeState } from '../src/state.js';
import { followReach, addressMismatch } from '../src/reach-follow.js';

const OLD = 'https://op-node.tail1234.ts.net';
const NEW = 'https://arena.example.org';

function node(reach, bond = { txid: '77'.repeat(32), vout: 0 }) {
  const home = mkdtempSync(join(tmpdir(), 'mm3885-'));
  const state = nodeState(home);
  state.save({ reach, bond });
  const posted = [];
  const refresh = async (o) => { const s = o.state.read(); posted.push(s.reach.url); o.state.save({ advertEndpoint: s.reach.url, endpointUpdate: { txid: 'bb'.repeat(32), endpoint: s.reach.url, atMs: 1 } }); return { ok: true, update: { txid: 'bb'.repeat(32) } }; };
  return { home, state, posted, refresh, removeTunnel: async () => ({ ok: true }) };
}

test('addressMismatch: public_url edited by hand on a bonded node is said and can be taken; a quick tunnel, a switch running or no bond cannot', () => {
  const s = { reach: { mode: 'tailscale', url: OLD }, bond: { txid: 'aa' } };
  assert.equal(addressMismatch({ s, publicEndpoint: OLD, censusRead: true, ownEndpoints: [OLD] }), null, 'the same address: nothing to say');
  const m = addressMismatch({ s, publicEndpoint: `${NEW}/`, censusRead: true, ownEndpoints: [OLD] });
  assert.equal(m.conf, NEW);
  assert.equal(m.confDiffers, true); assert.equal(m.censusDiffers, true); assert.equal(m.adoptable, true);
  assert.match(m.why, /public_url in arena\.conf is https:\/\/arena\.example\.org.*names https:\/\/op-node/);
  assert.match(m.why, /restarting changes nothing/);
  assert.equal(addressMismatch({ s, publicEndpoint: NEW, censusRead: true, ownEndpoints: [OLD], switching: true }).adoptable, false, 'a switch writes arena.conf itself');
  assert.equal(addressMismatch({ s: { ...s, bond: null }, publicEndpoint: NEW }).adoptable, false, 'no bond: no advertisement to update');
  assert.equal(addressMismatch({ s, publicEndpoint: 'https://a-b-c.trycloudflare.com' }).adoptable, false, 'a quick tunnel is never advertised');
  const q = addressMismatch({ s: { reach: { mode: 'quick', url: null }, bond: { txid: 'aa' } }, publicEndpoint: 'https://x-y.trycloudflare.com', censusRead: true, ownEndpoints: [OLD] });
  assert.equal(q.confDiffers, false); assert.equal(q.censusDiffers, true); assert.equal(q.quick, true); assert.equal(q.adoptable, false);
});

test('followReach: the mismatch is in the view and nothing is posted until asked; asked, public_url becomes the address and the update names it', async () => {
  const n = node({ mode: 'tailscale', port: 8470, url: OLD });
  const go = (extra = {}) => followReach({ home: n.home, state: n.state, publicEndpoint: NEW, censusRead: true, ownEndpoints: [OLD], refresh: n.refresh, removeTunnel: n.removeTunnel, nowMs: 1000, ...extra });
  let f = await go();
  assert.equal(n.posted.length, 0, 'before the change the census named OLD and the seat ran on NEW: nothing was ever posted');
  assert.equal(f.view.mismatch.adoptable, true);
  assert.equal(f.view.mismatch.conf, NEW);
  f = await go({ adoptUrl: NEW });
  assert.deepEqual(n.posted, [NEW], 'the update names public_url');
  assert.equal(n.state.read().reach.url, NEW);
  assert.equal(n.state.read().reach.adopted.from, OLD);
  assert.equal(n.state.read().reach.mode, 'tailscale', 'the way in kept');
  assert.ok(f.did.some((d) => /public_url https:\/\/arena\.example\.org taken/.test(d)));
  assert.equal(f.view.mismatch.confDiffers, false, 'arena.conf and the node agree now');
  assert.equal(f.view.mismatch.censusDiffers, true, 'the census until the update is 6 deep');
  assert.equal(f.view.update.txid, 'bb'.repeat(32));
  f = await go({ ownEndpoints: [NEW] });
  assert.equal(f.view.mismatch, null, 'the census names it: nothing to say');
  assert.equal(n.posted.length, 1);
});

test('followReach: accept() is the gate for taking it by itself - refused, it is said and not asked again for 10 min; a switch running is never taken', async () => {
  const n = node({ mode: 'permanent', port: 8470, url: OLD });
  let asked = 0, pass = false;
  const accept = async (u) => { asked++; assert.equal(u, NEW); return pass ? { ok: true } : { ok: false, why: 'no seat reached it' }; };
  const go = (nowMs, extra = {}) => followReach({ home: n.home, state: n.state, publicEndpoint: NEW, censusRead: true, ownEndpoints: [OLD], refresh: n.refresh, removeTunnel: n.removeTunnel, nowMs, accept, ...extra });
  let f = await go(1000);
  assert.equal(asked, 1); assert.equal(n.posted.length, 0);
  assert.equal(f.view.adopt.ok, false); assert.equal(f.view.adopt.why, 'no seat reached it');
  await go(2000); assert.equal(asked, 1, 'not asked again at once');
  writeFileSync(join(n.home, 'reach-switch.json'), JSON.stringify({ state: 'running', mode: 'permanent', atMs: 11 * 60000 }));
  pass = true;
  f = await go(12 * 60000);
  assert.equal(asked, 1, 'a switch running: its own address, not taken');
  assert.equal(f.view.mismatch.switching, true);
  writeFileSync(join(n.home, 'reach-switch.json'), JSON.stringify({ state: 'done', mode: 'permanent', atMs: 11 * 60000 }));
  f = await go(12 * 60000);
  assert.equal(asked, 2); assert.deepEqual(n.posted, [NEW]);
});

test('kanban #3886: the outside check gates every update - a switched address other seats cannot reach is not posted, and why', async () => {
  const n = node({ mode: 'tailscale', port: 8470, url: NEW });
  let pass = false, asked = 0;
  const accept = async () => { asked++; return pass ? { ok: true } : { ok: false, why: '2 of 2 seats could not reach it: its certificate is not valid', detail: { asked: 2 } }; };
  const go = (nowMs) => followReach({ home: n.home, state: n.state, publicEndpoint: NEW, censusRead: true, ownEndpoints: [OLD], refresh: n.refresh, removeTunnel: n.removeTunnel, nowMs, accept });
  let f = await go(1000);
  assert.equal(asked, 1); assert.equal(n.posted.length, 0, 'not posted');
  assert.match(f.view.update.why, /checked from outside first: 2 of 2 seats could not reach it/);
  assert.deepEqual(f.view.update.outside, { asked: 2 });
  await go(2000); assert.equal(asked, 1, 'tried again only after 10 min');
  pass = true;
  f = await go(11 * 60000);
  assert.equal(asked, 2); assert.deepEqual(n.posted, [NEW]);
  // the adopt path and the update in one pass: checked once
  const m = node({ mode: 'tailscale', port: 8470, url: OLD });
  let once = 0;
  await followReach({ home: m.home, state: m.state, publicEndpoint: NEW, censusRead: true, ownEndpoints: [OLD], refresh: m.refresh, removeTunnel: m.removeTunnel, nowMs: 1, accept: async () => { once++; return { ok: true }; } });
  assert.equal(once, 1); assert.deepEqual(m.posted, [NEW]);
});

test('kanban #3887: a public_url that is http, an IP or another port is said with its reason and never taken', async () => {
  for (const bad of ['http://203.0.113.9:8470', 'https://203.0.113.9', 'https://arena.example.org:8470']) {
    const n = node({ mode: 'tailscale', port: 8470, url: OLD });
    const f = await followReach({ home: n.home, state: n.state, publicEndpoint: bad, censusRead: true, ownEndpoints: [OLD], refresh: n.refresh, removeTunnel: n.removeTunnel, nowMs: 1, adoptUrl: bad, accept: async () => ({ ok: true }) });
    assert.equal(f.view.mismatch.adoptable, false, bad);
    assert.ok(f.view.mismatch.refusal && f.view.mismatch.refusal.why, bad);
    assert.equal(n.posted.length, 0, bad); assert.equal(n.state.read().reach.url, OLD, bad);
  }
});

test('kanban #3889: the update\'s progress - sent, n of 6 confirmations (the block it was found in kept), 6 deep, taken', async () => {
  const { progressOf } = await import('../src/reach-follow.js');
  const n = node({ mode: 'permanent', port: 8470, url: NEW });
  n.state.save({ chain: { kind: 'core' }, advertEndpoint: NEW, endpointUpdate: { txid: 'cc'.repeat(32), endpoint: NEW, tip: 100, atMs: 1 } });
  const asks = [];
  let answer = { depth: 0, height: null };
  const depthOf = async (chain, txid, o) => { asks.push({ chain: chain.kind, txid, ...o }); return answer; };
  const go = () => followReach({ home: n.home, state: n.state, publicEndpoint: NEW, censusRead: true, ownEndpoints: [OLD], refresh: n.refresh, removeTunnel: n.removeTunnel, nowMs: 5, depthOf });
  let f = await go();
  assert.deepEqual(asks[0], { chain: 'core', txid: 'cc'.repeat(32), sinceTip: 100, height: null });
  assert.equal(f.view.progress.step, 'sent'); assert.equal(f.view.progress.minutesLeft, 120);
  answer = { depth: 3, height: 101 };
  f = await go();
  assert.equal(f.view.progress.step, 'confirming'); assert.equal(f.view.progress.depth, 3); assert.equal(f.view.progress.minutesLeft, 90);
  answer = { depth: 6, height: 101 };
  f = await go();
  assert.equal(asks[2].height, 101, 'the block it was found in is kept: one getblockcount');
  assert.equal(f.view.progress.step, 'deep');
  f = await followReach({ home: n.home, state: n.state, publicEndpoint: NEW, censusRead: true, ownEndpoints: [NEW], refresh: n.refresh, removeTunnel: n.removeTunnel, nowMs: 6, depthOf });
  assert.equal(f.view.progress.step, 'taken'); assert.equal(asks.length, 3, 'taken: not asked again');
  assert.equal(progressOf(null), null);
  assert.equal(progressOf(null, { namesNew: true, censusRead: true }), null, 'the census named it with no update sent: no progress to show (seen in the Chrome check)');
});
