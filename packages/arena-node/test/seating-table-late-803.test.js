// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A TABLE'S FIRST ROUND THAT STARTED WITHOUT ITS CERTIFICATE IS JOINED LATE (kanban #803, measured 2026-10-30 on RPS table 24d4c900 of
// 00:00Z, federation B): 5 present, four of the five seated signed the seating of those 5, and the fifth (test host seat 7) held all five
// PRESENTs but was inside one 364 s seating tick from before the close until after the start - a started round was only read, so it
// never signed and the table stayed unseated all day. Now the late seat signs the seating another seated member signed, and certifies.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { schnorr } from '@noble/curves/secp256k1.js';
import { seatingAgent } from '../src/seating-agent.js';
import { encodeRoundContract, roundId as roundIdOf } from '../../arena-protocol/src/contracts.js';
import { signPresent, signSeating, seatedFrom, verifySeating, decodeSeatingCertificate } from '../../arena-protocol/src/seating.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { contractFor } from './window-fixture.js';

const nodes = Array.from({ length: 7 }, (_, i) => { const secret = new Uint8Array(32).fill(i + 1); return { secret, pubkey: schnorr.getPublicKey(secret), endpoint: `http://seat-${i}` }; });
const signer = (n) => (m) => schnorr.sign(m, n.secret);
const verify = (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } };
const RPS_V2 = fromHex('a75f54fd4f978a29ab6d39d9ef85c7adbe0576614634c679ae33d3e1c06164ea');
const START = 60500n;
const LATER = Number(START) + 30 * 60000;     // half an hour after the table's first round started

function table({ roundIndex = 0, others = 4, game = RPS_V2, hangPosts = null } = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE rounds (round_id BLOB, contract BLOB)');
  const c = { ...contractFor([]), gameId: game, protocolVersion: 2, seriesId: new Uint8Array(32).fill(0x80), nodes: [], gameVerifySlots: 7, settlementSlots: 7, roundIndex, startTimeMs: START };
  const b = encodeRoundContract(c); const rid = roundIdOf(c);
  db.prepare('INSERT INTO rounds (round_id, contract) VALUES (?, ?)').run(rid, b);
  const drawn = nodes.map((n) => ({ pubkey: n.pubkey, advert: { endpoint: n.endpoint } }));
  const present = nodes.slice(0, 5);                         // 5 present of the 7 drawn
  const me = present[4];
  const seated = seatedFrom({ drawn: nodes.map((n) => n.pubkey), present: present.map((n) => n.pubkey), slots: 7 });
  const signers = present.filter((n) => n !== me).slice(0, others);
  const posted = [];
  const fetcher = async (url, init = {}) => {
    const u = new URL(url);
    if ((init.method || 'GET') === 'POST') { posted.push(`${u.host}${u.pathname}`); if (hangPosts) await hangPosts; return new Response('{}', { status: 200 }); }
    if (u.pathname !== '/seating-batch') return new Response('{}', { status: 200 });
    const n = nodes.find((x) => x.endpoint === `http://${u.host}`);
    const sig = (role) => (signers.includes(n) ? { node: toHex(n.pubkey), seated: seated.map(toHex), signature: toHex(signSeating({ roundId: rid, role, seated }, signer(n))) } : null);
    return new Response(JSON.stringify({ rounds: { [toHex(rid)]: { presents: [], sig: { game: sig('game'), settlement: sig('settlement') }, cert: {} } } }), { status: 200 });
  };
  const agent = seatingAgent({ round: { db, pubkey: me.pubkey, get: (id) => (toHex(id) === toHex(rid) ? { contract: b } : null) },
    roster: { committeeFor: () => ({ ok: true, drawn }) }, sign: signer(me), verify, fetcher, nowMs: () => LATER });
  // the five PRESENTs this seat held at the close
  for (const n of present) for (const role of ['game', 'settlement']) assert.ok(agent.takePresent(signPresent({ roundId: rid, role, nodePubkey: n.pubkey }, signer(n)), { afterClose: true }).ok);
  return { agent, rid, seated, posted };
}

test('a seated member that missed signing the table\'s first round signs the seating the others signed, late, and the certificate stands', async () => {
  const { agent, rid, seated, posted } = table();
  await agent.tick();
  for (const role of ['game', 'settlement']) {
    assert.deepEqual(agent.mySignature(rid, role).seated, seated.map(toHex), `${role}: the seating the four signed, not one of its own`);
    const cert = agent.certOf(rid, role);
    assert.ok(cert, `${role}: the certificate stands`);
    assert.equal(decodeSeatingCertificate(fromHex(cert)).signatures.length, 5);
    assert.equal(agent.stateOf(rid)[role].seated.length, 5);
  }
  assert.equal(posted.filter((p) => p.endsWith('/seating')).length, 2 * 6, 'each certificate handed to the six other drawn seats');
});

test('with no seated member\'s signature to join, the late seat signs nothing of its own', async () => {
  const { agent, rid } = table({ others: 0 });
  await agent.tick();
  for (const role of ['game', 'settlement']) { assert.equal(agent.mySignature(rid, role), null); assert.equal(agent.certOf(rid, role), null); }
});

test('a later round of a table, and any started round that is no table\'s first, is still never signed late', async () => {
  for (const opts of [{ roundIndex: 3 }, { game: new Uint8Array(32).fill(0x11) }]) {
    const { agent, rid } = table(opts);
    await agent.tick();
    for (const role of ['game', 'settlement']) assert.equal(agent.mySignature(rid, role), null, JSON.stringify(Object.keys(opts)));
  }
});

test('the tick does not wait for the tables\' certificate asks (kanban #803: 35 s of a 35.2 s tick on test host seat 7)', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE rounds (round_id BLOB, contract BLOB)');
  const c0 = { ...contractFor([]), gameId: RPS_V2, protocolVersion: 2, seriesId: new Uint8Array(32).fill(0x90), nodes: [], gameVerifySlots: 7, settlementSlots: 7, roundIndex: 0, startTimeMs: START };
  const c5 = { ...c0, roundIndex: 5, startTimeMs: START + 40000n };
  const b5 = encodeRoundContract(c5);
  db.prepare('INSERT INTO rounds (round_id, contract) VALUES (?, ?)').run(roundIdOf(c5), b5);
  const drawn = nodes.map((n) => ({ pubkey: n.pubkey, advert: { endpoint: n.endpoint } }));
  let release; const slow = new Promise((r) => { release = r; }); let asks = 0;
  const fetcher = async (url) => { if (new URL(url).pathname === '/seating') { asks++; await slow; return new Response('{}', { status: 404 }); } return new Response(JSON.stringify({ rounds: {} })); };
  const agent = seatingAgent({ round: { db, pubkey: nodes[0].pubkey, get: (id) => (toHex(id) === toHex(roundIdOf(c5)) ? { contract: b5 } : null) },
    roster: { committeeFor: () => ({ ok: true, drawn }) }, sign: signer(nodes[0]), verify, fetcher, nowMs: () => Number(START) - 150000, contractOf: () => c0 });
  const t0 = Date.now();
  await agent.tick();
  assert.ok(Date.now() - t0 < 1000, 'the tick ended while every ask still hung');
  assert.equal(asks, 2 * 6, 'every other drawn seat asked, both roles, at once');
  await agent.tick();
  assert.equal(asks, 2 * 6, 'a second pass does not start while one runs');
  release(); await agent.settled();
});

test('the tick does not wait for the certificate\'s hand-out (kanban #803: take+certify 10.6 s of a 12.2 s tick on test host seat 2)', async () => {
  let release; const hang = new Promise((r) => { release = r; });
  const { agent, rid, posted } = table({ hangPosts: hang });
  const t0 = Date.now();
  await agent.tick();
  assert.ok(Date.now() - t0 < 1000, 'the tick ended while every hand-out still hung');
  assert.ok(agent.certOf(rid, 'game') && agent.certOf(rid, 'settlement'), 'both certificates stand');
  assert.equal(posted.filter((p) => p.endsWith('/seating')).length, 2 * 6, 'and were handed to the six other drawn seats');
  release();
});
