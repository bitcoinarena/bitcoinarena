import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { schnorr } from '@noble/curves/secp256k1.js';
import { seatingAgent } from '../src/seating-agent.js';
import { encodeRoundContract, roundId as roundIdOf } from '../../arena-protocol/src/contracts.js';
import { decodeSeatingCertificate, seatingId } from '../../arena-protocol/src/seating.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { contractFor } from './window-fixture.js';

const nodes = Array.from({ length: 9 }, (_, i) => { const secret = new Uint8Array(32).fill(i + 1); return { secret, pubkey: schnorr.getPublicKey(secret), endpoint: `http://seat-${i}` }; });
const signer = (n) => (m) => schnorr.sign(m, n.secret);
const START = 60500n;
const NOW = Number(START) - 150000;


const BAD = 1;
function setup({ dead = new Set(), badSeated, badNull = () => false }) {
  const c = { ...contractFor(nodes.slice(0, 7).map((n) => n.pubkey)), startTimeMs: START };
  const bytes = encodeRoundContract(c);
  const rid = roundIdOf(c);
  const drawn = nodes.map((n) => ({ pubkey: n.pubkey, advert: { endpoint: n.endpoint } }));
  const net = { now: NOW, agents: new Map(), dbs: new Map(), rid, bytes, drawn };
  const fetcherOf = () => async (url, init = {}) => {
    const u = new URL(url);
    const to = nodes.findIndex((n) => n.endpoint === `${u.protocol}//${u.host}`);
    const a = net.agents.get(to);
    if (!a || dead.has(to)) return new Response('down', { status: 503 });
    if (u.pathname === '/presents') { const r = a.takePresents(new Uint8Array(await new Response(init.body).arrayBuffer())); return new Response(JSON.stringify(r), { status: r.ok ? 201 : 400 }); }
    if (u.pathname === '/seating-batch') {
      const j = a.batchOf(u.searchParams.get('rounds').split(','));
      if (to === BAD) for (const r of Object.values(j.rounds)) {
        const seated = badSeated.map((i) => nodes[i].pubkey);
        const sigOf = (role) => (badNull() ? null : { node: toHex(nodes[BAD].pubkey), seated: seated.map(toHex), signature: toHex(schnorr.sign(seatingId({ roundId: rid, role, seated }), nodes[BAD].secret)) });
        r.sig = { game: sigOf('game'), settlement: sigOf('settlement') }; r.cert = { game: null, settlement: null };
      }
      return new Response(JSON.stringify(j), { status: 200 });
    }
    if (u.pathname === '/seating') {
      if (to === BAD) return new Response('ok', { status: 201 });
      const b = new Uint8Array(await new Response(init.body).arrayBuffer()); const r = a.keepCert(rid, decodeSeatingCertificate(b).role, b);
      return new Response(JSON.stringify(r), { status: r.ok ? 201 : 409 });
    }
    return new Response('no', { status: 404 });
  };
  net.boot = (i, fresh = true) => {
    const n = nodes[i];
    let db = net.dbs.get(i);
    if (fresh) {
      db = new DatabaseSync(':memory:');
      db.exec('CREATE TABLE rounds (round_id BLOB, contract BLOB)');
      db.prepare('INSERT INTO rounds (round_id, contract) VALUES (?, ?)').run(rid, bytes);
      net.dbs.set(i, db);
    }
    const round = { db, pubkey: n.pubkey, get: (id) => (toHex(id) === toHex(rid) ? { contract: bytes } : null) };
    net.agents.set(i, seatingAgent({ round, roster: { committeeFor: () => ({ ok: true, drawn }) }, sign: signer(n), fetcher: fetcherOf(i), nowMs: () => net.now,
      verify: (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } } }));
  };
  for (let i = 0; i < 9; i++) if (!dead.has(i)) net.boot(i);
  net.tickAll = async (times, all = false) => { for (let k = 0; k < times; k++) for (const [i, a] of net.agents) if (all || i !== BAD) await a.tick(); };
  net.report = (honest) => {
    const held = honest.filter((i) => net.agents.get(i).certOf(rid, 'settlement'));
    const roles = honest.map((i) => { const m = net.agents.get(i).mySignature(rid, 'settlement'); return `${i}:` + (m ? m.seated.map((k) => nodes.findIndex((n) => toHex(n.pubkey) === k)).join('') : '-'); });
    return { held, roles };
  };
  return net;
}

// VARIANT (restart): the bad seat 1 hands a valid signature over the first 5 drawn (the #1609 attack) until the honest seats kept it, then hands no
// signature at all. Honest seat 0 restarts (a deploy) inside WITHHELD_SIG_MS: seat_sigs still holds node 1's row, the seatings map that said it was
// over an earlier seating is gone, and withholdersOf counts "a seating not remembered here" as signing - so seat 0 never moves off 0123456, while the
// others move to 0234567, which then lacks seat 0's signature. No certificate by the start.
test('wf1489 a44 refute-3-2: an honest seat restarting after it kept an earlier-seating signature does not leave the round uncertified', async () => {
  let nul = false;
  const net = setup({ badSeated: [0, 1, 2, 3, 4], badNull: () => nul });
  const rid = net.rid;
  await net.tickAll(2, true);
  let n = 0;
  for (let t = Number(START - 120000n) + 1000; t < Number(START); t += 5000) {
    net.now = t; await net.tickAll(1);
    if (++n === 2) { nul = true; net.boot(0, false); }   // seat 0 restarts on its own store; the bad seat now hands no signature
  }
  const kept = net.dbs.get(0).prepare('SELECT COUNT(*) AS n FROM seat_sigs WHERE node = ?').get(toHex(nodes[BAD].pubkey)).n;
  const { held, roles } = net.report([0, 2, 3, 4, 5, 6, 7, 8]);
  assert.ok(held.length > 0, `seat 0 kept ${kept} sig row(s) of node 1; signed: ${roles.join(' ')}; no honest seat holds a settlement certificate at the start after one honest restart`);
});
