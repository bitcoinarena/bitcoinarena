// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// slash_presig with the seating (5A.3B, kanban #972): the node signs one per template-3 bond for the round's hold output, a seat refuses a seating without it, and a certificate carries them only
// when a seated node holds such a bond, byte for byte as before otherwise.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { schnorr } from '@noble/curves/secp256k1.js';
import { seatingAgent } from '../src/seating-agent.js';
import { tweakPoint } from '../src/curve.js';
import { encodeRoundContract, roundId as roundIdOf } from '../../arena-protocol/src/contracts.js';
import { checkSeatingPresigs, decodeSeatingCertificate, encodeSeatingCertificate, seatingId, signSeen, verifySeating, signSeatingBound } from '../../arena-protocol/src/seating.js';
import { holdClocksOf, presignedBond, roundPresigPlan, signSlashPresig, slashPresigVerifies, SLASH_PRESIG_HASH_TYPE } from '../../arena-protocol/src/slash-presig.js';
import { BOND_TEMPLATE_V3 } from '../../arena-protocol/src/bond-script.js';
import { drawPanels } from '../../arena-protocol/src/sortition.js';
import { NETWORK_ID_REGTEST } from '../../arena-protocol/src/genesis-ids.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { contractFor } from './window-fixture.js';

const nodes = Array.from({ length: 16 }, (_, i) => { const secret = new Uint8Array(32).fill(i + 1); return { secret, pubkey: schnorr.getPublicKey(secret), endpoint: `http://seat-${i}` }; });
const verify = (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } };
const censusKey = schnorr.getPublicKey(new Uint8Array(32).fill(0xc0));
const bondScript = (i) => Uint8Array.from([0x51, 0x20, ...new Uint8Array(32).fill(0x80 + i)]);
const contract = { ...contractFor([]), networkId: NETWORK_ID_REGTEST, protocolVersion: 25, startTimeMs: 60500n, gameVerifySlots: 7, settlementSlots: 7, bondMinSats: 1000n, censusMinNodes: 10, nodes: [] };

const entry = (n, i, template3) => ({ pubkey: n.pubkey, txid: new Uint8Array(32).fill(i + 1), vout: 0, height: 100, bondSats: 100000n, roles: ['game', 'settlement'], hostedGames: [contract.gameId],
  advert: { nodePubkey: n.pubkey, roles: ['game', 'settlement'], ...(template3 ? { bondScriptTemplateVersion: BOND_TEMPLATE_V3, censusKey, ownerPubkey: n.pubkey, bondMaturityHeight: 5000 } : { bondScriptTemplateVersion: 1 }) },
  ...(template3 ? { script: bondScript(i) } : {}) });
const seed = new Uint8Array(32).fill(0x33);
const plan4 = ({ entries, contract: c, committeeSeed, tweakPoint: t }) => roundPresigPlan({ entries, contract: c, panels: drawPanels({ entries, contract: c, committeeSeed }), tweakPoint: t });

test('the plan: one digest per template-3 bond, none for the others, none for a started bond, and a census with none draws nothing', () => {
  const entries = nodes.map((n, i) => entry(n, i, i < 3));
  const got = plan4({ entries, contract, committeeSeed: seed, tweakPoint });
  assert.equal(got.why, undefined);
  const { plan, panels } = got;
  assert.equal(plan.size, 3);
  assert.equal(plan.get(toHex(nodes[0].pubkey)).length, 1);
  assert.ok(panels.n >= 3, 'this census has panels');
  const noneAtAll = plan4({ entries: nodes.map((n, i) => entry(n, i, false)), contract, committeeSeed: seed, tweakPoint });
  assert.equal(noneAtAll.plan.size, 0);
  assert.equal(noneAtAll.panels, undefined, 'no panels were drawn');
  const started = { ...entries[0], hold: { txid: 'aa', vout: 0, height: 120 } };
  assert.equal(presignedBond(started), false);
  // the hold is the round's: another seed, other panels, another digest
  const other = plan4({ entries, contract, committeeSeed: new Uint8Array(32).fill(0x44), tweakPoint });
  assert.notEqual(toHex(other.plan.get(toHex(nodes[0].pubkey))[0].digest), toHex(plan.get(toHex(nodes[0].pubkey))[0].digest));
});

test('a hold depends on a round only through its panels: rounds of one draw, so a table\'s, and the two roles of a round share one presig', () => {
  const entries = nodes.map((n, i) => entry(n, i, i < 2));
  const one = plan4({ entries, contract, committeeSeed: seed, tweakPoint });
  const later = plan4({ entries, contract: { ...contract, roundIndex: 40, startTimeMs: contract.startTimeMs + 320000n }, committeeSeed: seed, tweakPoint });
  const [a] = one.plan.get(toHex(nodes[0].pubkey)), [b] = later.plan.get(toHex(nodes[0].pubkey));
  assert.equal(toHex(a.digest), toHex(b.digest));
});

test('a presig is 65 bytes, ends in 0x83, and verifies only over its own digest under its own key', () => {
  const entries = nodes.map((n, i) => entry(n, i, i < 2));
  const { plan } = plan4({ entries, contract, committeeSeed: seed, tweakPoint });
  const [a] = plan.get(toHex(nodes[0].pubkey)), [b] = plan.get(toHex(nodes[1].pubkey));
  const sig = signSlashPresig(a.digest, (d) => schnorr.sign(d, nodes[0].secret));
  assert.equal(sig.length, 65);
  assert.equal(sig[64], SLASH_PRESIG_HASH_TYPE);
  assert.equal(slashPresigVerifies(sig, a.digest, nodes[0].pubkey, verify), true);
  assert.equal(slashPresigVerifies(sig, b.digest, nodes[0].pubkey, verify), false);
  assert.equal(slashPresigVerifies(sig, a.digest, nodes[1].pubkey, verify), false);
  const other = sig.slice(); other[64] = 0x01;
  assert.equal(slashPresigVerifies(other, a.digest, nodes[0].pubkey, verify), false);
});

const certBase = () => {
  const roundId = new Uint8Array(32).fill(9), role = 'settlement', seated = nodes.slice(0, 7).map((n) => n.pubkey);
  const of = (k) => nodes.find((n) => toHex(n.pubkey) === toHex(k));
  const seating = seatingId({ roundId, role, seated });
  return { roundId, role, seated, signatures: seated.map((k) => ({ nodePubkey: k, signature: signSeatingBound({ roundId, role, seated }, (m) => schnorr.sign(m, of(k).secret)) })),
    seen: [{ present: seated, leftOut: [], signatures: seated.map((k) => ({ nodePubkey: k, signature: signSeen({ roundId, role, seating, present: seated, leftOut: [] }, (m) => schnorr.sign(m, of(k).secret)) })) }] };
};

test('the certificate: no presigs is the old bytes; presigs read back with no justification; checkSeatingPresigs takes only what the round asks', () => {
  const base = certBase(), plain = encodeSeatingCertificate(base);
  assert.equal(toHex(encodeSeatingCertificate({ ...base, presigs: [] })), toHex(plain), 'a seating with no template-3 bond is byte for byte as before');
  const entries = nodes.map((n, i) => entry(n, i, i < 2));
  const { plan } = plan4({ entries, contract, committeeSeed: seed, tweakPoint });
  const presigs = [0, 1].map((i) => { const [b] = plan.get(toHex(nodes[i].pubkey)); return { nodePubkey: nodes[i].pubkey, txid: fromHex(b.txid), vout: b.vout, signature: signSlashPresig(b.digest, (d) => schnorr.sign(d, nodes[i].secret)) }; });
  const bytes = encodeSeatingCertificate({ ...base, presigs });
  const c = decodeSeatingCertificate(bytes);
  assert.equal(c.justifications, null);
  assert.equal(c.presigs.length, 2);
  assert.equal(toHex(encodeSeatingCertificate(c)), toHex(bytes), 'POST /seating re-encodes what it read');
  // the client's check reads past them
  const check = { roundId: base.roundId, role: base.role, drawn: base.seated, slots: 7, verify, listsPresent: true };
  assert.equal(verifySeating(bytes, check).ok, true);
  const stands = (s, d, k) => slashPresigVerifies(s, d, k, verify);
  assert.equal(checkSeatingPresigs(c, plan, stands).ok, true);
  assert.match(checkSeatingPresigs(decodeSeatingCertificate(plain), plan, stands).why, /gave no slash_presig/);
  const bad = { ...c, presigs: c.presigs.map((p, i) => (i ? p : { ...p, signature: c.presigs[1].signature })) };
  assert.match(checkSeatingPresigs(bad, plan, stands).why, /does not verify/);
  assert.match(checkSeatingPresigs({ ...c, presigs: [...c.presigs].reverse() }, plan, stands).why, /sorted/);
  assert.match(checkSeatingPresigs(c, new Map([[toHex(nodes[0].pubkey), plan.get(toHex(nodes[0].pubkey))]]), stands).why, /does not ask/);
});

// two seats, the agent's own path: each signs its seating with its presig, and a signature with a bad presig is not counted
function seat(me, plan, peers, drawn) {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE rounds (round_id BLOB, contract BLOB)');
  const c = { ...contract }, bytes = encodeRoundContract(c), rid = roundIdOf(c);
  db.prepare('INSERT INTO rounds (round_id, contract) VALUES (?, ?)').run(rid, bytes);
  const round = { db, pubkey: me.pubkey, get: (id) => (toHex(id) === toHex(rid) ? { contract: bytes } : null) };
  const fetcher = async (url, init = {}) => {
    const u = new URL(url), to = peers.get(u.host);
    if (init.method === 'POST' && u.pathname === '/presents') { const b = new Uint8Array(init.body); for (let i = 0; i < b.length; i += 132) to?.agent.takePresent(b.slice(i, i + 132)); return new Response('{}'); }
    if (init.method === 'POST' && u.pathname === '/seating') { if (!to?.deaf) to?.agent.keepCert(rid, decodeSeatingCertificate(new Uint8Array(init.body)).role, new Uint8Array(init.body)); return new Response('{}'); }
    if (u.pathname === '/seating-batch') { const j = to ? to.agent.batchOf([toHex(rid)]) : { rounds: {} }; return new Response(JSON.stringify(to?.tamper ? to.tamper(j) : j)); }
    return new Response('', { status: 404 });
  };
  const agent = seatingAgent({ round, roster: { committeeFor: () => ({ ok: true, drawn }) }, sign: (m) => schnorr.sign(m, me.secret), verify, fetcher, nowMs: () => seat.now, holdsOf: () => ({ ok: true, plan }) });
  return { agent, rid, db };
}

test('through the agent: each seated node hands its presig with its signature, the certificate carries them, and a bad one stops the seating', async () => {
  const few = nodes.slice(0, 2);
  const c = { ...contract, gameVerifySlots: 2, settlementSlots: 2 };
  Object.assign(contract, c);
  const entries = nodes.map((n, i) => entry(n, i, i < 2));
  const { plan } = plan4({ entries, contract, committeeSeed: seed, tweakPoint });
  const drawn = few.map((n) => ({ pubkey: n.pubkey, advert: { endpoint: n.endpoint } }));
  for (const tamper of [null, (j) => { for (const r of Object.values(j.rounds)) r.cert = {}; for (const r of Object.values(j.rounds)) for (const sig of Object.values(r.sig)) if (sig && sig.presigs) sig.presigs[0].signature = sig.presigs[0].signature.replace(/^../, '00'); return j; }]) {
    const peers = new Map();
    const a = seat(few[0], plan, peers, drawn), b = seat(few[1], plan, peers, drawn);
    peers.set('seat-0', { ...a, deaf: !!tamper }); peers.set('seat-1', { ...b, tamper });
    seat.now = Number(contract.startTimeMs) - 150000;
    await a.agent.tick(); await b.agent.tick();
    seat.now = Number(contract.startTimeMs) - 100000;
    for (let i = 0; i < 4; i++) { await a.agent.tick(); await b.agent.tick(); }
    const cert = a.agent.certOf(a.rid, 'settlement');
    if (tamper) {
      assert.equal(cert, null, 'a seat does not count a signature whose presig is bad, so it builds no certificate');
      assert.equal(a.db.prepare('SELECT COUNT(*) AS n FROM seat_sigs WHERE node = ?').get(toHex(few[1].pubkey)).n, 0);
      continue;
    }
    assert.ok(cert, 'a certificate formed');
    const d = decodeSeatingCertificate(fromHex(cert));
    assert.equal(d.presigs.length, 2);
    const held = a.agent.presigOf({ rid: a.rid, txid: toHex(entries[1].txid), vout: 0 });
    assert.equal(held.node, toHex(few[1].pubkey));
    assert.equal(slashPresigVerifies(fromHex(held.signature), plan.get(held.node)[0].digest, few[1].pubkey, verify), true);
    assert.equal(a.agent.presigOf({ txid: toHex(entries[1].txid), vout: 0 }).signature, held.signature, 'with no round: the newest');
    // a certificate that comes from elsewhere with a member's presig missing is refused at the other seat
    const third = seat(few[0], plan, new Map(), drawn);
    third.db.exec('DELETE FROM seat_certs');
    const stripped = encodeSeatingCertificate({ ...d, presigs: d.presigs.slice(1) });
    assert.match(third.agent.keepCert(third.rid, 'settlement', stripped).why || '', /gave no slash_presig/);
  }
});

test('holdClocksOf reads the network', () => {
  assert.deepEqual(holdClocksOf(NETWORK_ID_REGTEST), { holdBlocks: 1, returnBlocks: 36, fallbackBlocks: 24 });
});
