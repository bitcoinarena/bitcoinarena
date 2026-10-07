// THE PICTURE AGAINST THE NODE'S OWN REPLAY OF THE SAME TRANSCRIPT (the owner 2026-09-18 13:05).
//
// The previous measurement stepped a bare core beside the run and read 0.000 m in one round and 53 m in the next,
// growing 0.1 m at a time - a separation, not an offset. A bare core is not the world the node replays: `replay.js`
// applies the round's own events - liquidations, loads, price samples and the live tape - each before its own tick,
// and the ground of this game moves with them. So this asks the node's own replay, in this process, over the very
// transcript the driver published, for the same ticks the watcher was pictured at.
//
// If the two agree, the earlier gap was the harness and the ghost sits where that player's core says. If they do not,
// the node's live ghost and the node's own replay disagree with each other, which is a fault in the picture path.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { webcrypto as crypto } from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519.js';
import { schnorr } from '@noble/curves/secp256k1.js';

import { Client } from '../src/client.js';
import { joinFromQuery, tabSeed, playerFor, entryFor, worldSeedFor } from '../src/join.js';
import { watchGhosts } from '../src/ghost-field.js';
import { fetchLobby } from '../src/lobby.js';
import { replay } from '../../blwp-node/src/replay.js';
import { TRUCK } from '../../core/plugin/nextblock.js';
import { feldmanGroup } from '../../blwp-node/src/curve.js';
import { toHex, fromHex } from '../../protocol/src/hash.js';
import { decodeTranscript, flatten } from '../../protocol/src/transcript.js';
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
const words = [];                        // every tick this driver published, in order
const pictured = new Map();              // tick -> the picture the watcher was shown
watcher.client.onGhost = ((was) => (g) => {
  if (toHex(g.entryId) === mine && !pictured.has(g.tick)) pictured.set(g.tick, { x: g.x, z: g.z, heading: g.heading });
  was(g);
})(watcher.client.onGhost);

const drivingFrom = Date.now();
let tick = 0, ended = null;
while (Date.now() < until && !ended) {
  const due = Math.floor((Date.now() - drivingFrom) / (1000 / 60));
  while (tick <= due) {
    if (driver.client.runOver()) { ended = 'the run reached its last tick'; break; }
    const steer = Math.sin(tick / 240) > 0 ? 16384 : -16384;
    const w = PARKED ? [0, 0, 0, 0, 0] : [65536, steer, 0, 0, 0];
    if (!driver.client.record(w)) { ended = driver.client.endedWhy || 'the client stopped recording'; break; }
    words.push(w);
    tick++;
    if (tick % 6 === 0) driver.client.drain();
  }
  field.drain(24);
  await wait(16);
}
// LET THE LAST BATCHES GO OUT, so the transcript this process holds is the one the node stored.
for (let i = 0; i < 40 && driver.client.hold.length && !driver.client.ended; i++) { try { await driver.client.drain(); } catch { break; } await wait(50); }
await wait(1500);

// AND NOW THE NODE'S OWN REPLAY, over the very ticks that were published, for the ticks that were pictured.
const joinTick = driver.client.joinedEntry && Number.isInteger(driver.client.joinedEntry.joinTick)
  ? driver.client.joinedEntry.joinTick : 0;
// AND NOT PAST THE RUN'S OWN END. A run is 9000 ticks from its join, and this loop recorded a few beyond it; the
// node's replay refuses such a transcript in those words, which is the right answer and not something to work round.
const RUN_TICKS = 9000;
const kept = words.slice(0, RUN_TICKS);
const transcript = {
  ticks: kept.map((w, i) => ({ tick: joinTick + i, words: w })),
  liquidations: [], loads: [], samples: [], tapes: [],
};
// THE NODE'S OWN TRANSCRIPT, not a reconstruction. If it carries events this client never sent - a liquidation, a
// price sample, a tape - then a replay of my own words was never the same run, and the parting tick is where the
// first of them lands.
let theirs = null;
const held = new Map();                  // node -> its own stored ticks, so two signers can be held against each other
for (const base of NODES) {
  try {
    const r = await fetch(`${base.replace(/\/+$/, '')}/transcript?round=${toHex(driver.rid)}&entry=${toHex(driver.eid)}`);
    if (!r.ok) continue;
    // A TRANSCRIPT ON THE WIRE IS BATCHES; `flatten` is what turns it into the ticks and events a replay eats.
    theirs = flatten(decodeTranscript(new Uint8Array(await r.arrayBuffer())));
    say(`${base.replace('https://', '').slice(0, 24)} holds ${theirs.ticks.length} ticks, `
      + `${(theirs.liquidations || []).length} liquidations, ${(theirs.loads || []).length} loads, `
      + `${(theirs.samples || []).length} samples, ${(theirs.tapes || []).length} tapes`);
    held.set(base, theirs);
  } catch (e) { say(`that node would not hand the transcript over: ${e.message}`); }
}
// AND WHETHER THE TWO SIGNERS HOLD THE SAME RUN. A watcher is pictured by whichever node serves it, so two nodes
// holding different inputs is a ghost that cannot match the other node's replay however right both of them are.
if (held.size === 2) {
  const [a, b] = [...held.values()];
  let differ = null;
  for (let i = 0; i < Math.min(a.ticks.length, b.ticks.length) && differ === null; i++) {
    const x = Array.from(a.ticks[i]), y = Array.from(b.ticks[i]);
    if (x.some((w, k) => w !== y[k])) differ = a.firstTick + i;
  }
  say(differ !== null ? `THE TWO SIGNERS HOLD DIFFERENT INPUTS, first at tick ${differ}`
    : `both signers hold the same ${Math.min(a.ticks.length, b.ticks.length)} ticks, word for word`);
}
const wantAt = [...pictured.keys()].filter((at) => at < joinTick + kept.length).sort((a, b) => a - b);
// THE NODE THAT HOLDS THE RUN, not whichever answered last: an empty answer from the second signer used to overwrite
// the first one's whole transcript, and a comparison against that is worth nothing.
theirs = [...held.values()].sort((a, b) => (b.ticks?.length || 0) - (a.ticks?.length || 0))[0] || null;
// REPLAY THE NODE'S OWN TRANSCRIPT when it gave one, and mine only as a fallback.
// `flatten` gives the words row by row with a `firstTick` base, not {tick, words} - so the run is rebuilt from that
// base here, which is also the one place my own reconstruction could have differed from what the node stored.
const asRun = (f) => ({
  ticks: f.ticks.map((w, i) => ({ tick: f.firstTick + i, words: Array.from(w) }))
    .filter((x) => x.tick < f.firstTick + RUN_TICKS),
  liquidations: f.liquidations || [], loads: f.loads || [], samples: f.samples || [], tapes: f.tapes || [],
});
const use = theirs && theirs.ticks && theirs.ticks.length ? asRun(theirs) : transcript;
if (theirs && theirs.ticks) {
  // AND WHETHER MY RECONSTRUCTION WAS THE SAME RUN AT ALL: the first tick whose words differ from the node's.
  let differ = null;
  for (let i = 0; i < Math.min(kept.length, theirs.ticks.length) && differ === null; i++) {
    const a = kept[i], b = Array.from(theirs.ticks[i]);
    if (a.length !== b.length || a.some((w, k) => w !== b[k])) differ = { tick: theirs.firstTick + i, mine: a, node: b };
  }
  say(differ ? `my words first differ from the node's at tick ${differ.tick}: mine ${differ.mine} node ${differ.node}`
    : `my words and the node's are the same for all ${Math.min(kept.length, theirs.ticks.length)} ticks compared`);
}
say(`replaying the ${theirs ? "node's own" : 'locally recorded'} transcript`);
const ran = replay(use, driver.client.joinedEntry, { core: TRUCK, seedWord: world.seedWord, pictures: wantAt });
if (!ran.ok) { say(`the node's own replay refused this transcript: ${ran.why}`); process.exit(0); }
say(`replayed ${transcript.ticks.length} ticks and asked for ${wantAt.length} pictures; it gave ${ran.pictures.length}`);

// AND A BARE CORE BESIDE BOTH, so the three can be read against each other and the odd one out is named rather than
// guessed at: the live picture, the node's own replay in this process, and a core stepped with the very same words.
const bare = coreInit(world.seedWord);
const bareAt = new Map();
for (let i = 0; i < kept.length; i++) {
  coreStep(bare, ...kept[i]);
  bareAt.set(joinTick + i, { x: bare.i32[O_TRUCK + T_X], z: bare.i32[O_TRUCK + T_Z], heading: bare.i32[O_TRUCK + T_HEADING] });
}
const M = (w) => (w / 65536).toFixed(1);
const D = (w) => ((w / 65536) * 360).toFixed(0);
let shown = 0;
let parted = null;                       // the first tick at which the live picture leaves the transcript's replay
const apart = [], turned = [], early = [], late = [];
for (const shot of ran.pictures) {
  const had = pictured.get(shot.tick ?? shot.at);
  if (!had) continue;
  const d = Math.hypot((had.x - shot.x) / 65536, (had.z - shot.z) / 65536);
  const dh = ((((had.heading - shot.heading) % 65536) + 98304) % 65536) - 32768;
  apart.push(d);
  turned.push(Math.abs(dh) / 65536 * 360);
  (shot.tick < joinTick + kept.length / 2 ? early : late).push(d);
  if (parted === null && d > 0.01) parted = { tick: shot.tick, d };
  if (shown < 5 && shot.tick > joinTick + 600 && shot.tick % 97 === 0) {
    shown++;
    const b = bareAt.get(shot.tick) || bareAt.get(shot.tick + 1);
    say(`  tick ${shot.tick}: picture (${M(had.x)}, ${M(had.z)}) ${D(had.heading)} deg`
      + ` | node replay (${M(shot.x)}, ${M(shot.z)}) ${D(shot.heading)} deg`
      + ` | bare core (${b ? M(b.x) : '-'}, ${b ? M(b.z) : '-'}) ${b ? D(b.heading) : '-'} deg`);
  }
}

const pct = (xs, p) => (xs.length ? xs.slice().sort((a, b) => a - b)[Math.floor(p * xs.length)] : null);
const m = (x) => (x === null ? '-' : `${x.toFixed(3)} m`);
const deg = (x) => (x === null ? '-' : `${x.toFixed(2)} deg`);
say(`${ended || 'the window closed'}: ${apart.length} pictures against the node's own replay of the same transcript`);
say(`position: p50 ${m(pct(apart, 0.5))}, p90 ${m(pct(apart, 0.9))}, max ${m(apart.length ? Math.max(...apart) : null)}`);
say(`heading:  p50 ${deg(pct(turned, 0.5))}, p90 ${deg(pct(turned, 0.9))}, max ${deg(turned.length ? Math.max(...turned) : null)}`);
say(`first half of the run p50 ${m(pct(early, 0.5))} (${early.length}), second half p50 ${m(pct(late, 0.5))} (${late.length})`);
say(parted ? `they first part at tick ${parted.tick} of ${joinTick + kept.length}, by ${parted.d.toFixed(3)} m`
  : 'they never part by more than a centimetre');
say(apart.length && pct(apart, 0.9) < 0.01
  ? "the live picture and the node's own replay are the same pose: the earlier gap was the bare core in the harness"
  : "the live picture and the node's OWN replay disagree: the fault is in the picture path, not in the harness");
try { await driver.client.close(); } catch {}
try { await watcher.client.close(); } catch {}
process.exit(0);
