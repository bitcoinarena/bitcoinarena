// WHICH SIGNER EACH TAB IS ON, AND WHAT THAT SIGNER HOLDS OF THE OTHER TRUCK (the owner 2026-09-18 13:45).
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
import { feldmanGroup } from '../../blwp-node/src/curve.js';
import { toHex, fromHex } from '../../protocol/src/hash.js';

const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d; };
const DAILY = arg('daily', process.env.BLWP_2OF2_DIR || '/mnt/bitcoin/blwp-2of2');
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
say('# two tabs, the signer each is on, and what that signer holds of the other truck');

for (let r = 1; r <= ROUNDS && Date.now() < until; r++) {
  const roundIdHex = await freeRound(until);
  if (!roundIdHex) { say('no joinable free round left'); break; }
  const named = await joinFromQuery(
    `?round=${roundIdHex}&node=${NODES.join(',')}&bond=${daily.bond}&advert=${daily.advert}`);
  const one = await seat(named, roundIdHex);
  // TRUCK 2 IS PUT ON THE OTHER SIGNER, deliberately, for the run that decides this.
  const other = NODES.find((n) => n !== one.client.base) || NODES[1] || NODES[0];
  const two = await seat(named, roundIdHex, Date.now() + 120000, other);
  const field = watchGhosts(two.client, { roundId: two.rid, entryId: two.eid });
  await field.watching;
  const mine = toHex(one.eid);
  say(`round ${r}: truck 1 is on ${short(one.client.base)}, truck 2 is on ${short(two.client.base)}`);

  const ages = { driver: [], node: [] };
  let lastPicture = null;
  const was = two.client.onGhost;
  two.client.onGhost = (g) => { if (toHex(g.entryId) === mine) lastPicture = { tick: g.tick, at: Date.now() }; was(g); };

  const began = Date.now();
  let tick = 0, ended = null, sampled = 0;
  let nextLook = 0;
  while (Date.now() < until && !ended && Date.now() - began < 165000) {
    const due = Math.floor((Date.now() - began) / (1000 / 60));
    while (tick <= due) {
      for (const t of [one, two]) {
        if (t.client.runOver()) { ended = 'the run reached its last tick'; break; }
        if (!t.client.record([65536, Math.sin(tick / 240) > 0 ? 16384 : -16384, 0, 0, 0])) {
          ended = t.client.endedWhy || 'a client stopped recording'; break;
        }
      }
      if (ended) break;
      tick++;
      if (tick % 6 === 0) for (const t of [one, two]) t.client.drain();
    }
    field.drain(24);

    // THE THREE NUMBERS AT ONE WALL CLOCK: what each signer holds of truck 1's run, and the picture truck 2 was shown.
    if (Date.now() >= nextLook) {
      nextLook = Date.now() + 10000;
      const holds = [];
      for (const base of NODES) holds.push([base, await heldBy(base, one.rid, one.eid)]);
      const own = one.client.nextTick;
      const pic = lastPicture ? lastPicture.tick : null;
      sampled++;
      if (pic !== null) {
        ages.driver.push(own - pic);
        const onTwo = holds.find(([b]) => b === two.client.base);
        if (onTwo && onTwo[1] >= 0) ages.node.push(Math.max(0, onTwo[1] - 1 - pic));
      }
      say(`round ${r} ${Math.round((Date.now() - began) / 1000)} s: truck 1 has published ${own}`
        + `; ${holds.map(([b, n]) => `${short(b)} holds ${n}`).join(', ')}`
        + `; truck 2's newest picture of it is tick ${pic === null ? 'NONE' : pic}`
        + `${pic === null ? '' : ` (${own - pic} ticks behind truck 1)`}`);
    }
    await wait(16);
  }
  const pct = (xs, p) => (xs.length ? xs.slice().sort((a, b) => a - b)[Math.floor(p * xs.length)] : null);
  say(`round ${r}: ${ended || 'window closed'}; picture behind truck 1: p50 ${pct(ages.driver, 0.5)}, `
    + `p90 ${pct(ages.driver, 0.9)}, max ${ages.driver.length ? Math.max(...ages.driver) : '-'} ticks`);
  say(`round ${r}: picture behind what truck 2's OWN signer holds: p50 ${pct(ages.node, 0.5)}, `
    + `p90 ${pct(ages.node, 0.9)}, max ${ages.node.length ? Math.max(...ages.node) : '-'} ticks`);
  for (const t of [one, two]) { try { await t.client.close(); } catch {} }
  await wait(2000);
}
process.exit(0);
