// A RUN'S CHECKPOINT CHAIN GROWS ON EVERY NODE OF THE COMMITTEE.
//
// Measured 2026-09-10 on the Daily's 2-of-2, two real Chromes: every run
// stored ONE checkpoint on daemon A and NONE on daemon B, and every later one
// was refused as "not following the chain head". The client sent each
// checkpoint to the one node it had proven, B never held the entry, and the
// head only moves when a mark is LIVE - two receipts on a committee of two -
// so the first link never went live and the chain never grew. The page's
// counters said "marks 1" and nothing about the three refused.
//
// Section 10: "a checkpoint is accepted when enough nodes receive it". Section
// 11: "the client periodically sends batches and checkpoints". Section 13C: a
// canonical chain is one the committee's receipts carry.
//
// These run against two real daemons, stood up by the same tool the Daily
// runs, and the page's own path: the URL the operator printed, the node list
// `index.html` puts on `window.BLWP_NODES`, `Client.at`, `join`, `markNow`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { ed25519 } from '@noble/curves/ed25519.js';
import { schnorr } from '@noble/curves/secp256k1.js';

import { standUpRound } from '../../blwp-node/tools/round-2of2.mjs';
import { Client, receiptsForLive } from '../src/client.js';
import { joinFromQuery, tabIdentity, entryFor } from '../src/join.js';
import { feldmanGroup } from '../../blwp-node/src/curve.js';
import { toHex } from '../../protocol/src/hash.js';
import { NO_PREVIOUS } from '../../protocol/src/checkpoint.js';
import { init as coreInit, step as coreStep } from '../../core/src/sim.js';

const require = createRequire(import.meta.url);
const core = require('../../core/dist/blwp-core.js');
const verify = (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } };
const random = (n) => crypto.getRandomValues(new Uint8Array(n));
const storage = () => {
  const held = new Map();
  return { getItem: (k) => held.get(k) ?? null, setItem: (k, v) => held.set(k, v) };
};
const fromHexHere = (hex) => {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
};

/** A seated, connected tab - exactly the page's steps, with the page's node list or without it. */
async function tab(round, named, { pageNodes }) {
  const secret = ed25519.utils.randomSecretKey();
  const player = tabIdentity({ storage: storage(), random, curve: feldmanGroup });
  const seat = entryFor(named.round, { playerPubkey: player.pubkey, random });
  // `nodes` is what the page's wrapper of `Client.at` adds (`index.html`): the
  // round's node list, `window.BLWP_NODES`. Without it, the Daily before this.
  const client = await Client.at({
    headers: named.chain.headers, bonds: named.chain.bonds,
    signedAdvert: fromHexHere(named.advert.signedAdvert),
    committee: named.round.nodes,
    ...(pageNodes ? { nodes: named.nodes } : {}),
  }, {
    core: { hash: (st) => core.hash(st) },
    sign: (id) => ed25519.sign(id, secret),
    verify, contract: named.round, roundIdGiven: fromHexHere(round.id),
  });
  const rid = await client.openRound(named.round);
  const entry = { ...seat, roundId: rid, sessionPubkey: ed25519.getPublicKey(secret) };
  const eid = await client.join(entry);
  await client.connect();
  client.setRound({ roundId: rid, entryId: eid, blockTicks: named.round.blockTicks | 0 });
  return { client, rid, eid };
}

/** How many checkpoints a daemon has STORED for this run, on its own public door. */
async function stored(base, rid, eid) {
  const r = await fetch(`${base}/checkpoints?round=${toHex(rid)}&entry=${toHex(eid)}`);
  await r.arrayBuffer();
  return Number(r.headers.get('x-checkpoints'));
}

/** A core driven to `tick`, hashed the way the bridge hashes it. */
function driven(seed, tick) {
  const st = coreInit(seed);
  for (let t = 0; t < tick; t++) coreStep(st, 45875, 0, 0, 0, 0);
  return core.hash(st);
}

test('each checkpoint is receipted by both daemons and the chain grows on A and on B', async () => {
  const round = await standUpRound({ host: '127.0.0.1', portA: 18250, portB: 18251 });
  let t;
  try {
    const named = await joinFromQuery(new URL(round.url).search);
    t = await tab(round, named, { pageNodes: true });
    const { client, rid, eid } = t;
    const [A, B] = [client.base, ...client.peers];
    assert.equal(client.peers.length, 1, 'the page named two nodes and the client knows one peer');
    assert.equal(receiptsForLive(named.round), 2, 'a 2-of-2 needs both receipts to go live');

    // THE ENTRY IS SEATED ON BOTH, or B refuses every checkpoint as "no such entry".
    assert.deepEqual(client.peerSeats.map((s) => s.ok), [true],
      `B did not seat the entry: ${JSON.stringify(client.peerSeats)}`);

    const links = [];
    for (const tick of [60, 120, 180, 240]) {
      const r = await client.markNow(driven(7, tick), tick);
      links.push(r);
      const at = [await stored(A, rid, eid), await stored(B, rid, eid)];
      console.log(`  tick ${tick}: ${r.answer}, live ${r.live}, witnessed ${client.witnessed(r.id)}, `
        + `refused ${r.refused.length}, stored A ${at[0]} B ${at[1]}`);
      assert.equal(r.answer, 'receipted', `A refused the checkpoint at ${tick}: ${r.answer}`);
      assert.deepEqual(r.refused, [], `a node refused the checkpoint at ${tick}`);
      assert.equal(r.live, true, `the checkpoint at ${tick} did not go live`);
      assert.equal(client.witnessed(r.id), 2, 'both daemons receipted it, so both count');
      assert.deepEqual(at, [links.length, links.length],
        `after ${links.length} checkpoints A and B store ${at}`);
    }

    // AND EACH LINK NAMES THE ONE BEFORE IT - the head moved, on both receipts.
    assert.equal(toHex(links[0].checkpoint.previousHash), toHex(NO_PREVIOUS));
    for (let i = 1; i < links.length; i++)
      assert.equal(toHex(links[i].checkpoint.previousHash), toHex(links[i - 1].id),
        `link ${i} does not name the head before it`);

    // THE COUNTERS SAY WHAT HAPPENED.
    assert.equal(client.marksSent, 4);
    assert.equal(client.marksAccepted, 4);
    assert.equal(client.marksRefused, 0);
    const line = client.status(240);
    assert.match(line, / marks 4 /);
    assert.match(line, / accepted 4\b/);
    assert.equal(/refused/.test(line), false, `a refusal was printed where there was none: ${line}`);
  } finally {
    if (t) { t.client.ended = true; t.client.close(); }
    await round.close();
  }
});

test('a client that reaches one daemon of two is refused past its first link, and says so', async () => {
  // THE DAILY BEFORE THIS FIX, reproduced: no page node list, so no peers.
  const round = await standUpRound({ host: '127.0.0.1', portA: 18252, portB: 18253 });
  let t;
  try {
    const named = await joinFromQuery(new URL(round.url).search);
    t = await tab(round, named, { pageNodes: false });
    const { client, rid, eid } = t;
    assert.equal(client.peers.length, 0);
    const other = named.nodes.map((n) => String(n).replace(/\/+$/, ''))
      .find((n) => n !== client.base);

    const first = await client.markNow(driven(7, 60), 60);
    assert.equal(first.answer, 'receipted');
    assert.equal(first.live, false, 'one receipt of two went live');
    const second = await client.markNow(driven(7, 120), 120);
    assert.match(second.answer, /chain head/, `the second link was not refused for the head: ${second.answer}`);

    const at = [await stored(client.base, rid, eid), await stored(other, rid, eid)];
    console.log(`  one daemon: stored A ${at[0]} B ${at[1]}; refused: ${client.marksRefusedWhy}`);
    assert.deepEqual(at, [1, 0]);

    // AND THE PAGE'S LINE NO LONGER HIDES IT.
    assert.equal(client.marksSent, 1);
    assert.equal(client.marksAccepted, 0);
    assert.equal(client.marksRefused, 1);
    assert.match(client.status(120), / refused 1\b/);
    assert.match(client.marksRefusedWhy, /chain head/);
  } finally {
    if (t) { t.client.ended = true; t.client.close(); }
    await round.close();
  }
});
