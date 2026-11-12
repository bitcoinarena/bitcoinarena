// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// #2574 THE CLIENT HOLDS THE SNAPSHOT FIVE OF SEVEN SEATS SIGN (spec ruling of kanban #2571): from any seat's GET /snapshot, its id
// recomputed here, its txids checked against the headers, and held only when the round's threshold of its signer nodes sign that
// id in their listing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { snapshotHeld, fetchHeldSnapshot } from '../src/ticktock-hold.js';
import { snapshotOfBlocks, snapshotIdOf, snapshotJson, merkleRootOfTxids, offeredParcel } from '../../arena-protocol/src/ticktock-snapshot.js';
import { lobbyListingId } from '../../arena-protocol/src/lobby-listing.js';
import { blockHashOf } from '../../arena-protocol/src/chain.js';
import { toHex, sha256 } from '../../arena-protocol/src/hash.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const enc = (s) => new TextEncoder().encode(s);
const RID = toHex(b32(0x31));
// a beacon of 300 transactions behind a header that commits to them
const txs = Array.from({ length: 300 }, (_, i) => ({ txid: sha256(enc(`t${i}`)), vsize: 120 + i * 9, feeSat: BigInt(500 + i), valueSat: BigInt(10000 + i) }));
const txids = [toHex(sha256(enc('coinbase'))), ...txs.map((t) => toHex(t.txid))];
const header = new Uint8Array(80); header[0] = 1; header.set(merkleRootOfTxids(txids), 36);
const snapshot = snapshotOfBlocks([{ height: 500, hash: blockHashOf(header), txs }]);
const wire = snapshotJson(snapshot, { roundId: b32(0x31), blocks: [{ height: 500, header, txids }] });
const ID = toHex(snapshotIdOf(snapshot));
const seats = Array.from({ length: 7 }, (_, i) => { const sk = sha256(enc(`seat ${i}`)); return { sk, key: toHex(schnorr.getPublicKey(sk)) }; });
const NOW = 1789200000000;
const listing = (seat, id = ID, signWith = seat.sk) => {
  const row = { id: RID, phase: 'open', assignedHere: true, joined: 1, playing: 0, snapshot: id };
  row.sig = toHex(schnorr.sign(lobbyListingId({ roundId: b32(0x31), nodePubkey: Uint8Array.from(Buffer.from(seat.key, 'hex')), nowMs: BigInt(NOW),
    phase: 'open', assignedHere: true, joined: 1, playing: 0, snapshotId: Uint8Array.from(Buffer.from(id, 'hex')) }), signWith));
  return { node: seat.key, nowMs: String(NOW), rounds: [row] };
};
const verify = (sig, msg, key) => schnorr.verify(sig, msg, key);
const signers = seats.map((s) => s.key);

test('#2574 five of seven seats sign the id: held; four, a forged signature or a seat of another round: not', () => {
  const five = snapshotHeld({ roundId: RID, signers, needed: 5, listings: seats.slice(0, 5).map((s) => listing(s)), snapshot: JSON.parse(JSON.stringify(wire)), verify });
  assert.equal(five.ok, true);
  assert.equal(five.id, ID);
  assert.equal(five.signedBy.length, 5);
  const four = snapshotHeld({ roundId: RID, signers, needed: 5, listings: [...seats.slice(0, 4).map((s) => listing(s)), listing(seats[4], ID, b32(9))], snapshot: wire, verify });
  assert.match(four.why, /4 of the round's signer nodes sign snapshot/, 'a signature not by the seat\'s key is not counted');
  const outsider = { sk: sha256(enc('outsider')) }; outsider.key = toHex(schnorr.getPublicKey(outsider.sk));
  const notOurs = snapshotHeld({ roundId: RID, signers, needed: 5, listings: [...seats.slice(0, 4).map((s) => listing(s)), listing(outsider), listing(seats[0])], snapshot: wire, verify });
  assert.equal(notOurs.ok, false, 'a key the round does not name, and the same seat twice, add nothing');
  console.log(`  MEASURED #2574 client hold: 5 of 7 signed -> held ${ID.slice(0, 16)}; 4 + a forgery -> ${four.why}`);
});

test('#2574 a seat that serves other sizes or fees serves another id: not held on the seats\' signatures', () => {
  const j = JSON.parse(JSON.stringify(wire));
  j.entries[0][2] = String(BigInt(j.entries[0][2]) + 100000n);       // a richer parcel
  const r = snapshotHeld({ roundId: RID, signers, needed: 5, listings: seats.map((s) => listing(s)), snapshot: j, verify });
  assert.equal(r.ok, false);
  assert.match(r.why, /0 of the round's signer nodes sign snapshot/);
  const k = JSON.parse(JSON.stringify(wire)); k.blocks[0].txids[5] = toHex(b32(7));
  assert.match(snapshotHeld({ roundId: RID, signers, needed: 5, listings: seats.map((s) => listing(s)), snapshot: k, verify }).why, /merkle root/);
});

test('#2574 fetched from the seats: the listings, the snapshot from the first seat whose one is held, and the entry\'s offers', async () => {
  const urls = seats.map((_, i) => `http://seat${i}`);
  const bad = JSON.parse(JSON.stringify(wire)); bad.entries[1][1] = 9999;
  const fetcher = async (u) => {
    const i = Number(/seat(\d)/.exec(u)[1]);
    const body = /\/rounds/.test(u) ? listing(seats[i]) : i === 0 ? bad : wire;     // seat 0 serves a doctored snapshot
    return { ok: true, json: async () => JSON.parse(JSON.stringify(body)) };
  };
  const eid = toHex(b32(0x44));
  const got = await fetchHeldSnapshot({ nodes: urls, roundId: RID, entryId: eid, signers, needed: 5, verify, fetcher });
  assert.equal(got.ok, true);
  assert.equal(got.offers.length, 40);
  assert.equal(got.offers[3].txid, toHex(offeredParcel(snapshot, b32(0x31), b32(0x44), 3).txid));
});
