// WHAT A WATCHER HOLDS WHEN THE ROUND TURNS OVER (the owner 2026-09-18 12:02: "after 2nd round Truck 1 cannot see
// Truck 2. Age 6736ms on young-hawk-9551").
//
// The four counts asked for, per round, measured on the Daily with real seats and the page's own client:
//   - trucks still drawn from a round this watcher has left
//   - first pictures dropped by the "superseded" rule (a new entry of a player whose old truck is still drawn)
//   - whether the clear fired: in the page `BlwpNextGhost` writes tick -2 when it meets a NEW field object, so what
//     is counted here is whether a round got a new field at all
//   - pictures that name an entry of a round this pair has left
//
// AND THE CASE THAT MATTERS: a watcher that keeps its field across the boundary. the owner's Truck 1 was looking at a
// truck whose newest picture was 6.7 s old and climbing - since 0.0.1591 a silence no longer retires it, so if
// nothing else takes it away it stands for ever. Both are driven here: a watcher rebuilt for the new round the way a
// player pressing PLAY gets one, and a watcher that is not.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { webcrypto as crypto } from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519.js';
import { schnorr } from '@noble/curves/secp256k1.js';

import { Client } from '../src/client.js';
import { joinFromQuery, tabSeed, playerFor, entryFor } from '../src/join.js';
import { watchGhosts } from '../src/ghost-field.js';
import { fetchLobby } from '../src/lobby.js';
import { feldmanGroup } from '../../blwp-node/src/curve.js';
import { toHex, fromHex } from '../../protocol/src/hash.js';

const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d; };
const DAILY = arg('daily', process.env.BLWP_2OF2_DIR || '/mnt/bitcoin/blwp-2of2');
const ROUNDS = Number(arg('rounds', 2));
const require = createRequire(import.meta.url);
const core = require('../../core/dist/blwp-core.js');
const verify = (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } };
const random = (n) => crypto.getRandomValues(new Uint8Array(n));
const storage = () => { const held = new Map(); return { getItem: (k) => held.get(k) ?? null, setItem: (k, v) => held.set(k, v) }; };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (l) => console.log(`${new Date().toISOString().slice(11, 19)}  ${l}`);
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
  return { client, rid, eid };
}

const until = Date.now() + 14 * 60000;
say('# the Daily: what a watcher holds when the round turns over');

// THE WATCHER THAT STAYS. Made once, on the first round, and never rebuilt - the case the owner photographed.
let sticky = null;
let stickyField = null;
let stickyRound = null;
const seen = [];

for (let r = 1; r <= ROUNDS && Date.now() < until; r++) {
  const roundIdHex = await freeRound(until);
  if (!roundIdHex) { say('no joinable free round left in the window'); break; }
  const named = await joinFromQuery(
    `?round=${roundIdHex}&node=${NODES.join(',')}&bond=${daily.bond}&advert=${daily.advert}`);

  const driver = await seat(named, roundIdHex);
  const mine = toHex(driver.eid);

  // A FRESH WATCHER, the way a player pressing PLAY gets one, and the sticky one that never re-seats.
  const fresh = await seat(named, roundIdHex);
  const freshField = watchGhosts(fresh.client, { roundId: fresh.rid, entryId: fresh.eid });
  await freshField.watching;
  if (!sticky) {
    sticky = fresh; stickyField = freshField; stickyRound = roundIdHex;
    say(`round ${r} ${roundIdHex.slice(0, 12)}: the sticky watcher was made here and will not be rebuilt`);
  } else {
    say(`round ${r} ${roundIdHex.slice(0, 12)}: a fresh watcher was made; the sticky one still watches `
      + `${stickyRound.slice(0, 12)}`);
  }

  // WHAT EACH OF THEM HOLDS the moment the new round begins.
  const held = (f) => [...(f.present ? f.present.keys() : [])];
  const carriedOver = held(stickyField).length;

  const first = { fresh: null, sticky: null };
  const was = { fresh: fresh.client.onGhost, sticky: sticky.client.onGhost };
  fresh.client.onGhost = (g) => { if (toHex(g.entryId) === mine && first.fresh === null) first.fresh = Date.now(); was.fresh(g); };
  if (sticky !== fresh) sticky.client.onGhost = (g) => { if (toHex(g.entryId) === mine && first.sticky === null) first.sticky = Date.now(); was.sticky(g); };

  const drivingFrom = Date.now();
  let tick = 0, ended = null;
  while (Date.now() < until && !ended && Date.now() - drivingFrom < 160000) {
    const due = Math.floor((Date.now() - drivingFrom) / (1000 / 60));
    while (tick <= due) {
      if (driver.client.runOver()) { ended = 'the run reached its last tick'; break; }
      if (!driver.client.record([0, 0, 0, 0, 0])) { ended = driver.client.endedWhy || 'the client stopped recording'; break; }
      tick++;
      if (tick % 6 === 0) driver.client.drain();
    }
    freshField.drain(24);
    if (stickyField !== freshField) stickyField.drain(24);
    await wait(16);
  }

  const line = (name, f, firstAt) => `${name}: trucks drawn ${held(f).length}`
    + `, first picture of this round's driver ${firstAt ? `${firstAt - drivingFrom} ms in` : 'NEVER'}`
    + `, superseded ${f.superseded | 0}, self ${f.self | 0}, silenced ${f.silenced | 0}, retired ${f.retired | 0}`;
  say(`round ${r}: carried over into this round by the sticky watcher: ${carriedOver} truck(s)`);
  say(`round ${r}: ${line('fresh watcher', freshField, first.fresh)}`);
  if (stickyField !== freshField) say(`round ${r}: ${line('sticky watcher', stickyField, first.sticky)}`);
  seen.push({ r, carriedOver, freshSaw: !!first.fresh, stickySaw: !!first.sticky });

  try { await driver.client.close(); } catch {}
  if (fresh !== sticky) { try { await fresh.client.close(); } catch {} }
  await wait(2000);
}

console.log('\n# the four counts, per round');
for (const s of seen)
  console.log(`  round ${s.r}: carried over ${s.carriedOver}; a fresh watcher saw this round's driver: ${s.freshSaw}; `
    + `a watcher that stayed on the old round saw it: ${s.stickySaw}`);
try { if (sticky) await sticky.client.close(); } catch {}
process.exit(0);
