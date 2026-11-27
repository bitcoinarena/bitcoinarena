// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// wf1489 r20 census-41 (P4 one of k-of-n blocks all, P2 counted before verified; gap in #2245 / #2360 confirmRead): the confirm read counts
// the drawn seats' certificates by their SEATED LIST, decoded and never verified, and hands keepCert the bytes of the FIRST answer with that
// list. One drawn seat M that answers its GET /seating-batch with the honest majority's seating T but junk signatures (listed before the
// honest holders in draw order, or the ones before it unreachable) makes every confirm read pass M's bytes to keepCert: refused ("does not
// verify"), and the read returns. A seat that was handed M's superseded S first never moves to the T every honest seat holds - the #2245 split,
// for good, by one seat's unsigned bytes.
// SAFE: a seat handed S first ends on the T the honest drawn seats hold, whatever junk one drawn seat answers under T's seated list.
// Fixture: wf1489-a45-refute-5-s3-1.test.js (M = node 2 the withholder, X = node 1 unreachable); seat 0 is not reachable from the late seat 9.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { schnorr } from '@noble/curves/secp256k1.js';
import { seatingAgent } from '../src/seating-agent.js';
import { encodeRoundContract, roundId as roundIdOf } from '../../arena-protocol/src/contracts.js';
import { decodeSeatingCertificate, encodeSeatingCertificate, signSeating } from '../../arena-protocol/src/seating.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { contractFor } from './window-fixture.js';

const nodes = Array.from({ length: 10 }, (_, i) => { const secret = new Uint8Array(32).fill(i + 1); return { secret, pubkey: schnorr.getPublicKey(secret), endpoint: `http://seat-${i}` }; });
const signer = (n) => (m) => schnorr.sign(m, n.secret);
const START = 60500n;
const CLOSE = Number(START - 120000n);
const X = 1, M = 2;
let honest = [0, 3, 4, 5, 6, 7, 8];
const role = 'settlement';
const idx = (k) => nodes.findIndex((n) => toHex(n.pubkey) === k);

async function setup({ beforeTick = null, down = [] } = {}) {
  const c = { ...contractFor(nodes.slice(0, 7).map((n) => n.pubkey)), startTimeMs: START };
  const bytes = encodeRoundContract(c);
  const rid = roundIdOf(c);
  const drawn = nodes.slice(0, 9).map((n) => ({ pubkey: n.pubkey, advert: { endpoint: n.endpoint } }));
  const net = { now: CLOSE - 60000 + 500, agents: new Map() };
  const fetcherOf = (from) => async (url, init = {}) => {
    const u = new URL(url);
    const to = nodes.findIndex((n) => n.endpoint === `${u.protocol}//${u.host}`);
    if (to === X && from !== M && from !== X) return new Response('bad gateway', { status: 502 });
    if (from === 9 && to === 0) return new Response('bad gateway', { status: 502 });
    const a = net.agents.get(to);
    if (!a) return new Response('down', { status: 503 });
    // M's door to the late seat: the honest T's seated list, junk signatures
    if (from === 9 && to === M && u.pathname === '/seating-batch' && net.junkT) {
      const j = a.batchOf(u.searchParams.get('rounds').split(','));
      for (const k of Object.keys(j.rounds || {})) j.rounds[k] = { ...j.rounds[k], cert: { ...(j.rounds[k].cert || {}), [role]: net.junkT } };
      return new Response(JSON.stringify(j), { status: 200 });
    }
    if (u.pathname === '/presents') { const r = a.takePresents(new Uint8Array(await new Response(init.body).arrayBuffer())); return new Response(JSON.stringify(r), { status: r.ok ? 201 : 400 }); }
    if (u.pathname === '/seating-batch') return new Response(JSON.stringify(a.batchOf(u.searchParams.get('rounds').split(','))), { status: 200 });
    if (u.pathname === '/seating') {
      const b = new Uint8Array(await new Response(init.body).arrayBuffer()); const r = a.keepCert(rid, decodeSeatingCertificate(b).role, b);
      return new Response(JSON.stringify(r), { status: r.ok ? 201 : 409 });
    }
    return new Response('no', { status: 404 });
  };
  const mk = (i) => {
    const n = nodes[i];
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE rounds (round_id BLOB, contract BLOB)');
    db.prepare('INSERT INTO rounds (round_id, contract) VALUES (?, ?)').run(rid, bytes);
    const round = { db, pubkey: n.pubkey, get: (id) => (toHex(id) === toHex(rid) ? { contract: bytes } : null) };
    return seatingAgent({ round, roster: { committeeFor: () => ({ ok: true, drawn }) }, sign: signer(n), fetcher: fetcherOf(i), nowMs: () => net.now,
      verify: (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } } });
  };
  for (let i = 0; i < 9; i++) if (!down.includes(i)) net.agents.set(i, mk(i));
  const tickAll = async (skip = []) => { for (const [i, a] of net.agents) if (!skip.includes(i)) await a.tick(); };
  await tickAll();
  net.now = CLOSE - 25000; await tickAll();
  net.now = CLOSE + 1000; await tickAll([M]);
  const S = net.agents.get(0).mySignature(rid, role);
  const sSigs = new Map();
  for (const i of honest) { if (!net.agents.has(i)) continue; const m = net.agents.get(i).mySignature(rid, role); if (m && m.seated.join() === S.seated.join()) sSigs.set(m.node, m.signature); }
  const seated = S.seated.map(fromHex);
  const sCert = () => encodeSeatingCertificate({ roundId: rid, role, seated, signatures: seated.map((k) => {
    const h = toHex(k);
    if (h === toHex(nodes[M].pubkey)) return { nodePubkey: k, signature: signSeating({ roundId: rid, role, seated }, signer(nodes[M])) };
    return { nodePubkey: k, signature: fromHex(sSigs.get(h)) };
  }) });
  for (let t = CLOSE + 3000; t < CLOSE + 25000; t += 2000) { net.now = t; if (beforeTick) await beforeTick({ net, rid, S, sCert }); await tickAll(); }
  const tHolder = honest.find((i) => net.agents.has(i) && net.agents.get(i).certOf(rid, role));
  return { net, rid, S, sCert, mk, tickAll, tCert: tHolder !== undefined ? net.agents.get(tHolder).certOf(rid, role) : null, tHolder };
}
const certBytes = (x) => (x instanceof Uint8Array ? x : typeof x === 'string' ? fromHex(x) : x && x.cert ? (typeof x.cert === 'string' ? fromHex(x.cert) : new Uint8Array(x.cert)) : new Uint8Array(x));

const seatedOf = (a, rid) => { const st = a.stateOf(rid)[role]; return (st && st.seated || []).map(idx); };
const runOn = async (net, tickAll, from, to, step = 2000) => { for (let t = from; t < to; t += step) { net.now = t; await tickAll(); } };


test('r20 census-41: one drawn seat answering T\'s seated list with junk signatures keeps a seat on the superseded S for good', async () => {
  const { net, rid, sCert, tCert, mk, tickAll } = await setup();
  await runOn(net, tickAll, CLOSE + 26000, Number(START) + 1000);
  const t = decodeSeatingCertificate(certBytes(tCert));
  net.junkT = toHex(encodeSeatingCertificate({ roundId: t.roundId, role, seated: t.seated, signatures: t.seated.map((k) => ({ nodePubkey: k, signature: new Uint8Array(64).fill(7) })) }));
  const late = mk(9);
  net.agents.set(9, late);
  net.now = Number(START) + 660000;
  const first = late.keepCert(rid, role, sCert());          // M (or a stranger relaying it) POSTs S first
  await runOn(net, tickAll, Number(START) + 662000, Number(START) + 900000, 4000);
  const honestSeated = net.agents.get(3).stateOf(rid)[role].seated.map(idx);
  console.log(`  FACTS: S kept ${JSON.stringify(first)}; T seats [${t.seated.map((k) => idx(toHex(k)))}]; late seat 9 seats [${seatedOf(late, rid)}], honest seat 3 seats [${honestSeated}]`);
  assert.deepEqual(seatedOf(late, rid), honestSeated, `the late seat seats ${seatedOf(late, rid)} while the honest seats seat ${honestSeated}`);
});

test('r20 census-41 (control): with M answering honestly the late seat moves from S to T', async () => {
  const { net, rid, sCert, mk, tickAll } = await setup();
  await runOn(net, tickAll, CLOSE + 26000, Number(START) + 1000);
  const late = mk(9); net.agents.set(9, late);
  net.now = Number(START) + 660000;
  late.keepCert(rid, role, sCert());
  await runOn(net, tickAll, Number(START) + 662000, Number(START) + 900000, 4000);
  assert.deepEqual(seatedOf(late, rid), net.agents.get(3).stateOf(rid)[role].seated.map(idx));
});
