// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 r5 census-2 (P6, bypass of the #1509 fix): a seated member that withholds its seating signature is left out after
// WITHHELD_SIG_MS, and the honest seats re-sign the seating without it ("the withholder signed nothing, so no seating of it can stand
// that an honest member left"). But the honest members' signatures over the FIRST seating were handed out (GET /seating-batch) before
// they moved: the withholder keeps them, signs that first seating itself once the second certificate stands, and posts the completed
// first certificate (POST /seating). Every honest seat then holds two valid certificates, records equivocation against the HONEST
// signers of both, and the round takes no entries - after players may already have entered.
// Safe behaviour: the late first certificate does not void the round nor name the honest re-signers as equivocators.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { schnorr } from '@noble/curves/secp256k1.js';
import { seatingAgent } from '../src/seating-agent.js';
import { encodeRoundContract, roundId as roundIdOf } from '../../arena-protocol/src/contracts.js';
import { decodeSeatingCertificate, encodeSeatingCertificate, signSeating } from '../../arena-protocol/src/seating.js';
import { fromHex } from '../../arena-protocol/src/hash.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { contractFor } from './window-fixture.js';

const nodes = Array.from({ length: 9 }, (_, i) => { const secret = new Uint8Array(32).fill(i + 1); return { secret, pubkey: schnorr.getPublicKey(secret), endpoint: `http://seat-${i}` }; });
const signer = (n) => (m) => schnorr.sign(m, n.secret);
const START = 60500n;
const NOW = Number(START) - 150000;
const BAD = 1;   // drawn and seated by score; present; never hands out its seating signature


// kanban #1489 a44-refute-50 (refute of the #1707 fix): the withholder no longer posts its late first certificate to the members that
// re-signed (they refuse it by name, seat_withheld) but to the drawn nodes OUTSIDE the first seating - the reserve the members take in,
// and the reserve after it - in the moment after the members re-signed and before the reserve signed the new seating. Those seats never
// named the withholder, hold no certificate yet, and keep the first one; the reserve then never signs the second seating (joinLate stops
// at a held certificate) and the leftOut rule makes each side refuse the other's certificate for good, with no equivocation recorded.
async function run({ targets = [], when = 'any', honestLate = false }) {
  const c = { ...contractFor(nodes.slice(0, 7).map((n) => n.pubkey)), startTimeMs: START };
  const bytes = encodeRoundContract(c);
  const rid = roundIdOf(c);
  const drawn = nodes.map((n) => ({ pubkey: n.pubkey, advert: { endpoint: n.endpoint } }));
  const net = { now: NOW, agents: new Map() };
  const fetcherOf = () => async (url, init = {}) => {
    const u = new URL(url);
    const to = nodes.findIndex((n) => n.endpoint === `${u.protocol}//${u.host}`);
    const a = net.agents.get(to);
    if (!a) return new Response('down', { status: 503 });
    if (u.pathname === '/presents') { const r = a.takePresents(new Uint8Array(await new Response(init.body).arrayBuffer())); return new Response(JSON.stringify(r), { status: r.ok ? 201 : 400 }); }
    if (u.pathname === '/seating-batch') {
      const j = a.batchOf(u.searchParams.get('rounds').split(','));
      if (to === BAD && !net.awake) for (const r of Object.values(j.rounds)) { r.sig = { game: null, settlement: null }; r.cert = { game: null, settlement: null }; }
      return new Response(JSON.stringify(j), { status: 200 });
    }
    if (u.pathname === '/seating') {
      if (to === BAD && !net.awake) return new Response('ok', { status: 201 });
      const b = new Uint8Array(await new Response(init.body).arrayBuffer()); const r = a.keepCert(rid, decodeSeatingCertificate(b).role, b);
      return new Response(JSON.stringify(r), { status: r.ok ? 201 : 409 });
    }
    return new Response('no', { status: 404 });
  };
  for (let i = 0; i < 9; i++) {
    const n = nodes[i];
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE rounds (round_id BLOB, contract BLOB)');
    db.prepare('INSERT INTO rounds (round_id, contract) VALUES (?, ?)').run(rid, bytes);
    const round = { db, pubkey: n.pubkey, get: (id) => (toHex(id) === toHex(rid) ? { contract: bytes } : null) };
    net.agents.set(i, seatingAgent({ round, roster: { committeeFor: () => ({ ok: true, drawn }) }, sign: signer(n), fetcher: fetcherOf(i), nowMs: () => net.now,
      verify: (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } } }));
  }
  const badHex = toHex(nodes[BAD].pubkey);
  const kept = new Map();
  const watch = () => { for (const [i, a] of net.agents) { if (i === BAD) continue; const m = a.mySignature(rid, 'settlement'); if (!m) continue;
    const k = m.seated.join(','); if (!kept.has(k)) kept.set(k, new Map()); kept.get(k).set(m.node, m.signature); } };
  const lateCert = () => {
    const first = [...kept.entries()].find(([k]) => k.split(',').includes(badHex));
    if (!first) return null;
    const seated = first[0].split(',');
    if (!seated.filter((k) => k !== badHex).every((k) => first[1].has(k))) return null;
    const sigs = seated.filter((k) => k !== badHex).map((k) => ({ nodePubkey: fromHex(k), signature: fromHex(first[1].get(k)) }));
    sigs.push({ nodePubkey: nodes[BAD].pubkey, signature: signSeating({ roundId: rid, role: 'settlement', seated: seated.map(fromHex) }, signer(nodes[BAD])) });
    return { seated, cert: encodeSeatingCertificate({ roundId: rid, role: 'settlement', seated: seated.map(fromHex), signatures: sigs }) };
  };
  let posted = null;
  const strike = () => {
    if (posted || net.awake) return;
    const without = (i) => { const m = net.agents.get(i).mySignature(rid, 'settlement'); return m && !m.seated.includes(badHex); };
    // the moment: 'any' = one honest member re-signed without the withholder; 'members' = every member did and the reserve has not signed yet
    const moved = when === 'any' ? [0, 2, 3, 4, 5, 6, 7, 8].some(without)
      : [0, 2, 3, 4, 5, 6].every(without) && !net.agents.get(7).mySignature(rid, 'settlement');
    if (!moved) return;
    // an honest node that was only slow (stalled, restarted) wakes now: it hands out its signature as any seat does
    if (honestLate) { net.awake = true; posted = { at: net.now, honestLate: true }; return; }
    const l = lateCert(); if (!l) return;
    posted = { at: net.now, firstSeating: l.seated.map((k) => nodes.findIndex((n) => toHex(n.pubkey) === k)).join(''), said: {} };
    for (const i of targets) posted.said[i] = net.agents.get(i).keepCert(rid, 'settlement', l.cert);
  };
  const step = async (all) => { for (const [i, a] of net.agents) { if (!all && !net.awake && i === BAD) continue; await a.tick(); watch(); strike(); } };
  await step(true); await step(true);
  for (let t = Number(START - 120000n) + 1000; t < Number(START); t += 5000) { net.now = t; await step(false); }
  const honest = [0, 2, 3, 4, 5, 6, 7, 8];
  const certs = Object.fromEntries(honest.map((i) => { const s = net.agents.get(i).certOf(rid, 'settlement');
    return [i, s ? decodeSeatingCertificate(fromHex(s)).seated.map((k) => nodes.findIndex((n) => toHex(n.pubkey) === toHex(k))).join('') : null]; }));
  const equivocated = honest.filter((i) => { const s = net.agents.get(i).stateOf(rid).settlement; return s && s.equivocated; });
  return { posted, certs, equivocated, finalSeatings: Object.fromEntries(honest.map((i) => { const m = net.agents.get(i).mySignature(rid, 'settlement'); return [i, m ? m.seated.map((k) => nodes.findIndex((n) => toHex(n.pubkey) === k)).join('') : null]; })) };
}

test('a44-refute-50 #1: the late first certificate handed to the incoming reserve after the members re-signed and before it signs leaves the members without a certificate', async () => {
  const r = await run({ targets: [7, 8], when: 'members' });
  console.log('  MEASURED a44-refute-50 #1:', JSON.stringify(r));
  assert.ok(r.posted, 'the attacker found its moment');
  const members = [0, 2, 3, 4, 5, 6];
  const without = members.filter((i) => !r.certs[i]);
  assert.equal(without.length, 0, `${without.length} of ${members.length} honest members hold no certificate at the start: the round takes no entries (the #1509 effect): ${JSON.stringify({ certs: r.certs, mySeating: r.finalSeatings, posted: r.posted })}`);
  const held = new Set(Object.values(r.certs).filter(Boolean));
  assert.ok(held.size <= 1, `honest seats hold ${held.size} different certificates: ${JSON.stringify(r.certs)}`);
});

test('a44-refute-50 #2: the late first certificate handed to a drawn seat right after the first member re-signed: every honest seat holds the same certificate', async () => {
  const r = await run({ targets: [8], when: 'any' });
  console.log('  MEASURED a44-refute-50 #2:', JSON.stringify(r));
  assert.ok(r.posted, 'the attacker found its moment');
  const honest = [0, 2, 3, 4, 5, 6, 7, 8];
  const none = honest.filter((i) => !r.certs[i]);
  assert.equal(none.length, 0, `honest seat(s) ${none.join(',')} hold no certificate while the others stand on ${[...new Set(Object.values(r.certs).filter(Boolean))].join(' vs ')}: ${JSON.stringify(r.certs)}`);
});

test('a44-refute-50 #3 (honest path): a member that was only slow and signs once one seat has re-signed - every honest seat holds the certificate', async () => {
  const r = await run({ when: 'any', honestLate: true });
  console.log('  MEASURED a44-refute-50 #3:', JSON.stringify(r));
  assert.ok(r.posted, 'the slow member woke');
  const honest = [0, 2, 3, 4, 5, 6, 7, 8];
  const none = honest.filter((i) => !r.certs[i]);
  assert.equal(none.length, 0, `honest seat(s) ${none.join(',')} hold no certificate while the others stand on ${[...new Set(Object.values(r.certs).filter(Boolean))].join(' vs ')}: ${JSON.stringify(r.certs)}`);
});
