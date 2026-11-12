#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// TICK TOCK'S DRAWN PARCELS, MEASURED ON A PRIVATE REGTEST (spec ruling of kanban #2571, #2574).
//
// Two regtest bitcoinds, peered (node A mines). Three blocks of ~110 wallet transactions each, of every parcel size class and
// fee rate, then two empty blocks for depth. Seven seats - seats 1-4 read node A, seats 5-7 node B - each find the round's beacon
// with the seat's own beacon reader (beacon-source.js) and derive the snapshot with its own reader (ticktock-snapshots.js), and
// each runs the load door (Round.batch) for one entry of a round on core 383aa469. Measured:
//   1. every seat derives the same snapshot_id;
//   2. a load naming a txid not drawn for its slot, and the drawn txid at another slot, are refused at every seat; the honest
//      load is taken at every seat;
//   3. a replay reproduces the offers from the block alone: a fresh reader of node B, the beacon hash and the entry - and the
//      parcels the seats stored are exactly those offers;
//   4. a client holds the snapshot from a seat's GET /snapshot answer on the seats' signed listings (5 of 7), its txids checked
//      against the real headers' merkle roots.
//
//   BITCOIND=/path/to/bitcoind node tools/ticktock-snapshot-regtest.mjs [scratch dir]     (ports 4257x; nothing else is touched)
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { schnorr } from '@noble/curves/secp256k1.js';
import { openStore } from '../src/store.js';
import { Round } from '../src/round.js';
import { chainBeacon } from '../src/beacon-source.js';
import { chainSnapshots } from '../src/ticktock-snapshots.js';
import { encodeInputBatch, batchId, decodeInputBatch } from '../../arena-protocol/src/batch.js';
import { GENESIS } from '../../arena-protocol/src/transcript.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { offersOf, offeredParcel, roomOfVsize, drawnParcelsRefusal, OFFER_SLOTS } from '../../arena-protocol/src/ticktock-snapshot.js';
import { lobbyListingId } from '../../arena-protocol/src/lobby-listing.js';
import { TEST_FEDERATION_ID } from '../../arena-protocol/src/test-federation.js';
import { TEST_DONATION_SET_REGTEST } from '../../arena-protocol/src/test-donation-sets.js';
import { donationSetId } from '../../arena-protocol/src/donation.js';
import { entryFeeMsat } from '../../arena-protocol/src/fee.js';
import { NETWORK_ID_REGTEST } from '../../arena-protocol/src/genesis-ids.js';
import { NEXTBLOCK_CORES_V8, TRUCK_383A_HASH, TRUCK_V3_CONFIG_HASH } from '../../nextblock/plugin/nextblock.js';
import { BLOCK_TICKS } from '../../nextblock/src/rules/gate.js';
import { testGame } from '../test/plugins/sign.js';
import { snapshotHeld } from '../../arena-client/src/ticktock-hold.js';

const BITCOIND = process.env.BITCOIND || 'bitcoind';
const DIR = process.argv[2] || mkdtempSync(join(tmpdir(), 'tt2574-'));
const PORTS = { A: { p2p: 42571, rpc: 42572 }, B: { p2p: 42573, rpc: 42574 } };
const AUTH = 'Basic ' + Buffer.from('tt2574:regtest-only').toString('base64');
const say = (s) => console.log(`#2574 ${s}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b32 = (n) => new Uint8Array(32).fill(n);

const rpc = (port, wallet = null) => async (method, params = []) => {
  const r = await fetch(`http://127.0.0.1:${port}/${wallet ? `wallet/${wallet}` : ''}`, { method: 'POST', headers: { authorization: AUTH, 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '1.0', id: 1, method, params }) });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
};
const procs = [];
function start(name) {
  const d = join(DIR, name); mkdirSync(d, { recursive: true });
  const { p2p, rpc: rp } = PORTS[name];
  writeFileSync(join(d, 'bitcoin.conf'), `regtest=1\n[regtest]\nport=${p2p}\nrpcport=${rp}\nrpcbind=127.0.0.1\nrpcallowip=127.0.0.1\nrpcuser=tt2574\nrpcpassword=regtest-only\nlisten=1\nbind=127.0.0.1\ndiscover=0\ndnsseed=0\nfallbackfee=0.0001\ntxindex=0\n`);
  const p = spawn(BITCOIND, [`-datadir=${d}`], { stdio: 'ignore' });
  procs.push(p);
}
const stop = async () => { for (const [n, { rpc: p }] of Object.entries(PORTS)) { try { await rpc(p)('stop'); } catch { /* down */ } void n; } await sleep(1500); for (const p of procs) try { p.kill(); } catch { /* gone */ } };

async function up(call) { for (let i = 0; i < 60; i++) { try { await call('getblockcount'); return; } catch { await sleep(500); } } throw new Error('bitcoind did not come up'); }

async function main() {
  say(`scratch ${DIR}, bitcoind ${BITCOIND}`);
  start('A'); start('B');
  const A = rpc(PORTS.A.rpc), B = rpc(PORTS.B.rpc);
  await up(A); await up(B);
  await B('addnode', [`127.0.0.1:${PORTS.A.p2p}`, 'add']);
  await A('addnode', [`127.0.0.1:${PORTS.B.p2p}`, 'add']);
  // block times 600 s apart from now on, both nodes on the same mock clock (a wallet made before it would skip blocks older than its birth)
  let clock = Math.floor(Date.now() / 1000);
  await A('setmocktime', [clock]); await B('setmocktime', [clock]);
  await A('createwallet', ['w']);
  const W = rpc(PORTS.A.rpc, 'w');
  const mine = async (n) => { const to = await W('getnewaddress'); for (let i = 0; i < n; i++) { clock += 600; await A('setmocktime', [clock]); await B('setmocktime', [clock]); await A('generatetoaddress', [1, to]); } };
  await mine(260);
  const pool = []; for (let i = 0; i < 60; i++) pool.push(await W('getnewaddress'));
  { const b = await W('getbalances'); say(`wallet: ${b.mine.trusted} BTC spendable, ${b.mine.immature} immature, ${(await W('listunspent')).length} coins`); }
  // three blocks of 110 transactions: 1, 4, 12 or 36 outputs (the four parcel size classes), fee rates 1 .. 60 sat/vB
  const shapes = [1, 4, 12, 36];
  let made = 0;
  for (let blk = 0; blk < 3; blk++) {
    for (let i = 0; i < 110; i++) {
      const k = shapes[(i + blk) % 4];
      const amounts = {}; for (let o = 0; o < k; o++) amounts[pool[(i * 7 + o) % pool.length]] = Number((0.0001 + ((i + o) % 9) / 10000).toFixed(8));
      try { await W('sendmany', { dummy: '', amounts, fee_rate: 1 + ((i * 13 + blk) % 60) }); }
      catch (e) { const b = await W('getbalances'); throw new Error(`block ${blk} tx ${i} (${k} outputs): ${e.message}; trusted ${b.mine.trusted}, pending ${b.mine.untrusted_pending}`); }
      made++;
    }
    await mine(1);
  }
  await mine(2);
  const tip = await A('getblockcount');
  for (let i = 0; i < 240 && (await B('getblockcount')) !== tip; i++) { if (i % 20 === 19) await B('addnode', [`127.0.0.1:${PORTS.A.p2p}`, 'onetry']).catch(() => {}); await sleep(500); }
  if ((await B('getblockcount')) !== tip) throw new Error(`node B did not sync: ${await B('getblockcount')} of ${tip}, ${(await B('getpeerinfo')).length} peers`);
  say(`regtest: ${made} wallet transactions in blocks ${tip - 4} .. ${tip - 2}, tip ${tip}, node B at ${await B('getblockcount')}`);

  // THE ROUND: committee time just before the median time past of the last block with transactions, so it is the beacon
  const H = tip - 2;
  const mtpOf = async (h) => (await A('getblockheader', [await A('getblockhash', [h])])).mediantime;
  const committeeTimeMs = BigInt(await mtpOf(H - 1)) * 1000n + 1000n;
  const V8 = testGame({ name: 'nextblock', cores: NEXTBLOCK_CORES_V8, runTicksMax: BLOCK_TICKS, dev: 'ticktock v8 regtest' });
  const contract = {
    networkId: NETWORK_ID_REGTEST, configHash: TRUCK_V3_CONFIG_HASH, censusConfirmations: 2, gameVerifySlots: 7, settlementSlots: 7,
    gameId: V8.gameId, simCoreHash: fromHex(TRUCK_383A_HASH), startTimeMs: committeeTimeMs + 60000n, entryCloseMs: committeeTimeMs + 30000n,
    objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20, slashRemainder: 'SPLIT', federationId: TEST_FEDERATION_ID,
    stakeExpiryBlocks: 144, publicationRelays: ['wss://r.example'], donationSetId: donationSetId(TEST_DONATION_SET_REGTEST.recipients),
    censusHeight: H - 30, censusRoot: b32(2), committeeTimeMs, randomnessRule: 'bitcoin-block-hash', stakeMsat: 100000n, bondMinSats: 50000n,
    blockTicks: BLOCK_TICKS, exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20, timeFloor: 30, timeCeil: 150, minScore: 1,
    rankNumerator: 3, rankDenominator: 4, nodes: [b32(4)],
  };
  const entry = (rid) => ({ roundId: rid, playerPubkey: b32(5), sessionPubkey: b32(6), stakeCommitment: b32(7), stakeMsat: 100000n,
    feeMsat: entryFeeMsat(100000n), donationMsat: 0n, joinTick: 0, worldSecret: b32(0x5e), vssSharesRef: new Uint8Array(32), stakePoint: new Uint8Array(33),
    feePreimage: new Uint8Array(32), stakeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, feeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n },
    claimKeyAttestationRef: new Uint8Array(32) });

  // SEVEN SEATS, EACH ITS OWN STORE, BEACON READER AND SNAPSHOT READER
  const seats = [];
  for (let i = 0; i < 7; i++) {
    const call = i < 4 ? A : B;
    const r = new Round(openStore(), () => Number(committeeTimeMs) + 5000, { plugins: [V8] });
    const beacon = chainBeacon({ call, window: 400 });
    const snaps = chainSnapshots({ call, log: () => {} });
    const rid = r.open(contract);
    const eid = r.enter(entry(rid));
    const seen = await beacon.refresh(contract);
    if (!seen.ok) throw new Error(`seat ${i + 1}: no beacon: ${seen.why}`);
    const got = await snaps.refresh(seen);
    r.snapshotOf = () => { const g = snaps.for(beacon.for({ contract })); return g ? { snapshot: g.snapshot, id: g.id } : { why: 'not read' }; };
    seats.push({ i: i + 1, r, rid, eid, beacon: seen, got, snaps, node: i < 4 ? 'A' : 'B' });
  }
  const ids = new Set(seats.map((s) => toHex(s.got.id)));
  const s0 = seats[0];
  say(`1. beacon block ${s0.beacon.height} (${toHex(Buffer.from(s0.beacon.hash).reverse()).slice(0, 16)}); snapshot ${s0.got.snapshot.count} transactions over ${s0.got.blocks.length} blocks`);
  for (const s of seats) say(`   seat ${s.i} (node ${s.node}): beacon ${s.beacon.height}, snapshot_id ${toHex(s.got.id)}`);
  say(`   distinct snapshot ids across 7 seats: ${ids.size}`);
  if (ids.size !== 1) throw new Error('the seats disagree');
  const rooms = new Map(); for (const e of s0.got.snapshot.entries) rooms.set(roomOfVsize(e.vsize), (rooms.get(roomOfVsize(e.vsize)) || 0) + 1);
  say(`   size classes in the snapshot (room -> count): ${[...rooms].map(([k, v]) => `${k}:${v}`).join(' ')}`);

  // THE LOADS: an honest bed of the parcels drawn at slots 1, 6, 22; a txid not drawn for slot 22; the slot-6 txid at slot 7
  const { rid, eid } = s0;
  const snap = s0.got.snapshot;
  const pick = [1, 6, 22].map((slot) => ({ slot, p: offeredParcel(snap, rid, eid, slot) }));
  const fee = pick.reduce((n, x) => n + Number(x.p.feeSat), 0), room = pick.reduce((n, x) => n + roomOfVsize(x.p.vsize), 0);
  const drawnSet = new Set(offersOf(snap, rid, eid).map((o) => toHex(o.txid)));
  const stranger = snap.entries.find((e) => !drawnSet.has(toHex(e.txid)));
  const batchOf = (loads) => encodeInputBatch({ roundId: rid, entryId: eid, previousHash: GENESIS, firstTick: 0, ticks: Array.from({ length: 10 }, () => [0, 0, 0, 0, 0]), liquidations: [], loads });
  const honest = [[2, fee, 0, room, pick.map((x) => [x.slot, x.p.txid])]];
  const notDrawn = [[2, fee, 0, room, [[1, pick[0].p.txid], [6, pick[1].p.txid], [22, stranger.txid]]]];
  const otherSlot = [[2, fee, 0, room, [[1, pick[0].p.txid], [7, pick[1].p.txid], [22, pick[2].p.txid]]]];
  const declared = [[2, 245, 0, 393214]];
  const at = (name, bytes) => seats.map((s) => { try { s.r.batch(bytes); return 'taken'; } catch (e) { return `refused (${e.message.slice(0, 70)})`; } }).map((v, k) => `seat ${k + 1}: ${v}`);
  for (const [name, loads] of [['a txid not drawn for slot 22', notDrawn], ['the slot-6 parcel named at slot 7', otherSlot], ['a self-declared bed, no parcel', declared]]) {
    const res = at(name, batchOf(loads));
    say(`2. ${name}: ${res.filter((x) => /refused/.test(x)).length} of 7 refused`);
    say(`   ${res[0]}`);
    if (res.some((x) => /taken/.test(x))) throw new Error(`${name} was taken somewhere`);
  }
  const ok = at('honest', batchOf(honest));
  say(`2. the honest bed (slots 1, 6, 22 -> ${fee} sats, room ${room}): ${ok.filter((x) => /taken/.test(x)).length} of 7 took it`);

  // A REPLAY FROM THE BLOCK ALONE: a fresh reader of node B, the beacon hash, the round and the entry
  const fresh = chainSnapshots({ call: B, log: () => {} });
  const replayed = await fresh.refresh({ hash: s0.beacon.hash, height: s0.beacon.height });
  const offers = offersOf(replayed.snapshot, rid, eid);
  const stored = decodeInputBatch(new Uint8Array(seats[6].r.db.prepare('SELECT bytes FROM batches WHERE entry_id = ? ORDER BY seq').all(eid)[0].bytes));
  const named = stored.loads[0][4];
  const match = named.every(([slot, txid]) => toHex(offers[slot].txid) === toHex(txid));
  say(`3. replay from block ${s0.beacon.height} alone: snapshot_id ${toHex(replayed.id).slice(0, 16)} (same: ${toHex(replayed.id) === toHex(s0.got.id)}), ${offers.length} offers drawn; seat 7's stored load names slots ${named.map((p) => p[0]).join(', ')} - each the replay's offer: ${match}; drawnParcelsRefusal on the replay: ${drawnParcelsRefusal(stored.loads[0], { snapshot: replayed.snapshot, roundId: rid, entryId: eid })}`);
  if (!match) throw new Error('the replay does not reproduce the offers');

  // THE CLIENT: GET /snapshot as seat 5 serves it, held on the seats' signed listings (each seat's own node key), 5 of 7
  const nowMs = BigInt(Number(committeeTimeMs) + 5000);
  const listings = seats.map((s) => {
    const row = { id: toHex(rid), phase: 'open', assignedHere: true, joined: 1, playing: 1, snapshot: toHex(s.got.id) };
    row.sig = toHex(schnorr.sign(lobbyListingId({ roundId: rid, nodePubkey: s.r.pubkey, nowMs, phase: 'open', assignedHere: true, joined: 1, playing: 1, snapshotId: s.got.id }), s.r.identity.secret));
    return { node: toHex(s.r.pubkey), nowMs: String(nowMs), rounds: [row] };
  });
  const wire = JSON.parse(JSON.stringify(seats[4].snaps.json(seats[4].got, rid)));
  const signers = seats.map((s) => toHex(s.r.pubkey));
  const held = snapshotHeld({ roundId: toHex(rid), signers, needed: 5, listings: listings.slice(0, 5), snapshot: wire, verify: (sg, m, k) => schnorr.verify(sg, m, k) });
  const four = snapshotHeld({ roundId: toHex(rid), signers, needed: 5, listings: listings.slice(0, 4), snapshot: wire, verify: (sg, m, k) => schnorr.verify(sg, m, k) });
  say(`4. client: GET /snapshot of seat 5 is ${JSON.stringify(wire).length} bytes, ${wire.blocks.length} blocks with headers; held on 5 signed listings: ${held.ok} (${held.signedBy.length} signers); on 4: ${four.ok} (${four.why})`);
  return true;
}

main().then(async () => { await stop(); say('done'); process.exit(0); }, async (e) => { say(`FAILED: ${e.stack || e.message}`); await stop(); process.exit(1); });
