// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// REFUTE #3020/#2992 (skeptic 2, lens: a census PEER, not a guardian): the ?standing=1 pull in gatherLiquidity checks each item with
// oneSig OUTSIDE any try. A census seat M answers ?standing=1 with JSON whose federationId has an own "toString" key: String() throws a
// TypeError, the whole pass aborts, every pass. S1 holds the list standing (D served it only), S2 (which asks M before S1) never does.
// Based on AUDIT gossip r2-1: ONE SEATED GUARDIAN DECIDES, SEAT BY SEAT, WHETHER A ROUND'S LIQUIDITY SEATING STANDS.
// A seat learns a liquidity seating only from the seated guardians' own GET /liquidity-seating (ownLiquiditySeatings), and the
// fee table of every paid round (server.js signerNodesFor, liquidity providers) pays the providers only where the seat holds a
// standing one. One node that is both a seated guardian and a liquidity provider (D) answers its /liquidity-claim to two honest
// guardians only, so the honest ones split (A, B sign {P1, D}; C signs {P1}) - threshold - 1 honest signatures on one list. D then
// signs that list and serves its signature to seat S1 only. S1 holds the list standing (A, B, D = 3 of 4), S2 holds none, on every
// later pass too: the two build different fee tables for every paid round of that federation and epoch.
// Drives server.js's own gatherLiquidity as test/liquidity-seating-once.test.js does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { schnorr } from '@noble/curves/secp256k1.js';
import { signLiquiditySeating, standingLiquiditySeating, liquiditySeatingFrom } from '../../arena-protocol/src/liquidity-seating.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { seatingEpochAt } from '../../arena-protocol/src/gateway-seating.js';

const src = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
const from = src.indexOf('const gatherLiquidity = async () => {');
const body = src.slice(from, src.indexOf('\n    };\n', from) + 7);
const NAMES = ['chainTip', 'GATEWAY_EPOCH_BLOCKS', 'fedRecords', 'addressBook', 'toHex', 'round', 'liquiditySeatings', 'ownLiquiditySeatings', 'getJson',
  'checkGatewayClaim', 'checkLiquidityClaim', 'schnorrVerify', 'chainTxOut', 'provenFreeSats', 'messageCurve', 'liquiditySeatingFrom', 'liquiditySaid',
  'signLiquiditySeating', 'standingLiquiditySeating', 'schnorr', 'keepSeating', 'seatingEpochAt'];   // 2.0 reads the epoch with seatingEpochAt
const makeGather = new Function(...NAMES, `${body}\nreturn gatherLiquidity;`);

const verify = (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } };
const fid = 'f0'.repeat(32), lnKey = '03' + '99'.repeat(32);
const node = (name, i, url) => { const secret = new Uint8Array(32).fill(0x41 + i); const pubkey = schnorr.getPublicKey(secret); return { name, secret, pubkey, hex: toHex(pubkey), url }; };
const guardians = ['A', 'B', 'C', 'D'].map((n, i) => node(n, i, `https://g${i}.example`));
const others = ['M', 'S1', 'S2'].map((n, i) => node(n, 10 + i, `https://s${i}.example`));
const P1 = { hex: '11'.repeat(32), url: 'https://p1.example' };
const D = guardians[3];
const entries = [...guardians, ...others, P1].map((x) => ({ pubkey: Uint8Array.from(Buffer.from(x.hex, 'hex')), advert: { endpoint: x.url } }));
const claimOf = (hex) => ({ node: hex, freeSats: '612345', channels: [{ peer: lnKey, capacitySats: '100000' }] });


const POISON = '[{"federationId":{"toString":0},"guardian":{"toString":0},"epoch":1090}]';
test('a census peer\'s malformed ?standing=1 answer does not keep a seat from the standing liquidity seating', async () => {
  const seats = [...guardians, ...others].map((g) => ({ g, own: new Map(), standing: new Map() }));
  const byName = Object.fromEntries(seats.map((s) => [s.g.name, s]));
  const getJsonFor = (asker) => async (u) => {
    if (u.startsWith(D.url) && u.endsWith('/liquidity-claim')) return ['A', 'B', 'D'].includes(asker) ? claimOf(D.hex) : null;
    if (u.startsWith(P1.url) && u.endsWith('/liquidity-claim')) return claimOf(P1.hex);
    const seat = seats.find((s) => u.startsWith(s.g.url));
    if (!seat) return null;
    if (u.includes('/gateway-claim')) return guardians.includes(seat.g) ? { node: seat.g.hex, lightningPubkey: lnKey } : null;
    if (u.includes('/liquidity-seating?')) {
      const q = new URL(u).searchParams;
      if (seat.g.name === 'M') return q.get('standing') === '1' ? JSON.parse(POISON) : null;   // the attacker peer: parsed as jsonUpTo parses it
      if (seat.g === D && asker !== 'S1') return null;   // the guardian's signature (and its standing proof): to S1 only
      if (q.get('standing') === '1') { const st = seat.standing.get(`${q.get('federation')}:${Number(q.get('epoch'))}`); return (st && st.proof) || null; }
      return seat.own.get(`${q.get('federation')}:${Number(q.get('epoch'))}`) || null;
    }
    return null;
  };
  const fedRecords = { list: () => [{ federation: fid }], recordOf: () => ({ record: { threshold: 3 } }), seatedGuardians: () => guardians.map((g) => g.pubkey), censusNow: () => ({ ok: true, entries }) };
  const errors = [];
  for (const s of seats) { const g = makeGather(async () => 144 * 1091 + 5, 144, fedRecords, { endpointOf: (e) => e.advert.endpoint }, toHex, { pubkey: s.g.pubkey, identity: { secret: s.g.secret } },
    s.standing, s.own, getJsonFor(s.g.name), () => ({ ok: true }), () => ({ ok: true }), verify, undefined, null, null, liquiditySeatingFrom, () => {},
    signLiquiditySeating, standingLiquiditySeating, schnorr, () => {}, seatingEpochAt);
    s.pass = () => g().catch((e) => errors.push(`${s.g.name}: ${e.message}`)); }   // as gatherLiquidityOnce: a thrown pass is logged
  for (const n of ['A', 'B', 'C', 'D']) await byName[n].pass();
  const k = `${fid}:1090`;
  const list = (m) => (m ? m.providers.map((p) => p.node.slice(0, 2)).join(',') : 'none');
  for (let i = 0; i < 4; i++) { await byName.S1.pass(); await byName.S2.pass(); }
  const s1 = list(byName.S1.standing.get(k)), s2 = list(byName.S2.standing.get(k));
  console.log(`standing liquidity seating for epoch 1090: S1 ${s1}, S2 ${s2}; passes that threw: ${errors.length} ${errors.slice(0, 2).join(' / ')}`);
  assert.notEqual(s1, 'none', 'S1 holds the list standing (D served it its signature)');
  assert.equal(s1, s2, 'every seat builds a round\'s fee table on the same liquidity seating (or on none)');
});
