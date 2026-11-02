// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A TABLE IS SEATED ONCE, BY ITS FIRST ROUND (2026-10-13 pick (c)): of an RPS v2 table's rounds only round 0 exchanges
// PRESENTs and signs a seating; every later round of the table takes round 0's seating, state and certificate - so all of them name one
// committee, and the seats make one claim key for the table.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { schnorr } from '@noble/curves/secp256k1.js';
import { seatingAgent } from '../src/seating-agent.js';
import { encodeRoundContract, roundId as roundIdOf } from '../../arena-protocol/src/contracts.js';
import { signPresent, signSeating, encodeSeatingCertificate, seatedFrom } from '../../arena-protocol/src/seating.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { contractFor } from './window-fixture.js';

const nodes = Array.from({ length: 9 }, (_, i) => { const secret = new Uint8Array(32).fill(i + 1); return { secret, pubkey: schnorr.getPublicKey(secret), endpoint: `http://seat-${i}` }; });
const signer = (n) => (m) => schnorr.sign(m, n.secret);
const RPS_V2 = fromHex('a75f54fd4f978a29ab6d39d9ef85c7adbe0576614634c679ae33d3e1c06164ea');
const START = 60500n;
const NOW = Number(START) - 150000;

test('only the table\'s first round is seated; a later round of the table takes its seating, state and certificate', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE rounds (round_id BLOB, contract BLOB)');
  const series = new Uint8Array(32).fill(0x5e);
  const base = { ...contractFor([]), gameId: RPS_V2, protocolVersion: 2, seriesId: series, nodes: [], gameVerifySlots: 7, settlementSlots: 7 };
  const c0 = { ...base, roundIndex: 0, startTimeMs: START }, c5 = { ...base, roundIndex: 5, startTimeMs: START + 40000n };
  const rows = new Map();
  for (const c of [c0, c5]) { const b = encodeRoundContract(c); const id = roundIdOf(c); rows.set(toHex(id), b); db.prepare('INSERT INTO rounds (round_id, contract) VALUES (?, ?)').run(id, b); }
  const rid0 = roundIdOf(c0), rid5 = roundIdOf(c5);
  const me = nodes[0];
  const round = { db, pubkey: me.pubkey, get: (id) => (rows.has(toHex(id)) ? { contract: rows.get(toHex(id)) } : null) };
  const drawn = nodes.map((n) => ({ pubkey: n.pubkey, advert: { endpoint: n.endpoint } }));
  const asked = [];
  const fetcher = async (url, init = {}) => {
    const u = new URL(url); asked.push(`${init.method || 'GET'} ${u.pathname}?${u.searchParams.get('rounds') || ''}`);
    return new Response(JSON.stringify({ rounds: {} }), { status: 200 });
  };
  const verify = (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } };
  const agent = seatingAgent({ round, roster: { committeeFor: () => ({ ok: true, drawn }) }, sign: signer(me), verify, fetcher, nowMs: () => NOW });
  await agent.tick();
  // round 5 starts 40 s later, so it is inside its own PRESENT window too - yet nothing of it is exchanged
  assert.ok(agent.presentsOf(rid0).length >= 2, 'the table\'s first round: this node\'s PRESENTs signed');
  assert.equal(agent.presentsOf(rid5).length, 0, 'a later round of the table: no PRESENT');
  assert.ok(asked.every((a) => !a.includes(toHex(rid5))), 'no seat is asked about the later round');
  // round 0's certificate seats round 5
  const seated = seatedFrom({ drawn: nodes.map((n) => n.pubkey), present: nodes.map((n) => n.pubkey), slots: 7 });
  const cert = encodeSeatingCertificate({ roundId: rid0, role: 'settlement', seated,
    signatures: seated.map((k) => ({ nodePubkey: k, signature: signSeating({ roundId: rid0, role: 'settlement', seated }, signer(nodes.find((n) => toHex(n.pubkey) === toHex(k)))) })) });
  assert.deepEqual(agent.keepCert(rid0, 'settlement', cert), { ok: true, kept: true });
  assert.deepEqual(agent.seatedFor(rid5, 'settlement'), agent.seatedFor(rid0, 'settlement'));
  assert.equal(agent.seatedFor(rid5, 'settlement').length, 7);
  assert.deepEqual(agent.stateOf(rid5).settlement, agent.stateOf(rid0).settlement);
  assert.deepEqual(agent.certOf(rid5, 'settlement'), agent.certOf(rid0, 'settlement'));
});

test('a seat that never wrote the table\'s first round keeps its certificate, drawn on round 0 built from the series it holds (kanban #604)', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE rounds (round_id BLOB, contract BLOB)');
  const series = new Uint8Array(32).fill(0x6e);
  const base = { ...contractFor([]), gameId: RPS_V2, protocolVersion: 2, seriesId: series, nodes: [], gameVerifySlots: 7, settlementSlots: 7 };
  const c0 = { ...base, roundIndex: 0, startTimeMs: START }, c5 = { ...base, roundIndex: 5, startTimeMs: START + 40000n };
  const rows = new Map([[toHex(roundIdOf(c5)), encodeRoundContract(c5)]]);   // round 5 held, round 0 never written
  const rid0 = roundIdOf(c0), rid5 = roundIdOf(c5);
  const round = { db, pubkey: nodes[0].pubkey, get: (id) => (rows.has(toHex(id)) ? { contract: rows.get(toHex(id)) } : null) };
  const drawn = nodes.map((n) => ({ pubkey: n.pubkey, advert: { endpoint: n.endpoint } }));
  const calls = [];
  const roster = { committeeFor: (id, role, opts = {}) => { calls.push({ id: toHex(id), posted: !!opts.posted }); return { ok: true, drawn }; } };
  const verify = (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } };
  const seated = seatedFrom({ drawn: nodes.map((n) => n.pubkey), present: nodes.map((n) => n.pubkey), slots: 7 });
  const cert = encodeSeatingCertificate({ roundId: rid0, role: 'game', seated,
    signatures: seated.map((k) => ({ nodePubkey: k, signature: signSeating({ roundId: rid0, role: 'game', seated }, signer(nodes.find((n) => toHex(n.pubkey) === toHex(k)))) })) });
  const without = seatingAgent({ round, roster, sign: signer(nodes[0]), verify, fetcher: async () => new Response('{}'), nowMs: () => NOW });
  assert.equal(without.keepCert(rid0, 'game', cert).ok, false, 'no row and no series: refused, as before');
  const agent = seatingAgent({ round, roster, sign: signer(nodes[0]), verify, fetcher: async () => new Response('{}'), nowMs: () => NOW,
    contractOf: (id) => (toHex(id) === toHex(rid0) ? c0 : null) });
  assert.deepEqual(agent.keepCert(rid0, 'game', cert), { ok: true, kept: true });
  assert.deepEqual(calls.at(-1), { id: toHex(rid0), posted: true }, 'drawn as a posted contract');
  assert.equal(agent.seatedFor(rid5, 'game').length, 7, 'every round of the table takes it');
});

test('a seat holding a table\'s later rounds but not its first asks the table\'s seats for the first round\'s certificates (kanban #604)', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE rounds (round_id BLOB, contract BLOB)');
  const series = new Uint8Array(32).fill(0x7e);
  const base = { ...contractFor([]), gameId: RPS_V2, protocolVersion: 2, seriesId: series, nodes: [], gameVerifySlots: 7, settlementSlots: 7 };
  const c0 = { ...base, roundIndex: 0, startTimeMs: START }, c5 = { ...base, roundIndex: 5, startTimeMs: START + 40000n };
  const rid0 = roundIdOf(c0), rid5 = roundIdOf(c5);
  const b5 = encodeRoundContract(c5);
  db.prepare('INSERT INTO rounds (round_id, contract) VALUES (?, ?)').run(rid5, b5);
  const round = { db, pubkey: nodes[0].pubkey, get: (id) => (toHex(id) === toHex(rid5) ? { contract: b5 } : null) };
  const drawn = nodes.map((n) => ({ pubkey: n.pubkey, advert: { endpoint: n.endpoint } }));
  const seated = seatedFrom({ drawn: nodes.map((n) => n.pubkey), present: nodes.map((n) => n.pubkey), slots: 7 });
  const certOf = (role) => encodeSeatingCertificate({ roundId: rid0, role, seated,
    signatures: seated.map((k) => ({ nodePubkey: k, signature: signSeating({ roundId: rid0, role, seated }, signer(nodes.find((n) => toHex(n.pubkey) === toHex(k)))) })) });
  const asked = [];
  const fetcher = async (url) => {
    const u = new URL(url); asked.push(`${u.host}${u.pathname}`);
    if (u.pathname === '/seating' && u.searchParams.get('round') === toHex(rid0)) return new Response(JSON.stringify({ cert: toHex(certOf(u.searchParams.get('role'))) }), { status: 200 });
    return new Response(JSON.stringify({ rounds: {} }), { status: 200 });
  };
  const verify = (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } };
  const agent = seatingAgent({ round, roster: { committeeFor: () => ({ ok: true, drawn }) }, sign: signer(nodes[0]), verify, fetcher, nowMs: () => NOW,
    contractOf: (id) => (toHex(id) === toHex(rid0) ? c0 : null) });
  await agent.tick(); await agent.settled();
  assert.equal(agent.seatedFor(rid5, 'game').length, 7);
  assert.equal(agent.seatedFor(rid5, 'settlement').length, 7);
  // every drawn seat but this one, both roles at once (kanban #803: one after another, it held the tick for 35 s)
  assert.equal(asked.filter((a) => a.endsWith('/seating')).length, 2 * 8, 'each drawn seat asked once per role');
  await agent.tick(); await agent.settled();
  assert.equal(asked.filter((a) => a.endsWith('/seating')).length, 2 * 8, 'not asked again once both stand');
});

// A TABLE'S CHECK-IN (kanban #1020): a node that went away after the table was seated gives its seat to a reserve at the next quarter of an hour
const reseatFixture = ({ failingNode = true, lastSeated = 6, withReserve = true } = {}) => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE rounds (round_id BLOB, contract BLOB)');
  const series = new Uint8Array(32).fill(0x7e);
  const base = { ...contractFor([]), gameId: RPS_V2, protocolVersion: 2, seriesId: series, nodes: [], gameVerifySlots: 7, settlementSlots: 7 };
  const Q = 900000n, period = 8000n, t0 = 100n * Q;
  const c0 = { ...base, roundIndex: 0, startTimeMs: t0 };
  const index = Number(Q / period) + 1;        // the first round of the next quarter
  const cIn = { ...base, roundIndex: index, startTimeMs: t0 + BigInt(index) * period };
  const cBefore = { ...base, roundIndex: index - 1, startTimeMs: t0 + BigInt(index - 1) * period };
  const cAfter = { ...base, roundIndex: index + 1, startTimeMs: t0 + BigInt(index + 1) * period };
  const rows = new Map();
  for (const c of [c0, cBefore, cIn, cAfter]) { const b = encodeRoundContract(c); const id = roundIdOf(c); rows.set(toHex(id), b); db.prepare('INSERT INTO rounds (round_id, contract) VALUES (?, ?)').run(id, b); }
  const rid0 = roundIdOf(c0), ridIn = roundIdOf(cIn), ridBefore = roundIdOf(cBefore), ridAfter = roundIdOf(cAfter);
  const drawn = nodes.map((n) => ({ pubkey: n.pubkey, advert: { endpoint: n.endpoint } }));
  const me = nodes[0];
  const round = { db, pubkey: me.pubkey, get: (id) => (rows.has(toHex(id)) ? { contract: rows.get(toHex(id)) } : null) };
  const dead = nodes[lastSeated];
  const fetcher = async (url, init = {}) => {
    if (failingNode && url.startsWith(dead.endpoint)) throw new Error('nobody home');
    return new Response(JSON.stringify({ rounds: {} }), { status: 200 });
  };
  const verify = (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } };
  let now = Number(cIn.startTimeMs) - 170000;
  let contractOf = () => null;
  const agent = seatingAgent({ round, roster: { committeeFor: () => ({ ok: true, drawn }) }, sign: signer(me), verify, fetcher, nowMs: () => now,
    endpointOf: undefined, contractOf: (rid, index) => contractOf(rid, index) });
  const seat7 = nodes.slice(0, 7);
  const certFor = (rid, list) => { const keys = list.map((n) => n.pubkey);
    return encodeSeatingCertificate({ roundId: rid, role: 'settlement', seated: keys, signatures: list.map((n) => ({ nodePubkey: n.pubkey, signature: signSeating({ roundId: rid, role: 'settlement', seated: keys }, signer(n)) })) }); };
  assert.equal(agent.keepCert(rid0, 'settlement', certFor(rid0, seat7)).ok, true);
  const present = (n, rid) => agent.takePresent(signPresent({ roundId: rid, role: 'settlement', nodePubkey: n.pubkey }, signer(n)));
  return { agent, rows, contractIn: cIn, setContractOf: (fn) => { contractOf = fn; }, rid0, ridIn, ridBefore, ridAfter, dead, present, certFor, seat7, withReserve, tick: async (at) => { if (at !== undefined) now = at; await agent.tick(); }, closeMs: Number(cIn.startTimeMs) - 120000, get now() { return now; } };
};

test('a seated node gone from a table: a later check-in seats the reserve from that round on, not before (kanban #1020)', async () => {
  const f = reseatFixture();
  const seated0 = f.agent.seatedFor(f.ridIn, 'settlement');
  assert.equal(seated0.length, 7);
  const newList = [...nodes.slice(0, 6), nodes[7]];
  const k = f.agent.keepCert(f.ridIn, 'settlement', f.certFor(f.ridIn, newList));
  assert.deepEqual(k, { ok: true, kept: true });
  const want = newList.map((n) => toHex(n.pubkey));
  assert.deepEqual(f.agent.seatedFor(f.ridBefore, 'settlement'), seated0, 'the round before keeps the old seats');
  assert.deepEqual(f.agent.seatedFor(f.ridIn, 'settlement'), want);
  assert.deepEqual(f.agent.seatedFor(f.ridAfter, 'settlement'), want, 'and every round after it');
  assert.equal(f.agent.certRoundOf(f.ridAfter, 'settlement') > 0, true);
  assert.equal(f.agent.certOf(f.rid0, 'settlement', f.ridBefore) !== f.agent.certOf(f.rid0, 'settlement', f.ridAfter), true, 'the door answers by the round asked for');
});

test('a round that is no check-in holds no seating of its own (kanban #1020)', () => {
  const f = reseatFixture();
  const r = f.agent.keepCert(f.ridAfter, 'settlement', f.certFor(f.ridAfter, f.seat7));
  assert.equal(r.ok, false);
  assert.match(r.why, /no check-in/);
});

const toCheckIn = async (f, { presents }) => {
  const close = f.closeMs;
  await f.tick(close - 50000);
  await f.tick(close - 15000);
  for (const n of presents) f.present(n, f.ridIn);
  await f.tick(close + 1000);
};

test('at a check-in this seat signs the reserve into the place of a node that neither checked in nor answers (kanban #1020)', async () => {
  const f = reseatFixture();
  await toCheckIn(f, { presents: [...nodes.slice(1, 6), nodes[7], nodes[8]] });
  const m = f.agent.mySignature(f.ridIn, 'settlement');
  assert.ok(m, 'a seating was signed');
  assert.deepEqual(m.seated, [...nodes.slice(0, 6), nodes[7]].map((n) => toHex(n.pubkey)), 'the six stay, the next drawn takes the place');
});

test('a seated node that answers keeps its seat without a check-in: an older build sends none (kanban #1020)', async () => {
  const f = reseatFixture({ failingNode: false });
  await toCheckIn(f, { presents: [...nodes.slice(1, 6), nodes[7], nodes[8]] });
  assert.equal(f.agent.mySignature(f.ridIn, 'settlement'), null);
});

test('a seated node that checked in keeps its seat though this seat cannot reach it (kanban #1020)', async () => {
  const f = reseatFixture();
  await toCheckIn(f, { presents: [...nodes.slice(1, 7), nodes[7], nodes[8]] });
  assert.equal(f.agent.mySignature(f.ridIn, 'settlement'), null);
});

test('with no reserve that checked in, the table stays as it is: a seat is never lost for nothing (kanban #1020)', async () => {
  const f = reseatFixture();
  await toCheckIn(f, { presents: nodes.slice(1, 6) });
  assert.equal(f.agent.mySignature(f.ridIn, 'settlement'), null);
});

test('a seat that never wrote the check-in keeps its certificate, built from the series it holds (kanban #1020)', () => {
  const f = reseatFixture();
  const list = [...nodes.slice(0, 6), nodes[7]];
  const bytes = f.certFor(f.ridIn, list);
  const c = f.contractIn;
  f.rows.delete(toHex(f.ridIn));
  assert.equal(f.agent.keepCert(f.ridIn, 'settlement', bytes).ok, false, 'with no index it cannot be drawn');
  f.setContractOf((rid, index) => (index === c.roundIndex ? c : null));
  assert.deepEqual(f.agent.keepCert(f.ridIn, 'settlement', bytes, { index: c.roundIndex }), { ok: true, kept: true });
  assert.deepEqual(f.agent.seatedFor(f.ridAfter, 'settlement'), list.map((n) => toHex(n.pubkey)), 'and the rounds after it are seated by it');
  assert.equal(f.agent.certRoundOf(f.ridAfter, 'settlement'), c.roundIndex, 'the door names the check-in\'s index though this seat has no row of it');
});
