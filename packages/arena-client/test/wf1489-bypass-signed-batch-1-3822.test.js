// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 bypass of #1503 (signed batches) beside #3696/#3697/#3711: a home seat that KEEPS a signed batch A but
// answers it with an ordinary refusal (not the socket closing, not 'stake not seen'), while the peers refuse A once too,
// makes the client re-sign a second, bigger batch B on the same previousHash after its resync. The seat then hands the
// kept, validly signed A to the honest peers first: they take it (first one wins) and refuse the player's real chain -
// the seat wrote a run into the victim's entry at the honest seats that the player never published.
// Rig copied from wf1489-3711-refused-taken-batch.test.js.
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
import { toHex } from '../../arena-protocol/src/hash.js';
import { entryId as entryIdOf, encodeRoundContract } from '../../arena-protocol/src/contracts.js';
import { MIN_ENTRY_WINDOW_MS, TYPE_SIGNED_INPUT_BATCH } from '../../arena-protocol/src/constants.js';
import { NETWORK_ID_REGTEST } from '../../arena-protocol/src/genesis-ids.js';
import { splitSignedBatch } from '../../arena-protocol/src/batch.js';
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
            if (said !== undefined) { down.send(said, { binary: typeof said !== 'string' }); return; }   // undefined: passed through
          }
          if (isBinary && front.before && bytes[0] === TYPE_SIGNED_INPUT_BATCH) await front.before(bytes);
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
  front.wss = wss;
  front.close = () => new Promise((ok) => { for (const c of wss.clients) c.terminate(); server.close(() => ok()); server.closeAllConnections?.(); });
  return front;
}

async function rig3() {
  const a = await serve(openStore(':memory:'), { plugins: HOSTED, port: 0, ...FUNDED });   // the home seat
  const b = await serve(openStore(':memory:'), { plugins: HOSTED, port: 0, ...FUNDED });   // an honest peer
  const c = await serve(openStore(':memory:'), { plugins: HOSTED, port: 0, ...FUNDED });   // a second peer
  const front = await maliciousFront(a);
  // kanban #3697: the peer, reached through a pass-through front that can stand in for a stake view still behind ('stake not seen')
  const bFront = await maliciousFront(b);
  const cFront = await maliciousFront(c);
  const session = ed25519.utils.randomSecretKey();
  const sign = (id) => ed25519.sign(id, session);
  const contract = {
    networkId: NETWORK_ID_REGTEST, configHash: TRUCK_V3_CONFIG_HASH, censusConfirmations: 6,
    gameVerifySlots: 3, settlementSlots: 3, gameId: NEXTBLOCK_GAME_ID, simCoreHash: TRUCK_CORE_HASH,
    committeeTimeMs: 500n, randomnessRule: 'bitcoin-block-hash',
    startTimeMs: 500n + MIN_ENTRY_WINDOW_MS, entryCloseMs: 200000n,
    objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20,
    slashRemainder: 'SPLIT', federationId: TEST_FEDERATION_ID, stakeExpiryBlocks: 144, publicationRelays: ['wss://r.example'], donationSetId: idOfDonationSet(TEST_DONATION_SET_REGTEST.recipients), censusHeight: 900000,
    censusRoot: b32(2), stakeMsat: 0n, bondMinSats: 50000n, blockTicks: BLOCK_TICKS,
    exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20,
    timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4,
    nodes: [a.round.pubkey, b.round.pubkey, c.round.pubkey],
  };
  const client = new Client({ base: `http://127.0.0.1:${front.port}`, core, sign, verify });
  client.deliverTo([`http://127.0.0.1:${bFront.port}`, `http://127.0.0.1:${cFront.port}`]);
  const rid = await client.openRound(contract);
  for (const p of [b, c]) {
    const r = await fetch(`http://127.0.0.1:${p.port}/round`, { method: 'POST', body: encodeRoundContract(contract) });
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
  return { a, b, c, front, bFront, cFront, client, rid, eid, entry };
}

let recorded = 0;
const race = (p, ms) => Promise.race([p, wait(ms)]);
async function drive(client, n) {
  for (let i = 0; i < n; i++) client.record([HONEST[0], HONEST[1] + (recorded++ % 4096), 0, 0, 0]);
  for (let i = 0; i < 60; i++) {
    const p = client.drain();
    if (p) { try { await race(p, 300); } catch { /* the refusal is the measurement */ } }
    if (client.recovering) { try { await race(client.recovering, 300); } catch { /* named on the client */ } }
    await wait(3);
    if ((!client.hold.length && !client.publishing) || client.ended) break;
  }
}
const ticksAt = (node, rid, eid) => node.round.transcript(rid, eid).ticks;
async function settle(client, node, rid, eid, want) {
  for (let i = 0; i < 100; i++) {
    client.pumpPeers();
    await wait(20);
    if (ticksAt(node, rid, eid).length >= want) return;
  }
}
const say = (c) => `(client ended=${c.ended} ${c.endingReason || ''}; held ${c.hold.length}; publishing ${!!c.publishing}; stakeWaits ${c.stakeWaits}; homeRefusals ${c.homeRefusals || 0} ${c.homeRefusedWhy || ''})`;




test('bypass-signed-batch-1: a batch the home seat refused (and kept) while the peers refused it once is never followed by a second batch on its head', async () => {
  const { a, b, c, front, bFront, cFront, client, rid, eid } = await rig3();
  const byHead = new Map();
  const seen = (bytes) => {
    const { batch, id } = splitSignedBatch(bytes);
    const h = toHex(batch.previousHash);
    if (!byHead.has(h)) byHead.set(h, new Set());
    byHead.get(h).add(toHex(id));
  };
  let A = null;
  // the home seat keeps the first frame from the real seat and answers an ordinary refusal; the game goes on meanwhile
  front.lie = (bytes) => {
    seen(bytes);
    front.lie = null; A = bytes.slice();
    for (let i = 0; i < 15; i++) client.record([HONEST[0], HONEST[1] + (recorded++ % 4096), 0, 0, 0]);
    return 'error the batch breaks a rule of this seat';
  };
  // each peer refuses A once (a peer still catching up, a short outage of its own)
  const onceRefuse = (f) => { f.lie = (bytes) => { if (A && Buffer.from(bytes).equals(Buffer.from(A))) { f.lie = null; return 'error not now'; } return undefined; }; };
  onceRefuse(bFront); onceRefuse(cFront);
  bFront.before = async (bytes) => { seen(bytes); };
  cFront.before = async (bytes) => { seen(bytes); };
  let handed = null;
  // the next frame the client sends the home seat: the seat first hands the kept A to both honest peers itself
  front.before = (bytes) => new Promise((ok) => {
    seen(bytes);
    if (!A || handed) return ok();
    handed = { second: bytes.slice(), said: [] };
    let left = 2;
    for (const p of [b, c]) {
      const ws = new WS(`ws://127.0.0.1:${p.port}/play`);
      ws.on('open', () => ws.send(A));
      ws.on('message', (m) => { handed.said.push(String(m)); ws.close(); if (--left === 0) ok(); });
      ws.on('error', () => { if (--left === 0) ok(); });
    }
  });
  for (let k = 0; k < 8; k++) await drive(client, 15);
  for (let k = 0; k < 2; k++) await drive(client, 0);
  for (let i = 0; i < 100; i++) { client.pumpPeers(); await wait(20); if (ticksAt(b, rid, eid).length >= 135 && ticksAt(c, rid, eid).length >= 135) break; }
  try {
    assert.ok(A, 'the home seat kept a first batch');
    const heads = [...byHead.entries()].map(([h, ids]) => `${h.slice(0, 8)}:${ids.size}`);
    const same = handed && Buffer.from(handed.second).equals(Buffer.from(A));
    console.log(`bypass-1 heads ${heads.join(' ')}; A ${A.length} B, next ${handed ? handed.second.length : '-'} B same ${same}; peers said ${handed ? handed.said.join(' | ') : '-'}; home ${ticksAt(a, rid, eid).length}, b ${ticksAt(b, rid, eid).length}, c ${ticksAt(c, rid, eid).length} ${say(client)}`);
    for (const [h, ids] of byHead) assert.equal(ids.size, 1, `the client signed ${ids.size} different batches on head ${h.slice(0, 16)}`);
    assert.equal(ticksAt(b, rid, eid).length, 135, `the honest peer b holds every tick the player published ${say(client)}`);
    assert.equal(ticksAt(c, rid, eid).length, 135, `the honest peer c holds every tick the player published ${say(client)}`);
  } finally { client.close(); for (const f of [front, bFront, cFront]) await f.close(); for (const n of [a, b, c]) await n.close(); }
});
