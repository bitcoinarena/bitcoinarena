// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 r6 census-1 (P6 / P4): ONE seated member voids a round and makes the honest seats look like equivocators, through the
// ordered re-sign (#738) after a silent-but-present node (#979) - not the withhold path (#1509, known).
//
// X (node 1) is drawn and present - its PRESENT reached every seat - but the honest seats cannot reach it (#979: two failed requests),
// so each honest seat signs S, the seating of the PRESENTs held less X. M (node 2, the attacker, a member of S) reaches X, so its own
// seating is T (X in). M first reads every honest seat's signature over S (GET /seating-batch hands it out), then signs T. That is the
// #738 trigger: a member of S signed a seating not before S, so every honest member re-signs T, and T's certificate forms. M then signs
// S as well and hands out S's certificate - every member of S signed S - and every honest seat records "two seatings - equivocation":
// the round is void and the honest signers' keys are named as equivocators (slashable, §5A.3B).
// Safe behaviour: a certificate stands at the honest seats and the round is not void after one member's late second signature.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { schnorr } from '@noble/curves/secp256k1.js';
import { seatingAgent } from '../src/seating-agent.js';
import { encodeRoundContract, roundId as roundIdOf } from '../../arena-protocol/src/contracts.js';
import { decodeSeatingCertificate, encodeSeatingCertificate, signSeating } from '../../arena-protocol/src/seating.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { contractFor } from './window-fixture.js';

const nodes = Array.from({ length: 9 }, (_, i) => { const secret = new Uint8Array(32).fill(i + 1); return { secret, pubkey: schnorr.getPublicKey(secret), endpoint: `http://seat-${i}` }; });
const signer = (n) => (m) => schnorr.sign(m, n.secret);
const START = 60500n;
const CLOSE = Number(START - 120000n);
const X = 1;      // present, unreachable for the honest seats
const M = 2;      // the attacker: a seated member

test('wf1489 r6 census-1: one member\'s late signature over the seating it made the others leave does not void the round', async () => {
  const c = { ...contractFor(nodes.slice(0, 7).map((n) => n.pubkey)), startTimeMs: START };
  const bytes = encodeRoundContract(c);
  const rid = roundIdOf(c);
  const drawn = nodes.map((n) => ({ pubkey: n.pubkey, advert: { endpoint: n.endpoint } }));
  const net = { now: CLOSE - 60000 + 500, agents: new Map(), mSilentSig: true };
  const fetcherOf = (from) => async (url, init = {}) => {
    const u = new URL(url);
    const to = nodes.findIndex((n) => n.endpoint === `${u.protocol}//${u.host}`);
    // the honest seats cannot reach X; X and M reach everybody
    if (to === X && from !== M && from !== X) return new Response('bad gateway', { status: 502 });
    const a = net.agents.get(to);
    if (!a) return new Response('down', { status: 503 });
    if (u.pathname === '/presents') { const r = a.takePresents(new Uint8Array(await new Response(init.body).arrayBuffer())); return new Response(JSON.stringify(r), { status: r.ok ? 201 : 400 }); }
    if (u.pathname === '/seating-batch') return new Response(JSON.stringify(a.batchOf(u.searchParams.get('rounds').split(','))), { status: 200 });
    if (u.pathname === '/seating') {
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
  const tickAll = async (skip = []) => { for (const [i, a] of net.agents) if (!skip.includes(i)) await a.tick(); };
  // the PRESENT window: X pushes its PRESENT everywhere; the honest seats fail to reach X twice, 30 s apart (#979)
  await tickAll();
  net.now = CLOSE - 25000; await tickAll();
  // the close: every honest seat signs S (X left out as silent); M does not tick yet - it only reads the honest S signatures
  net.now = CLOSE + 1000; await tickAll([M]);
  const honest = [0, 3, 4, 5, 6, 7, 8];
  const role = 'settlement';
  const S = net.agents.get(0).mySignature(rid, role);
  assert.ok(S && !S.seated.includes(toHex(nodes[X].pubkey)) && S.seated.includes(toHex(nodes[M].pubkey)), 'setup: the honest seats sign S, without X, with M');
  const sSigs = new Map();
  for (const i of honest) { const m = net.agents.get(i).mySignature(rid, role); if (m && m.seated.join() === S.seated.join()) sSigs.set(m.node, m.signature); }
  // now M runs its agent: it reaches X, so it signs T (X in) - the #738 trigger - and the honest seats move to T
  for (let t = CLOSE + 3000; t < CLOSE + 25000; t += 2000) { net.now = t; await tickAll(); }
  const held = honest.filter((i) => net.agents.get(i).certOf(rid, role));
  assert.ok(held.length > 0, 'setup: a certificate (T) stands at the honest seats');
  // M signs S as well, and hands S's certificate (every member of S signed it) to every honest seat
  const seated = S.seated.map(fromHex);
  const signatures = seated.map((k) => {
    const h = toHex(k);
    if (h === toHex(nodes[M].pubkey)) return { nodePubkey: k, signature: signSeating({ roundId: rid, role, seated }, signer(nodes[M])) };
    assert.ok(sSigs.has(h), `setup: M read ${h.slice(0, 8)}'s signature over S`);
    return { nodePubkey: k, signature: fromHex(sSigs.get(h)) };
  });
  const sCert = encodeSeatingCertificate({ roundId: rid, role, seated, signatures });
  const said = honest.map((i) => net.agents.get(i).keepCert(rid, role, sCert));
  const voided = honest.filter((i) => { const st = net.agents.get(i).stateOf(rid); return st[role] && st[role].equivocated; });
  assert.equal(voided.length, 0, `${voided.length} of ${honest.length} honest seats now hold "two seatings - equivocation" and take no entries for the round; `
    + `named as equivocators: ${(said.find((x) => x.signers) || { signers: [] }).signers.map((k) => nodes.findIndex((n) => toHex(n.pubkey) === k)).join(',')}`);
});
