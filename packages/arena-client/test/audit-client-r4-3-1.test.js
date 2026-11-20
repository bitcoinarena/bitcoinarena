// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// Audit 2026-11-19 r4, client round 3, finding 1: THE LIQUIDATION CLAIM WINDOW IS READ AGAINST A TIP ONE SEAT SETS.
// claimLiquidations (src/arena-ui/index.html) reads "the chain tip" as the LARGEST height of any federation record in ARENA_FED_LOADS -
// every federation any seat of the round lists at GET /federations. A record's height is only bounded by censusHeight + CENSUS_TIP_SLACK
// (1008 blocks). One bonded census seat whose advert names a made-up federation of its own (nominal 1, it alone its guardian) signs a
// verified record of that federation at censusHeight + 1008: the page's "tip" jumps a week ahead, and presentNotes answers 'the claims
// closed' for the player's genuinely liquidated federation during the whole signed window (testnet4: halt+12 .. halt+144). The notes are
// never presented and are worthless after the window.
// Safe: a seat's own federation record does not move the tip the player's claim window is judged at - the notes are handed over.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { schnorr } from '@noble/curves/secp256k1.js';
import { federationStatuses } from '../src/federations.js';
import { presentNotes } from '../src/liquidation-claim.js';
import { buildFederationRecord, encodeFederationRecord, federationRecordId, joinSignedRecord } from '../../arena-protocol/src/federation-record.js';
import { inviteForGuardians } from '../../arena-node/src/invite.js';
import { eventMessage } from '../../arena-protocol/src/arbitration-event.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const HTML = readFileSync(new URL('../../../src/arena-ui/index.html', import.meta.url), 'utf8');
// the page's own tip expression, as claimLiquidations computes it
const tipLine = HTML.split('\n').find((l) => l.includes('const tip = (() => {') && l.includes('ARENA_FED_LOADS'));

test('audit-client-r4-3-1: one seat\'s self-made federation record at censusHeight+1008 closes the player\'s liquidation claim window', async () => {
  assert.ok(tipLine, 'claimLiquidations tip line found');
  const NET = new Uint8Array(32).fill(0x10);
  const CENSUS_H = 150000, REAL_TIP = 150020, HALT = 150000;   // the player's federation halted at the census height; tip 20 blocks later
  // honest federation H: 4 guardians, bonded
  const H = new Uint8Array(32).fill(0x37), hHex = toHex(H);
  const honest = Array.from({ length: 4 }, (_, i) => { const secret = new Uint8Array(32).fill(i + 1); return { secret, pubkey: schnorr.getPublicKey(secret), guardianKey: Uint8Array.from([2, ...new Uint8Array(32).fill(0x60 + i)]) }; });
  // the attacker seat: one bonded census node; its own advert names a federation F of its own making
  const F = new Uint8Array(32).fill(0x99), fHex = toHex(F);
  const evil = { secret: new Uint8Array(32).fill(0x42) }; evil.pubkey = schnorr.getPublicKey(evil.secret); evil.guardianKey = Uint8Array.from([3, ...new Uint8Array(32).fill(0x77)]);
  const census = [
    ...honest.map((n, i) => ({ pubkey: n.pubkey, txid: new Uint8Array(32).fill(i), vout: 0, bondSats: 50000n, advert: { guardianOf: [{ federationId: H, guardianKey: n.guardianKey }] } })),
    { pubkey: evil.pubkey, txid: new Uint8Array(32).fill(9), vout: 0, bondSats: 50000n, advert: { guardianOf: [{ federationId: F, guardianKey: evil.guardianKey }] } },
  ];
  const recordOf = (fid, signers, entries, height, status) => {
    const r = buildFederationRecord({ federationId: fid, networkId: NET, invite: inviteForGuardians(fid, [{ url: 'wss://g.example/', peer: 0 }]), nominal: signers.length, height, status,
      guardians: entries.map((e) => ({ peerKey: e.advert.guardianOf[0].guardianKey, nodePubkey: e.pubkey, operatorId: '', bondTxid: e.txid, bondVout: 0, endpoint: '', bondSats: 50000n })) });
    const id = federationRecordId(r);
    return toHex(joinSignedRecord(encodeFederationRecord(r), signers.map((n) => ({ nodePubkey: n.pubkey, signature: schnorr.sign(id, n.secret) }))));
  };
  const hRec = recordOf(H, honest, census.slice(0, 4), CENSUS_H, undefined);
  const fRec = recordOf(F, [evil], census.slice(4), CENSUS_H + 1008, undefined);
  const fetcher = async (u) => new Response(JSON.stringify(String(u).includes('evil')
    ? { federations: [{ federation: hHex, record: hRec }, { federation: fHex, record: fRec }] }
    : { federations: [{ federation: hHex, record: hRec }] }), { status: 200 });
  const verifyRec = (sig, msg, key) => schnorr.verify(sig, msg, key);
  const all = await federationStatuses({ nodes: ['https://a.example', 'https://b.example', 'https://evil.example'], census, verify: verifyRec, fetcher, censusHeight: CENSUS_H });
  console.log('FACTS: statuses', JSON.stringify([...all].map(([k, v]) => [k.slice(0, 8), v.status, v.height])));
  // the page's tip, by its own expression
  const window = { ARENA_FED_LOADS: all };
  const pendingTip = () => ({ tipHeight: REAL_TIP });
  const tip = new Function('window', 'pendingTip', tipLine.trim() + '\nreturn tip;')(window, pendingTip);
  console.log(`FACTS: page tip = ${tip}, real tip = ${REAL_TIP}`);
  // the arbitration set's signed liquidation of H (testnet4 clocks: opens halt+12, last paid halt+144)
  const secrets = [1, 2, 3].map((n) => new Uint8Array(32).fill(0x20 + n));
  const keys = secrets.map((x) => toHex(schnorr.getPublicKey(x)));
  const ev = { kind: 'liquidation', network: 'testnet4', federation: hHex, status: 'claims open', halt: { height: HALT, proof: null }, door: 'https://arb.example', firstMs: 1, atMs: 1 };
  const events = [{ event: ev, signatures: [0, 1].map((i) => ({ key: keys[i], sig: toHex(schnorr.sign(eventMessage(ev), secrets[i])) })) }];
  const store = new Map();
  const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) };
  const posted = [];
  const wallet = { sendAllEcash: async () => JSON.stringify({ msat: 768000, ecash: 'notes-1' }), receiveEcash: async () => '{}', pendingOutputs: async () => '[]' };
  const out = await presentNotes({ events, network: 'testnet4', arbitration: { keys, k: 2 }, verify: (s, m, k) => schnorr.verify(s, m, k), held: [hHex],
    walletFor: async () => wallet, payoutPk: '02' + '11'.repeat(32), height: tip, storage, put: (s, k, v) => s.setItem(k, v),
    fetcher: async (url, o) => { posted.push(url); return { ok: true, status: 200, json: async () => ({ accepted: [1] }) }; } });
  console.log('FACTS: presentNotes', JSON.stringify(out));
  assert.ok(tip <= REAL_TIP, `the page judged the claim window at height ${tip}, ${tip - REAL_TIP} blocks past the real tip, because one seat's own federation record says so`);
  assert.ok(posted.length > 0, `the player's notes were never presented inside the signed window: ${out.map((x) => x.why).join('; ')}`);
});
