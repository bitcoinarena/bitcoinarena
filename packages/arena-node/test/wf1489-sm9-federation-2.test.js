// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 sm9-find-federation 2 (state machine audit, federation; a guardian whose federation changes under a running watch):
// THE GATEWAY WATCH OF A GUARDIAN WHOSE FEDERATION WAS RETIRED SEATS THE OLD FEDERATION'S GATEWAYS IN THE NEW ONE.
// SM9 (gateway-watch.js): the watch's probes, per epoch, are one Map node -> { probes, up, claim } (plus `volumes`, `cursor`, `seatedBy`)
// that is NOT keyed by federation, while its federation is read at every probe: server.js watchFor passes
// `federationId: async () => federationOfDir(g.dataDir)`. A retirement (federation-retire.js / node-start.js retire) sets the guardian's
// database aside and starts a guardian in setup IN THE SAME DIRECTORY, in the same process, and the next founding makes it guard F2.
// From then on every probe and view of that watch is F2's - over F1's rows: view() ranks the last whole epoch, which F1's probes filled,
// with F2's seated guardians; a node that was an F1 gateway and is seated in F2 stands as an F2 gateway seat - `registered` from F1's
// routing_info answers, its peg-in and URL from F1's claim - although its seat serves no F2 claim and its gateway does not serve F2.
// GET /gateway-seats then names it, the pages deposit through it (an invoice F2's clients cannot pay), and the settlement's gateway
// fees follow the seating. (A restart would read F2's own rows from gateway_probes, kept per federation; the process does not restart.)
// Invariant: a federation's gateway seats are gateways that claim THAT federation and answer routing_info for it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { createGatewayWatch } from '../src/gateway-watch.js';
import { signGatewayClaim } from '../../arena-protocol/src/gateway-claim.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const F1 = 'f1'.repeat(32), F2 = 'f2'.repeat(32);
const keys = [1, 2].map((n) => { const secret = new Uint8Array(32).fill(n); return { secret, hex: toHex(schnorr.getPublicKey(secret)) }; });
const verify = (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } };
const claimOf = (i, fid) => signGatewayClaim({ node: keys[i].hex, federationId: fid, gatewayUrl: `https://n${i}.example/gateway/`, lightningPubkey: '02' + 'ab'.repeat(32),
  capacitySats: 300000, pegInSats: 60000, atMs: 1, inboundSats: 150000, outboundSats: 150000, outsideInboundSats: 150000 }, (h) => schnorr.sign(h, keys[i].secret));

test('#1489 sm9 federation-2: after the guardian\'s directory guards a new federation, the old one\'s gateways are its gateway seats', async () => {
  let guarded = F1;                         // federationOfDir(g.dataDir): F1, then (retired, refounded in the same directory) F2
  let height = 144 * 10 + 5;
  const entries = keys.map((k, i) => ({ pubkey: Uint8Array.from(Buffer.from(k.hex, 'hex')), bondSats: 50000n, advert: { endpoint: `https://seat${i}.example`, operatorId: `op${i}` } }));
  const asked = [];
  const fetcher = async (url, o = {}) => {
    const seat = /^https:\/\/seat(\d)\.example\/gateway-claim\?federation=([0-9a-f]{64})$/.exec(url);
    if (seat) { asked.push(`claim ${seat[2].slice(0, 2)}`); return seat[2] === F1 ? { status: 200, json: async () => claimOf(Number(seat[1]), F1) } : { status: 404, json: async () => ({}) }; }
    const gw = /^https:\/\/n(\d)\.example\/gateway\/routing_info$/.exec(url);
    // the two gateways joined F1 only: routing_info answers for F1, null for F2 (each its own module key: HEAD's owners hold one key per gateway)
    if (gw) return { status: 200, text: async () => (o.body === JSON.stringify(F1) ? '{"module_public_key":"02' + ('3' + gw[1]).repeat(32) + '"}' : 'null') };
    throw new Error(`unexpected ${url}`);
  };
  const w = createGatewayWatch({ federationId: async () => guarded, seated: async () => keys.map((k) => k.hex), entries: async () => entries,
    tip: async () => height, beaconAt: async () => new Uint8Array(32).fill(7), verify, fetcher });
  // epoch 10: F1's watch, both F1 gateways up at every probe
  for (let i = 0; i < 5; i++) await w.probe();
  const f1 = await w.view();
  assert.equal(f1.federationId, F1);
  assert.equal(f1.seated.length, 2, 'precondition: both gateways seated in F1');
  // F1 retired; the same directory now guards F2 (the two nodes are seated in F2 too). Epoch 11: their seats serve no F2 claim yet and
  // their gateways do not serve F2
  guarded = F2; height += 144;
  for (let i = 0; i < 3; i++) await w.probe();
  const v = await w.view();
  console.log('  FACTS #1489 sm9 federation-2:', JSON.stringify({ federation: v.federationId.slice(0, 4), epoch: v.epoch, measured: v.measuredEpoch, seated: v.seated.map((s) => s.slice(0, 8)),
    gateways: Object.fromEntries(Object.entries(v.gateways || {}).map(([k, g]) => [k.slice(0, 8), g.url])), lastProbe: { claims: v.lastProbe && v.lastProbe.claims }, askedF2: asked.filter((a) => a === 'claim f2').length }));
  assert.equal(v.federationId, F2);
  assert.equal(v.lastProbe.claims, 0, 'precondition: no seat serves a claim for F2 and no probe of F2 found a gateway');
  // THE INVARIANT: F2's gateway seats stand only on F2's own claims and probes
  assert.deepEqual(v.seated, [], `F2 seats ${v.seated.length} gateway(s) from F1's claims and probes`);
  assert.deepEqual(Object.keys(v.gateways || {}), [], 'F2\'s view lists F1\'s gateways');
});
