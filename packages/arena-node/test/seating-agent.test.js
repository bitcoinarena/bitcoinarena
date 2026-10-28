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
import { signPresent, signSeating, encodeSeatingCertificate, seatedFrom, seatingId, verifySeating, seatingEquivocation,
  decodeSeatingCertificate, signSeen } from '../../arena-protocol/src/seating.js';
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

// ONE OVERLOADED SEAT SIGNED A SMALLER SEATING AND NO CERTIFICATE FORMED (kanban #738, measured 2026-10-27 23:30Z, Up/Down round
// d77b3d03, 9 drawn for 7 seats): six seats signed the seating of 7 (8 present of 9 drawn), the overloaded one the seating of 5 (5
// present) and never again - no certificate, the round unseated. Eight live seats of nine drawn, node 8 stopped; until the close
// `slow` hears only nodes 0, 1, 2 and 4 (the others' PRESENTs never reach it), after it every node hears every node.
const upTo = (n) => Array.from({ length: n }, (_, i) => i);
async function seatingNet({ slow = 3, protocolVersion = 20, lateStrips = () => [], sigOf = (from, to, sig) => sig } = {}) {
  const hears = (from, to) => (from !== slow || [0, 1, 2, 4].includes(to)) && (to !== slow || [0, 1, 2, 4].includes(from));
  const c = { ...contractFor(nodes.slice(0, 7).map((n) => n.pubkey)), startTimeMs: START, protocolVersion };
  const bytes = encodeRoundContract(c);
  const rid = roundIdOf(c);
  const drawn = nodes.map((n) => ({ pubkey: n.pubkey, advert: { endpoint: n.endpoint } }));
  const net = { now: NOW, rid, drawn, agents: new Map(), logs: new Map(), dbs: new Map() };
  const closed = () => BigInt(net.now) >= START - 120000n;
  const fetcherOf = (from) => async (url, init = {}) => {
    const u = new URL(url);
    const to = nodes.findIndex((n) => n.endpoint === `${u.protocol}//${u.host}`);
    const a = net.agents.get(to);
    if (!a || (!closed() && !hears(from, to))) return new Response('down', { status: 503 });
    if (u.pathname === '/presents') { const r = a.takePresents(new Uint8Array(await new Response(init.body).arrayBuffer())); return new Response(JSON.stringify(r), { status: r.ok ? 201 : 400 }); }
    if (u.pathname === '/seating-batch') {
      const j = a.batchOf(u.searchParams.get('rounds').split(','));
      // before the close the slow seat gets no PRESENT of a node it does not hear, at first hand or relayed
      const strip = closed() ? lateStrips(from, to) : from === slow ? upTo(9).filter((k) => ![0, 1, 2, 4, slow].includes(k)) : [];
      for (const r of Object.values(j.rounds)) r.presents = r.presents.filter((p) => !strip.includes(nodes.findIndex((n) => toHex(n.pubkey) === p.node)));
      // a seating signature as it reaches `from` (kanban #738: stripped of, or with a forged, justification)
      for (const r of Object.values(j.rounds)) for (const role of Object.keys(r.sig)) if (r.sig[role]) r.sig[role] = sigOf(from, to, r.sig[role]);
      return new Response(JSON.stringify(j), { status: 200 });
    }
    if (u.pathname === '/seating') { const b = new Uint8Array(await new Response(init.body).arrayBuffer()); const r = a.keepCert(rid, decodeSeatingCertificate(b).role, b); return new Response(JSON.stringify(r), { status: r.ok ? 201 : 409 }); }
    return new Response('no', { status: 404 });
  };
  for (let i = 0; i < 8; i++) {
    const n = nodes[i];
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE rounds (round_id BLOB, contract BLOB)');
    db.prepare('INSERT INTO rounds (round_id, contract) VALUES (?, ?)').run(rid, bytes);
    const round = { db, pubkey: n.pubkey, get: (id) => (toHex(id) === toHex(rid) ? { contract: bytes } : null) };
    const logs = []; net.logs.set(i, logs); net.dbs.set(i, db);
    net.agents.set(i, seatingAgent({ round, roster: { committeeFor: () => ({ ok: true, drawn }) }, sign: signer(n), fetcher: fetcherOf(i), nowMs: () => net.now,
      verify: (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } }, log: (l) => logs.push(l) }));
  }
  net.tickAll = async (times = 1, only = null) => { for (let k = 0; k < times; k++) for (const [i, a] of net.agents) if (!only || only.includes(i)) await a.tick(); };
  net.close = () => { net.now = Number(START - 120000n) + 1000; };
  net.signedOf = (i, role = 'game') => { const s = net.agents.get(i).mySignature(rid, role); return s ? s.seated.map((k) => nodes.findIndex((n) => toHex(n.pubkey) === k)) : null; };
  net.check = (role) => ({ roundId: rid, role, drawn: drawn.map((e) => e.pubkey), slots: 7, verify: (s, m, k) => schnorr.verify(s, m, k), listsPresent: protocolVersion >= 22 });
  return net;
}

for (const protocolVersion of [20, 22]) {
  test(`kanban #738 (protocol ${protocolVersion}): the seat that signed the seating of 5 re-signs the seating of 7 once a member signed it, and a certificate of 7 forms`, async () => {
    const net = await seatingNet({ protocolVersion });
    await net.tickAll(2);
    net.close();
    await net.tickAll(1, [3]);                                          // the overloaded seat signs first, from what it holds
    assert.deepEqual(net.signedOf(3), [0, 1, 2, 3, 4], 'the seating of 5, as measured');
    assert.ok(net.logs.get(3).some((l) => /game: signed the seating of 5 \(5 present of 9 drawn\)/.test(l)));
    await net.tickAll(4);
    for (const i of upTo(8)) assert.deepEqual(net.signedOf(i), i === 7 ? null : upTo(7), `node ${i} signs the seating of 7 in the end (node 7, the reserve, none)`);
    assert.ok(net.logs.get(3).some((l) => /game: re-signed the seating of 7 \(member [0-9a-f]{8} signed another; the seating of 5 can never stand\)/.test(l)), net.logs.get(3).join('\n'));
    for (const i of upTo(8)) if (i !== 3) assert.ok(!net.logs.get(i).some((l) => /re-signed/.test(l)), `node ${i} signed once`);
    for (const role of ['game', 'settlement']) for (const i of upTo(8)) {
      const cert = net.agents.get(i).certOf(net.rid, role);
      assert.ok(cert, `${role}: node ${i} holds the certificate`);
      const v = verifySeating(Buffer.from(cert, 'hex'), net.check(role));
      assert.equal(v.ok, true, v.why);
      assert.deepEqual(v.seating.seated.map(toHex), nodes.slice(0, 7).map((n) => toHex(n.pubkey)));
      assert.ok(net.logs.get(i).every((l) => !/two seatings/.test(l)), 'no equivocation seen');
    }
    // THE OLD SEATING NEVER COMPLETES: only the overloaded seat signed it, so with the certificate it proves nothing against anyone
    const five = [0, 1, 2, 3, 4].map((i) => nodes[i].pubkey);
    const fiveId = toHex(seatingId({ roundId: net.rid, role: 'game', seated: five }));
    const overFive = [...net.dbs.values()].flatMap((db) => db.prepare('SELECT node, signature FROM seat_sigs WHERE role = ? AND seating = ?').all('game', fiveId));
    assert.deepEqual([...new Set(overFive.map((r) => r.node))], [toHex(nodes[3].pubkey)], 'the seating of 5 carries one signature, the overloaded seat\'s');
    const old = encodeSeatingCertificate({ roundId: net.rid, role: 'game', seated: five, signatures: [{ nodePubkey: nodes[3].pubkey, signature: new Uint8Array(overFive[0].signature) }] });
    const e = seatingEquivocation(old, Buffer.from(net.agents.get(0).certOf(net.rid, 'game'), 'hex'), net.check('game'));
    assert.equal(e.ok, false); assert.match(e.why, /first seating does not stand/);
  });
}

test('kanban #738: no re-sign while the members of its seating only lag - they signed nothing else yet', async () => {
  const net = await seatingNet();
  await net.tickAll(2);
  net.close();
  await net.tickAll(3, [3]);                                            // the others have not reached their close tick: no signature of theirs
  assert.deepEqual(net.signedOf(3), [0, 1, 2, 3, 4]);
  assert.ok(!net.logs.get(3).some((l) => /re-signed/.test(l)));
  assert.equal(net.agents.get(3).presentsOf(net.rid).filter((p) => p.role === 'game').length, 5, 'no PRESENT taken after the close');
});

test('kanban #738: the seats of the seating of 7 never re-sign over the overloaded seat\'s seating of 5 - it comes before theirs', async () => {
  const net = await seatingNet();
  await net.tickAll(2);
  net.close();
  await net.tickAll(1, [3]);                                                // the overloaded seat signs the seating of 5
  await net.tickAll(1, [0, 1, 2, 4, 5, 6, 7]);                              // the others sign the seating of 7, reading its signature over 5
  const fiveId = toHex(seatingId({ roundId: net.rid, role: 'game', seated: [0, 1, 2, 3, 4].map((i) => nodes[i].pubkey) }));
  assert.ok(net.dbs.get(0).prepare('SELECT 1 FROM seat_sigs WHERE role = ? AND seating = ?').get('game', fiveId), 'node 0 kept the signature over 5');
  assert.deepEqual(net.signedOf(0), upTo(7));
  assert.ok(!net.logs.get(0).some((l) => /re-signed/.test(l)));
});

test('kanban #738: a seat not in the seating of what it holds now does not re-sign, and the others certify without it', async () => {
  // node 7 (the 8th in score order) is the slow one: it signs {0, 1, 2, 4, 7}; the seating of the 8 present is 0..6, without it
  const net = await seatingNet({ slow: 7 });
  await net.tickAll(2);
  net.close();
  await net.tickAll(1, [7]);
  assert.deepEqual(net.signedOf(7), [0, 1, 2, 4, 7]);
  await net.tickAll(4);
  assert.deepEqual(net.signedOf(7), [0, 1, 2, 4, 7], 'its seating can never stand, but the seating of 7 has no seat for it');
  assert.ok(!net.logs.get(7).some((l) => /re-signed/.test(l)));
  assert.ok(net.agents.get(0).certOf(net.rid, 'game'), 'the seating of 7 needs none of it');
});

test('kanban #738: no re-sign to a seating nobody else signed - what the seat holds gives the seating of 6, the others signed 7', async () => {
  // after the close the slow seat still never gets the PRESENTs of nodes 6 and 7: it holds 0..5, whose seating is 0..5
  const net = await seatingNet({ lateStrips: (from) => (from === 3 ? [6, 7] : []) });
  await net.tickAll(2);
  net.close();
  await net.tickAll(1, [3]);
  await net.tickAll(4);
  assert.equal(net.agents.get(3).presentsOf(net.rid).filter((p) => p.role === 'game').length, 6, 'the late PRESENTs it could get: 0..5');
  assert.deepEqual(net.signedOf(3), [0, 1, 2, 3, 4], 'the seating of 6 is signed by no other node: it keeps its signature');
  assert.ok(!net.logs.get(3).some((l) => /re-signed/.test(l)));
  assert.equal(net.agents.get(0).certOf(net.rid, 'game'), null, 'and no certificate forms');
});

test('kanban #738: a seat that holds a certificate signs nothing more', async () => {
  const net = await seatingNet();
  await net.tickAll(2);
  net.close();
  await net.tickAll(1, [3]);
  // a certificate reaches it first (by POST /seating): the seating of 7, every seated node's signature
  const seated = nodes.slice(0, 7).map((n) => n.pubkey);
  const cert = encodeSeatingCertificate({ roundId: net.rid, role: 'game', seated,
    signatures: nodes.slice(0, 7).map((n) => ({ nodePubkey: n.pubkey, signature: signSeating({ roundId: net.rid, role: 'game', seated }, signer(n)) })) });
  assert.deepEqual(net.agents.get(3).keepCert(net.rid, 'game', cert), { ok: true, kept: true });
  await net.tickAll(4);
  assert.deepEqual(net.signedOf(3, 'game'), [0, 1, 2, 3, 4], 'a certificate stands: the game seating is not signed again');
  assert.ok(!net.logs.get(3).some((l) => /game: re-signed/.test(l)));
  assert.ok(net.logs.get(3).some((l) => /settlement: re-signed/.test(l)), 'the settlement seating, with no certificate, is');
});

// NO RULE MAY EVER SLASH AN HONEST SEAT (kanban #738, RULED 2026-10-28, protocol 22). The #738 run above: seat 3 signed the seating of
// 5, left it for the seating of 7 once a member signed that, and the seating of 7 was certified. Now the members 0, 1, 2 and 4 -
// Byzantine - sign the seating of 5 as well, so with seat 3's first signature it completes: two certificates, sharing 0, 1, 2, 3, 4.
// Seat 3 broke no rule; its second signature carries the member's signed seating of 7, and the proof stands against the four only.
const fiveOf = (rid) => ({ roundId: rid, role: 'game', seated: [0, 1, 2, 3, 4].map((i) => nodes[i].pubkey) });
async function resignedAt22(opts = {}) {
  const net = await seatingNet({ protocolVersion: 22, ...opts });
  await net.tickAll(2);
  net.close();
  await net.tickAll(1, [3]);
  await net.tickAll(1, [0, 1, 2, 4, 5, 6, 7]);                            // the others sign the seating of 7, and keep seat 3's over 5
  await net.tickAll(1, [3]);                                              // seat 3 re-signs: the seating of 7
  return net;
}
const sigRowAt = (net, at, i, seating) => net.dbs.get(at).prepare('SELECT signature, justification FROM seat_sigs WHERE role = ? AND seating = ? AND node = ?')
  .get('game', seating, toHex(nodes[i].pubkey));
const sevenId = (rid) => toHex(seatingId({ roundId: rid, role: 'game', seated: nodes.slice(0, 7).map((n) => n.pubkey) }));

test('kanban #738 (protocol 22): Byzantine members complete the seating seat 3 left - the proof by both certificates names them, never seat 3', async () => {
  const net = await resignedAt22();
  await net.tickAll(4);
  assert.ok(net.agents.get(5).certOf(net.rid, 'game'), 'the seating of 7 is certified');
  assert.ok(net.agents.get(3).mySignature(net.rid, 'game').justification, 'seat 3\'s second signature carries its justification');
  // the four sign the seating of 5 and who was present at it; seat 3's signature and SEEN over it are its own, from the close
  const five = fiveOf(net.rid), fid = toHex(seatingId(five));
  const db3 = net.dbs.get(3);
  const own = db3.prepare('SELECT signature FROM seat_sigs WHERE role = ? AND seating = ? AND node = ?').get('game', fid, toHex(nodes[3].pubkey));
  const seen3 = db3.prepare('SELECT present, left_out, signature FROM seat_seen WHERE role = ? AND seating = ? AND node = ?').get('game', fid, toHex(nodes[3].pubkey));
  const byz = [0, 1, 2, 4];
  const present = five.seated.map(toHex).sort();
  const cert5 = encodeSeatingCertificate({ ...five,
    signatures: [...byz.map((i) => ({ nodePubkey: nodes[i].pubkey, signature: signSeating(five, signer(nodes[i])) })), { nodePubkey: nodes[3].pubkey, signature: new Uint8Array(own.signature) }],
    seen: [{ present, leftOut: [], signatures: [...byz.map((i) => ({ nodePubkey: nodes[i].pubkey, signature: signSeen({ roundId: net.rid, role: 'game', seating: seatingId(five), present, leftOut: [] }, signer(nodes[i])) })),
      { nodePubkey: nodes[3].pubkey, signature: new Uint8Array(seen3.signature) }] }] });
  assert.deepEqual([JSON.parse(seen3.present), JSON.parse(seen3.left_out)], [present, []], 'seat 3 held the five at the close');
  const k = net.agents.get(5).keepCert(net.rid, 'game', cert5);
  assert.equal(k.ok, true, k.why); assert.equal(k.equivocation, true, 'two certificates: the round takes no entries');
  assert.deepEqual([...k.signers].sort(), byz.map((i) => toHex(nodes[i].pubkey)).sort(), 'the proof names the four that signed both, not seat 3');
  const [eq] = net.agents.get(5).equivocationOf(net.rid);
  assert.deepEqual(eq.excused, [toHex(nodes[3].pubkey)], 'seat 3 is excused by its justification');
  assert.ok(eq.signedTwice.length && eq.signedTwice.every((x) => byz.map((i) => toHex(nodes[i].pubkey)).includes(x.node) && x.certificate === 'b'),
    'and the member its justification names is proved against by its seating of 7 and the certificate of 5');
});

test('kanban #738 (protocol 22): a second signature without its justification is not counted - one with it is, and below 22 none is asked', async () => {
  const strip = (from, to, sig) => { if (to !== 3) return sig; const { justification, ...rest } = sig; return rest; };
  for (const [opts, counted] of [[{}, true], [{ sigOf: strip }, false]]) {
    const net = await resignedAt22(opts);
    assert.ok(net.agents.get(3).mySignature(net.rid, 'game').justification);
    await net.tickAll(1, [0, 1, 2, 4, 5, 6]);                               // they read seat 3's second signature
    const row = sigRowAt(net, 0, 3, sevenId(net.rid));
    assert.equal(!!row, counted, counted ? 'justified: counted' : 'stripped of its justification: not counted');
    if (row) assert.ok(row.justification, 'and kept with its justification, for the certificate');
  }
  // protocol 20: no justification is signed, the second signature counts as before - seat 3, holding every signature over the seating
  // of 7 once it re-signs, certifies it at once and hands it on - and the certificate is the old bytes
  const net = await seatingNet({ protocolVersion: 20, sigOf: strip });
  await net.tickAll(2); net.close();
  await net.tickAll(1, [3]); await net.tickAll(1, [0, 1, 2, 4, 5, 6, 7]); await net.tickAll(1, [3]);
  assert.deepEqual(net.signedOf(3), upTo(7));
  assert.equal(net.agents.get(3).mySignature(net.rid, 'game').justification, undefined, 'below 22 nothing is carried');
  const cert = net.agents.get(0).certOf(net.rid, 'game');
  assert.ok(cert, 'the seating of 7 stands at seat 0');
  const d = decodeSeatingCertificate(Buffer.from(cert, 'hex'));
  assert.deepEqual([d.seen, d.justifications], [null, null]);
  assert.deepEqual(Buffer.from(cert, 'hex'), Buffer.from(encodeSeatingCertificate({ roundId: net.rid, role: 'game', seated: d.seated, signatures: d.signatures })));
});

test('kanban #738 (protocol 22): a forged justification refuses the signature it came with', async () => {
  // the member's signature in it, one byte off (the last byte is the nested flag, the 64 before it the signature)
  const forge = (from, to, sig) => {
    if (to !== 3 || !sig.justification) return sig;
    const b = Buffer.from(sig.justification, 'hex'); b[b.length - 2] ^= 1;
    return { ...sig, justification: b.toString('hex') };
  };
  const net = await resignedAt22({ sigOf: forge });
  await net.tickAll(1, [0, 1, 2, 4, 5, 6]);
  assert.equal(sigRowAt(net, 0, 3, sevenId(net.rid)), undefined, 'not counted');
  const junk = await resignedAt22({ sigOf: (from, to, sig) => (to === 3 && sig.justification ? { ...sig, justification: '00' } : sig) });
  await junk.tickAll(1, [0, 1, 2, 4, 5, 6]);
  assert.equal(sigRowAt(junk, 0, 3, sevenId(junk.rid)), undefined, 'an undecodable one neither');
});
