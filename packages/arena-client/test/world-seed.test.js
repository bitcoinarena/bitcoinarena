// THE WORLD THE PLAYER DRIVES AND THE WORLD THE COMMITTEE REPLAYS ARE ONE
// WORLD, OR THE GHOST IS A PICTURE OF SOMEBODY ELSE.
//
// Measured on a real 2-of-2 round before this existed: `CoreDrivenTruck.seed`
// is `0x5eed1234`, a constant, and nothing ever set it from the round - so the
// page stepped its core in the harness world, bay 13, z 10.20 m, for every
// player of every round. The committee replays each entry with
// `seedWordForEntry(entry, randomness)`, which is a different word, a
// different bay and a different world. Two tabs of one round measured
//
//     the page's own core        bay 13   z  10.20 m
//     the committee's copy of it bay 20   z  57.80 m   (delta 47.60 m)
//     the committee's copy of it bay 18   z  44.20 m   (delta 34.00 m)
//
// before either truck moved, and the seed drives the rng stream after it - so
// the replayed truck is not a shifted copy of the driven one, it is a
// different run in a different world. That is the 17:05 photograph: one tab
// drawing the other truck on the grass at -69,-57 m while that truck was
// standing on its yellow bay.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ed25519 } from '@noble/curves/ed25519.js';
import { schnorr } from '@noble/curves/secp256k1.js';

import { standUpRound } from '../../arena-node/tools/round-2of2.mjs';
// #23: these are about PER-PLAYER worlds (the bridge must not fall back to the harness seed), so their rounds name the
// per-player config v3; the shared world (v4) is world-shared.test.js and world-shared-door.test.js.
import { TRUCK_V3_CONFIG_HASH } from '../../nextblock/plugin/nextblock.js';
import { joinFromQuery, tabSeed, playerFor, entryFor, fetchRandomness, worldSeedFor } from '../src/join.js';
import { feldmanGroup } from '../../arena-node/src/curve.js';
import { seedWordForEntry } from '../../arena-protocol/src/seed.js';
import { init as coreInit, step as coreStep, spawnBay, bayZ } from '../../nextblock/src/sim.js';
import { SOLO_SEED, SOLO_BAY } from '../../nextblock/src/rng.js';
import { O_TRUCK, T_X, T_Z, T_HEADING } from '../../nextblock/src/state.js';
import { roundId } from '../../arena-protocol/src/contracts.js';
import { Client } from '../src/client.js';
import { watchGhosts } from '../src/ghost-field.js';
import { createRequire } from 'node:module';
import { toHex } from '../../arena-protocol/src/hash.js';

const require = createRequire(import.meta.url);
const core = require('../../nextblock/dist/blwp-core.js');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const verify = (sg, m, k) => { try { return schnorr.verify(sg, m, k); } catch { return false; } };
const fromHexHere = (h) => Uint8Array.from(h.match(/../g).map((x) => parseInt(x, 16)));
const random = (n) => crypto.getRandomValues(new Uint8Array(n));
const storage = () => {
  const held = new Map();
  return { getItem: (k) => held.get(k) ?? null, setItem: (k, v) => held.set(k, v) };
};
const METRES = (w) => w / 65536;

/** Where a core seeded with `word` stands before it is stepped. */
const standsAt = (word) => {
  const st = coreInit(word);
  return { x: METRES(st.i32[O_TRUCK + T_X]), z: METRES(st.i32[O_TRUCK + T_Z]), bay: spawnBay(word) };
};

test('the daemons name one randomness for a round, and a page can ask them both', async () => {
  const round = await standUpRound({ host: '127.0.0.1', portA: 18210, portB: 18211, configHash: TRUCK_V3_CONFIG_HASH });
  try {
    const named = await joinFromQuery(new URL(round.url).search);
    const got = await fetchRandomness(round.id, named.nodes);
    assert.equal(got.randomness.length, 32);
    assert.ok(got.agreed >= 2, `only ${got.agreed} node(s) named the randomness`);
    console.log(`  both daemons name randomness ${toHex(got.randomness).slice(0, 16)}… at height ${got.height}`);

    // AND A NODE THAT NAMES A DIFFERENT WORLD IS A REFUSAL, not a vote. A
    // player alone in a world nobody replays is the fault this whole letter
    // is about, arriving by another road.
    const liar = async (u) => {
      if (!/randomness/.test(u)) return fetch(u);
      return new Response(new Uint8Array(32).fill(0xcc), { status: 200, headers: { 'x-height': '1' } });
    };
    await assert.rejects(
      () => fetchRandomness(round.id, named.nodes, {
        fetcher: (u) => (u.includes(named.nodes[0]) ? fetch(u) : liar(u)),
      }),
      /names two worlds is not one round|says this round's randomness is/);
  } finally { await round.close(); }
});

/**
 * THE SPLIT ITSELF, END TO END, AND IT IS NOT CIRCULAR.
 *
 * One tab drives. The other is shown pictures of it, produced by the daemon's
 * own replay. Those pictures are held against a core THIS TEST steps itself,
 * seeded with what `worldSeedFor` gives the page - and against a second core
 * seeded with the harness constant the page used to use. The first has to
 * match to the word; the second has to not, or this round cannot tell the two
 * apart and says so rather than passing.
 *
 * That is the 17:05 photograph as an assertion: a ghost on the grass at
 * -69,-57 m while the truck it is a picture of stands on its yellow bay.
 */
test('the ghost a watcher is shown is the driver\'s own core pose, and the harness seed is not', async () => {
  const round = await standUpRound({ host: '127.0.0.1', portA: 18212, portB: 18213, configHash: TRUCK_V3_CONFIG_HASH });
  const tabs = [];
  try {
    const named = await joinFromQuery(new URL(round.url).search);
    const rid0 = roundId(named.round);
    const beacon = await fetchRandomness(toHex(rid0), named.nodes);

    // A ROUND THAT CAN TELL THE TWO SEEDS APART, chosen rather than hoped for.
    // One player in 24 lands on the solo bay by chance, and a fixture that
    // agreed with the harness constant that often would be a test that passes
    // on the fault every 24th run. The driver's identity is drawn until its
    // own world is not the harness's, and the drawing is what makes the
    // comparison below mean something.
    const offBay = () => {
      for (let tries = 0; tries < 200; tries++) {
        const secret = ed25519.utils.randomSecretKey();
        const player = playerFor(named.round, { seed: tabSeed({ storage: storage(), random }), curve: feldmanGroup });
        const signerNode = entryFor(named.round, { seed: player.seed, curve: feldmanGroup, random });
        const entry = { ...signerNode, roundId: rid0, sessionPubkey: ed25519.getPublicKey(secret) };
        if (spawnBay(seedWordForEntry(entry, beacon.randomness)) !== SOLO_BAY)
          return { secret, signerNode };
      }
      throw new Error('200 identities all parked on the solo bay, which is not chance');
    };

    for (const which of ['driver', 'watcher']) {
      const drawn = which === 'driver' ? offBay()
        : { secret: ed25519.utils.randomSecretKey(),
            signerNode: entryFor(named.round, {
              seed: tabSeed({ storage: storage(), random }), curve: feldmanGroup, random,
            }) };
      const secret = drawn.secret;
      const signerNode = drawn.signerNode;
      const client = await Client.at({
        headers: named.chain.headers, bonds: named.chain.bonds,
        signedAdvert: fromHexHere(named.advert.signedAdvert),
        committee: named.round.nodes,
      }, {
        core: { hash: (st) => core.hash(st) },
        sign: (id) => ed25519.sign(id, secret),
        verify, contract: named.round, roundIdGiven: fromHexHere(round.id),
      });
      const rid = await client.openRound(named.round);
      const entry = { ...signerNode, roundId: rid, sessionPubkey: ed25519.getPublicKey(secret) };
      const eid = await client.join(entry);
      await client.connect();
      client.setRound({ roundId: rid, entryId: eid, blockTicks: named.round.blockTicks | 0 });
      tabs.push({ which, client, eid, entry, rid });
    }
    const [driver, watcher] = tabs;

    // WHAT THE PAGE WOULD SEED ITS CORE WITH, through the door that answers it.
    const world = await worldSeedFor({ entry: driver.entry, round: driver.rid, nodes: named.nodes, contract: named.round });
    const mine = coreInit(world.seedWord);
    const harness = coreInit(SOLO_SEED);
    console.log(`  the driver's own world is seed 0x${(world.seedWord >>> 0).toString(16)}, bay `
      + `${spawnBay(world.seedWord)}; the harness constant is bay ${SOLO_BAY}`);

    const field = watchGhosts(watcher.client, {
      roundId: watcher.entry.roundId, entryId: watcher.eid,
    });
    await field.watching;

    const WORDS = [45875, 22000, 0, 0, 0];
    const shown = [];
    for (let batch = 0; batch < 8; batch++) {
      for (let t = 0; t < 6; t++) {
        driver.client.record(WORDS);
        coreStep(mine, ...WORDS);
        coreStep(harness, ...WORDS);
      }
      await driver.client.drain();
      await wait(120);
      for (const g of field.drain(24))
        if (toHex(g.entryId) === toHex(driver.eid)) shown.push(g);
    }

    assert.ok(shown.length >= 1, 'the watcher was shown no picture of the driver at all');
    const last = shown[shown.length - 1];
    console.log(`  the watcher was shown ${shown.length} picture(s); the newest is tick ${last.tick} `
      + `at (${METRES(last.x).toFixed(3)}, ${METRES(last.z).toFixed(3)}) m`);

    // THE PICTURE IS THIS TICK'S POSE OF A CORE IN THE DRIVER'S OWN WORLD.
    // Stepped here from the same words, so nothing is taken on the daemon's
    // say-so.
    const at = poseAt(driver, world.seedWord, WORDS, last.tick);
    console.log(`  a core seeded with the driver's own world stands at `
      + `(${METRES(at.x).toFixed(3)}, ${METRES(at.z).toFixed(3)}) m at tick ${last.tick}`);
    assert.equal(last.x, at.x, 'the ghost is not at the x the driver\'s own world puts them');
    assert.equal(last.z, at.z, 'the ghost is not at the z the driver\'s own world puts them');
    assert.equal(last.heading, at.heading, 'the ghost is not facing where the driver faces');

    // AND THE HARNESS CONSTANT IS NOT THAT WORLD. This is the assertion that
    // fails on the 17:05 behaviour: a page seeding its core with 0x5eed1234
    // drove a truck standing here while every watcher was shown one standing
    // there.
    const wrong = poseAt(driver, SOLO_SEED, WORDS, last.tick);
    const apart = Math.hypot(METRES(wrong.x - at.x), METRES(wrong.z - at.z));
    console.log(`  the harness constant would have stood the same drive at `
      + `(${METRES(wrong.x).toFixed(3)}, ${METRES(wrong.z).toFixed(3)}) m - ${apart.toFixed(2)} m away`);
    assert.ok(apart > 0.5,
      'this round\'s entry-derived seed lands where the harness constant does, so it '
      + 'cannot tell a page that seeds from the round from one that seeds from a constant');
  } finally {
    for (const t of tabs) { try { t.client.close(); } catch { /* gone */ } }
    await round.close();
  }
});

/** A core in `word`'s world, stepped with the same five words to `tick`. */
function poseAt(driver, word, words, tick) {
  const st = coreInit(word);
  for (let t = 0; t <= tick; t++) coreStep(st, ...words);
  return {
    x: st.i32[O_TRUCK + T_X], z: st.i32[O_TRUCK + T_Z],
    heading: st.i32[O_TRUCK + T_HEADING],
  };
}
