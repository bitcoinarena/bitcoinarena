// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// wf1489 v1 refute-17-s3-2 (#1681, #1741 replacement in keepCert, fa5f7cde4): "the replacement takes the held one's place WHILE THE ROUND HAS NO
// ENTRIES" is asked of the seating's own round only. A table is seated by its first round (pick (c)), and its later rounds take the entries; the
// second copy of that rule (seatedAt, kanban #1020: "a round with entries keeps the seats it had when they came: a later seating does not move money
// already on the table") is not asked either. So a replacement certificate that arrives after round 5 of the table took entries under S moves
// round 5 to S' - the stake already dealt to S's signer nodes is now settled by another committee (and server.js seatTable writes S' into it).
// Safe behaviour: a round of the table with entries keeps the seats it had when they came.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { schnorr } from '@noble/curves/secp256k1.js';
import { seatingAgent } from '../src/seating-agent.js';
import { encodeRoundContract, roundId as roundIdOf } from '../../arena-protocol/src/contracts.js';
import { signSeating, encodeSeatingCertificate } from '../../arena-protocol/src/seating.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { contractFor } from './window-fixture.js';

const nodes = Array.from({ length: 9 }, (_, i) => { const secret = new Uint8Array(32).fill(i + 1); return { secret, pubkey: schnorr.getPublicKey(secret), endpoint: `http://seat-${i}` }; });
const RPS_V2 = fromHex('a75f54fd4f978a29ab6d39d9ef85c7adbe0576614634c679ae33d3e1c06164ea');
const START = 60500n;

test('wf1489 v1 refute-17-s3-2: a replacement certificate moves a later table round that already took entries', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE rounds (round_id BLOB, contract BLOB)');
  const series = new Uint8Array(32).fill(0x5e);
  const base = { ...contractFor([]), gameId: RPS_V2, protocolVersion: 2, seriesId: series, nodes: [], gameVerifySlots: 7, settlementSlots: 7 };
  const c0 = { ...base, roundIndex: 0, startTimeMs: START }, c5 = { ...base, roundIndex: 5, startTimeMs: START + 40000n };
  const rows = new Map();
  for (const c of [c0, c5]) { const b = encodeRoundContract(c); const id = roundIdOf(c); rows.set(toHex(id), b); db.prepare('INSERT INTO rounds (round_id, contract) VALUES (?, ?)').run(id, b); }
  const rid0 = roundIdOf(c0), rid5 = roundIdOf(c5);
  // round 0 of the table had no player; round 5 has one, taken while S seated the table
  const round = { db, pubkey: nodes[0].pubkey, get: (id) => (rows.has(toHex(id)) ? { contract: rows.get(toHex(id)) } : null),
    entriesOf: (id) => (toHex(id) === toHex(rid5) ? [{}] : []) };
  const drawn = nodes.map((n) => ({ pubkey: n.pubkey, advert: { endpoint: n.endpoint } }));
  const verify = (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } };
  const replaced = [];
  const agent = seatingAgent({ round, roster: { committeeFor: () => ({ ok: true, drawn }) }, sign: (m) => schnorr.sign(m, nodes[0].secret), verify,
    fetcher: async () => new Response(JSON.stringify({ rounds: {} }), { status: 200 }), nowMs: () => Number(START) - 150000,
    onSeated: (r, role, s, _c, o = {}) => { if (o.replaced) replaced.push(toHex(r)); } });
  const certOf = (pos) => { const seated = pos.map((i) => nodes[i].pubkey);
    return encodeSeatingCertificate({ roundId: rid0, role: 'settlement', seated, signatures: pos.map((i) => ({ nodePubkey: nodes[i].pubkey, signature: signSeating({ roundId: rid0, role: 'settlement', seated }, (m) => schnorr.sign(m, nodes[i].secret)) })) }); };
  const S = [0, 1, 2, 3, 4, 5, 6], S2 = [0, 2, 3, 4, 5, 6, 7];
  assert.equal(agent.keepCert(rid0, 'settlement', certOf(S)).kept, true);
  const before = agent.seatedFor(rid5, 'settlement');
  assert.deepEqual(before, S.map((i) => toHex(nodes[i].pubkey)));
  const r = agent.keepCert(rid0, 'settlement', certOf(S2));
  const after = agent.seatedFor(rid5, 'settlement');
  assert.deepEqual(after, before, `round 5 of the table took an entry under S (${S.join('')}); the replacement S' (${S2.join('')}) was ${JSON.stringify(r)} `
    + `and round 5 is now seated by ${after ? after.map((k) => nodes.findIndex((n) => toHex(n.pubkey) === k)).join('') : 'nobody'} - the money on the table moved committee (onSeated replaced: ${replaced.length})`);
});
