// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A MARK NAMES THE INPUTS IT COMES FROM (kanban #3758, ruled 2026-11-25: the client sends the real head). The page's bridge calls
// markNow(hash, tick) with no input chain, and the client filled in GENESIS: every mark committed to no batch. Since #3567 a seat
// replays a close only through the inputs the last carried mark committed to, so such a run was cut back to its join tick, the replay
// had no ticks ("that transcript carries no ticks"), and no seat ever signed it. Now each mark names the first batch of the client's
// chain that reaches its tick - not the newest, which a peer may not hold yet - and the canonical transcript both seats build commits
// to inputs through the last mark. Two real seats (round-2of2), the page's own order.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { ed25519 } from '@noble/curves/ed25519.js';
import { schnorr } from '@noble/curves/secp256k1.js';

import { standUpRound } from '../../arena-node/tools/round-2of2.mjs';
import { Client } from '../src/client.js';
import { joinFromQuery, tabSeed, playerFor, entryFor } from '../src/join.js';
import { feldmanGroup } from '../../arena-node/src/curve.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { splitSignedBatch, batchTicks, batchId } from '../../arena-protocol/src/batch.js';
import { decodeTranscript, GENESIS } from '../../arena-protocol/src/transcript.js';
import { init as coreInit, step as coreStep } from '../../nextblock/src/sim.js';

const require = createRequire(import.meta.url);
const core = require('../../nextblock/dist/blwp-core.js');
const verify = (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } };
const random = (n) => crypto.getRandomValues(new Uint8Array(n));
const storage = () => { const held = new Map(); return { getItem: (k) => held.get(k) ?? null, setItem: (k, v) => held.set(k, v) }; };
const fromHexHere = (hex) => Uint8Array.from(hex.match(/../g), (x) => parseInt(x, 16));

async function tab(round, named) {
  const secret = ed25519.utils.randomSecretKey();
  const player = playerFor(named.round, { seed: tabSeed({ storage: storage(), random }), curve: feldmanGroup });
  const signerNode = entryFor(named.round, { seed: player.seed, curve: feldmanGroup, random });
  const client = await Client.at({
    headers: named.chain.headers, bonds: named.chain.bonds, signedAdvert: fromHexHere(named.advert.signedAdvert),
    committee: named.round.nodes, nodes: named.nodes,
  }, { core: { hash: (st) => core.hash(st) }, sign: (id) => ed25519.sign(id, secret), verify, contract: named.round, roundIdGiven: fromHexHere(round.id) });
  const rid = await client.openRound(named.round);
  const eid = await client.join({ ...signerNode, roundId: rid, sessionPubkey: ed25519.getPublicKey(secret) });
  await client.connect();
  client.setRound({ roundId: rid, entryId: eid, blockTicks: named.round.blockTicks | 0 });
  return { client, rid, eid };
}
async function publishAll(client) {
  for (let i = 0; i < 500 && (client.hold.length || client.publishing); i++) {
    await (client.drain() || client.publishing);
    await client.awaitPublishes();
  }
  await client.awaitPeers();
}
function driven(seed, tick) {
  const st = coreInit(seed);
  for (let t = 0; t < tick; t++) coreStep(st, 45875, 0, 0, 0, 0);
  return core.hash(st);
}
const drive = (client, n) => { for (let i = 0; i < n; i++) client.record([45875, 0, 0, 0, 0]); };
/** The batch of this client's chain that first reaches `tick`: the head a mark at `tick` has to name. */
const headThrough = (client, tick) => { const p = client.published.find((x) => x.through >= tick); return p ? toHex(splitSignedBatch(p.bytes).id) : null; };
const storedOn = async (base, rid, eid) => {
  const r = await fetch(`${base}/transcript?round=${toHex(rid)}&entry=${toHex(eid)}`);
  assert.equal(r.status, 200, `${base} serves no transcript`);
  return decodeTranscript(new Uint8Array(await r.arrayBuffer()));
};

test('#3758 every mark names the batch that reaches its tick, and both seats hold that batch: the inputs the mark commits to reach its tick', async () => {
  const round = await standUpRound({ host: '127.0.0.1', portA: 18760, portB: 18761 });
  let t;
  try {
    const named = await joinFromQuery(new URL(round.url).search);
    t = await tab(round, named);
    const { client, rid, eid } = t;
    const [A, B] = [client.base, ...client.peers];
    const named60 = [];

    // THE PAGE'S ORDER: record, then mark at once, with the mark's last ticks still in the hold
    for (const tick of [60, 120]) {
      drive(client, 60);
      const r = await client.markNow(driven(7, tick), tick);
      assert.equal(r.live, true, `the mark at ${tick} did not go live: ${r.answer}`);
      named60.push([tick, toHex(r.checkpoint.inputChainHash)]);
    }
    // A BATCH PAST THE MARK ALREADY OUT: ticks to 210 published, then the mark at 180 names the batch reaching 180, not the newest
    drive(client, 60); await publishAll(client);
    drive(client, 30); await publishAll(client);
    const r180 = await client.markNow(driven(7, 180), 180);
    assert.equal(r180.live, true, `the mark at 180 did not go live: ${r180.answer}`);
    named60.push([180, toHex(r180.checkpoint.inputChainHash)]);
    assert.notEqual(headThrough(client, 180), toHex(client.batchHead), 'the setup: a batch past tick 180 is out');

    for (const [tick, named] of named60) {
      assert.notEqual(named, toHex(GENESIS), `the mark at ${tick} commits to no inputs`);
      assert.equal(named, headThrough(client, tick), `the mark at ${tick} names another batch than the one reaching its tick`);
    }

    // WHAT #3567 CUTS ON (a close replays through the inputs the last carried mark commits to): at both seats the batch each mark
    // names is held and reaches the mark's tick, so the cut takes nothing off
    await client.awaitPeers();
    for (const base of [A, B]) {
      const held = new Map(); let through = null;
      for (const b of (await storedOn(base, rid, eid)).batches) { const at = batchTicks(b); if (at.length) through = at.at(-1) + 1; held.set(toHex(batchId(b)), through); }
      for (const [tick, named] of named60) {
        assert.ok(held.has(named), `${base} does not hold the batch the mark at ${tick} names`);
        assert.ok(held.get(named) >= tick, `${base}: the inputs the mark at ${tick} commits to end at ${held.get(named)}`);
      }
    }
  } finally {
    if (t) { t.client.ended = true; t.client.close(); }
    await round.close();
  }
});
