// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 sm2-find-entry 6 (state machine audit round 2, entry): THE RETURN DOOR TAKES A HELD ENTRY'S OWN STAKE LOCK DURING A DRAIN.
// Since #1848 a seat keeps taking the locks of an entry it took before its federation turned DRAINING (POST /lock asks offerRefusalOfRound
// with held: true), but POST /refused-lock still reads the drain as a refusal (unenteredReturnOfRound -> offerRefusalOfRound without held)
// and counts the player as entered only once his stake is seen or his lock verified here (#1582). So while the page's background hand-over
// (client.js #handLocksUntilTaken) has reached one seat and not yet the other, anyone (the lock fields are all public: the entry's outpoint,
// stake point, net stake and refund key, the round's claim key, the federation's expiry) hands that very lock to the other seat's return
// door: it is kept there as a refused-round lock, and from then on returnedHere (#1639) refuses it at POST /lock and at every peer repair.
// One seat stakes the entry, the other never can: the seats hold different entry sets for the round.
// (original header follows)
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

test('#1489 sm2-entry-6 a held entry\'s stake lock handed to the return door during a drain still stakes the entry at that seat', { timeout: 120000 }, async () => {
  const w = await seatsOnDisk();
  try {
    skipTo(Number(w.c.committeeTimeMs) + 20);
    const p = await lockAndPlay(w, player('p', 0x74), { only: [], noMarks: true });
    for (const d of w.nodes) assert.ok(d.round.entry(p.eid), 'the entry is held at every seat');
    await w.restart({ ARENA_DRAINING: `${toHex(TEST_FEDERATION_ID)}:${'5a'.repeat(32)}` });
    const base = (d) => `http://127.0.0.1:${d.port}`;
    const lockBody = JSON.stringify(lockFieldsToJson(p.fields));

    // the page's hand-over reached seat a
    const atA = await post(`${base(w.a)}/lock?entry=${toHex(p.eid)}`, lockBody);
    const atAText = (await atA.text()).slice(0, 140);
    // before it reaches seat b, the same public lock is handed to seat b's return door
    const ret = await post(`${base(w.b)}/refused-lock?round=${toHex(w.rid)}`,
      JSON.stringify({ outpoint: `${toHex(p.outpoint.txid)}:0`, fields: lockFieldsToJson(p.fields) }));
    const retText = (await ret.text()).slice(0, 140);
    // then the page's hand-over reaches seat b
    const atB = await post(`${base(w.b)}/lock?entry=${toHex(p.eid)}`, lockBody);
    const atBText = (await atB.text()).slice(0, 160);
    const op = `${toHex(p.outpoint.txid)}:0`;
    const facts = { atA: [atA.status, atAText], ret: [ret.status, retText], atB: [atB.status, atBText],
      stakedA: !!w.a.round.stakeLock(p.eid), stakedB: !!w.b.round.stakeLock(p.eid), keptAsRefusedB: !!w.b.round.refusedLockAt(op) };
    console.log('  FACTS:', JSON.stringify(facts));
    assert.equal(atA.status, 201, `seat a takes the held entry's lock during the drain (#1848): ${atAText}`);
    // the invariant: a lock the seats take for an entry they both hold is taken at both, never staked at one and kept for return at the other
    assert.equal(facts.stakedA, facts.stakedB,
      `seat a stakes the entry with its lock and seat b refused the same lock (${atBText}) after keeping it as a refused-round lock (${retText}): the seats hold different entry sets`);
  } finally { await w.close(); }
});
