// IS THE DRAWN GHOST THE OTHER CLIENT'S TRUCK? (the owner 2026-09-18 12:02: "Drawn pose must match the other client's
// truck", and the shots where the other truck is not where it can be seen.)
//
// Step two of the agreed order, after the round-boundary counts. Every picture names a TICK; this steps a core of the
// driver's own world with the driver's own inputs to that same tick and compares the two poses, word for word in
// Q16.16. Same tick, same world:
//   - if they differ, the node's replay and the driver's core are in different worlds, and no drawing rule can fix it
//   - if they agree, every "wrong place" a player sees is staleness: a picture that is old, or a truck of a round
//     that is over, which is what the round-boundary counts already found
//
// The driver DRIVES here rather than standing at its door - a parked truck would make any two worlds agree.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { webcrypto as crypto } from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519.js';
import { schnorr } from '@noble/curves/secp256k1.js';

import { Client } from '../src/client.js';
import { joinFromQuery, tabSeed, playerFor, entryFor, worldSeedFor } from '../src/join.js';
import { watchGhosts } from '../src/ghost-field.js';
import { fetchLobby } from '../src/lobby.js';
import { feldmanGroup } from '../../blwp-node/src/curve.js';
import { toHex, fromHex } from '../../protocol/src/hash.js';
import { init as coreInit, step as coreStep } from '../../core/src/sim.js';
import { O_TRUCK, T_X, T_Z, T_HEADING } from '../../core/src/state.js';

const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d; };
const DAILY = arg('daily', process.env.BLWP_2OF2_DIR || '/mnt/bitcoin/blwp-2of2');
const MINUTES = Number(arg('minutes', 6));
const PARKED = process.argv.includes('--parked');
const require = createRequire(import.meta.url);
const core = require('../../core/dist/blwp-core.js');
const verify = (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } };
const random = (n) => crypto.getRandomValues(new Uint8Array(n));
const storage = () => { const held = new Map(); return { getItem: (k) => held.get(k) ?? null, setItem: (k, v) => held.set(k, v) }; };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (l) => console.log(`${new Date().toISOString().slice(11, 19)}  ${l}`);
const METRES = (w) => w / 65536;
const daily = JSON.parse(readFileSync(`${DAILY}/daily.json`, 'utf8'));
const NODES = daily.node;

async function freeRound(until) {
  for (;;) {
    const lobby = await fetchLobby({ nodes: NODES, verify }).catch(() => ({ rows: [] }));
    const open = (lobby.rows || []).filter((r) => r.phase === 'open' && r.free && r.joinable
      && Number(r.entryCloseMs || 0) > Date.now() + 20000);
    const pick = open.sort((a, b) => Number(b.entryCloseMs || 0) - Number(a.entryCloseMs || 0))[0];
    if (pick) return pick.id;
    if (Date.now() >= until) return null;
    await wait(5000);
  }
}

async function seat(named, roundIdHex, until = Date.now() + 120000) {
  for (;;) {
    try { return await seated(named, roundIdHex); }
    catch (e) {
      if (Date.now() >= until || !/still reading its chain view|no beacon|randomness/.test(e.message)) throw e;
      await wait(5000);
    }
  }
}

async function seated(named, roundIdHex) {
  const secret = ed25519.utils.randomSecretKey();
  const player = playerFor(named.round, { seed: tabSeed({ storage: storage(), random }), curve: feldmanGroup });
  const built = entryFor(named.round, { seed: player.seed, curve: feldmanGroup, random });
  const client = await Client.at({
    headers: named.chain.headers, bonds: named.chain.bonds,
    signedAdvert: fromHex(named.advert.signedAdvert), committee: named.round.nodes,
  }, {
    core: { hash: (st) => core.hash(st) },
    sign: (id) => ed25519.sign(id, secret),
    verify, contract: named.round, roundIdGiven: fromHex(roundIdHex),
  });
  const rid = await client.openRound(named.round);
  const entry = { ...built, roundId: rid, sessionPubkey: ed25519.getPublicKey(secret) };
  const eid = await client.join(entry);
  await client.connect();
  client.setRound({ roundId: rid, entryId: eid, blockTicks: named.round.blockTicks | 0 });
  return { client, rid, eid, entry };
}

const until = Date.now() + MINUTES * 60000;
say(`# the Daily, ${MINUTES} min: every picture against the driver's own core at the same tick`
  + (PARKED ? ' (the driver is PARKED: the control)' : ' (the driver drives)'));

const roundIdHex = await freeRound(until);
if (!roundIdHex) { say('the Daily listed no joinable free round'); process.exit(0); }
const named = await joinFromQuery(
  `?round=${roundIdHex}&node=${NODES.join(',')}&bond=${daily.bond}&advert=${daily.advert}`);
const driver = await seat(named, roundIdHex);
const watcher = await seat(named, roundIdHex);
const field = watchGhosts(watcher.client, { roundId: watcher.rid, entryId: watcher.eid });
await field.watching;
const mine = toHex(driver.eid);

// THE DRIVER'S OWN WORLD, asked of the nodes exactly as the page asks.
const world = await worldSeedFor({ entry: driver.entry, round: driver.rid, nodes: named.nodes });
say(`the driver's world seed word is ${world.seedWord >>> 0}`);
const st = coreInit(world.seedWord);
const poseAt = [];                       // what the driver's own core holds, per tick

const apart = [];                        // metres between the picture and the core's pose at the same tick
const turned = [];                       // degrees between them
let compared = 0, unknownTick = 0;
watcher.client.onGhost = ((was) => (g) => {
  if (toHex(g.entryId) === mine) {
    const held = poseAt[g.tick];
    if (!held) unknownTick++;
    else {
      compared++;
      apart.push(Math.hypot(METRES(g.x - held.x), METRES(g.z - held.z)));
      const d = ((((g.heading - held.heading) % 65536) + 98304) % 65536) - 32768;
      turned.push(Math.abs(d) / 65536 * 360);
    }
  }
  was(g);
})(watcher.client.onGhost);

const drivingFrom = Date.now();
let tick = 0, ended = null;
while (Date.now() < until && !ended) {
  const due = Math.floor((Date.now() - drivingFrom) / (1000 / 60));
  while (tick <= due) {
    if (driver.client.runOver()) { ended = 'the run reached its last tick'; break; }
    // A TRUCK THAT MOVES: full throttle, and a lean on the wheel every few seconds so the heading is not constant.
    // PARKED is the control: with every word zero the two worlds must agree exactly, whatever the input mapping is,
    // so a disagreement there is a different world and a disagreement only when driving is this harness's own words.
    const steer = Math.sin(tick / 240) > 0 ? 16384 : -16384;
    const words = PARKED ? [0, 0, 0, 0, 0] : [65536, steer, 0, 0, 0];
    if (!driver.client.record(words)) { ended = driver.client.endedWhy || 'the client stopped recording'; break; }
    coreStep(st, ...words);
    poseAt[tick] = { x: st.i32[O_TRUCK + T_X], z: st.i32[O_TRUCK + T_Z], heading: st.i32[O_TRUCK + T_HEADING] };
    tick++;
    if (tick % 6 === 0) driver.client.drain();
  }
  field.drain(24);
  await wait(16);
}

const pct = (xs, p) => (xs.length ? xs.slice().sort((a, b) => a - b)[Math.floor(p * xs.length)] : null);
const m = (x) => (x === null ? '-' : `${x.toFixed(3)} m`);
const deg = (x) => (x === null ? '-' : `${x.toFixed(2)} deg`);
say(`${ended || 'the window closed'}: ${compared} pictures compared, ${unknownTick} at a tick this core had not reached`);
say(`the picture against the driver's own core, same tick: p50 ${m(pct(apart, 0.5))}, p90 ${m(pct(apart, 0.9))}, `
  + `max ${m(apart.length ? Math.max(...apart) : null)}`);
say(`and the heading: p50 ${deg(pct(turned, 0.5))}, p90 ${deg(pct(turned, 0.9))}, `
  + `max ${deg(turned.length ? Math.max(...turned) : null)}`);
say(apart.length && Math.max(...apart) < 0.001
  ? 'the node replays the driver in the driver\'s own world: every wrong place a player sees is staleness'
  : 'THE TWO WORLDS DISAGREE: the node\'s replay is not the pose the driver\'s core holds');
try { await driver.client.close(); } catch {}
try { await watcher.client.close(); } catch {}
process.exit(0);
