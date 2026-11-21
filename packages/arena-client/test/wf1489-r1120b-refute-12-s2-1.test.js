// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// REFUTE of #3036 / #3177 (kanban #1489, wf1489 r1120b item 12, skeptic 2): a different attacker role - ONE PEER seat, not the home seat.
//
// 606649c69 (#3177) offers a batch the home seat answered 'error stake not seen' to the peers from the FIRST batch on, and
// #carriedByPeers awaits EVERY peer feed (awaitPeers). A peer link has no answer timeout (sendPeer), so one peer seat that
// keeps its /play socket open and never answers a batch keeps batch() from ever returning: an honest home seat whose stake
// view is a moment behind (the normal "stake still on its way" wait) answers the first batch 'stake not seen', the batch
// goes to the peers, the silent peer holds the await forever, `publishing` never settles, and the home seat - which counts
// the stake a moment later - never receives another tick. Before #3177 that stake wait was held and asked again, and the run
// went on. SAFE BEHAVIOUR asserted: once the honest home seat has counted the stake, it ends up holding every tick signed.
import { TEST_FEDERATION_ID } from '../../arena-protocol/src/test-federation.js';
import { TRUCK_CORE_HASH, TRUCK_V3_CONFIG_HASH, NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';
import { BLOCK_TICKS } from '../../nextblock/src/rules/gate.js';
import { TEST_DONATION_SET_REGTEST } from '../../arena-protocol/src/test-donation-sets.js';
import { donationSetId as idOfDonationSet } from '../../arena-protocol/src/donation.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequire } from 'node:module';
import { WebSocketServer, WebSocket as WS } from 'ws';
import { ed25519 } from '@noble/curves/ed25519.js';
import { schnorr } from '@noble/curves/secp256k1.js';

import { openStore } from '../../arena-node/src/store.js';
import { serve } from '../../arena-node/src/server.js';
import { Client } from '../src/client.js';
import { entryId as entryIdOf, encodeRoundContract } from '../../arena-protocol/src/contracts.js';
import { MIN_ENTRY_WINDOW_MS, TYPE_SIGNED_INPUT_BATCH } from '../../arena-protocol/src/constants.js';
import { NETWORK_ID_REGTEST } from '../../arena-protocol/src/genesis-ids.js';
import { assumeStakeSeen } from '../../arena-node/test/assignment.js';
import { HOSTED } from '../../arena-node/test/plugins/hosted.js';

const require = createRequire(import.meta.url);
const core = require('../../nextblock/dist/blwp-core.js');
const b32 = (n) => new Uint8Array(32).fill(n);
const verify = (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const FUNDED = { funded: () => true, randomnessFor: () => ({ hash: b32(0xbe), height: 900005, timeMs: 900n }) };
const HONEST = [45875, 22000, 0, 0, 0];

/**
 * THE MALICIOUS HOME SEAT: a real seat (`a`) behind a front that passes every HTTP request and /play frame through
 * unchanged - until `lie` is set; then it answers each signed input batch itself with `lie(bytes)` and keeps it from `a`.
 */
async function maliciousFront(a) {
  const front = { lie: null };
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    try {
      const r = await fetch(`http://127.0.0.1:${a.port}${req.url}`, {
        method: req.method, headers: { 'content-type': req.headers['content-type'] || 'application/octet-stream' },
        body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body,
      });
      const out = Buffer.from(await r.arrayBuffer());
      const headers = {};
      r.headers.forEach((v, k) => { if (k !== 'content-length' && k !== 'transfer-encoding' && k !== 'connection') headers[k] = v; });
      res.writeHead(r.status, headers);
      res.end(out);
    } catch (e) { res.writeHead(502); res.end(String(e.message)); }
  });
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, (down) => {
      const up = new WS(`ws://127.0.0.1:${a.port}/play`);
      const waiting = [];
      let chain = new Promise((ok, no) => { up.once('open', ok); up.once('error', no); });
      up.on('message', (data, isBinary) => {
        const w = waiting.shift();
        if (w) w({ data, isBinary });
      });
      down.on('message', (data, isBinary) => {
        chain = chain.then(async () => {
          const bytes = new Uint8Array(data);
          if (isBinary && front.lie && bytes[0] === TYPE_SIGNED_INPUT_BATCH) {
            const said = front.lie(bytes);
            if (said === null) return;          // the seat says nothing at all
            down.send(said, { binary: typeof said !== 'string' });
            return;
          }
          const answer = await new Promise((ok) => { waiting.push(ok); up.send(data, { binary: isBinary }); });
          down.send(answer.data, { binary: answer.isBinary });
        }).catch(() => {});
      });
      down.on('close', () => { try { up.close(); } catch { /* gone */ } });
      up.on('close', () => { try { down.close(); } catch { /* gone */ } });
    });
  });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  front.port = server.address().port;
  front.close = () => new Promise((ok) => { for (const c of wss.clients) c.terminate(); server.close(() => ok()); server.closeAllConnections?.(); });
  return front;
}

async function rig() {
  const a = await serve(openStore(':memory:'), { plugins: HOSTED, port: 0, ...FUNDED });   // the honest home seat
  const b = await serve(openStore(':memory:'), { plugins: HOSTED, port: 0, ...FUNDED });   // an honest peer
  const c = await serve(openStore(':memory:'), { plugins: HOSTED, port: 0, ...FUNDED });   // the malicious peer
  const home = await maliciousFront(a);   // passes everything through; used only to make the home's first answer a stake wait
  const silent = await maliciousFront(c);  // the attacker: silent on every batch
  const session = ed25519.utils.randomSecretKey();
  const sign = (id) => ed25519.sign(id, session);
  const contract = {
    networkId: NETWORK_ID_REGTEST, configHash: TRUCK_V3_CONFIG_HASH, censusConfirmations: 6,
    gameVerifySlots: 2, settlementSlots: 2, gameId: NEXTBLOCK_GAME_ID, simCoreHash: TRUCK_CORE_HASH,
    committeeTimeMs: 500n, randomnessRule: 'bitcoin-block-hash',
    startTimeMs: 500n + MIN_ENTRY_WINDOW_MS, entryCloseMs: 200000n,
    objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20,
    slashRemainder: 'SPLIT', federationId: TEST_FEDERATION_ID, stakeExpiryBlocks: 144, publicationRelays: ['wss://r.example'], donationSetId: idOfDonationSet(TEST_DONATION_SET_REGTEST.recipients), censusHeight: 900000,
    censusRoot: b32(2), stakeMsat: 0n, bondMinSats: 50000n, blockTicks: BLOCK_TICKS,
    exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20,
    timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4,
    nodes: [a.round.pubkey, b.round.pubkey, c.round.pubkey],
  };
  const client = new Client({ base: `http://127.0.0.1:${home.port}`, core, sign, verify });
  client.deliverTo([`http://127.0.0.1:${b.port}`, `http://127.0.0.1:${silent.port}`]);
  const rid = await client.openRound(contract);
  for (const n of [b, c]) {
    const r = await fetch(`http://127.0.0.1:${n.port}/round`, { method: 'POST', body: encodeRoundContract(contract) });
    assert.ok(r.status === 201 || r.status === 200, `the peer took the round (${r.status})`);
  }
  const entry = {
    roundId: rid, playerPubkey: b32(5), sessionPubkey: ed25519.getPublicKey(session),
    stakeCommitment: b32(7), stakeMsat: 0n, feeMsat: 0n, donationMsat: 0n,
    joinTick: 0, worldSecret: b32(0x5e), vssSharesRef: new Uint8Array(32), stakePoint: new Uint8Array(33), feePreimage: new Uint8Array(32), stakeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, feeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, claimKeyAttestationRef: new Uint8Array(32),
  };
  const eid = await client.join(entry);
  assert.deepEqual(eid, entryIdOf(entry));
  for (const n of [a, b, c]) { assert.ok(n.round.entry(eid), 'every seat holds the entry'); assumeStakeSeen(n.round, entry); }
  await client.connect();
  client.setRound({ roundId: rid, entryId: eid, blockTicks: contract.blockTicks });
  return { a, b, c, home, silent, client, rid, eid };
}

let recorded = 0;
const race = (p, ms) => Promise.race([p, wait(ms)]);
async function drive(client, n) {
  for (let i = 0; i < n; i++) client.record([HONEST[0], HONEST[1] + (recorded++ % 4096), 0, 0, 0]);
  for (let i = 0; i < 12; i++) {
    const p = client.drain();
    if (p) { try { await race(p, 300); } catch { /* the refusal is the measurement */ } }
    if (client.recovering) { try { await race(client.recovering, 300); } catch { /* named on the client */ } }
    await wait(3);
    if ((!client.hold.length && !client.publishing) || client.ended) break;
  }
}
const ticksAt = (node, rid, eid) => node.round.transcript(rid, eid).ticks;
const say = (c) => `(client ended=${c.ended} ${c.endingReason || ''}; held ${c.hold.length}; publishing ${!!c.publishing}; stakeWaits ${c.stakeWaits}; nextTick ${c.nextTick})`;

test('wf1489-r1120b-refute-12-s2-1: one silent PEER seat does not stall publishing after the honest home seat\'s first-batch stake wait (#3177)', async () => {
  const { a, b, c, home, silent, client, rid, eid } = await rig();
  try {
    silent.lie = () => null;                       // the malicious peer: socket open, never answers a batch
    // the honest home seat: its stake view one batch behind - the first batch is answered as a stake still on its way
    home.lie = () => { home.lie = null; return 'error stake not seen: its stake lock has not been verified by this signer node (§23.1 step 5)'; };
    await drive(client, 15);
    // from here the home seat has counted the stake and answers honestly
    for (let k = 0; k < 8; k++) await drive(client, 15);
    for (let i = 0; i < 40 && ticksAt(a, rid, eid).length < 135; i++) { try { await race(client.drain() || Promise.resolve(), 50); } catch { /* measured below */ } await wait(20); }
    assert.equal(ticksAt(a, rid, eid).length, 135,
      `one silent peer seat keeps the player's ticks from the honest home seat: it holds ${ticksAt(a, rid, eid).length} of 135 ${say(client)}`);
  } finally { client.close(); await home.close(); await silent.close(); await a.close(); await b.close(); await c.close(); }
});
