// kanban #1489 a45 refute 5, skeptic 3 (#2321 / #2245 / #1812): the confirm read ends with the round's index, 10 min after the start.
// A seat that holds no certificate of a round until then (down or joined later; a long round is played and settled long after)
// is handed M's superseded S by POST /seating (open to anyone), keeps it, refuses the honest T by #1707 and is never read again.
// Original header of the s2 fixture follows:
// kanban #1489 a45 refute 5, skeptic 2 (#1812 / #2245): the confirm read that lets a seat move from a superseded S to the T most drawn seats
// hold runs only BEFORE THE START (tick: `certified && (late || ...) continue`). A seat that holds no certificate at the start - restarted,
// joined or busy until then, drawn or not - and is handed M's S certificate first (POST /seating is open to anyone: a stranger relays it)
// keeps S, refuses T after it (#1707 "the seating held stands"), and is never read again: it seats S for good while every honest seat seats T.
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


test('a45 refute 5 s3-1: a seat handed S 11 min after the start (out of the index) seats S for good while every honest seat seats T', async () => {
  const { net, rid, sCert, tCert, mk, tickAll } = await setup();
  await runOn(net, tickAll, CLOSE + 26000, Number(START) + 1000);
  const late = mk(9);                      // a seat that comes up, or joins, 11 min into a long round: nothing held, the round not in its index
  net.agents.set(9, late);
  net.now = Number(START) + 660000;
  const first = late.keepCert(rid, role, sCert());          // M (or a stranger) POSTs S first
  const then = late.keepCert(rid, role, certBytes(tCert));  // the honest T after it
  await runOn(net, tickAll, Number(START) + 662000, Number(START) + 780000, 4000);
  assert.deepEqual(seatedOf(late, rid), net.agents.get(0).stateOf(rid)[role].seated.map(idx),
    `S ${JSON.stringify(first)}, T ${JSON.stringify(then)}: the seat seats ${seatedOf(late, rid)}, the honest seats ${net.agents.get(0).stateOf(rid)[role].seated.map(idx)}`);
});

test('a45 refute 5 s3-2: a drawn seat down for 12 min across the close and start, handed S when it is back, seats S for good', async () => {
  const { net, rid, sCert, mk, tickAll } = await setup({ down: [8] });
  await runOn(net, tickAll, CLOSE + 26000, Number(START) + 1000);
  const back = mk(8);
  net.now = Number(START) + 600500;
  back.keepCert(rid, role, sCert());
  net.agents.set(8, back);
  await runOn(net, tickAll, Number(START) + 602000, Number(START) + 720000, 4000);
  assert.deepEqual(seatedOf(back, rid), net.agents.get(0).stateOf(rid)[role].seated.map(idx),
    `seat 8 seats ${seatedOf(back, rid)} while seat 0 seats ${net.agents.get(0).stateOf(rid)[role].seated.map(idx)}`);
});

test('a45 refute 5 s3-3 (honest path): a seat that takes T 11 min after the start keeps T', async () => {
  const { net, rid, tCert, mk, tickAll } = await setup();
  await runOn(net, tickAll, CLOSE + 26000, Number(START) + 1000);
  const late = mk(9); net.agents.set(9, late);
  net.now = Number(START) + 660000;
  assert.ok(late.keepCert(rid, role, certBytes(tCert)).ok);
  await runOn(net, tickAll, Number(START) + 662000, Number(START) + 700000, 4000);
  assert.deepEqual(seatedOf(late, rid), net.agents.get(0).stateOf(rid)[role].seated.map(idx));
});
