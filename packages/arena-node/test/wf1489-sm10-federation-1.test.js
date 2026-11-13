// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 state-machine audit round 10, federation 1: "the record in force at a round's census height" (recordAt, §23A.3a) is
// what every signer node reads the guardians' pressure weights from (server.js signerNodesFor: reserve, cap, nominal "the same inputs on
// every signer node"). But a seat keeps, per height, whatever record it took LAST at that height (keep() takes a gather at the same height
// always, a mirror of the same status too), and each gather names the reserve its guardians read at that moment. Two seats that gathered
// one census height ten minutes apart, a deposit between, hold two different "records in force" at that height - and split the guardian
// pool of the same round by two different weight tables, so their settlement transactions differ.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { federationRecords } from '../src/federation-records.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { guardianWeights } from '../../arena-protocol/src/capacity.js';

const FED = new Uint8Array(32).fill(0x41);
const NET = new Uint8Array(32).fill(0x10);
const INVITE = `fed:${toHex(FED)}`;
const inviteFederationId = (inv) => fromHex(String(inv).split(':')[1]);
const H = 160002;

test('wf1489-sm10-federation-1: two seats gathering one census height before and after a deposit hold different records "in force" at it, and weigh one round\'s guardians differently', async () => {
  const bonds = [50000n, 50000n, 50000n, 50000n, 50000n, 200000n, 400000n];
  const nodes = bonds.map((_, i) => ({ secret: new Uint8Array(32).fill(i + 91) }));
  for (const [i, n] of nodes.entries()) { n.pubkey = schnorr.getPublicKey(n.secret); n.guardianKey = Uint8Array.from([2, ...new Uint8Array(32).fill(0x70 + i)]); n.endpoint = `wss://sm10-${i}.example`; }
  const census = { ok: true, entries: nodes.map((n, i) => ({ pubkey: n.pubkey, txid: new Uint8Array(32).fill(0xb0 + i), vout: 0, bondSats: bonds[i],
    advert: { operatorId: `op${i}`, endpoint: n.endpoint, guardianEndpoint: `wss://g-sm10-${i}.example`, guardianOf: [{ federationId: FED, guardianKey: n.guardianKey }] } })) };
  // the federation's on-chain reserve as its guardians read it now: a peg-in lands between the two gatherings
  let reserveNow = 150000n;
  const seats = nodes.map((n) => federationRecords({
    round: { pubkey: n.pubkey, identity: { secret: n.secret } }, newest: () => ({ rid: new Uint8Array(32).fill(9), contract: { censusHeight: H, networkId: NET } }),
    roster: { censusFor: () => census }, inviteFor: () => INVITE, networkId: NET,
    reserveOf: async () => ({ ok: true, reserveSats: reserveNow }),
    fetcher: async (url) => {
      const j = seats[nodes.findIndex((m) => url.startsWith(m.endpoint.replace('wss:', 'https:')))];
      const u = new URL(url);
      const hp = u.searchParams.get('height');
      const body = await j.mySignature(u.searchParams.get('federation'), hp === null ? null : Number(hp), u.searchParams.get('reserve'));
      return new Response(JSON.stringify(body), { status: body.ok ? 200 : 404 });
    },
  }));
  const A = seats[0], B = seats[1];
  const a = await A.gather(FED, inviteFederationId);
  assert.deepEqual([a.ok, a.height], [true, H], a.why);
  reserveNow = 300000n;                       // a deposit confirmed; B's 10-minute timer runs next
  const b = await B.gather(FED, inviteFederationId);
  assert.deepEqual([b.ok, b.height], [true, H], b.why);
  const ra = A.recordAt(toHex(FED), H), rb = B.recordAt(toHex(FED), H);
  const weightsOf = (rec) => guardianWeights({ bonds: nodes.map((n, i) => ({ node: toHex(n.pubkey), bondSats: bonds[i] })), reserveSats: rec.reserveSats,
    exposureCapSats: rec.exposureCapSats, nominal: rec.nominal, bondMinSats: 50000n });
  const wa = weightsOf(ra), wb = weightsOf(rb);
  const show = (w) => (w ? [...w.values()].map((x) => String(x / 1000000n)).join(',') : 'even');
  console.log(`sm10-federation-1 measure: record in force at ${H}: seat A reserve ${ra.reserveSats} sat, seat B reserve ${rb.reserveSats} sat (cap ${ra.exposureCapSats}); guardian weights A [${show(wa)}] B [${show(wb)}]`);
  assert.equal(String(ra.reserveSats), String(rb.reserveSats), 'one census height, one record in force at every seat');
  assert.deepEqual(wa && [...wa.entries()], wb && [...wb.entries()], 'every signer node splits the round\'s guardian pool by the same weights');
});
