// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A CLAIM KEY'S RUNS ASK ONLY WHAT IS STILL MISSING (kanban #791, measured 2026-10-30 01:3xZ on second-host seat 3: 25,000 /dkg requests
// served and 39,000 sent a minute - a committee one member never dealt to was run every second until its entry closed, and every run
// posted this node's contribution to each peer again and fetched each peer's again). dkg.js: a peer that took this node's contribution
// is not told again, a peer whose contribution is held is not asked again, and runAgainIn backs a stuck committee off to 30 s.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { openStore } from '../src/store.js';
import { Round } from '../src/round.js';
import { Dkg, runAgainIn } from '../src/dkg.js';
import { feldmanGroup, tweakPoint } from '../src/curve.js';
import { fromHex } from '../../arena-protocol/src/hash.js';

const curve = { ...feldmanGroup, tweakPoint };
const rand = (n) => new Uint8Array(randomBytes(n));

/** `n` signer nodes in one process, reached at http://n<i> through one fetcher that counts each /dkg call; `silent` never deals. */
function committee(n, { silent = -1 } = {}) {
  const st = { silent };
  const calls = [];
  const dkgs = [];
  const fetcher = async (url, opts = {}) => {
    const u = new URL(url); const i = Number(u.hostname.slice(1)); const method = opts.method || 'GET';
    calls.push({ to: i, method, path: u.pathname });
    const epoch = fromHex(u.searchParams.get('epoch'));
    const d = dkgs[i];
    if (u.pathname === '/dkg' && method === 'POST') {
      if (i === st.silent) return new Response('this node knows no such epoch', { status: 409 });
      const r = await d.accept(new Uint8Array(opts.body));
      return r.ok ? new Response('ok') : new Response(r.why, { status: 409 });
    }
    if (u.pathname === '/dkg') {
      const held = i === st.silent ? null : d.round.epoch(epoch);
      return held && held.mine ? new Response(held.mine) : new Response('none', { status: 404 });
    }
    if (u.pathname === '/dkg-agreement') {
      const a = i === st.silent ? { ok: false } : d.agreementBytes(epoch);
      return a.ok ? new Response(a.bytes) : new Response('none', { status: 404 });
    }
    return new Response('no such door', { status: 404 });
  };
  for (let i = 0; i < n; i++) dkgs.push(new Dkg(new Round(openStore(':memory:')), { curve, random: rand, fetcher }));
  const nodes = dkgs.map((d) => d.round.pubkey);
  const peersOf = (i) => dkgs.map((_, j) => `http://n${j}`).filter((_, j) => j !== i);
  return { dkgs, nodes, peersOf, calls, st };
}

const dkgCalls = (calls, from) => calls.slice(from).filter((c) => c.path === '/dkg').length;

test('once every peer holds this node\'s contribution and it holds theirs, a run posts and fetches no contribution again', async () => {
  const { dkgs, nodes, peersOf, calls } = committee(3);
  const k2 = { needed: 2 };
  await Promise.all(dkgs.map((d) => d.deal(nodes, k2)));
  const first = await dkgs[0].run(nodes, peersOf(0), k2);
  assert.deepEqual([first.told, first.got, first.moved], [2, 2, 4], 'both peers told, both asked');
  await dkgs[1].run(nodes, peersOf(1), k2); await dkgs[2].run(nodes, peersOf(2), k2);
  const before = calls.length;
  const again = await dkgs[0].run(nodes, peersOf(0), k2);
  assert.equal(dkgCalls(calls, before), 0, 'no POST or GET /dkg: nothing is missing');
  assert.deepEqual([again.told, again.got, again.moved], [2, 2, 0]);
  assert.equal(again.ok, true, again.why);
});

test('a member that never deals is the only one asked again, and the wait doubles to 30 s while nothing arrives', async () => {
  const { dkgs, nodes, peersOf, calls, st } = committee(4, { silent: 3 });
  const k3 = { needed: 3 };
  await Promise.all(dkgs.slice(0, 3).map((d) => d.deal(nodes, k3)));
  let said = await dkgs[0].run(nodes, peersOf(0), k3);
  assert.equal(said.ok, false);
  assert.deepEqual([said.told, said.got, said.have, said.of], [2, 2, 3, 4]);
  let w = runAgainIn(said, { waitMs: 1000 });
  assert.equal(w.waitMs, 1000, 'the first run added peers: 1 s');
  const waits = [];
  for (let k = 0; k < 6; k++) {
    const before = calls.length;
    said = await dkgs[0].run(nodes, peersOf(0), k3);
    const to = calls.slice(before).filter((c) => c.path === '/dkg').map((c) => c.to);
    assert.deepEqual([...new Set(to)], [3], 'only the silent member is told and asked');
    w = runAgainIn(said, w); waits.push(w.waitMs);
  }
  assert.deepEqual(waits, [2000, 4000, 8000, 16000, 30000, 30000]);
  // it deals at last: its contribution arrives, and the next run is in 1 s again
  await dkgs[3].deal(nodes, k3); st.silent = -1;
  said = await dkgs[0].run(nodes, peersOf(0), k3);
  assert.deepEqual([said.told, said.got, said.moved], [3, 3, 2], 'the late member told and asked once');
  assert.equal(said.have, undefined, 'past the count: waiting for agreements');
  assert.equal(runAgainIn(said, w).waitMs, 1000, 'every contribution in: 1 s');
});

test('runAgainIn: a contribution that arrived by being pushed counts as progress; a run with no count keeps 1 s', () => {
  assert.equal(runAgainIn({ have: 5, of: 7, moved: 0 }, { waitMs: 16000, had: 4 }).waitMs, 1000);
  assert.equal(runAgainIn({ have: 5, of: 7, moved: 0 }, { waitMs: 16000, had: 5 }).waitMs, 30000);
  assert.equal(runAgainIn({ ok: false, why: 'this node cannot make key material' }, { waitMs: 8000 }).waitMs, 1000);
});
