// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// AUDIT gossip r2-1 (2026-11-19): ONE SEATED GUARDIAN DECIDES, SEAT BY SEAT, WHETHER A ROUND'S GATEWAY SEATING STANDS.
// The gateway-seating twin of #2992 (which names only the liquidity seating). A seat learns a gateway seating only from the seated
// guardians' own GET /gateway-seating (ownSeatings), and the fee table of every paid round (server.js signerNodesFor, the gateway seats
// and their peg-in weights) pays the gateways only where the seat holds a standing one. Honest guardians' signed bodies differ whenever
// their watch views differ (seats, and since #559 the proved peg-ins are part of the body): here one node D that is a seated guardian and
// a gateway answers its /gateway-claim to A and B only, so A, B sign {G1, D}, C signs {G1} - threshold - 1 honest signatures on one body.
// D signs {G1, D} and serves its GET /gateway-seating to seat S1 only. S1 holds it standing (A, B, D = 3 of 4), S2 holds none, on every
// later pass too: the two build different fee tables (gateway shares) for every paid round of that federation and epoch.
// Drives server.js's own gatherSeatings, as audit-gossip-r2-1 of 2026-11-18 (#2992) drove gatherLiquidity.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { schnorr } from '@noble/curves/secp256k1.js';
import { signGatewaySeating, standingSeating } from '../../arena-protocol/src/gateway-seating.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const src = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
const from = src.indexOf('const gatherSeatings = async () => {');
assert.ok(from > 0, 'gatherSeatings found in server.js');
const body = src.slice(from, src.indexOf('\n    };\n', from) + 7);
const NAMES = ['chainTip', 'GATEWAY_EPOCH_BLOCKS', 'gatewayWatches', 'ownSeatings', 'gatewaySeatings', 'signGatewaySeating', 'toHex', 'round', 'schnorr',
  'keepSeating', 'fedRecords', 'addressBook', 'fetch', 'jsonUpTo', 'PEER_LISTING_BYTES', 'standingSeating', 'schnorrVerify'];
const makeGather = new Function(...NAMES, `${body}\nreturn gatherSeatings;`);

const verify = (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } };
const fid = 'f0'.repeat(32);
const node = (name, i, url) => { const secret = new Uint8Array(32).fill(0x41 + i); const pubkey = schnorr.getPublicKey(secret); return { name, secret, pubkey, hex: toHex(pubkey), url }; };
const guardians = ['A', 'B', 'C', 'D'].map((n, i) => node(n, i, `https://g${i}.example`));
const others = ['S1', 'S2'].map((n, i) => node(n, 10 + i, `https://s${i}.example`));
const G1 = '11'.repeat(32);
const D = guardians[3];
const entries = [...guardians, ...others].map((x) => ({ pubkey: x.pubkey, advert: { endpoint: x.url } }));
const TIP = 144 * 1091 + 5, EPOCH = 1090;
const answer = (status, j) => ({ status, ok: status === 200, json: async () => j, body: null });
const jsonUpTo = async (r) => r.json();

test('a seated guardian serving its gateway-seating signature to some seats only does not leave the seats with different gateway seatings', async () => {
  const seats = [...guardians, ...others].map((g) => ({ g, own: new Map(), standing: new Map() }));
  const byName = Object.fromEntries(seats.map((s) => [s.g.name, s]));
  // each guardian's own gateway watch: D's gateway claim reached A, B and D only (D answered C's GET /gateway-claim with nothing)
  const viewOf = (name) => ({ ok: true, measuredEpoch: 'whole', epoch: EPOCH, federationId: fid,
    seated: ['A', 'B', 'D'].includes(name) ? [G1, D.hex] : [G1], belowMinimums: [], gateways: {} });
  const fetchFor = (asker) => async (u) => {
    const seat = seats.find((s) => String(u).startsWith(s.g.url));
    if (!seat || !String(u).includes('/gateway-seating?')) return answer(404, null);
    const q = new URL(u).searchParams;
    if (q.get('standing') === '1') { const st = seat.standing.get(`${q.get('federation')}:${Number(q.get('epoch'))}`); return st && st.proof ? answer(200, st.proof) : answer(404, { ok: false }); }   // the door's ?standing=1 (#3020)
    if (seat.g === D && asker !== 'S1') return answer(404, { ok: false });   // the attacker's signature: to S1 only
    const got = seat.own.get(`${q.get('federation')}:${Number(q.get('epoch'))}`);
    return got ? answer(200, got) : answer(404, { ok: false });
  };
  const fedRecords = { list: () => [{ federation: fid }], recordOf: () => ({ record: { threshold: 3 } }), seatedGuardians: () => guardians.map((g) => g.pubkey),
    censusNow: () => ({ ok: true, entries }), censusNewest: () => entries };
  for (const s of seats) {
    const isGuardian = guardians.includes(s.g);
    const watches = isGuardian ? [{ watch: { view: async () => viewOf(s.g.name) } }] : [];
    s.pass = makeGather(async () => TIP, 144, watches, s.own, s.standing, signGatewaySeating, toHex,
      { pubkey: s.g.pubkey, identity: { secret: s.g.secret }, db: { prepare: () => ({ run: () => {} }) } }, schnorr, () => {}, fedRecords,
      { endpointOf: (e) => e.advert.endpoint }, fetchFor(s.g.name), jsonUpTo, 1 << 22, standingSeating, verify);
  }
  for (const n of ['A', 'B', 'C', 'D']) await byName[n].pass();
  const k = `${fid}:${EPOCH}`;
  const list = (m) => (m ? m.seats.map((x) => x.slice(0, 2)).sort().join(',') : 'none');
  console.log(`signed: A ${list(byName.A.own.get(k))}, B ${list(byName.B.own.get(k))}, C ${list(byName.C.own.get(k))}, D ${list(byName.D.own.get(k))}`);
  for (let i = 0; i < 4; i++) { await byName.S1.pass(); await byName.S2.pass(); }
  const s1 = list(byName.S1.standing.get(k)), s2 = list(byName.S2.standing.get(k));
  console.log(`standing gateway seating for epoch ${EPOCH}: S1 ${s1}, S2 ${s2}`);
  assert.equal(s1, s2, 'every seat builds a round\'s fee table on the same gateway seating (or on none)');
});

