// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A SEAT WITH NO CHAIN VIEW STILL FINDS ITS ROUND'S PEERS (kanban #735, part 2). Measured 2026-10-27 in the 2026.1.9.11 release check:
// seat 1 was restarted inside round 2927d830's objection window and for ~15 min its roster read no chain view for the round
// ("reads no signer node addresses: this node has no chain view for that round"), so it asked nobody for FINAL and held its own
// signature alone while the other five held FINAL 6 of 6. Now the seated nodes' endpoints are kept with the round at seating time
// (round.keepRoundPeers), and every "where are the round's signer nodes" lookup reads them when the roster cannot answer.
//
// On the sevenSignerNodes fixture (one daemon, six keys): the round's peers kept as the seating agent keeps them, the roster's chain
// view taken away, no operator peers and no DKG peers - the finality tick still asks the kept peer (GET /final-sig) and takes its
// signature; GET /round-peers serves the kept set; the roster's answer comes first once the chain view is back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { schnorr } from '@noble/curves/secp256k1.js';
import { sevenSignerNodes } from './window-fixture.js';
import { testNow, skipTo } from './test-clock.js';
import { resultFinality } from '../src/finality.js';
import { NO_CHAIN_VIEW_WHY } from '../src/roster.js';
import { windowsOf } from '../../arena-protocol/src/window.js';
import { signFinalSig } from '../../arena-protocol/src/final-sig.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A peer that answers GET /final-sig for one entry with the signature it is given, once; every ask is counted. */
async function keptPeer() {
  const asks = [];
  const only = { entry: null };
  let answer = null;
  const srv = createServer((req, res) => {
    if (req.url.startsWith('/final-sig') && only.entry && req.url.includes(`entry=${only.entry}`)) {
      asks.push(Date.now());
      if (answer) { const a = answer(); answer = null; res.writeHead(200); return res.end(Buffer.from(a)); }
    }
    res.writeHead(404); res.end('no new signature');
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  return { port, http: `http://127.0.0.1:${port}`, asks, only, answerOnce: (f) => { answer = f; }, close: () => new Promise((r) => srv.close(r)) };
}

test('a seat whose roster has no chain view asks the peers kept at seating for FINAL and takes their signatures; the roster comes first when it answers', { timeout: 110000 }, async () => {
  const peer = await keptPeer();
  const w = await sevenSignerNodes(1000, undefined, { endMs: testNow() + 4000, finality: { everyMs: 250 } });
  try {
    const { holder, rid } = w;
    w.sign('agrees', () => ({}), { posted: false });
    w.post('agrees', 5);
    const eid = w.runs.agrees.eid;
    peer.only.entry = toHex(eid);
    // THE PREMISE: no operator peers, no DKG peers - only the census could name the peers, as on a live seat
    assert.equal((holder.verifier.peers || []).length, 0, 'the fixture names no operator peers');
    assert.equal((holder.dkg.peers || []).length, 0, 'the fixture names no DKG peers');
    // KEPT AS THE SEATING AGENT KEEPS THEM: the seated nodes' keys with their advertised (ws://) endpoints, this seat among them
    const seated = schnorr.getPublicKey(w.others[0]);
    const n = holder.round.keepRoundPeers(rid, 'game', [
      { node: toHex(seated), endpoint: `ws://127.0.0.1:${peer.port}/` },
      { node: toHex(holder.round.pubkey), endpoint: 'ws://127.0.0.1:1' },
      { node: toHex(schnorr.getPublicKey(w.others[1])), endpoint: '' },          // advertises none: not kept
    ]);
    assert.equal(n, 2, 'two rows kept: the node with no endpoint is not written');
    // THE CHAIN VIEW GOES, as on seat 1 at 10:52Z: the roster refuses every committee
    const chainFor = holder.roster.chainFor;
    holder.roster.chainFor = () => null;
    const refused = holder.roster.committeeFor(rid, 'game');
    assert.equal(refused.ok, false);
    assert.equal(refused.why, NO_CHAIN_VIEW_WHY);
    // every lookup falls back to the kept set, this seat left out, ws:// turned into the doors' http://
    assert.deepEqual(holder.verifier.peersFor(rid), [peer.http], 'the verifier\'s peers are the kept ones');
    // the door a peer may ask
    const door = await (await fetch(`http://127.0.0.1:${holder.port}/round-peers?round=${toHex(rid)}`)).json();
    assert.deepEqual(door.peers.game.map((p) => p.node).sort(), [toHex(seated), toHex(holder.round.pubkey)].sort());
    assert.deepEqual(door.peers.settlement, []);
    assert.equal(door.fromRoster.game, false, 'the door says the roster did not answer');

    // THE RUN BECOMES SIGNABLE: the finality tick signs here and asks the peers - the kept one answers another seat's FINAL
    skipTo(Number(windowsOf(w.contract).finalAfterMs) + 100);
    const f = resultFinality(holder.round, rid, eid);
    assert.ok(f.signable, f.why);
    const runId = fromHex(typeof f.signable.runId === 'string' ? f.signable.runId : toHex(f.signable.runId));
    peer.answerOnce(() => signFinalSig({ roundId: rid, entryId: eid, runId, signerPubkey: seated, signedAtMs: BigInt(holder.round.now()) },
      (d) => schnorr.sign(d, w.others[0])));
    for (let i = 0; i < 160 && !holder.round.finalSigs(rid, eid, runId).some((r) => toHex(r.signerPubkey) === toHex(seated)); i++) await sleep(250);
    assert.ok(peer.asks.length >= 1, `the kept peer was asked for FINAL: ${peer.asks.length} ask(s)`);
    const theirs = holder.round.finalSigs(rid, eid, runId).filter((r) => toHex(r.signerPubkey) === toHex(seated));
    assert.equal(theirs.length, 1, 'the kept peer\'s FINAL signature was gathered with no chain view');
    const own = holder.round.finalSigs(rid, eid, runId).filter((r) => toHex(r.signerPubkey) === toHex(holder.round.pubkey));
    assert.equal(own.length, 1, 'its own FINAL signature, once');
    const after = resultFinality(holder.round, rid, eid);
    assert.equal(after.finalSigs.signed, 2, `2 of 7 FINAL signatures held: ${JSON.stringify(after.finalSigs)}`);

    // THE ROSTER FIRST: the chain view back, the verifier's peers are the census's six again (the fixture's bonds advertise
    // node1..node6), not the kept one; a round nothing was kept for falls back to [] as before
    holder.roster.chainFor = chainFor;
    assert.equal(holder.roster.committeeFor(rid, 'game').ok, true, 'the roster answers again');
    const census = holder.verifier.peersFor(rid);
    assert.equal(census.length, 6, `the census's six addresses come first: ${census.join(', ')}`);
    assert.ok(!census.includes(peer.http), 'the kept one is not among them');
    assert.deepEqual(holder.round.roundPeers(new Uint8Array(32).fill(0x11), 'game'), [], 'a round nothing was kept for');
    console.log(`  FACTS: asks ${peer.asks.length}, FINAL signatures ${after.finalSigs.signed}, kept rows ${n}, roster refused with "${refused.why}"`);
  } finally { await w.close(); await peer.close(); }
});
