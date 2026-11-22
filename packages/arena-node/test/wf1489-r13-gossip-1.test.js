// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// wf1489 r13 gossip-1: Dkg.run asks every peer of the round's committees (settlement AND game, server.js makeClaimKey peersOf) one
// after the other, POST /dkg, GET /dkg and GET /dkg-agreement, with no timeout. One peer that takes the connection and never
// finishes its answer (or trickles it) holds the run forever: the peers after it are never told or asked, the claim key is never
// made, and makeClaimKey's attempt() never schedules another run (claimKeyRuns keeps the key). Safe: every peer ask is bounded, so
// a hung peer is passed by like a refusing one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { openStore } from '../src/store.js';
import { Round } from '../src/round.js';
import { Dkg } from '../src/dkg.js';
import { feldmanGroup, tweakPoint } from '../src/curve.js';
import { fromHex } from '../../arena-protocol/src/hash.js';

const curve = { ...feldmanGroup, tweakPoint };
const rand = (n) => new Uint8Array(randomBytes(n));

function committee(n) {
  const dkgs = [];
  const fetcher = async (url, opts = {}) => {
    const u = new URL(url);
    // the attacker: a seat of the round's game committee (not a signer node) that never finishes an answer, unless the ask is aborted
    if (u.hostname === 'evil') return new Promise((_, rej) => { if (opts.signal) opts.signal.addEventListener('abort', () => rej(new Error('aborted'))); });
    const i = Number(u.hostname.slice(1)); const method = opts.method || 'GET';
    const epoch = fromHex(u.searchParams.get('epoch'));
    const d = dkgs[i];
    if (u.pathname === '/dkg' && method === 'POST') { const r = await d.accept(new Uint8Array(opts.body)); return r.ok ? new Response('ok') : new Response(r.why, { status: 409 }); }
    if (u.pathname === '/dkg') { const held = d.round.epoch(epoch); return held && held.mine ? new Response(held.mine) : new Response('none', { status: 404 }); }
    if (u.pathname === '/dkg-agreement') { const a = d.agreementBytes(epoch); return a.ok ? new Response(a.bytes) : new Response('none', { status: 404 }); }
    return new Response('no such door', { status: 404 });
  };
  for (let i = 0; i < n; i++) dkgs.push(new Dkg(new Round(openStore(':memory:')), { curve, random: rand, fetcher }));
  return { dkgs, nodes: dkgs.map((d) => d.round.pubkey) };
}

test('one hung committee peer does not hold a seat\'s claim-key run forever', { timeout: 120000 }, async () => {
  const { dkgs, nodes } = committee(3);
  const k2 = { needed: 2 };
  await Promise.all(dkgs.map((d) => d.deal(nodes, k2)));
  // the two honest peers finish among themselves (they do not list the hung seat first)
  await dkgs[1].run(nodes, ['http://n0', 'http://n2'], k2);
  await dkgs[2].run(nodes, ['http://n0', 'http://n1'], k2);
  // seat 0's peers as makeClaimKey reads them: the hung game-committee seat first, then its two fellow signer nodes
  const LIMIT_MS = 60000;
  const run = dkgs[0].run(nodes, ['http://evil', 'http://n1', 'http://n2'], k2).then((r) => ({ done: true, r }));
  const timer = new Promise((res) => { const t = setTimeout(() => res({ done: false }), LIMIT_MS); t.unref?.(); });
  const got = await Promise.race([run, timer]);
  assert.equal(got.done, true, `dkg.run still waiting on the hung peer after ${LIMIT_MS / 1000} s: no claim key, and no further run is ever scheduled`);
  assert.equal(dkgs[0].signerNodeFor(nodes).ok, true, 'the honest committee made its key without the hung seat');
});
