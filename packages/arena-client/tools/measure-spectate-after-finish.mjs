// DOES A WATCHER WHOSE OWN RUN HAS FINISHED STILL GET PICTURES? (the owner 2026-09-18 20:00, SPECTATE.)
//
// `finish()` no longer closes the socket, so the line to the node stays up after a run ends - but an open socket is
// not proof that anything still comes down it. A player who presses SPECTATE after their own run wants the other
// trucks to keep moving, and those arrive over that line. This drives two seats: one keeps driving, the other calls
// `finish()` mid-round and then only watches. Counted: pictures before the finish, pictures after it, the round they
// name, and how long the gap is - so "the node stopped pushing" is a number rather than a fear.
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

const until = Date.now() + 10 * 60000;
say('# one seat finishes its run and then watches the other, which keeps driving');

const roundIdHex = await freeRound(until);
if (!roundIdHex) { say('the Daily listed no joinable free round'); process.exit(0); }
const named = await joinFromQuery(
  `?round=${roundIdHex}&node=${NODES.join(',')}&bond=${daily.bond}&advert=${daily.advert}`);
const driver = await seat(named, roundIdHex);
const watcher = await seat(named, roundIdHex);
const field = watchGhosts(watcher.client, { roundId: watcher.rid, entryId: watcher.eid });
await field.watching;
const mine = toHex(driver.eid);

let finishedAt = null;
const before = [], after = [];
const was = watcher.client.onGhost;
watcher.client.onGhost = (g) => {
  if (toHex(g.entryId) === mine) {
    const row = { at: Date.now(), tick: g.tick, round: g.roundId ? toHex(g.roundId).slice(0, 8) : '-' };
    (finishedAt === null ? before : after).push(row);
  }
  was(g);
};

const began = Date.now();
let tick = 0, ended = null;
while (Date.now() < until && !ended && Date.now() - began < 150000) {
  const due = Math.floor((Date.now() - began) / (1000 / 60));
  while (tick <= due) {
    if (driver.client.runOver()) { ended = 'the driver reached its last tick'; break; }
    if (!driver.client.record([65536, Math.sin(tick / 240) > 0 ? 16384 : -16384, 0, 0, 0])) {
      ended = driver.client.endedWhy || 'the driver stopped recording'; break;
    }
    // THE WATCHER DRIVES TOO, until it finishes: a seat that never published is not the case being measured.
    if (finishedAt === null) watcher.client.record([0, 0, 0, 0, 0]);
    tick++;
    if (tick % 6 === 0) { driver.client.drain(); if (finishedAt === null) watcher.client.drain(); }
  }
  field.drain(24);

  // A THIRD OF THE WAY IN, the watcher's own run ends the way a delivery ends it.
  if (finishedAt === null && Date.now() - began > 45000) {
    const r = await watcher.client.finish({ why: 'this seat is spectating from here' }).catch((e) => ({ why: e.message }));
    finishedAt = Date.now();
    say(`the watcher finished its own run ${Math.round((finishedAt - began) / 1000)} s in`
      + `; unsent ${r && r.unsent}; its socket is ${watcher.client.sock ? 'still open' : 'CLOSED'}`
      + `; state ${watcher.client.state}`);
  }
  await wait(16);
}

const gap = after.length && finishedAt ? after[0].at - finishedAt : null;
say(`${ended || 'the window closed'}: the driver was pictured ${before.length} times before the watcher finished`
  + ` and ${after.length} times after`);
say(after.length
  ? `the first picture after finishing came ${gap} ms later, at tick ${after[0].tick}, naming round ${after[0].round}`
  : 'NOT ONE picture arrived after the watcher finished: the node stops pushing to a seat whose own run is over');
if (after.length) {
  const gaps = [];
  for (let i = 1; i < after.length; i++) gaps.push(after[i].at - after[i - 1].at);
  gaps.sort((a, b) => a - b);
  say(`after finishing, pictures kept coming every ${gaps.length ? gaps[Math.floor(gaps.length / 2)] : '-'} ms at the median`
    + `, over ${Math.round((after[after.length - 1].at - after[0].at) / 1000)} s`);
}
try { await driver.client.close(); } catch {}
try { await watcher.client.close(); } catch {}
process.exit(0);
