// THE PAGE'S OWN CORE AGAINST THE ADVERTISED NODE'S REPLAY, AT THE SAME TICK (the owner 2026-09-18 14:00).
//
// Both tabs take their endpoint from the same signed advert, so they sit on one signer: split signers are not why one
// tab cannot see the other. What is left to test is whether a player's own truck and the ghost of that player in the
// other tab are the same pose - two worlds would line up nowhere, and each side would still be right in its own.
//
// So both tabs drive, each steps a core of its OWN world with its OWN published words, and each tab's pictures of the
// other are held against that other tab's core at the same tick. Printed beside it: the seed each side used, whether
// any picture arrives at all, and the round a picture names against the round the tab thinks it is in.
//
// Measured before this tool existed, for one entry at one moment: one signer held 8986 ticks of that run and the
// other held 0. A watcher is pictured by the signer it is subscribed to, so a tab on the empty signer can only be
// shown an old tick or nothing at all - which is "Truck 1 cannot see Truck 2", and an age of 6736 ms.
//
// So, for two tabs in one round, this records at the same wall clock:
//   - the signer each tab is subscribed to
//   - the tick each signer holds for the driver's entry (the `x-ticks` header of its own /transcript)
//   - the tick of the picture the watcher was just shown, and the tick the driver has published
// and reports the age of a picture against both, plus whether the empty signer ever catches up.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { webcrypto as crypto } from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519.js';
import { schnorr } from '@noble/curves/secp256k1.js';

import { Client } from '../src/client.js';
import { joinFromQuery, tabSeed, playerFor, entryFor } from '../src/join.js';
import { watchGhosts } from '../src/ghost-field.js';
import { fetchLobby } from '../src/lobby.js';
import { feldmanGroup } from '../../arena-node/src/curve.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { worldSeedFor } from '../src/join.js';
import { init as coreInit, step as coreStep } from '../../nextblock/src/sim.js';
import { O_TRUCK, T_X, T_Z, T_HEADING } from '../../nextblock/src/state.js';

const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d; };
const DAILY = arg('daily', process.env.ARENA_2OF2_DIR || '/mnt/bitcoin/blwp-2of2');
const ROUNDS = Number(arg('rounds', 2));
const require = createRequire(import.meta.url);
const core = require('../../nextblock/dist/blwp-core.js');
const verify = (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } };
const random = (n) => crypto.getRandomValues(new Uint8Array(n));
const storage = () => { const held = new Map(); return { getItem: (k) => held.get(k) ?? null, setItem: (k, v) => held.set(k, v) }; };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (l) => console.log(`${new Date().toISOString().slice(11, 19)}  ${l}`);
const short = (u) => String(u).replace('https://', '').split('-')[0];
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

async function seat(named, roundIdHex, until = Date.now() + 120000, onlyNode = null) {
  for (;;) {
    try { return await seated(named, roundIdHex, onlyNode); }
    catch (e) {
      if (Date.now() >= until || !/still reading its chain view|no beacon|randomness/.test(e.message)) throw e;
      await wait(5000);
    }
  }
}

async function seated(named, roundIdHex, onlyNode = null) {
  const secret = ed25519.utils.randomSecretKey();
  const player = playerFor(named.round, { seed: tabSeed({ storage: storage(), random }), curve: feldmanGroup });
  const built = entryFor(named.round, { seed: player.seed, curve: feldmanGroup, random });
  const client = await Client.at({
    headers: named.chain.headers, bonds: named.chain.bonds,
    signedAdvert: fromHex(named.advert.signedAdvert), committee: named.round.nodes,
    // ONE SIGNER ON PURPOSE, when asked: a player's two tabs need not land on the same one, and the whole question is
    // what a tab sees when its own signer holds nothing of the other truck.
    ...(onlyNode ? { nodes: [onlyNode] } : {}),
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
  return { client, rid, eid };
}

/** How many ticks a signer holds of one entry's run, from its own header. */
async function heldBy(base, rid, eid) {
  try {
    const r = await fetch(`${base.replace(/\/+$/, '')}/transcript?round=${toHex(rid)}&entry=${toHex(eid)}`);
    if (!r.ok) return -1;
    const n = Number(r.headers.get('x-ticks'));
    await r.arrayBuffer();
    return Number.isFinite(n) ? n : -1;
  } catch { return -1; }
}


const until = Date.now() + 14 * 60000;
const METRES = (w) => w / 65536;
const pct = (xs, p) => (xs.length ? xs.slice().sort((a, b) => a - b)[Math.floor(p * xs.length)] : null);
const m = (x) => (x === null || x === undefined ? '-' : `${x.toFixed(3)} m`);
const deg = (x) => (x === null || x === undefined ? '-' : `${x.toFixed(2)} deg`);
say('# both tabs drive; each tab\'s pictures of the other are held against that other tab\'s own core');

for (let r = 1; r <= ROUNDS && Date.now() < until; r++) {
  const roundIdHex = await freeRound(until);
  if (!roundIdHex) { say('no joinable free round left'); break; }
  const named = await joinFromQuery(
    `?round=${roundIdHex}&node=${NODES.join(',')}&bond=${daily.bond}&advert=${daily.advert}`);

  const tabs = [];
  for (const name of ['truck 1', 'truck 2']) {
    const s = await seat(named, roundIdHex);
    const field = watchGhosts(s.client, { roundId: s.rid, entryId: s.eid });
    await field.watching;
    const seed = await worldSeedFor({ entry: s.client.joinedEntry, round: s.rid, nodes: named.nodes });
    // A RUN'S TICKS ARE ITS OWN. The second tab joins later, so its run starts at a later joinTick and a counter of
    // this loop's own is a different tick for it - which is the whole of an asymmetry measured before this line
    // existed: pictures of the first tab matched its core to 0.000 m while pictures of the second were 7.98 m out.
    const join = s.client.joinedEntry && Number.isInteger(s.client.joinedEntry.joinTick) ? s.client.joinedEntry.joinTick : 0;
    tabs.push({
      name, ...s, field, join, seed: seed.seedWord, st: coreInit(seed.seedWord), poseAt: new Map(), stepped: 0,
      mine: toHex(s.eid), got: new Map(), firstOf: new Map(), wrongRound: 0, pictures: 0,
    });
    say(`round ${r}: ${name} is on ${short(s.client.base)}, its world seed word is ${seed.seedWord >>> 0}`
      + `, and its run joins at tick ${join}`);
  }
  say(`round ${r}: the two tabs' seeds are ${tabs[0].seed === tabs[1].seed ? 'THE SAME' : 'different, as two players are'}`);

  for (const me of tabs) {
    const was = me.client.onGhost;
    me.client.onGhost = (g) => {
      const who = toHex(g.entryId);
      me.pictures++;
      if (g.roundId && toHex(g.roundId) !== toHex(me.rid)) me.wrongRound++;
      if (!me.firstOf.has(who)) me.firstOf.set(who, Date.now());
      me.got.set(who + ':' + g.tick, { tick: g.tick, x: g.x, z: g.z, heading: g.heading, at: Date.now() });
      was(g);
    };
  }

  const began = Date.now();
  let tick = 0, ended = null;
  while (Date.now() < until && !ended && Date.now() - began < 165000) {
    const due = Math.floor((Date.now() - began) / (1000 / 60));
    while (tick <= due) {
      const w = [65536, Math.sin(tick / 240) > 0 ? 16384 : -16384, 0, 0, 0];
      for (const t of tabs) {
        if (t.client.runOver()) { ended = 'the run reached its last tick'; break; }
        if (!t.client.record(w)) { ended = t.client.endedWhy || 'a client stopped recording'; break; }
        coreStep(t.st, ...w);
        t.poseAt.set(t.join + t.stepped, { x: t.st.i32[O_TRUCK + T_X], z: t.st.i32[O_TRUCK + T_Z], heading: t.st.i32[O_TRUCK + T_HEADING] });
        t.stepped++;
      }
      if (ended) break;
      tick++;
      if (tick % 6 === 0) for (const t of tabs) t.client.drain();
    }
    for (const t of tabs) t.field.drain(24);
    await wait(16);
  }

  for (const [me, other] of [[tabs[0], tabs[1]], [tabs[1], tabs[0]]]) {
    const apart = [], turned = [];
    let first = null;
    for (const [key, shot] of me.got) {
      if (!key.startsWith(other.mine)) continue;
      const held = other.poseAt.get(shot.tick) || other.poseAt.get(shot.tick - 1);
      if (!held) continue;
      const d = Math.hypot(METRES(shot.x - held.x), METRES(shot.z - held.z));
      const dh = ((((shot.heading - held.heading) % 65536) + 98304) % 65536) - 32768;
      apart.push(d); turned.push(Math.abs(dh) / 65536 * 360);
      if (first === null && d > 0.01) first = { tick: shot.tick, d };
    }
    const firstAt = me.firstOf.get(other.mine);
    say(`round ${r}: ${me.name} of ${other.name}: ${apart.length} pictures held against that tab's own core`
      + `; position p50 ${m(pct(apart, 0.5))}, p90 ${m(pct(apart, 0.9))}, max ${m(apart.length ? Math.max(...apart) : null)}`
      + `; heading p50 ${deg(pct(turned, 0.5))}, p90 ${deg(pct(turned, 0.9))}`);
    say(`round ${r}: ${me.name} saw ${me.pictures} pictures in all, first of ${other.name} `
      + `${firstAt ? `${firstAt - began} ms in` : 'NEVER'}; pictures naming another round ${me.wrongRound}`
      + `; ${first ? `first apart at tick ${first.tick} by ${first.d.toFixed(3)} m` : 'never apart by a centimetre'}`);
  }
  for (const t of tabs) { try { await t.client.close(); } catch {} }
  await wait(2000);
}
process.exit(0);
