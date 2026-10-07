// THE RUN'S FINAL MARK, AND A SIGNER NODE THAT MISSED ITS LAST INPUTS (ruled 2026-09-23).
//
// Measured before (last-mark-window-probe.mjs, the page's own bridge on the Daily's 2-of-2): signer node B down for 7 s
// as the core said DELIVERED; `finish` asked for the final mark, `markNow` held it for every peer, B's feed stayed at
// tick 1002 against 1006 with its socket closed, and after 10 s the mark was SENT TO NOBODY. B's feed never ran again,
// A signed DELIVERED and B FAILED - 3 runs of 3. The ruling: the final mark goes to the nodes that already hold its
// inputs; it is the pending link; `#relink` re-offers that SAME mark, FEED FIRST, until every signer node has receipted
// it, the page leaves, or the settlement is combined. Every other mark keeps the all-peers wait and its timeout.
//   1  the final mark goes to A alone; B, back, is fed the batches it never answered - through the mark's tick and
//      nothing past it - and only then offered the same mark, byte for byte; it receipts it; both hold the same ticks,
//      the same transcript hash and the same chain, and no fork proof exists at either.
//   2  the control: a mark that is not final, with B short, still waits out `markWaitMs` and is sent to nobody; once B
//      is back the next mark chains on the head both hold - no second mark names one parent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { ed25519 } from '@noble/curves/ed25519.js';
import { schnorr } from '@noble/curves/secp256k1.js';

import { standUpRound } from '../../blwp-node/tools/round-2of2.mjs';
import { Client } from '../src/client.js';
import { joinFromQuery, tabSeed, playerFor, entryFor } from '../src/join.js';
import { feldmanGroup } from '../../blwp-node/src/curve.js';
import { decodeInputBatch } from '../../protocol/src/batch.js';
import { toHex } from '../../protocol/src/hash.js';
import { init as coreInit, step as coreStep } from '../../nextblock/src/sim.js';

const require = createRequire(import.meta.url);
const core = require('../../nextblock/dist/blwp-core.js');
const verify = (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } };
const random = (n) => crypto.getRandomValues(new Uint8Array(n));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const storage = () => { const held = new Map(); return { getItem: (k) => held.get(k) ?? null, setItem: (k, v) => held.set(k, v) }; };
const fromHexHere = (hex) => Uint8Array.from(hex.match(/../g), (x) => parseInt(x, 16));

/** A joined, connected tab - the page's steps, with the page's node list (index.html's wrapper of Client.at). */
async function tab(round, named) {
  const secret = ed25519.utils.randomSecretKey();
  const player = playerFor(named.round, { seed: tabSeed({ storage: storage(), random }), curve: feldmanGroup });
  const signerNode = entryFor(named.round, { seed: player.seed, curve: feldmanGroup, random });
  const client = await Client.at({
    headers: named.chain.headers, bonds: named.chain.bonds, signedAdvert: fromHexHere(named.advert.signedAdvert),
    committee: named.round.nodes, nodes: named.nodes,
  }, { core: { hash: (st) => core.hash(st) }, sign: (id) => ed25519.sign(id, secret), verify, contract: named.round, roundIdGiven: fromHexHere(round.id) });
  const rid = await client.openRound(named.round);
  const eid = await client.join({ ...signerNode, roundId: rid, sessionPubkey: ed25519.getPublicKey(secret) });
  await client.connect();
  client.setRound({ roundId: rid, entryId: eid, blockTicks: named.round.blockTicks | 0 });
  return { client, rid, eid };
}
const door = async (base, path, rid, eid) => {
  const r = await fetch(`${base}/${path}?round=${toHex(rid)}&entry=${toHex(eid)}`);
  return { r, bytes: new Uint8Array(await r.arrayBuffer()) };
};
const stored = async (base, rid, eid) => Number((await door(base, 'checkpoints', rid, eid)).r.headers.get('x-checkpoints'));
const transcript = async (base, rid, eid) => { const { r } = await door(base, 'transcript', rid, eid); return { ticks: Number(r.headers.get('x-ticks')), hash: r.headers.get('x-transcript-hash') }; };
const chain = async (base, rid, eid) => toHex((await door(base, 'checkpoints', rid, eid)).bytes);
const forkProof = async (base, rid, eid) => (await door(base, 'equivocation', rid, eid)).r.status;
function driven(seed, tick) { const st = coreInit(seed); for (let t = 0; t < tick; t++) coreStep(st, 45875, 0, 0, 0, 0); return core.hash(st); }
const drive = (client, n) => { for (let i = 0; i < n; i++) client.record([45875, 0, 0, 0, 0]); };
async function publishAll(client) {
  for (let i = 0; i < 500 && (client.hold.length || client.publishing); i++) { await (client.drain() || client.publishing); await client.awaitPublishes(); }
}

test('the final mark goes to the node holding its inputs; a signer node that was down is fed the missing batches first, then the same mark, and receipts it', async () => {
  const round = await standUpRound({ host: '127.0.0.1', portA: 18270, portB: 18271 });
  let t;
  try {
    const named = await joinFromQuery(new URL(round.url).search);
    t = await tab(round, named);
    const { client, rid, eid } = t;
    const [A, B] = [client.base, ...client.peers];
    drive(client, 60);
    assert.equal((await client.markNow(driven(7, 60), 60)).live, true, 'with both up the first mark goes live');

    // B STOPS; the run goes on to its end on A.
    await round.b.close();
    await wait(100);
    drive(client, 60);
    await publishAll(client);
    const behindAtEnd = client.peerBatches()[0].ticks;

    // EVERY MESSAGE THE CLIENT SENDS TO B FROM HERE, in order.
    const toB = [];
    const real = client.sendPeer.bind(client);
    client.sendPeer = (base, bytes) => { if (base === B) toB.push(new Uint8Array(bytes)); return real(base, bytes); };

    const fin = await client.finish({ stateHash: driven(7, 120), tick: 120, why: 'the core said DELIVERED at tick 120' });
    const asked = fin.mark;
    const finalBytes = client.finalLink && toHex(client.finalLink.bytes);
    console.log(`  finish: B's feed at ${behindAtEnd}; final mark ${asked && asked.answer}, sent to ${asked && asked.sentTo} node(s), `
      + `witnessed ${client.finalLink ? client.witnessed(client.finalLink.id) : 0}; pending link ${client.pendingLink ? client.pendingLink.tick : null}`);
    assert.ok(asked && !asked.timedOut, 'the final mark waited on B and timed out - it was held for every peer');
    assert.equal(asked.sentTo, 1, 'the final mark was not sent to A alone');
    assert.equal(client.witnessed(client.finalLink.id), 1);
    assert.equal(client.pendingLink && client.pendingLink.tick, 120, 'the final mark is not the pending link');

    // B IS SERVED AGAIN; the re-offer catches it up.
    await round.restartB();
    for (let i = 0; i < 60 && client.finalCatchUp !== 'receipted'; i++) await wait(250);
    const kinds = toB.map((b) => (toHex(b) === finalBytes ? 'mark' : 'batch'));
    const firstMark = kinds.indexOf('mark');
    const batches = toB.filter((b, i) => kinds[i] === 'batch').map((b) => decodeInputBatch(b));
    const lastTick = Math.max(...batches.map((b) => b.firstTick + b.ticks.length - 1));
    const [ta, tb] = [await transcript(A, rid, eid), await transcript(B, rid, eid)];
    console.log(`  after B back: catch-up ${client.finalCatchUp} after ${client.finalRelinks} re-offer(s); to B: ${batches.length} batch(es) `
      + `ticks ${behindAtEnd}..${lastTick}, then the mark (message ${firstMark + 1} of ${toB.length}); A ${ta.ticks} ticks ${ta.hash.slice(0, 12)}, `
      + `B ${tb.ticks} ticks ${tb.hash.slice(0, 12)}; checkpoints A ${await stored(A, rid, eid)} B ${await stored(B, rid, eid)}`);
    assert.equal(client.finalCatchUp, 'receipted', 'B never receipted the final mark');
    assert.equal(client.witnessed(client.finalLink.id), 2);
    assert.ok(firstMark > 0, 'the mark went to B before any batch');
    assert.ok(kinds.slice(0, firstMark).every((k) => k === 'batch'), 'something other than batches went before the mark');
    assert.ok(batches.length > 0 && batches[0].firstTick === behindAtEnd, 'the feed did not start at the first tick B never answered');
    assert.ok(lastTick <= 119, `a batch past the mark's tick went to B: tick ${lastTick}`);
    assert.ok(toB.filter((b, i) => kinds[i] === 'mark').every((b) => toHex(b) === finalBytes), 'another mark was offered to B');
    assert.deepEqual([tb.ticks, tb.hash], [ta.ticks, ta.hash], 'B does not hold the transcript A holds');
    assert.equal(ta.ticks, 120);
    assert.equal(await chain(B, rid, eid), await chain(A, rid, eid), 'the two signer nodes hold different checkpoint chains');
    assert.deepEqual([await forkProof(A, rid, eid), await forkProof(B, rid, eid)], [204, 204], 'a fork proof exists');
  } finally {
    if (t) { t.client.ended = true; t.client.close(); }
    try { await round.close(); } catch { /* gone */ }
  }
});

test('the control: a mark that is not final, with a signer node short, still waits out its bound and is sent to nobody - and no second mark names one parent', async () => {
  const round = await standUpRound({ host: '127.0.0.1', portA: 18272, portB: 18273 });
  let t;
  try {
    const named = await joinFromQuery(new URL(round.url).search);
    t = await tab(round, named);
    const { client, rid, eid } = t;
    const [A, B] = [client.base, ...client.peers];
    client.markWaitMs = 1500;
    drive(client, 60);
    assert.equal((await client.markNow(driven(7, 60), 60)).live, true);
    await round.b.close();
    await wait(100);
    drive(client, 60);
    const t0 = Date.now();
    const held = await client.markNow(driven(7, 120), 120);
    const waited = Date.now() - t0;
    console.log(`  not final, B down: ${held.answer} after ${waited} ms; A stores ${await stored(A, rid, eid)}; final link ${client.finalLink ? 'set' : 'none'}`);
    assert.equal(held.timedOut, true, 'a non-final mark did not wait for B');
    assert.ok(waited >= client.markWaitMs - 100, `it waited ${waited} ms, not its ${client.markWaitMs} ms bound`);
    assert.equal(await stored(A, rid, eid), 1, 'the non-final mark was sent to A anyway');
    assert.equal(client.finalLink || null, null, 'a non-final mark became a final link');
    // B BACK: the next mark chains on the head both hold.
    await round.restartB();
    await wait(500);
    drive(client, 60);
    await publishAll(client);
    const next = await client.markNow(driven(7, 180), 180);
    await client.awaitPeers();
    console.log(`  B back: the next mark ${next.answer}, live ${next.live}; A ${await stored(A, rid, eid)} B ${await stored(B, rid, eid)} checkpoints`);
    assert.equal(next.live, true);
    assert.equal(await chain(B, rid, eid), await chain(A, rid, eid));
    assert.deepEqual([await forkProof(A, rid, eid), await forkProof(B, rid, eid)], [204, 204], 'a second mark named one parent');
  } finally {
    if (t) { t.client.ended = true; t.client.close(); }
    try { await round.close(); } catch { /* gone */ }
  }
});
