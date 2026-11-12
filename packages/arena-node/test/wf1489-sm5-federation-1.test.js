// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 sm5-find-federation 1 (state machine audit, federation; interleaving of a consent and a deposit):
// A RETIREMENT CONSENTED WHILE THE FEDERATION WAS EMPTY CLOSES IT LATER WITH MONEY IN IT.
// SM6 (federation-retire.js, server.js POST /owner/federation/retire): each owner's consent needs the guardian's audit to hold nothing
// and the record's reserve to be 0 - AT THAT MOMENT ONLY. The consent is kept for good (retire.json), and from then on that seat builds
// and signs ONLY the CLOSED body (federation-records.js bodyFor: retiringOf -> closed: true) whatever the reserve it reads (mySignature
// checks the named reserve against its own reading and signs CLOSED over it). Between the threshold-th consent and the next gather
// (ARENA_FEDERATION_RECORD_MS, 10 min) the record is still OPEN - and an empty federation has load 0, so it is exactly the one
// pickFederation (first deposits) and openingFederation (new rounds) choose. Money paid in then is closed in: the record goes CLOSED
// (no successor), every seat stops observing its halts (halts.js skips CLOSED), no reserve move is made for a CLOSED federation
// (reserve-move.js), and the retire timer sets every guardian aside without auditing again (server.js 4977-4993).
// Invariant: a retirement record (CLOSED, no successor) is signed only over a federation that holds nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { federationRecords } from '../src/federation-records.js';
import { openingFederation } from '../src/opening-federation.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';

const FED = new Uint8Array(32).fill(0x37);
const OTHER = 'ab'.repeat(32);
const NET = new Uint8Array(32).fill(0x10);
const INVITE = `fed:${toHex(FED)}`;
const inviteFederationId = (inv) => fromHex(String(inv).split(':')[1]);

// (fixture as federation-record.test.js `seven`) seven guardian seats on one census; `retiring` the seats whose owners consented
// (retiringOf, as server.js wires retireBook.has); `reserveSats` what the guardians' wallet_summary names (reserveOf, as server.js)
function seven() {
  const nodes = Array.from({ length: 7 }, (_, i) => ({ secret: new Uint8Array(32).fill(i + 1) }));
  for (const [i, n] of nodes.entries()) { n.pubkey = schnorr.getPublicKey(n.secret); n.guardianKey = Uint8Array.from([2, ...new Uint8Array(32).fill(0x60 + i)]); n.endpoint = `wss://seat-${i}.example`; }
  const census = { ok: true, entries: nodes.map((n, i) => ({ pubkey: n.pubkey, txid: new Uint8Array(32).fill(0xa0 + i), vout: 0, bondSats: 50000n,
    advert: { operatorId: `op${i}`, endpoint: n.endpoint, guardianEndpoint: `wss://g${i}.example`, guardianOf: [{ federationId: FED, guardianKey: n.guardianKey }] } })) };
  const box = { retiring: [], reserveSats: 0n };
  const seats = nodes.map((n, i) => federationRecords({
    round: { pubkey: n.pubkey, identity: { secret: n.secret } }, newest: () => ({ rid: new Uint8Array(32).fill(9), contract: { censusHeight: 156036, networkId: NET } }),
    roster: { censusFor: () => census }, inviteFor: () => INVITE, networkId: NET, leavingAtMs: () => null,
    successorOf: () => null, closedOf: () => false, retiringOf: () => box.retiring.includes(i),
    reserveOf: async () => ({ ok: true, reserveSats: box.reserveSats }),
    fetcher: async (url) => {
      const j = seats[nodes.findIndex((m) => url.startsWith(m.endpoint.replace('wss:', 'https:')))];
      const u = new URL(url);
      const body = await j.mySignature(u.searchParams.get('federation'), null, u.searchParams.get('reserve'));
      return new Response(JSON.stringify(body), { status: body.ok ? 200 : 404 });
    },
  }));
  return { nodes, seats, box };
}

test('#1489 sm5 federation-1: owners consent to retire an empty federation; money paid in before the next gather is closed in by a CLOSED record', async () => {
  const s = seven();
  // the federation is OPEN and empty at every seat
  for (const seat of s.seats) { const g = await seat.gather(FED, inviteFederationId); assert.equal(g.status, 'OPEN', g.why); }
  // the door's guard holds at each consent: the record's reserve is 0 (and the audit, not modelled here, holds nothing)
  assert.equal(String(s.seats[0].recordOf(toHex(FED)).record.reserveSats), '0');
  // FIVE OWNERS CONSENT (the threshold of 7), each while it held nothing; the record stays OPEN until the next gather
  s.box.retiring = [0, 1, 2, 3, 4];
  // meanwhile the OPEN federation at load 0 is the one a seat opens its new round on (and a page's first deposit goes to)
  const listed = s.seats[0].list().map((x) => ({ ...x, load: 0 })).concat([{ federation: OTHER, status: 'OPEN', load: 0.4, height: 156036 }]);
  const opening = openingFederation({ listed, serves: [toHex(FED), OTHER], own: OTHER });
  assert.equal(opening.federationId, toHex(FED), 'the empty federation being retired is where new rounds open');
  // ...and a round settles 25,000 sat of reserve into it (the guardians' wallet now names it)
  s.box.reserveSats = 25000n;
  const g = await s.seats[0].gather(FED, inviteFederationId);   // a consenting guardian's seat gathers (every 10 min)
  const held = s.seats[0].recordOf(toHex(FED));
  console.log('  FACTS #1489 sm5 federation-1:', JSON.stringify({ gather: { ok: g.ok, status: g.status, signers: g.signers, why: g.why || null },
    kept: held && { status: held.status, reserveSats: String(held.record.reserveSats), successor: held.record.successorId ? toHex(held.record.successorId) : null } }));
  // THE INVARIANT: no retirement record (CLOSED, no successor) stands over a federation that holds something
  assert.ok(!(held.status === 'CLOSED' && BigInt(held.record.reserveSats) > 0n),
    `the federation was retired (CLOSED, no successor) holding ${held.record.reserveSats} sat: every consent was given while it was empty and none was checked again`);
});
