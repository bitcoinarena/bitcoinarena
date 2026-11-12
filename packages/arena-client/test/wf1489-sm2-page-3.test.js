// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// WF1489 SM2 page-3: ONE PHRASE'S LIQUIDATION CLAIM HOLDS EVERY OTHER PHRASE'S NOTES OF THAT FEDERATION OUT OF THE CLAIM WINDOW.
//
// The liquidation claim record is one per federation (arena-liquidation-ecash-<fid>), shared by every tab of the browser, and names no
// phrase. Two tabs of one browser play on two phrases (P1, P2), each with notes in federation F. F halts and the arbitration set signs its
// liquidation. Tab 1 (P1) presents P1's notes: the record is 'posted'. Tab 2 (P2) runs claimLiquidations with P2's payout key: it finds a
// record, reads `taken` with P2's key (false), and - the record being 'posted' - never hands P2's notes over. The record goes only when a
// signed event lists P1's key AND a pass with P1's key runs: P1's tab closed, the record stands until the claims close, and P2's notes are
// never presented - worthless after the window.
// The invariant: every phrase's notes in a liquidated federation are presented inside the window, whatever another phrase's tab did.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { presentNotes, pendingClaimKey } from '../src/liquidation-claim.js';
import { eventMessage } from '../../arena-protocol/src/arbitration-event.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const FED = 'ab'.repeat(32);
const PK1 = '02' + '11'.repeat(32), PK2 = '02' + '22'.repeat(32);
const secrets = [1, 2, 3].map((n) => new Uint8Array(32).fill(n));
const keys = secrets.map((x) => toHex(schnorr.getPublicKey(x)));
const SET = { keys, k: 2 };
const verify = (sig, msg, key) => schnorr.verify(sig, msg, key);
const liquidation = (extra = {}) => ({ kind: 'liquidation', network: 'regtest', federation: FED, status: 'claims open', halt: { height: 1000, proof: null },
  door: 'http://arb.example', firstMs: 1, atMs: 1, ...extra });
const signed = (extra) => [{ event: liquidation(extra), signatures: [0, 1].map((i) => ({ key: keys[i], sig: toHex(schnorr.sign(eventMessage(liquidation(extra)), secrets[i])) })) }];

test('wf1489-sm2-page-3: a second phrase\'s notes are presented although the first phrase\'s claim record stands', async () => {
  const store = new Map();
  const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => { store.set(k, v); }, removeItem: (k) => store.delete(k) };
  const sent = [], posted = [];
  const walletOf = (label, ecash) => ({ sendAllEcash: async () => { sent.push(label); return JSON.stringify({ msat: 500000, ecash }); },
    receiveEcash: async () => '{}', pendingOutputs: async () => '[]' });
  const w1 = walletOf('P1', 'notes-of-p1'), w2 = walletOf('P2', 'notes-of-p2');
  const fetcher = async (url, o) => { const b = JSON.parse(o.body); posted.push([b.ecash, b.payoutPk]); return { ok: true, json: async () => ({ accepted: [1] }) }; };
  const base = { network: 'regtest', arbitration: SET, verify, held: [FED], storage, fetcher, put: (s, k, v) => s.setItem(k, v) };

  // tab 1, phrase P1, height 1012: P1's notes presented
  await presentNotes({ ...base, events: signed(), walletFor: async () => w1, payoutPk: PK1, height: 1012, nowMs: 1000 });
  assert.equal(JSON.parse(store.get(pendingClaimKey(FED))).state, 'posted');
  assert.deepEqual(sent, ['P1']);

  // tab 2, phrase P2, every 10 min through the window; tab 1 closed after its pass. The set lists P1's claim accepted at 1020.
  const accepted = signed({ atMs: 2, claims: { accepted: [{ nonce: 'n', amountMsat: '500000', height: 1012, payoutPk: PK1 }], refused: [], msat: '500000' } });
  const said = [];
  for (let h = 1013, t = 2000; h <= 1100; h += 1, t += 600000) {
    const out = await presentNotes({ ...base, events: h >= 1020 ? accepted : signed(), walletFor: async () => w2, payoutPk: PK2, height: h, nowMs: t });
    said.push(...out.map((x) => x.why));
  }
  console.log('FACTS sent:', JSON.stringify(sent), 'posted:', JSON.stringify(posted.map(([e, pk]) => [e, pk.slice(0, 8)])), 'record:', store.get(pendingClaimKey(FED)) && JSON.parse(store.get(pendingClaimKey(FED))).state,
    'tab2 last said:', said[said.length - 1]);
  assert.ok(sent.includes('P2'), 'P2\'s notes were never handed over inside the claim window (1010-1100): they are lost with the liquidation');
  assert.ok(posted.some(([e, pk]) => e === 'notes-of-p2' && pk === PK2), 'P2\'s notes presented to P2\'s payout key');
});
