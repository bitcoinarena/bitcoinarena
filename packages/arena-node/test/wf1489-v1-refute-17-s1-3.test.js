// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1681, #1741 (wf1489 v1 refute-17): of two certificates where one is the other less a withholding member, the next reserve in, the replacement
// stands at every seat whichever came first - and a pair of any other shape is still equivocation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { schnorr } from '@noble/curves/secp256k1.js';
import { seatingAgent } from '../src/seating-agent.js';
import { encodeRoundContract, roundId as roundIdOf } from '../../arena-protocol/src/contracts.js';
import { signSeating, encodeSeatingCertificate } from '../../arena-protocol/src/seating.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { contractFor } from './window-fixture.js';

const nodes = Array.from({ length: 9 }, (_, i) => { const secret = new Uint8Array(32).fill(i + 1); return { secret, pubkey: schnorr.getPublicKey(secret), endpoint: `http://seat-${i}` }; });
const c = { ...contractFor(nodes.slice(0, 7).map((n) => n.pubkey)), startTimeMs: 60500n };
const bytes = encodeRoundContract(c);
const rid = roundIdOf(c);
const drawn = nodes.map((n) => ({ pubkey: n.pubkey, advert: { endpoint: n.endpoint } }));
const certOf = (pos) => { const seated = pos.map((i) => nodes[i].pubkey);
  return encodeSeatingCertificate({ roundId: rid, role: 'settlement', seated, signatures: pos.map((i) => ({ nodePubkey: nodes[i].pubkey, signature: signSeating({ roundId: rid, role: 'settlement', seated }, (m) => schnorr.sign(m, nodes[i].secret)) })) }); };
const agentOf = ({ entries = 0 } = {}) => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE rounds (round_id BLOB, contract BLOB)');
  db.prepare('INSERT INTO rounds (round_id, contract) VALUES (?, ?)').run(rid, bytes);
  const seated = [];
  const round = { db, pubkey: nodes[0].pubkey, get: (id) => (toHex(id) === toHex(rid) ? { contract: bytes } : null), entriesOf: () => Array.from({ length: entries }) };
  const agent = seatingAgent({ round, roster: { committeeFor: () => ({ ok: true, drawn }) }, sign: (m) => schnorr.sign(m, nodes[0].secret), fetcher: async () => new Response('no', { status: 404 }),
    nowMs: () => 0, onSeated: (r, role, s, _c, o = {}) => seated.push({ s: s.map(toHex), replaced: !!o.replaced }), verify: (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } } });
  return { agent, seated };
};
const S = certOf([0, 1, 2, 3, 4, 5, 6]);          // the old seating, the withholder 1 in it
const S2 = certOf([0, 2, 3, 4, 5, 6, 7]);         // 1 left out, the reserve 7 in

test('#1681: the replacement held first - the old seating coming after is refused, no equivocation', () => {
  const { agent } = agentOf();
  assert.equal(agent.keepCert(rid, 'settlement', S2).kept, true);
  const r = agent.keepCert(rid, 'settlement', S);
  assert.equal(r.ok, false); assert.equal(r.superseded, true);
  assert.equal(agent.equivocationOf(rid).length, 0);
  assert.equal(agent.certOf(rid, 'settlement'), toHex(S2));
});

test('#1681: the old seating held first - the replacement takes its place, and the seats are written in again', () => {
  const { agent, seated } = agentOf();
  agent.keepCert(rid, 'settlement', S);
  const r = agent.keepCert(rid, 'settlement', S2);
  assert.deepEqual(r, { ok: true, kept: true, replaced: true });
  assert.equal(agent.equivocationOf(rid).length, 0);
  assert.equal(agent.certOf(rid, 'settlement'), toHex(S2));
  assert.deepEqual(agent.stateOf(rid).settlement.seated, [0, 2, 3, 4, 5, 6, 7].map((i) => toHex(nodes[i].pubkey)));
  assert.equal(seated.at(-1).replaced, true);
  assert.equal(agent.keepCert(rid, 'settlement', S).superseded, true);
});

test('#1681: once the round has entries the held certificate is not replaced - two seatings are equivocation, as before', () => {
  const { agent } = agentOf({ entries: 1 });
  agent.keepCert(rid, 'settlement', S);
  assert.equal(agent.keepCert(rid, 'settlement', S2).equivocation, true);
  assert.equal(agent.equivocationOf(rid).length, 1);
});

test('#1681: two seatings of any other shape are still equivocation', () => {
  const { agent } = agentOf();
  agent.keepCert(rid, 'settlement', certOf([0, 1, 2, 3, 4, 5, 7]));
  const r = agent.keepCert(rid, 'settlement', certOf([0, 2, 3, 4, 5, 6, 7]));   // leaves out 1 but takes in 6, which ranks before 7
  assert.equal(r.equivocation, true);
  assert.equal(agent.stateOf(rid).settlement.equivocated, true);
});
