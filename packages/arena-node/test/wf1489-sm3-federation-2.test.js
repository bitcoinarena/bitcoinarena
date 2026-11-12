// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 sm3-find-federation 1 (state machine audit, federation): A FEDERATION THAT TURNS DRAINING BETWEEN AN ENTRY AND ITS LOCK.
// The page submits the stake lock to the federation first, posts the entry, and hands the lock to the seats afterwards, in the
// background, for up to LOCK_HAND_MS (a market order's until its entry close; client.js #handLocksUntilTaken). A seat that takes the
// federation's DRAINING/CRITICAL/HALTED record (gatherAll every 10 min) or a package naming a successor (markDraining) in that window
// refuses the lock at POST /lock - offerRefusalOfRound -> drainingRefusal, "no new round or deposit names it" - although the entry was
// taken while the federation was OPEN. The return door then refuses it too: POST /refused-lock answers "that player entered the round
// at this signer node: the stake is settled with the round", and the round never settles it, because no seat holds its lock. The
// player's stake sits in the draining federation until the lock's expiry (the round's stakeExpiryBlocks).
// Invariant: a stake lock of an entry a seat holds is either taken (/lock 201, settled with the round) or kept for its return.
// The draining state here is the one a restart with ARENA_DRAINING (the same markDraining a package update calls) puts the seat in.
import { CLOCK } from './block-clock.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TEST_FEDERATION_ID } from '../../arena-protocol/src/test-federation.js';
import { openStore } from '../src/store.js';
import { serve } from '../src/server.js';
import { assumeAssigned } from './assignment.js';
import { lockPort, bondedChainSlot, bondedChainFor } from './lock-fixture.js';
import { lockAndPlay, curve, lnurl } from './lock-round-fixture.js';
import { presentDay, b32, STAKE, WINDOW_MS, contractFor, opts } from './window-fixture.js';
import { testNow, skipTo } from './test-clock.js';
import { encodeRoundContract, roundId } from '../../arena-protocol/src/contracts.js';
import { lockFieldsToJson } from '../../arena-protocol/src/stake-lock.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { HOSTED } from './plugins/hosted.js';

// a socket the old daemon held may be handed out once more after the restart: asked again
async function post(url, body) {
  for (let i = 0; ; i++) { try { return await fetch(url, { method: 'POST', body }); } catch (e) { if (i >= 3) throw e; await new Promise((r) => setTimeout(r, 200)); } }
}
const player = (name, n) => ({ name, key: b32(n), worldSecret: new Uint8Array(32), ticks: 0, words: () => [0, 0, 0, 0, 0] });

async function seatsOnDisk() {
  const dir = mkdtempSync(join(tmpdir(), 'wf1489-sm3-fed-'));
  const slot = bondedChainSlot(lockPort());
  const port = slot.port;
  const address = lnurl(port);
  const start = async (name, at = 0) => {
    const d = await serve(openStore(join(dir, `${name}.sqlite`)),
      { plugins: HOSTED, port: at, ...opts, stakeLocks: port, poolCurve: curve, finality: { everyMs: 100 }, lnurlFetch: address.fetchLike,
        chainFor: slot.chainFor, randomnessFor: slot.randomnessFor });
    d.round.chainView = CLOCK.chainView();
    return d;
  };
  const w = { port, lnurl: address, a: await start('a'), b: await start('b') };
  const wire = () => {
    w.nodes = [w.a, w.b];
    for (const [d, o] of [[w.a, w.b], [w.b, w.a]]) {
      const there = [`http://127.0.0.1:${o.port}`];
      d.verifier.peers = there; d.stakeSecrets.peers = there; d.dkg.peers = there;
    }
  };
  wire();
  w.c = presentDay({ ...contractFor([w.a.round.pubkey, w.b.round.pubkey], BigInt(WINDOW_MS), [w.a, w.b].map((d) => `http://127.0.0.1:${d.port}`)),
    custody: 'FEDERATION', federationId: TEST_FEDERATION_ID, minScore: 1, stakeMsat: STAKE }, testNow() + 3000);
  w.c = { ...w.c, censusRoot: bondedChainFor(w.c.nodes, w.c, slot, { endpoints: [w.a, w.b].map((d) => `ws://127.0.0.1:${d.port}`) }).censusRoot };
  w.rid = roundId(w.c);
  w.randomness = slot.randomnessFor({ contract: w.c }).hash;
  for (const d of [w.a, w.b]) {
    const r = await fetch(`http://127.0.0.1:${d.port}/round`, { method: 'POST', body: encodeRoundContract(w.c) });
    assert.equal(r.status, 201, await r.text());
    assumeAssigned(d.round, w.rid, w.c.nodes);
  }
  for (let pass = 0; pass < 2; pass++) for (const d of [w.a, w.b]) await d.dkg.run(w.c.nodes);
  const held = w.a.dkg.signerNodeFor(w.c.nodes);
  assert.equal(held.ok, true, held.why);
  w.claimPk = held.pool.groupPublicKey;
  w.needed = 2;
  // both seats started again on their files and ports, with `env` set while they start
  w.restart = async (env = {}) => {
    const at = { a: w.a.port, b: w.b.port };
    await w.a.close(); await w.b.close();
    const saved = {}; for (const k of Object.keys(env)) { saved[k] = process.env[k]; process.env[k] = env[k]; }
    try { w.a = await start('a', at.a); w.b = await start('b', at.b); }
    finally { for (const k of Object.keys(env)) { process.env[k] = saved[k] === undefined ? '' : saved[k]; } }
    wire();
  };
  w.close = async () => { await w.a.close(); await w.b.close(); };
  return w;
}

test('#1489 sm3-federation-2 an entry taken while its federation was OPEN keeps a way for its stake lock once the federation is DRAINING', { timeout: 120000 }, async () => {
  const w = await seatsOnDisk();
  try {
    skipTo(Number(w.c.committeeTimeMs) + 20);
    // the page: the lock submitted to the federation, the entry posted to both seats; the locks are still being handed
    const p = await lockAndPlay(w, player('p', 0x73), { only: [], noMarks: true });
    console.log('  STEP: entered');
    for (const d of w.nodes) assert.ok(d.round.entry(p.eid), 'the entry is held at every seat');
    assert.ok(w.port.locks.has(`${toHex(p.outpoint.txid)}:0`), 'the stake lock is in the federation');
    // meanwhile both seats take the federation as draining (its successor named)
    await w.restart({ ARENA_DRAINING: `${toHex(TEST_FEDERATION_ID)}:${'5a'.repeat(32)}` });
    console.log('  STEP: restarted');
    const base = (d) => `http://127.0.0.1:${d.port}`;
    const lockSaid = [], returnSaid = [];
    for (const d of w.nodes) {
      const r = await post(`${base(d)}/lock?entry=${toHex(p.eid)}`, JSON.stringify(lockFieldsToJson(p.fields)));
      lockSaid.push([r.status, (await r.text()).slice(0, 140)]);
    }
    // the entries closed long ago (and the unentered grace with them): the return door is asked for the same lock
    skipTo(Number(w.c.entryCloseMs) + 3_600_000);
    for (const d of w.nodes) {
      const r = await post(`${base(d)}/refused-lock?round=${toHex(w.rid)}`,
        JSON.stringify({ outpoint: `${toHex(p.outpoint.txid)}:0`, fields: lockFieldsToJson(p.fields) }));
      returnSaid.push([r.status, (await r.text()).slice(0, 140)]);
    }
    const stillLocked = w.port.locks.has(`${toHex(p.outpoint.txid)}:0`);
    console.log('  FACTS:', JSON.stringify({ lockSaid, returnSaid, stillLocked, expiresInBlocks: p.fields.expiration - w.port.height }));
    // every seat that holds the entry must either take the lock or keep it for its return
    for (let i = 0; i < w.nodes.length; i++)
      assert.ok(lockSaid[i][0] === 201 || returnSaid[i][0] === 201,
        `seat ${i} holds the entry, refused its stake lock (${lockSaid[i][1]}) and refused its return (${returnSaid[i][1]}): the stake waits for the lock's expiry`);
  } finally { await w.close(); }
});
