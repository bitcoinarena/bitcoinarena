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

test('wf1489 r5 census-2: a withholder cannot finish the first seating late and void the round the honest seats re-seated', async () => {
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
      // the attacker answers fine, hands its PRESENTs, but never its seating signature (nor a certificate)
      if (to === BAD) for (const r of Object.values(j.rounds)) { r.sig = { game: null, settlement: null }; r.cert = { game: null, settlement: null }; }
      return new Response(JSON.stringify(j), { status: 200 });
    }
    if (u.pathname === '/seating') {
      if (to === BAD) return new Response('ok', { status: 201 });
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
  // the attacker's own agent ticks before the close only (it signs and hands out its PRESENTs), and builds nothing after it
  const tickAll = async (times, all = false) => { for (let k = 0; k < times; k++) for (const [i, a] of net.agents) if (all || i !== BAD) await a.tick(); };
  await tickAll(2, true);                                   // PRESENTs exchanged before the close
  // from the close to just before the start, every 5 s
  // the attacker reads every seat's batch each tick (as a drawn node does) and keeps the signatures over its first seating
  const kept = new Map();   // seating list -> Map(node hex -> signature hex)
  const watch = () => { for (const [i, a] of net.agents) { if (i === BAD) continue; const m = a.mySignature(rid, 'settlement'); if (!m) continue;
    const k = m.seated.join(','); if (!kept.has(k)) kept.set(k, new Map()); kept.get(k).set(m.node, m.signature); } };
  for (let t = Number(START - 120000n) + 1000; t < Number(START); t += 5000) { net.now = t; await tickAll(1); watch(); }
  const honest = [0, 2, 3, 4, 5, 6, 7, 8];
  const held = honest.filter((i) => net.agents.get(i).certOf(rid, 'settlement'));
  assert.ok(held.length > 0, 'the #1509 re-seating formed a certificate without the withholder');
  const badHex = toHex(nodes[BAD].pubkey);
  const first = [...kept.entries()].find(([k]) => k.split(',').includes(badHex));
  assert.ok(first, 'the honest seats first signed a seating with the withholder in it');
  const seated = first[0].split(',');
  const sigs = seated.filter((k) => k !== badHex && first[1].has(k)).map((k) => ({ nodePubkey: fromHex(k), signature: fromHex(first[1].get(k)) }));
  // the withholder signs the first seating now, and completes it with the signatures it read
  const seatedBytes = seated.map(fromHex);
  sigs.push({ nodePubkey: nodes[BAD].pubkey, signature: signSeating({ roundId: rid, role: 'settlement', seated: seatedBytes }, signer(nodes[BAD])) });
  assert.equal(sigs.length, seated.length, 'every member of the first seating signed it');
  const late = encodeSeatingCertificate({ roundId: rid, role: 'settlement', seated: seatedBytes, signatures: sigs });
  const said = honest.map((i) => net.agents.get(i).keepCert(rid, 'settlement', late));
  const voided = honest.filter((i) => net.agents.get(i).stateOf(rid).settlement && net.agents.get(i).stateOf(rid).settlement.equivocated);
  console.log('  MEASURED r5 census-2:', JSON.stringify({ firstSeating: seated.map((k) => nodes.findIndex((n) => toHex(n.pubkey) === k)).join(''),
    certHolders: held.length, keepCert: said[0], equivocatedAt: voided.length }));
  assert.equal(voided.length, 0, `${voided.length} honest seats recorded equivocation by ${said[0].signers ? said[0].signers.length : 0} signers (honest re-signers among them) from the withholder's late first certificate: the round takes no entries`);
});
