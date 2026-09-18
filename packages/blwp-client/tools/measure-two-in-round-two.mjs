// TWO TABS, ONE LIVE ROUND, THEN THE NEXT ONE (the owner 2026-09-18 12:02: "after 2nd round Truck 1 cannot see Truck 2.
// Age 6736ms").
//
// The earlier round-boundary probe drove one truck and watched with another, and rebuilt the watcher each round; it
// never missed. This is the pair a player has: BOTH tabs drive and BOTH watch each other, and both press PLAY again
// for the second round. At 6.7 seconds into round two - the age in the owner's shot - each tab is asked, in numbers:
//   - is the other truck in my field at all
//   - how long after this round's first tick its first picture arrived
//   - how old that picture is
//   - and if it is not there: never arrived, dropped as superseded, or named a round I am not watching
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
const ASK_AT_MS = Number(arg('askAt', 6700));          // the age in the owner's shot
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

/** One tab: a seat that drives and watches. */
async function tab(name, named, roundIdHex) {
  const s = await seat(named, roundIdHex);
  const field = watchGhosts(s.client, { roundId: s.rid, entryId: s.eid });
  await field.watching;
  const t = { name, ...s, field, mine: toHex(s.eid), first: new Map(), newest: new Map(), otherRound: 0 };
  const was = s.client.onGhost;
  s.client.onGhost = (g) => {
    const key = toHex(g.entryId);
    // A PICTURE OF A ROUND THIS TAB IS NOT WATCHING would be the third way to lose a truck; counted, not assumed.
    if (g.roundId && toHex(g.roundId) !== toHex(s.rid)) t.otherRound++;
    if (!t.first.has(key)) t.first.set(key, Date.now());
    t.newest.set(key, { at: Date.now(), tick: g.tick });
    was(g);
  };
  return t;
}

const until = Date.now() + 14 * 60000;
say(`# two tabs that both drive and both watch, across ${ROUNDS} rounds; each asked at ${ASK_AT_MS} ms into a round`);

for (let r = 1; r <= ROUNDS && Date.now() < until; r++) {
  const roundIdHex = await freeRound(until);
  if (!roundIdHex) { say('no joinable free round left'); break; }
  const named = await joinFromQuery(
    `?round=${roundIdHex}&node=${NODES.join(',')}&bond=${daily.bond}&advert=${daily.advert}`);
  const one = await tab('truck 1', named, roundIdHex);
  const two = await tab('truck 2', named, roundIdHex);
  say(`round ${r} ${roundIdHex.slice(0, 12)}: both tabs seated`);

  const began = Date.now();
  let asked = false;
  let tick = 0, ended = null;
  while (Date.now() < until && !ended && Date.now() - began < 170000) {
    const due = Math.floor((Date.now() - began) / (1000 / 60));
    while (tick <= due) {
      for (const t of [one, two]) {
        if (t.client.runOver()) { ended = 'the run reached its last tick'; break; }
        if (!t.client.record([0, 0, 0, 0, 0])) { ended = t.client.endedWhy || 'a client stopped recording'; break; }
      }
      if (ended) break;
      tick++;
      if (tick % 6 === 0) for (const t of [one, two]) t.client.drain();
    }
    for (const t of [one, two]) t.field.drain(24);

    if (!asked && Date.now() - began >= ASK_AT_MS) {
      asked = true;
      for (const [me, other] of [[one, two], [two, one]]) {
        const held = [...(me.field.present ? me.field.present.keys() : [])];
        const newest = me.newest.get(other.mine);
        const firstAt = me.first.get(other.mine);
        const why = newest ? 'drawn'
          : (me.field.superseded | 0) > 0 ? 'dropped as superseded'
            : me.otherRound > 0 ? 'only pictures of another round arrived'
              : 'no picture of it ever arrived';
        say(`round ${r}, ${Math.round(Date.now() - began)} ms in, ${me.name}: the other truck is ${why}`
          + `; trucks in my field ${held.length}`
          + `; first picture ${firstAt ? `${firstAt - began} ms after this round began` : 'NEVER'}`
          + `; its age ${newest ? `${Date.now() - newest.at} ms (tick ${newest.tick})` : '-'}`
          + `; superseded ${me.field.superseded | 0}, self ${me.field.self | 0}, silenced ${me.field.silenced | 0}`
          + `, round-ended ${me.field.roundEnded | 0}, pictures of another round ${me.otherRound}`);
      }
    }
    await wait(16);
  }
  say(`round ${r}: ${ended || 'the window closed'}`);
  for (const t of [one, two]) { try { await t.client.close(); } catch {} }
  await wait(2000);
}
process.exit(0);
