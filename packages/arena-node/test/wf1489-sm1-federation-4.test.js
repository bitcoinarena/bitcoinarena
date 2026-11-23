// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 state machine audit (federation), finding 4: A PARTIAL RETIREMENT FREEZES THE FEDERATION'S RECORD FOR GOOD.
// SM6 (federation-retire.js): an owner's consent to retire is kept for good (retire.json; no revoke, no expiry, no re-audit), and from
// it on that guardian's seat builds and signs ONLY the CLOSED body (federation-records.js bodyFor: retiringOf -> closed: true). A body
// is signed only by the guardians that build exactly it. So once n - threshold + 1 owners consented (3 of 7) and fewer than the
// threshold (5) did, no body has a threshold of signers: neither the CLOSED one nor the OPEN/DRAINING/CRITICAL one. The record kept at the
// seats stays the last one - OPEN - whatever happens next: a guardian whose owner leaves is never recorded gone, the federation is
// never DRAINING or CRITICAL, no page moves its players' notes out (ARENA_EVACUATE reads the record) and the seats go on opening
// rounds and taking deposits in it. A fourth consent needs an empty audit, which the deposits then prevent - and nothing un-consents.
// Safe behaviour: a guardian leaving a federation whose retirement has not reached its threshold is still recorded (DRAINING).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { federationRecords } from '../src/federation-records.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';

const FED = new Uint8Array(32).fill(0x37);
const NET = new Uint8Array(32).fill(0x10);
const INVITE = `fed:${toHex(FED)}`;
const inviteFederationId = (inv) => fromHex(String(inv).split(':')[1]);

// (fixture copied from federation-record.test.js `seven`) seven guardian seats on one census; `leaving` the ones whose owners left,
// `retiring` the ones whose owners consented to retire (retiringOf, as server.js wires retireBook.has)
function seven({ leaving = [], retiring = [] } = {}) {
  const nodes = Array.from({ length: 7 }, (_, i) => ({ secret: new Uint8Array(32).fill(i + 1) }));
  for (const [i, n] of nodes.entries()) { n.pubkey = schnorr.getPublicKey(n.secret); n.guardianKey = Uint8Array.from([2, ...new Uint8Array(32).fill(0x60 + i)]); n.endpoint = `wss://seat-${i}.example`; }
  const census = { ok: true, entries: nodes.map((n, i) => ({ pubkey: n.pubkey, txid: new Uint8Array(32).fill(0xa0 + i), vout: 0, bondSats: 50000n,
    advert: { operatorId: `op${i}`, endpoint: n.endpoint, guardianEndpoint: `wss://g${i}.example`, guardianOf: [{ federationId: FED, guardianKey: n.guardianKey }] } })) };
  const box = { leaving, retiring };
  const seats = nodes.map((n, i) => federationRecords({
    round: { pubkey: n.pubkey, identity: { secret: n.secret } }, newest: () => ({ rid: new Uint8Array(32).fill(9), contract: { censusHeight: 156036, networkId: NET } }),
    roster: { censusFor: () => census }, inviteFor: () => INVITE, networkId: NET, leavingAtMs: () => (box.leaving.includes(i) ? 1 : null),
    successorOf: () => null, closedOf: () => false, retiringOf: () => box.retiring.includes(i),
    fetcher: async (url) => {
      const j = seats[nodes.findIndex((m) => url.startsWith(m.endpoint.replace('wss:', 'https:')))];
      const u = new URL(url); const gone = (u.searchParams.get('gone') || '').split(',').filter(Boolean);
      const rv = u.searchParams.get('reserve');
      const list = (k) => (u.searchParams.get(k) || '').split(',').filter(Boolean);
      const body = await (gone.length ? j.mySignatureWithGone(u.searchParams.get('federation'), gone, null, rv, list('absent'), list('departed'), list('emergency'), { left: list('left') })
        : j.mySignature(u.searchParams.get('federation'), null, rv));
      return new Response(JSON.stringify(body), { status: body.ok ? 200 : 404 });
    },
  }));
  return { nodes, census, seats, box };
}

test('#1489 sm1 federation-4: three owners\' consents to retire (of the five needed) leave a guardian\'s departure unrecorded: the record stays OPEN', async () => {
  // control: no consent, guardian 6's owner leaves -> every gatherer signs DRAINING
  const plain = seven({ leaving: [6] });
  const g0 = await plain.seats[3].gather(FED, inviteFederationId);
  assert.deepEqual([g0.ok, g0.status], [true, 'DRAINING'], g0.why);

  // the same federation: OPEN, kept at every seat; then the owners of guardians 0, 1, 2 consent to retire it (each while it held nothing),
  // and later the owner of guardian 6 leaves
  const s = seven();
  for (const seat of s.seats) { const g = await seat.gather(FED, inviteFederationId); assert.equal(g.status, 'OPEN', g.why); }
  s.box.retiring = [0, 1, 2];
  s.box.leaving = [6];
  const said = [];
  for (const [i, seat] of s.seats.entries()) {
    const g = await seat.gather(FED, inviteFederationId);
    said.push({ seat: i, ok: g.ok, status: g.status || null, signatures: g.signatures, why: g.why ? String(g.why).slice(0, 90) : null, kept: seat.list()[0].status });
  }
  console.log('  FACTS #1489 sm1 federation-4:', JSON.stringify(said));
  // THE INVARIANT: a federation with a guardian gone and no retirement at its threshold is not OPEN at the seats (no new round, the
  // pages move the notes out)
  for (const x of said) assert.notEqual(x.kept, 'OPEN', `seat ${x.seat} still holds the federation OPEN with guardian 6 gone (its gather: ${x.ok ? x.status : x.why})`);
});
