// kanban #1489 a45 refute 5 (#1812): the superseded-certificate fix holds only in one order of arrival.
// #1812 refuses a certificate for seating S when the seat already holds T and S comes before T (#738). A seat that holds NO certificate yet
// - a seat that holds the round but was not drawn (any of the network's seats takes POST /seating), or a drawn seat that was down at the
// close - and gets M's late S certificate first keeps S; T arrives after and is refused ("the seating held stands", #1707), by POST /seating
// and by every gossip pass after. That seat seats S - X out, node 7 in - for good, while every honest seat seats T: one member splits the
// network's view of the round's committee with the same signatures #1812 calls superseded.
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


test('a45 refute 5-1: a seat with no certificate yet that gets the superseded S first seats S for good, while the honest seats seat T', async () => {
  const { net, rid, sCert, tCert, mk, tickAll } = await setup();
  const late = mk(9);       // a seat that holds the round, not drawn for it (POST /seating is open to anyone)
  net.agents.set(9, late);
  const first = late.keepCert(rid, role, sCert());
  const then = late.keepCert(rid, role, certBytes(tCert));
  for (let t = CLOSE + 26000; t < CLOSE + 60000; t += 4000) { net.now = t; await tickAll(); }
  const st = late.stateOf(rid)[role];
  const others = net.agents.get(0).stateOf(rid)[role].seated;
  assert.deepEqual(st && st.seated && st.seated.map(idx), others.map(idx), `S kept ${JSON.stringify(first)}, then T: ${JSON.stringify(then)}; `
    + `the late seat seats ${(st && st.seated || []).map(idx)} while the honest seats seat ${others.map(idx)}`);
});

test('a45 refute 5-2: a drawn seat down at the close that gets S first on its way back seats S, not the T every other seat holds', async () => {
  const { net, rid, sCert, mk, tickAll } = await setup({ down: [8] });
  const back = mk(8);
  back.keepCert(rid, role, sCert());     // M's POST /seating reaches it before the first gossip pass
  net.agents.set(8, back);
  for (let t = CLOSE + 26000; t < CLOSE + 60000; t += 4000) { net.now = t; await tickAll(); }
  const st = back.stateOf(rid)[role];
  const others = net.agents.get(0).stateOf(rid)[role].seated;
  assert.deepEqual(st && st.seated && st.seated.map(idx), others.map(idx), `seat 8 seats ${(st && st.seated || []).map(idx)} while seat 0 seats ${others.map(idx)}`);
});
