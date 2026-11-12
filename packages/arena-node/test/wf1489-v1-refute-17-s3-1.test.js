// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// wf1489 v1 refute-17-s3-1 (#1509, after fa5f7cde4 + dfb79464a): a withholder BAD plus a colluding first reserve R that SIGNS the replacement S'
// but hides its signature and the certificate. The honest seats signed S (BAD in it), BAD withheld 30 s, they moved to S' (BAD out, R in) and
// signed it. Before they give up on R, BAD hands out the certificate of S, built from the honest seats' old signatures over S and its own: every
// honest seat takes it (seat_withheld is not asked by keepCert), the round is seated by S and takes entries. Then R hands out S' (the honest
// seats' signatures over S' plus its own): a round with entries is not replaced, so the pair is an equivocation by every honest member, and a
// round with entries on it is voided - worse than the one #1509 fixed, and impossible before the fix (no honest seat ever signed S').
// Safe behaviour: once a round seated and took entries, two colluding seats cannot void it with the honest seats' own signatures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { schnorr } from '@noble/curves/secp256k1.js';
import { seatingAgent } from '../src/seating-agent.js';
import { encodeRoundContract, roundId as roundIdOf } from '../../arena-protocol/src/contracts.js';
import { decodeSeatingCertificate, signSeating, encodeSeatingCertificate } from '../../arena-protocol/src/seating.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { contractFor } from './window-fixture.js';

const nodes = Array.from({ length: 9 }, (_, i) => { const secret = new Uint8Array(32).fill(i + 1); return { secret, pubkey: schnorr.getPublicKey(secret), endpoint: `http://seat-${i}` }; });
const signer = (n) => (m) => schnorr.sign(m, n.secret);
const START = 60500n;
const NOW = Number(START) - 150000;
const BAD = 1;   // seated by score; present; never hands out its seating signature
const R = 7;     // the first reserve, colluding: present, signs, but hands out neither its signature nor a certificate
const keyOf = (k) => nodes.find((n) => toHex(n.pubkey) === k).pubkey;
const idx = (k) => nodes.findIndex((n) => toHex(n.pubkey) === k);

test('wf1489 v1 refute-17-s3-1: a withholder and a reserve that hides its signature void a round that already took entries', async () => {
  const c = { ...contractFor(nodes.slice(0, 7).map((n) => n.pubkey)), startTimeMs: START };
  const bytes = encodeRoundContract(c);
  const rid = roundIdOf(c);
  const drawn = nodes.map((n) => ({ pubkey: n.pubkey, advert: { endpoint: n.endpoint } }));
  const net = { now: NOW, agents: new Map(), entries: 0 };
  const fetcherOf = (from) => async (url, init = {}) => {
    const u = new URL(url);
    const to = nodes.findIndex((n) => n.endpoint === `${u.protocol}//${u.host}`);
    const a = net.agents.get(to);
    if (!a) return new Response('down', { status: 503 });
    if (u.pathname === '/presents') { const r = a.takePresents(new Uint8Array(await new Response(init.body).arrayBuffer())); return new Response(JSON.stringify(r), { status: r.ok ? 201 : 400 }); }
    if (u.pathname === '/seating-batch') {
      const j = a.batchOf(u.searchParams.get('rounds').split(','));
      if (to === BAD || to === R) for (const r of Object.values(j.rounds)) { r.sig = { game: null, settlement: null }; r.cert = { game: null, settlement: null }; }
      return new Response(JSON.stringify(j), { status: 200 });
    }
    if (u.pathname === '/seating') {
      if (from === R || to === BAD || to === R) return new Response('ok', { status: 201 });   // R posts nothing it builds
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
    const round = { db, pubkey: n.pubkey, get: (id) => (toHex(id) === toHex(rid) ? { contract: bytes } : null), entriesOf: () => Array.from({ length: net.entries }) };
    net.agents.set(i, seatingAgent({ round, roster: { committeeFor: () => ({ ok: true, drawn }) }, sign: signer(n), fetcher: fetcherOf(i), nowMs: () => net.now,
      verify: (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } } }));
  }
  const honest = [0, 2, 3, 4, 5, 6, 8];
  const tickAll = async (times, all = false) => { for (let k = 0; k < times; k++) for (const [i, a] of net.agents) if (all || i !== BAD) await a.tick(); };
  await tickAll(2, true);
  const oldSigs = new Map();
  const sig = (i) => net.agents.get(i).mySignature(rid, 'settlement');
  let moved = false;
  for (let t = Number(START - 120000n) + 1000; t < Number(START) && !moved; t += 5000) {
    net.now = t; await tickAll(1);
    for (const i of honest) { const m = sig(i); if (m && m.seated.includes(toHex(nodes[BAD].pubkey)) && !oldSigs.has(i)) oldSigs.set(i, m); }
    const r = sig(R);
    moved = !!r && !r.seated.includes(toHex(nodes[BAD].pubkey)) && r.seated.filter((k) => idx(k) !== R).every((k) => { const m = sig(idx(k)); return m && m.seated.join() === r.seated.join(); });
  }
  assert.ok(moved, 'the fix itself: the honest seats moved to S\' (BAD out, R in) and R signed it');
  // BAD's certificate of S: the honest seats' old signatures over S plus its own
  const S = oldSigs.get(0).seated;
  const certS = encodeSeatingCertificate({ roundId: rid, role: 'settlement', seated: S.map(keyOf), signatures: S.map((k) => idx(k) === BAD
    ? { nodePubkey: nodes[BAD].pubkey, signature: signSeating({ roundId: rid, role: 'settlement', seated: S.map(keyOf) }, signer(nodes[BAD])) }
    : { nodePubkey: keyOf(k), signature: Uint8Array.from(Buffer.from(oldSigs.get(idx(k)).signature, 'hex')) }) });
  const tookS = honest.map((i) => net.agents.get(i).keepCert(rid, 'settlement', certS));
  // the round is seated by S at the honest seats, and players enter
  net.entries = 1;
  // R's certificate of S': the honest seats' signatures over S' plus its own
  const S2 = sig(R).seated;
  const certS2 = encodeSeatingCertificate({ roundId: rid, role: 'settlement', seated: S2.map(keyOf), signatures: S2.map((k) => ({ nodePubkey: keyOf(k), signature: Uint8Array.from(Buffer.from(sig(idx(k)).signature, 'hex')) })) });
  const tookS2 = honest.map((i) => net.agents.get(i).keepCert(rid, 'settlement', certS2));
  const voided = honest.filter((i) => net.agents.get(i).equivocationOf(rid).length);
  assert.equal(voided.length, 0, `S=${S.map(idx).join('')} taken: ${JSON.stringify(tookS.map((x) => x.kept))}; S'=${S2.map(idx).join('')}: ${JSON.stringify(tookS2[0])}; `
    + `honest seat(s) ${voided.join(',')} hold an equivocation by their own members and void a round that took entries`);
});
