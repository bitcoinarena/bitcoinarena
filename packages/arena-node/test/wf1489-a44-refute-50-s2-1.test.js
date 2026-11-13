// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 a44-refute-50-s2 (second skeptic of #1707 / 56b6c1341), built on the r5 census-2 harness.
// r5 census-2 (P6, bypass of the #1509 fix): a seated member that withholds its seating signature is left out after
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


async function run({ targets = [], when = 'any', honestLate = false, race = false, midRead = false }) {
  const c = { ...contractFor(nodes.slice(0, 7).map((n) => n.pubkey)), startTimeMs: START };
  const bytes = encodeRoundContract(c);
  const rid = roundIdOf(c);
  const drawn = nodes.map((n) => ({ pubkey: n.pubkey, advert: { endpoint: n.endpoint } }));
  const net = { now: NOW, agents: new Map() };
  const badHex = toHex(nodes[BAD].pubkey);
  let posted = null;
  const fetcherOf = (from) => async (url, init = {}) => {
    const u = new URL(url);
    const to = nodes.findIndex((n) => n.endpoint === `${u.protocol}//${u.host}`);
    const a = net.agents.get(to);
    if (!a) return new Response('down', { status: 503 });
    if (u.pathname === '/presents') { const r = a.takePresents(new Uint8Array(await new Response(init.body).arrayBuffer())); return new Response(JSON.stringify(r), { status: r.ok ? 201 : 400 }); }
    if (u.pathname === '/seating-batch') {
      const j = a.batchOf(u.searchParams.get('rounds').split(','));
      if (to === BAD && !net.awake) for (const r of Object.values(j.rounds)) { r.sig = { game: null, settlement: null }; r.cert = { game: null, settlement: null }; }
      // MID-READ (a44-refute-50-s2 #3): the incoming reserve 7 reads the members' batches (each answer made here, now) and only then joins S2 and
      // certifies it. Right after the last member answered it - every member re-signed S2, the reserve not yet - the withholder hands S1 to the members.
      if (midRead && !posted && from === 7 && to === 6 && [0, 2, 3, 4, 5, 6].every((i) => { const m = net.agents.get(i).mySignature(rid, 'settlement'); return m && !m.seated.includes(badHex); }) && !net.agents.get(7).mySignature(rid, 'settlement')) {
        const l = lateCert(); if (l) { posted = { at: net.now, midRead: true, said: {} }; for (const i of [0, 2, 3, 4, 5, 6]) posted.said[i] = net.agents.get(i).keepCert(rid, 'settlement', l.cert); }
      }
      return new Response(JSON.stringify(j), { status: 200 });
    }
    if (u.pathname === '/seating') {
      if (to === BAD && !net.awake) {
        // THE RACE (a44-refute-50-s2): the withholder is a drawn node, so the incoming reserve that completes the second seating hands its
        // certificate to it too. It answers at once with the first seating, completed, to every honest seat that holds no certificate yet.
        if (race && !posted) { const b = new Uint8Array(await new Response(init.body).arrayBuffer()); const s = decodeSeatingCertificate(b).seated.map(toHex);
          if (!posted && !s.includes(badHex)) { const l = lateCert(); if (l) { posted = { at: net.now, race: true, honest: !!honestLate, trigger: decodeSeatingCertificate(b).role + ':' + s.map((k) => nodes.findIndex((n) => toHex(n.pubkey) === k)).join(''), before: Object.fromEntries([0, 2, 3, 4, 5, 6, 7, 8].map((i) => { const c = net.agents.get(i).certOf(rid, 'settlement'); return [i, c ? decodeSeatingCertificate(fromHex(c)).seated.map((k) => nodes.findIndex((n) => toHex(n.pubkey) === toHex(k))).join('') : null]; })), firstSeating: l.seated.map((k) => nodes.findIndex((n) => toHex(n.pubkey) === k)).join(''), said: {} };
            for (const i of [0, 2, 3, 4, 5, 6, 7, 8]) if (!net.agents.get(i).certOf(rid, 'settlement')) posted.said[i] = net.agents.get(i).keepCert(rid, 'settlement', l.cert); } } }
        return new Response('ok', { status: 201 });
      }
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
  const strike = () => {
    if (race || midRead || posted || net.awake) return;
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


// THE ATTACK (a44-refute-50-s2 #1): since 56b6c1341 a seat with no certificate keeps ANY valid one, the withholder's late first seating S1
// included, and a seat that holds one refuses the other (by seat_withheld name or the leftOut rule) without equivocation. So the withholder
// waits until the second seating S2 is certified by the reserve that completes it - the reserve hands S2 to every drawn node, the
// withholder among them - and answers at once with S1 to the honest seats S2 has not reached yet. Each side then refuses the other's
// certificate for good: honest seats stand on two different seatings of one round.
test('a44-refute-50-s2 #1: S1 raced against the S2 hand-out splits the honest seats over two certificates', async () => {
  const r = await run({ race: true });
  console.log('  MEASURED a44-refute-50-s2 #1:', JSON.stringify(r));
  assert.ok(r.posted, 'the withholder found its moment (the S2 hand-out reached it)');
  const held = new Set(Object.values(r.certs).filter(Boolean));
  assert.ok(held.size <= 1, `honest seats hold ${held.size} different certificates of one round: ${JSON.stringify(r.certs)} (posted ${JSON.stringify(r.posted)})`);
  const none = Object.entries(r.certs).filter(([, v]) => !v).map(([k]) => k);
  assert.equal(none.length, 0, `honest seat(s) ${none.join(',')} hold no certificate: ${JSON.stringify(r.certs)}`);
});

// THE HONEST PATH (a44-refute-50-s2 #2): no attacker. A seated member that was only slow (stalled past WITHHELD_SIG_MS, then back) signs the first
// seating S1 it had read everyone's signatures over and certifies it, and its hand-out crosses the reserve's hand-out of S2 - two honest
// certificates in flight at once, as on any real network. Same code path as #1: whoever holds none keeps whichever comes first, and keeps it.
test('a44-refute-50-s2 #2 (honest path): a slow member completing S1 while the reserve hands out S2 leaves honest seats on two certificates', async () => {
  const r = await run({ race: true, honestLate: true });
  console.log('  MEASURED a44-refute-50-s2 #2:', JSON.stringify(r));
  assert.ok(r.posted, 'the two hand-outs crossed');
  const held = new Set(Object.values(r.certs).filter(Boolean));
  assert.ok(held.size <= 1, `honest seats hold ${held.size} different certificates of one round with no attacker: ${JSON.stringify(r.certs)}`);
});

// THE RESERVE'S READ, THEN ITS JOIN (a44-refute-50-s2 #3): the reserve taken in reads every member's batch (all re-signed S2, none holds a
// certificate), then joins S2 and certifies it. Between its last read and its join the withholder hands S1 to the members only: they hold
// none, so they keep it; the reserve's S2 then reaches them and is refused (leftOut), and S1 never reaches the reserve as a second one it takes.
test('a44-refute-50-s2 #3: S1 handed to the members between the reserve\'s batch read and its join splits the seats', async () => {
  const r = await run({ midRead: true });
  console.log('  MEASURED a44-refute-50-s2 #3:', JSON.stringify(r));
  assert.ok(r.posted, 'the withholder found its moment');
  const held = new Set(Object.values(r.certs).filter(Boolean));
  assert.ok(held.size <= 1, `honest seats hold ${held.size} different certificates of one round: ${JSON.stringify(r.certs)} (posted ${JSON.stringify(r.posted)})`);
});
