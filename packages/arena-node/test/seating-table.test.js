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
  await agent.tick();
  assert.equal(agent.seatedFor(rid5, 'game').length, 7);
  assert.equal(agent.seatedFor(rid5, 'settlement').length, 7);
  assert.equal(asked.filter((a) => a.endsWith('/seating')).length, 2, 'one seat asked per role, the first that had it');
  await agent.tick();
  assert.equal(asked.filter((a) => a.endsWith('/seating')).length, 2, 'not asked again once both stand');
});
