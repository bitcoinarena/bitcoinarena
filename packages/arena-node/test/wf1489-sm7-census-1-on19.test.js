// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 state-machine audit, round 7 (census): A TABLE CHECK-IN THAT EQUIVOCATED STILL SEATS THE TABLE.
// Two seating certificates for one check-in round (kanban #1020) that share signers are an equivocation: keepCert records it
// (seat_equivocations, certs -> null, "the round takes no entries"). But the check-in's FIRST kept certificate already went into
// the table's reseat list (noteReseat / listReseat, first per index wins), and seatedAt / stateOf read that list and the anchor's
// key only - so every later round of the table is still seated by whichever certificate reached THIS seat first. Two seats that
// got the two certificates in opposite orders both say "equivocation" and yet seat different nodes for the same rounds.
// kanban #2091 ON 1.9 (f5bdcca16): the card's own pair (one swap) is a #1509 leave-out pair under #1707/#2245, no equivocation by rule; what
// must hold is the invariant - two seats holding the same two certificates seat the same nodes - for that pair and for a pair no honest
// move makes (two members swapped, not ordered), which is equivocation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { schnorr } from '@noble/curves/secp256k1.js';
import { seatingAgent } from '../src/seating-agent.js';
import { encodeRoundContract, roundId as roundIdOf } from '../../arena-protocol/src/contracts.js';
import { signSeating, encodeSeatingCertificate } from '../../arena-protocol/src/seating.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { contractFor } from './window-fixture.js';

const nodes = Array.from({ length: 9 }, (_, i) => { const secret = new Uint8Array(32).fill(i + 1); return { secret, pubkey: schnorr.getPublicKey(secret), endpoint: `http://seat-${i}` }; });
const signer = (n) => (m) => schnorr.sign(m, n.secret);
const RPS_V2 = fromHex('a75f54fd4f978a29ab6d39d9ef85c7adbe0576614634c679ae33d3e1c06164ea');
const verify = (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } };

// one seat: its own store, the same table (same contracts, so the same round ids at every seat)
const seat = (meIndex) => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE rounds (round_id BLOB, contract BLOB)');
  const series = new Uint8Array(32).fill(0x7e);
  const base = { ...contractFor([]), gameId: RPS_V2, protocolVersion: 2, seriesId: series, nodes: [], gameVerifySlots: 7, settlementSlots: 7 };
  const Q = 900000n, period = 8000n, t0 = 100n * Q;
  const c0 = { ...base, roundIndex: 0, startTimeMs: t0 };
  const index = Number(Q / period) + 1;
  const cIn = { ...base, roundIndex: index, startTimeMs: t0 + BigInt(index) * period };
  const cAfter = { ...base, roundIndex: index + 1, startTimeMs: t0 + BigInt(index + 1) * period };
  const rows = new Map();
  for (const c of [c0, cIn, cAfter]) { const b = encodeRoundContract(c); const id = roundIdOf(c); rows.set(toHex(id), b); db.prepare('INSERT INTO rounds (round_id, contract) VALUES (?, ?)').run(id, b); }
  const me = nodes[meIndex];
  const round = { db, pubkey: me.pubkey, get: (id) => (rows.has(toHex(id)) ? { contract: rows.get(toHex(id)) } : null) };
  const drawn = nodes.map((n) => ({ pubkey: n.pubkey, advert: { endpoint: n.endpoint } }));
  const mk = () => seatingAgent({ round, roster: { committeeFor: () => ({ ok: true, drawn }) }, sign: signer(me), verify,
    fetcher: async () => new Response(JSON.stringify({ rounds: {} }), { status: 200 }), nowMs: () => Number(cIn.startTimeMs) - 170000 });
  const agent = mk();
  return { agent, mk, db, round, rid0: roundIdOf(c0), ridIn: roundIdOf(cIn), ridAfter: roundIdOf(cAfter) };
};
const certFor = (rid, list) => { const keys = list.map((n) => n.pubkey);
  return encodeSeatingCertificate({ roundId: rid, role: 'settlement', seated: keys,
    signatures: list.map((n) => ({ nodePubkey: n.pubkey, signature: signSeating({ roundId: rid, role: 'settlement', seated: keys }, signer(n)) })) }); };


const run = (A0, B0) => {
  const s1 = seat(0), s2 = seat(1);
  for (const s of [s1, s2]) assert.equal(s.agent.keepCert(s.rid0, 'settlement', certFor(s.rid0, nodes.slice(0, 7))).ok, true);
  const A = certFor(s1.ridIn, A0), B = certFor(s1.ridIn, B0);
  const said = [s1.agent.keepCert(s1.ridIn, 'settlement', A), s1.agent.keepCert(s1.ridIn, 'settlement', B),
    s2.agent.keepCert(s2.ridIn, 'settlement', B), s2.agent.keepCert(s2.ridIn, 'settlement', A)];
  const short = (l) => (l ? l.map((k) => nodes.findIndex((n) => toHex(n.pubkey) === k)).join('') : null);
  const out = { said: said.map((x) => ({ ok: x.ok, kept: x.kept, replaced: x.replaced, equivocation: x.equivocation, superseded: x.superseded })),
    in1: short(s1.agent.seatedFor(s1.ridIn, 'settlement')), in2: short(s2.agent.seatedFor(s2.ridIn, 'settlement')),
    after1: short(s1.agent.seatedFor(s1.ridAfter, 'settlement')), after2: short(s2.agent.seatedFor(s2.ridAfter, 'settlement')),
    state1: s1.agent.stateOf(s1.ridAfter).settlement, state2: s2.agent.stateOf(s2.ridAfter).settlement,
    restart1: short(s1.mk().seatedFor(s1.ridAfter, 'settlement')), restart2: short(s2.mk().seatedFor(s2.ridAfter, 'settlement')) };
  console.log('  MEASURED', JSON.stringify(out));
  return out;
};

test('kanban #2091 on 1.9: the card\'s pair (one member swapped for the next reserve) seats the same nodes at both seats, whichever came first', () => {
  const o = run([...nodes.slice(0, 6), nodes[7]], [...nodes.slice(0, 6), nodes[8]]);
  assert.equal(o.in1, o.in2); assert.equal(o.after1, o.after2); assert.equal(o.restart1, o.restart2);
});

test('kanban #2091 on 1.9: an ordered pair (#738: re-signed forward) is no equivocation at either seat, whichever came first', () => {
  const o = run([...nodes.slice(0, 5), nodes[5], nodes[7]], [...nodes.slice(0, 5), nodes[6], nodes[8]]);
  assert.ok(!o.said[1].equivocation && !o.said[3].equivocation, `one seat took an ordered pair for equivocation: ${JSON.stringify(o.said)}`);
});

test('kanban #2091 on 1.9: a pair no honest move makes (neither ordered nor a leave-out) is equivocation and seats nothing later, at both seats', () => {
  const o = run([...nodes.slice(0, 5), nodes[5], nodes[8]], [...nodes.slice(0, 5), nodes[6], nodes[7]]);
  assert.ok(o.said[1].equivocation && o.said[3].equivocation, `both seats hold the pair and see the equivocation: ${JSON.stringify(o.said)}`);
  assert.equal(o.after1, o.after2, 'two seats holding the same two certificates seat the round after the check-in differently');
  assert.equal(o.after1, null, 'an equivocated check-in seats the later rounds of its table');
  assert.equal(o.restart1, null, 'after a restart the equivocated check-in seats the later rounds again');
  assert.equal(o.restart2, null);
});
