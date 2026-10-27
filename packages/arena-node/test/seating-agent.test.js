// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE SEATING AGENT ASKS ONLY WHAT IT LACKS, AND DOES NOT CHECK A HELD CERTIFICATE AGAIN (2026-10-12: "figure out why
// CPU usage so high and optimise it"; "Write unit tests"). Measured on seat 3 before: GET /seating-batch 88 times in 30 s,
// 14.3 MB of JSON - every round of the window asked of every drawn node each tick; and every repeated certificate verified.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { schnorr } from '@noble/curves/secp256k1.js';
import { seatingAgent } from '../src/seating-agent.js';
import { encodeRoundContract, roundId as roundIdOf } from '../../arena-protocol/src/contracts.js';
import { signPresent, signSeating, encodeSeatingCertificate, seatedFrom } from '../../arena-protocol/src/seating.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { contractFor } from './window-fixture.js';

const nodes = Array.from({ length: 9 }, (_, i) => { const secret = new Uint8Array(32).fill(i + 1); return { secret, pubkey: schnorr.getPublicKey(secret), endpoint: `http://seat-${i}` }; });
const signer = (n) => (m) => schnorr.sign(m, n.secret);
const START = 60500n;
const NOW = Number(START) - 150000;            // inside the PRESENT window, before seating_close (start - 120 s)
// a certificate of the seating every node makes from all nine PRESENTs, signed by its seated - made once per round and role, as on the
// network (each node signs its seating once and keeps that signature, so every peer hands out the same bytes)
const certsMade = new Map();
const certFor = (rid, role) => { const k = `${toHex(rid)}:${role}`; if (!certsMade.has(k)) certsMade.set(k, certOnce(rid, role)); return certsMade.get(k); };
const certOnce = (rid, role) => {
  const seated = seatedFrom({ drawn: nodes.map((n) => n.pubkey), present: nodes.map((n) => n.pubkey), slots: 7 });
  return encodeSeatingCertificate({ roundId: rid, role, seated,
    signatures: seated.map((k) => ({ nodePubkey: k, signature: signSeating({ roundId: rid, role, seated }, signer(nodes.find((n) => toHex(n.pubkey) === toHex(k)))) })) });
};

function world({ withhold = null, leftNode = () => false, now = NOW, servesCert = false } = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE rounds (round_id BLOB, contract BLOB)');
  const c = { ...contractFor(nodes.slice(0, 7).map((n) => n.pubkey)), startTimeMs: START };
  const bytes = encodeRoundContract(c);
  const rid = roundIdOf(c);
  db.prepare('INSERT INTO rounds (round_id, contract) VALUES (?, ?)').run(rid, bytes);
  const me = nodes[0];
  const round = { db, pubkey: me.pubkey, get: (id) => (toHex(id) === toHex(rid) ? { contract: bytes } : null) };
  const drawn = nodes.map((n) => ({ pubkey: n.pubkey, advert: { endpoint: n.endpoint } }));
  const roster = { committeeFor: () => ({ ok: true, drawn }) };
  let verifies = 0;
  const verify = (s, m, k) => { verifies++; try { return schnorr.verify(s, m, k); } catch { return false; } };
  const asked = [];
  // each peer answers with the PRESENTs it signed, for both roles - except a withheld one
  const fetcher = async (url, init = {}) => {
    asked.push(`${init.method || 'GET'} ${url.replace(/\?.*$/, '')}`);
    const u = new URL(url);
    if (u.pathname === '/seating-batch') {
      const i = nodes.findIndex((n) => n.endpoint === `${u.protocol}//${u.host}`);
      const presents = withhold === i ? [] : ['game', 'settlement'].map((role) => ({ role, node: toHex(nodes[i].pubkey),
        present: toHex(signPresent({ roundId: rid, role, nodePubkey: nodes[i].pubkey }, signer(nodes[i]))) }));
      const cert = servesCert ? Object.fromEntries(['game', 'settlement'].map((role) => [role, toHex(certFor(rid, role))])) : {};
      return new Response(JSON.stringify({ rounds: { [toHex(rid)]: { presents, sig: {}, cert } } }), { status: 200 });
    }
    return new Response('ok', { status: 200 });
  };
  const agent = seatingAgent({ round, roster, sign: signer(me), verify, fetcher, nowMs: () => now, leftNode });
  return { agent, rid, asked, verifies: () => verifies, drawn };
}

test('a round whose PRESENTs from every drawn node are held is not asked again before its close', async () => {
  const w = world();
  await w.agent.tick();
  const first = w.asked.filter((a) => a.startsWith('GET') && a.endsWith('/seating-batch')).length;
  assert.equal(first, 8, 'the first tick asks each of the 8 other drawn nodes');
  for (const role of ['game', 'settlement']) assert.equal(w.agent.presentsOf(w.rid).filter((p) => p.role === role).length, 9, `all 9 ${role} PRESENTs held`);
  w.asked.length = 0;
  await w.agent.tick();
  assert.equal(w.asked.filter((a) => a.endsWith('/seating-batch')).length, 0, 'nothing is asked once every PRESENT is held');
});

test('a round still missing a drawn node\'s PRESENT keeps being asked', async () => {
  const w = world({ withhold: 5 });
  await w.agent.tick();
  w.asked.length = 0;
  await w.agent.tick();
  assert.equal(w.asked.filter((a) => a.endsWith('/seating-batch')).length, 8, 'node 5 has not said it is present: the round is asked again');
});

test('a certificate held byte for byte is not verified again', () => {
  const w = world();
  const seated = seatedFrom({ drawn: nodes.map((n) => n.pubkey), present: nodes.map((n) => n.pubkey), slots: 7 });
  const cert = encodeSeatingCertificate({ roundId: w.rid, role: 'game', seated,
    signatures: seated.map((k) => ({ nodePubkey: k, signature: signSeating({ roundId: w.rid, role: 'game', seated }, signer(nodes.find((n) => toHex(n.pubkey) === toHex(k)))) })) });
  const before = w.verifies();
  assert.deepEqual(w.agent.keepCert(w.rid, 'game', cert), { ok: true, kept: true });
  const once = w.verifies() - before;
  assert.ok(once >= 7, `the first copy is checked: ${once} signature checks`);
  assert.deepEqual(w.agent.keepCert(w.rid, 'game', cert), { ok: true, kept: false });
  assert.equal(w.verifies() - before, once, 'the same bytes again cost no signature check');
});

test('a node its owner took out with the emergency key (§23A.5a, protocol 17) is in no seating: its PRESENT is not counted, and it signs none itself', async () => {
  const gone = toHex(nodes[5].pubkey);
  const w = world({ leftNode: (hex) => hex === gone });
  await w.agent.tick();
  for (const role of ['game', 'settlement']) {
    const held = w.agent.presentsOf(w.rid).filter((p) => p.role === role);
    assert.deepEqual([held.length, held.some((p) => p.node === gone)], [8, false], `${role}: 8 PRESENTs, none from the node that left`);
  }
  const me = toHex(nodes[0].pubkey);
  const back = world({ leftNode: (hex) => hex === me });
  await back.agent.tick();
  assert.equal(back.agent.presentsOf(back.rid).some((p) => p.node === me), false, 'the owner\'s node, back online, says PRESENT for nothing');
});

test('a seat restarted after its round started reads the certificate it lacks - and sends no PRESENT, signs no seating', async () => {
  // kanban #576, 2026-10-23 12:0xZ: seats restarted after the 12:00 window started counted themselves unseated for good
  const w = world({ now: Number(START) + 60000, servesCert: true });
  await w.agent.tick();
  assert.equal(w.asked.filter((a) => a.endsWith('/seating-batch')).length, 8, 'the started round is asked of the other drawn nodes');
  assert.equal(w.asked.filter((a) => a.startsWith('POST')).length, 0, 'no PRESENT is handed out for a round already started');
  assert.equal(w.agent.presentsOf(w.rid).some((p) => p.node === toHex(nodes[0].pubkey)), false, 'and this node signs none');
  w.asked.length = 0;
  await w.agent.tick();
  assert.equal(w.asked.filter((a) => a.endsWith('/seating-batch')).length, 0, 'both certificates held: nothing more is asked');
});

test('a started round nobody can certify is asked, but this node builds no certificate of its own', async () => {
  const w = world({ now: Number(START) + 60000, servesCert: false });
  await w.agent.tick();
  await w.agent.tick();
  assert.equal(w.asked.filter((a) => a.startsWith('POST')).length, 0, 'nothing is posted: no PRESENT, no seating signature handed out');
});

test('a started round\'s PRESENTs are neither taken nor checked: only its certificates cost signature checks (kanban #587)', async () => {
  // measured 2026-10-23 13:2xZ: closed rounds' PRESENTs, refused after their check and never kept, were checked on every tick
  const w = world({ now: Number(START) + 60000, servesCert: true });
  await w.agent.tick();
  assert.equal(w.verifies(), 14, 'two certificates of 7 seated signatures each, and no PRESENT');
  await w.agent.tick();
  assert.equal(w.verifies(), 14, 'the second tick asks nothing and checks nothing');
  assert.equal(w.agent.presentsOf(w.rid).length, 0, 'no PRESENT of a started round is kept');
});

// FROM PROTOCOL 22 THE CERTIFICATE SAYS WHO WAS PRESENT (§5A.3, kanban #727, the owner 2026-10-27): eight live seats of nine drawn, one
// stopped, and a node the round's census left out as absent coming back. Every seated node signs a SEEN with its seating; the
// certificate is made only with all seven, and names the present reserve and the returning node - not the stopped one.
test('a 22 round: the seated sign who was present, and the certificate names the seated, the present reserve and a node coming back - never the stopped one', async () => {
  const back = (() => { const secret = new Uint8Array(32).fill(40); return { secret, pubkey: schnorr.getPublicKey(secret) }; })();
  const db0 = () => { const db = new DatabaseSync(':memory:'); db.exec('CREATE TABLE rounds (round_id BLOB, contract BLOB)'); return db; };
  const c = { ...contractFor(nodes.slice(0, 7).map((n) => n.pubkey)), startTimeMs: START, protocolVersion: 22 };
  const bytes = encodeRoundContract(c);
  const rid = roundIdOf(c);
  const drawn = nodes.map((n) => ({ pubkey: n.pubkey, advert: { endpoint: n.endpoint } }));
  let now = NOW;
  const agents = new Map();
  const fetcher = async (url, init = {}) => {
    const u = new URL(url);
    const a = agents.get(`${u.protocol}//${u.host}`);
    if (!a) return new Response('down', { status: 503 });            // node 8: stopped
    if (u.pathname === '/presents') { const r = a.takePresents(new Uint8Array(await new Response(init.body).arrayBuffer())); return new Response(JSON.stringify(r), { status: r.ok ? 201 : 400 }); }
    if (u.pathname === '/seating-batch') return new Response(JSON.stringify(a.batchOf(u.searchParams.get('rounds').split(','))), { status: 200 });
    if (u.pathname === '/seating') { const b = new Uint8Array(await new Response(init.body).arrayBuffer()); const r = a.keepCert(rid, (await import('../../arena-protocol/src/seating.js')).decodeSeatingCertificate(b).role, b); return new Response(JSON.stringify(r), { status: r.ok ? 201 : 409 }); }
    return new Response('no', { status: 404 });
  };
  for (const n of nodes.slice(0, 8)) {
    const db = db0();
    db.prepare('INSERT INTO rounds (round_id, contract) VALUES (?, ?)').run(rid, bytes);
    // the seated nodes' addresses the agent keeps with the round when the certificate stands (kanban #735)
    const kept = new Map();
    const round = { db, pubkey: n.pubkey, get: (id) => (toHex(id) === toHex(rid) ? { contract: bytes } : null),
      keepRoundPeers: (id, role, peers) => { assert.equal(toHex(id), toHex(rid)); kept.set(role, peers); return peers.length; } };
    agents.set(n.endpoint, { ...seatingAgent({ round, roster: { committeeFor: () => ({ ok: true, drawn }) }, sign: signer(n), fetcher, nowMs: () => now,
      verify: (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } }, leftOutOf: () => [toHex(back.pubkey)] }), kept });
  }
  const all = [...agents.values()];
  // the returning node hands its PRESENT to the drawn before the close; a node neither drawn nor left out is refused
  for (const a of all) for (const role of ['game', 'settlement']) assert.equal(a.takePresent(signPresent({ roundId: rid, role, nodePubkey: back.pubkey }, signer(back))).ok, true);
  const stranger = { secret: new Uint8Array(32).fill(41) }; stranger.pubkey = schnorr.getPublicKey(stranger.secret);
  assert.match(all[0].takePresent(signPresent({ roundId: rid, role: 'game', nodePubkey: stranger.pubkey }, signer(stranger))).why, /not drawn/);
  for (const a of all) await a.tick();
  now = Number(START - 120000n) + 1000;                               // past the close: sign, gather, certify
  for (let i = 0; i < 3; i++) for (const a of all) await a.tick();
  const { verifySeating } = await import('../../arena-protocol/src/seating.js');
  for (const role of ['game', 'settlement']) {
    const cert = all[0].certOf(rid, role);
    assert.ok(cert, `${role}: certified`);
    const v = verifySeating(Buffer.from(cert, 'hex'), { roundId: rid, role, drawn: drawn.map((e) => e.pubkey), slots: 7, verify: (s, m, k) => schnorr.verify(s, m, k), listsPresent: true });
    assert.equal(v.ok, true, v.why);
    assert.deepEqual(v.seating.seated.map(toHex), nodes.slice(0, 7).map((n) => toHex(n.pubkey)));
    assert.ok(v.present.includes(toHex(nodes[7].pubkey)), 'the present reserve');
    assert.ok(v.present.includes(toHex(back.pubkey)), 'the node coming back');
    assert.ok(!v.present.includes(toHex(nodes[8].pubkey)), 'not the stopped node');
    assert.deepEqual(v.leftOut, [toHex(back.pubkey)]);
    // AND EVERY NODE THAT HOLDS THE CERTIFICATE KEPT THE SEATED NODES' ADDRESSES WITH THE ROUND (kanban #735): the 7 seated, each with
    // the endpoint its census advert names - what the node reads for the round's peers when its roster has no chain view
    for (const a of all) assert.deepEqual(a.kept.get(role), nodes.slice(0, 7).map((n) => ({ node: toHex(n.pubkey), endpoint: n.endpoint })), `${role}: the seated nodes' addresses kept`);
  }
});
