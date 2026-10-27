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
  decodeSeatingCertificate } from '../../arena-protocol/src/seating.js';
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

// ONE OVERLOADED SEAT SIGNED A SMALLER SEATING AND NO CERTIFICATE FORMED (kanban #738, measured 2026-10-27 23:30Z, Up/Down round
// d77b3d03, 9 drawn for 7 seats): six seats signed the seating of 7 (8 present of 9 drawn), the overloaded one the seating of 5 (5
// present) and never again - no certificate, the round unseated. Eight live seats of nine drawn, node 8 stopped; until the close
// `slow` hears only nodes 0, 1, 2 and 4 (the others' PRESENTs never reach it), after it every node hears every node.
const upTo = (n) => Array.from({ length: n }, (_, i) => i);
async function seatingNet({ slow = 3, protocolVersion = 20, lateStrips = () => [] } = {}) {
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

for (const protocolVersion of [20]) {   // 22 is 2.0's (its SEEN, #727); this line has no 22
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
