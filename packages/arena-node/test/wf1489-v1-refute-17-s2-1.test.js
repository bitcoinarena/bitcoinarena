// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 r1 census-1 (P4): ONE drawn seat that hands out its PRESENT and answers every request, but never signs (or never hands
// out) its seating signature, must not leave the round without a certificate. A seating stands only with the signature of EVERY
// node it seats; silentOf/answeringOf (#979) replaces only a node that cannot be reached. A seat that answers but withholds its
// signature stays seated in every honest seat's seating, no certificate forms by the start, and the round takes no entries.
// Safe behaviour: by the round's start, the honest seats hold a certificate (the withholding node replaced by a reserve).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { schnorr } from '@noble/curves/secp256k1.js';
import { seatingAgent } from '../src/seating-agent.js';
import { encodeRoundContract, roundId as roundIdOf } from '../../arena-protocol/src/contracts.js';
import { decodeSeatingCertificate } from '../../arena-protocol/src/seating.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { contractFor } from './window-fixture.js';

const nodes = Array.from({ length: 9 }, (_, i) => { const secret = new Uint8Array(32).fill(i + 1); return { secret, pubkey: schnorr.getPublicKey(secret), endpoint: `http://seat-${i}` }; });
const signer = (n) => (m) => schnorr.sign(m, n.secret);
const START = 60500n;
const NOW = Number(START) - 150000;
const BAD = 1;   // drawn and seated by score; present; never hands out its seating signature
const BAD2 = 7;  // the first reserve, colluding: present, answers, never signs either

// wf1489 v1 refute-17-s2-1 (#1509): a withholding seated member plus a withholding FIRST RESERVE (a second, colluding peer). resign() leaves out only the
// withholders of the present seating, so after the move to S' (reserve in) the reserve is the withholder, the seating of the PRESENTs less it seats the
// first withholder again: the honest seats swing S -> S' -> S every 30 s and no certificate forms, though 7 honest PRESENTs fill the 7 seats.
test('wf1489 v1 refute-17-s2-1: a withholder and a withholding first reserve still leave the round uncertified', async () => {
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
      if (to === BAD || to === BAD2) for (const r of Object.values(j.rounds)) { r.sig = { game: null, settlement: null }; r.cert = { game: null, settlement: null }; }
      return new Response(JSON.stringify(j), { status: 200 });
    }
    if (u.pathname === '/seating') {
      if (to === BAD || to === BAD2) return new Response('ok', { status: 201 });
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
  const tickAll = async (times, all = false) => { for (let k = 0; k < times; k++) for (const [i, a] of net.agents) if (all || (i !== BAD && i !== BAD2)) await a.tick(); };
  await tickAll(2, true);                                   // PRESENTs exchanged before the close
  // from the close to just before the start, every 5 s
  for (let t = Number(START - 120000n) + 1000; t < Number(START); t += 5000) { net.now = t; await tickAll(1); }
  const honest = [0, 2, 3, 4, 5, 6, 8];
  const held = honest.filter((i) => net.agents.get(i).certOf(rid, 'settlement'));
  const seatedBad = net.agents.get(0).mySignature(rid, 'settlement');
  const roles = honest.map((i) => { const m = net.agents.get(i).mySignature(rid, 'settlement'); return m ? m.seated.map((k) => nodes.findIndex((n) => toHex(n.pubkey) === k)).join('') : '-'; });
  assert.ok(held.length > 0, `signed: ${roles.join(' ')}; ` +
    `no honest seat holds a settlement certificate at the start: every honest seat still signs a seating with node ${BAD} in it `
    + `(${seatedBad ? seatedBad.seated.map((k) => nodes.findIndex((n) => toHex(n.pubkey) === k)).join(',') : 'none'}) - one withholding seat leaves the round with no entries`);
});
