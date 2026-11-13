// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #2640 (outside report #055): A GUARDIAN SIGNS ONE LIQUIDITY SEATING PER FEDERATION AND EPOCH (§23A.10: "the same way as the
// gateway seating"). Before: a seated guardian that saw no standing list re-read the providers' claims on every pass and replaced its
// signature with a new list (GET /liquidity-seating serves only the latest). One provider answering /liquidity-claim on one pass and not
// on the next (an attacker, or timeouts under load) made two lists both reach the threshold: a seat froze the first, another the
// second (a standing list is never read again), so they built different fee tables and the paid rounds of that epoch never settled.
// This drives server.js's own gatherLiquidity (its source, with stubbed seats) through four guardians, threshold 3.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { schnorr } from '@noble/curves/secp256k1.js';
import { signLiquiditySeating, standingLiquiditySeating, liquiditySeatingFrom } from '../../arena-protocol/src/liquidity-seating.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const src = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
const from = src.indexOf('const gatherLiquidity = async () => {');
const body = src.slice(from, src.indexOf('\n    };\n', from) + 7);
const NAMES = ['chainTip', 'GATEWAY_EPOCH_BLOCKS', 'fedRecords', 'addressBook', 'toHex', 'round', 'liquiditySeatings', 'ownLiquiditySeatings', 'getJson',
  'checkGatewayClaim', 'checkLiquidityClaim', 'schnorrVerify', 'chainTxOut', 'provenFreeSats', 'messageCurve', 'liquiditySeatingFrom', 'liquiditySaid',
  'signLiquiditySeating', 'standingLiquiditySeating', 'schnorr', 'keepSeating'];
const makeGather = new Function(...NAMES, `${body}\nreturn gatherLiquidity;`);

const verify = (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } };
const fid = 'f0'.repeat(32), lnKey = '03' + '99'.repeat(32);
const guardians = ['A', 'B', 'C', 'D'].map((name, i) => { const secret = new Uint8Array(32).fill(0x61 + i); const pubkey = schnorr.getPublicKey(secret); return { name, secret, pubkey, hex: toHex(pubkey), url: `https://g${i}.example` }; });
const providers = ['11', '22'].map((b, i) => ({ hex: b.repeat(32), url: `https://p${i}.example` }));
const entries = [...guardians, ...providers].map((x) => ({ pubkey: Uint8Array.from(Buffer.from(x.hex, 'hex')), advert: { endpoint: x.url } }));
const claimOf = (p) => ({ node: p.hex, freeSats: '612345', channels: [{ peer: lnKey, capacitySats: '100000' }] });

test('a provider that answers on one pass and not the next cannot make two seats freeze two different lists', async () => {
  let p2Answers = true;
  const seats = guardians.map((g) => ({ g, own: new Map(), standing: new Map() }));
  const getJson = async (u) => {
    const seat = seats.find((s) => u.startsWith(s.g.url));
    if (seat && u.includes('/gateway-claim')) return { node: seat.g.hex, lightningPubkey: lnKey };
    if (seat && u.includes('/liquidity-seating?')) { const q = new URL(u).searchParams; return seat.own.get(`${q.get('federation')}:${Number(q.get('epoch'))}`) || null; }
    const p = providers.findIndex((x) => u.startsWith(x.url));
    if (p >= 0 && u.endsWith('/liquidity-claim')) return p === 1 && !p2Answers ? null : claimOf(providers[p]);
    return null;
  };
  const fedRecords = { list: () => [{ federation: fid }], recordOf: () => ({ record: { threshold: 3 } }), seatedGuardians: () => guardians.map((g) => g.pubkey), censusNow: () => ({ ok: true, entries }) };
  for (const s of seats) s.pass = makeGather(async () => 144 * 1091 + 5, 144, fedRecords, { endpointOf: () => null }, toHex, { pubkey: s.g.pubkey, identity: { secret: s.g.secret } },
    s.standing, s.own, getJson, () => ({ ok: true }), () => ({ ok: true }), verify, undefined, null, null, liquiditySeatingFrom, () => {},
    signLiquiditySeating, standingLiquiditySeating, schnorr, () => {});
  const [A, B, C, D] = seats;
  // pass 1, both providers answer: A and B sign {P1, P2}; D signs it too and sees it stand (A, B, D) - D freezes it
  await A.pass(); await B.pass(); await D.pass();
  const k = `${fid}:1090`;
  assert.equal(D.standing.get(k)?.providers.length, 2, 'the two-provider list stands at D');
  // pass 2, P2 does not answer: A and B have no standing list yet, C gathers for the first time
  p2Answers = false;
  await A.pass(); await B.pass(); await C.pass();
  const at = (s) => (s.standing.get(k)?.providers || []).map((p) => p.node.slice(0, 2)).join(',') || 'none';
  console.log(`#2640 standing lists: A ${at(A)}, B ${at(B)}, C ${at(C)}, D ${at(D)}; A signs ${A.own.get(k).providers.length} provider(s)`);
  assert.equal(A.own.get(k).providers.length, 2, 'A keeps the one list it signed for the epoch');
  assert.equal(at(C), at(D), 'every seat that holds a standing list holds the same one');
});
