// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 state machine audit (federation), finding 5: A FAILED GATHER TAKES A FEDERATION BACK FROM CRITICAL TO OPEN.
// SM3 (federation-records.js): a record's height is the census height it is built at - the newest held round's, the same for hours (every
// round of a day's grid) - so records of one height are signed at different times. recordStep lets a MIRROR take a record of the height
// kept when its status is the same or BETTER (#1157: "a mirror never worsens"). gatherAll mirrors whenever this seat's own gather fails
// (a guardian slow to answer the reserve read is enough). So: every seat holds OPEN at h; two guardians' owners leave; seat 3 gathers
// CRITICAL at h (the guardians' signed word), and draining() says CRITICAL - no new round, the pages move the players' notes out. Its next
// gather fails, it mirrors, and any guardian node that has not gathered since serves the old OPEN at h: taken, `draining` cleared. The
// seat names the federation for new rounds and deposits again, two guardians short of a halt, and its GET /federations tells the pages
// OPEN. The same pass at every mirroring seat spreads the stale OPEN.
// Safe behaviour: a status the guardians signed worse at a height is not undone by an older record of that height a peer still serves.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { federationRecords } from '../src/federation-records.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';

const FED = new Uint8Array(32).fill(0x37);
const NET = new Uint8Array(32).fill(0x10);
const INVITE = `fed:${toHex(FED)}`;
const inviteFederationId = (inv) => fromHex(String(inv).split(':')[1]);

// (fixture copied from federation-record.test.js `seven`, with GET /federations answered and a reserve read that can fail)
function seven() {
  const box = { leaving: [], reserveDown: new Set() };
  const nodes = Array.from({ length: 7 }, (_, i) => ({ secret: new Uint8Array(32).fill(i + 1) }));
  for (const [i, n] of nodes.entries()) { n.pubkey = schnorr.getPublicKey(n.secret); n.guardianKey = Uint8Array.from([2, ...new Uint8Array(32).fill(0x60 + i)]); n.endpoint = `wss://seat-${i}.example`; }
  const census = { ok: true, entries: nodes.map((n, i) => ({ pubkey: n.pubkey, txid: new Uint8Array(32).fill(0xa0 + i), vout: 0, bondSats: 50000n,
    advert: { operatorId: `op${i}`, endpoint: n.endpoint, guardianEndpoint: `wss://g${i}.example`, guardianOf: [{ federationId: FED, guardianKey: n.guardianKey }] } })) };
  const seats = nodes.map((n, i) => federationRecords({
    round: { pubkey: n.pubkey, identity: { secret: n.secret } }, newest: () => ({ rid: new Uint8Array(32).fill(9), contract: { censusHeight: 156036, networkId: NET } }),
    roster: { censusFor: () => census }, inviteFor: () => INVITE, networkId: NET, leavingAtMs: () => (box.leaving.includes(i) ? 1 : null),
    successorOf: () => null, closedOf: () => false, retiringOf: () => false,
    // the guardians' reserve (wallet_summary at a threshold): 0 sat, unless this seat's read does not answer this pass
    reserveOf: async () => (box.reserveDown.has(i) ? { ok: false, why: 'fewer than 5 guardians answered wallet_summary' } : { ok: true, reserveSats: 0n }),
    fetcher: async (url) => {
      const j = seats[nodes.findIndex((m) => url.startsWith(m.endpoint.replace('wss:', 'https:')))];
      const u = new URL(url);
      if (u.pathname === '/federations') return new Response(JSON.stringify({ federations: j.list() }), { status: 200 });
      const gone = (u.searchParams.get('gone') || '').split(',').filter(Boolean);
      const rv = u.searchParams.get('reserve');
      const list = (k) => (u.searchParams.get(k) || '').split(',').filter(Boolean);
      const body = await (gone.length ? j.mySignatureWithGone(u.searchParams.get('federation'), gone, null, rv, list('absent'), list('departed'), list('emergency'), { left: list('left') })
        : j.mySignature(u.searchParams.get('federation'), null, rv));
      return new Response(JSON.stringify(body), { status: body.ok ? 200 : 404 });
    },
  }));
  return { nodes, census, seats, box };
}

test('#1489 sm1 federation-5: a seat that gathered CRITICAL goes back to OPEN at the same height when its next gather fails and a peer still serves the old OPEN', async () => {
  const s = seven();
  // every seat gathers the federation OPEN at the day's census height
  for (const seat of s.seats) { const g = (await seat.gatherAll(inviteFederationId))[0]; assert.equal(g.status, 'OPEN', g.why); }
  // the owners of guardians 5 and 6 leave; seat 3 gathers next: CRITICAL, signed by all seven
  s.box.leaving = [5, 6];
  const g3 = (await s.seats[3].gatherAll(inviteFederationId))[0];
  assert.deepEqual([g3.ok, g3.status], [true, 'CRITICAL'], g3.why);
  assert.equal(s.seats[3].draining(toHex(FED)), 'CRITICAL', 'no new round or deposit names it here');
  const before = s.seats[3].recordOf(toHex(FED));
  // ten minutes on, seat 3's reserve read does not reach a threshold of guardians: its gather fails, gatherAll mirrors
  s.box.reserveDown.add(3);
  const next = (await s.seats[3].gatherAll(inviteFederationId))[0];
  const after = s.seats[3].recordOf(toHex(FED));
  const facts = { before: { status: before.status, height: before.height }, pass: { ok: next.ok, mirrored: next.mirrored, status: next.status, gathered: next.gathered },
    after: { status: after.status, height: after.height }, draining: s.seats[3].draining(toHex(FED)), served: s.seats[3].list()[0].status };
  console.log('  FACTS #1489 sm1 federation-5:', JSON.stringify(facts));
  assert.equal(after.status, 'CRITICAL', `seat 3 took the stale OPEN record of height ${after.height} back over the CRITICAL one its guardians signed at that height`);
  assert.equal(s.seats[3].draining(toHex(FED)), 'CRITICAL', 'seat 3 names a CRITICAL federation for new rounds and deposits again');
});
