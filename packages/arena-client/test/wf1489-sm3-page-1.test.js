// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// WF1489 sm3-page-1 (state-machine audit, round 3): TWO TABS PRESENTING NOTES TO ONE LIQUIDATION AT ONCE LOSE ONE TAB'S NOTES.
// The liquidation claim record (arena-liquidation-ecash-<fid>) is one per federation in the browser's localStorage, shared by every tab and
// every phrase. presentNotes reads it, and a tab that finds an INTENT - whatever its age - takes it for "an intent left by a tab closed during the
// hand-over" and drops it; its own steps write over the stored record with no compare-and-set (claimStep checks only the copy in memory). So:
//   tab A (phrase X) writes its intent and awaits sendAllEcash;  tab B (phrase Y, its 10-min timer or a load) drops A's live intent, writes its
//   own, hands Y's notes over and keeps them;  the door does not answer (a 5xx: the record stays kept);  A's send returns and A writes kept with
//   X's notes OVER B's record.  Y's notes have left Y's wallet and are now kept nowhere: no later pass can present them.
// Safe: a record that holds notes is never written over by another hand-over; every note handed over stays kept until it is taken.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { presentNotes, pendingClaimKey } from '../src/liquidation-claim.js';
import { eventMessage } from '../../arena-protocol/src/arbitration-event.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const FED = 'ab'.repeat(32);
const secrets = [1, 2, 3].map((n) => new Uint8Array(32).fill(n));
const keys = secrets.map((x) => toHex(schnorr.getPublicKey(x)));
const SET = { keys, k: 2 };
const verify = (sig, msg, key) => schnorr.verify(sig, msg, key);
const event = { kind: 'liquidation', network: 'regtest', federation: FED, status: 'claims open', halt: { height: 1000, proof: null },
  door: 'http://arb.example', firstMs: 1, atMs: 1 };
const events = [{ event, signatures: [0, 1].map((i) => ({ key: keys[i], sig: toHex(schnorr.sign(eventMessage(event), secrets[i])) })) }];

test('wf1489-sm3-page-1: two tabs (two phrases) presenting at once - every note handed over stays kept in the browser', async () => {
  // ONE localStorage for both tabs
  const store = new Map();
  const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => { store.set(k, v); }, removeItem: (k) => { store.delete(k); } };
  const put = (s, k, v) => s.setItem(k, v);
  let releaseA;
  const aMayAnswer = new Promise((r) => { releaseA = r; });
  const handed = [];
  const walletOf = (notes, slow) => ({
    sendAllEcash: async () => { if (slow) await slow; handed.push(notes); return JSON.stringify({ msat: 500000, ecash: notes }); },
    receiveEcash: async () => { throw new Error('the federation is halted'); },
    pendingOutputs: async () => '[]',
  });
  const walletX = walletOf('fedimint-notes-of-phrase-X', aMayAnswer);   // tab A: its wallet answers the send late (wasm, the store's commit)
  const walletY = walletOf('fedimint-notes-of-phrase-Y', null);         // tab B
  // the arbitration set's door does not answer yet (a 5xx: nothing taken, the record stays kept and is presented again)
  const fetcher = async () => ({ ok: false, status: 503, json: async () => ({ why: 'the door is restarting' }) });
  const base = { events, network: 'regtest', arbitration: SET, verify, held: [FED], height: 1012, storage, fetcher, put };

  const tabA = presentNotes({ ...base, walletFor: async () => walletX, payoutPk: '02' + '11'.repeat(32), nowMs: 1000 });
  await new Promise((r) => setTimeout(r, 10));                         // A's intent is on disk, its send in flight
  const midA = JSON.parse(store.get(pendingClaimKey(FED)));
  const tabB = await presentNotes({ ...base, walletFor: async () => walletY, payoutPk: '02' + '22'.repeat(32), nowMs: 1005 });
  releaseA();
  const outA = await tabA;

  const kept = store.has(pendingClaimKey(FED)) ? JSON.parse(store.get(pendingClaimKey(FED))) : null;
  const keptNotes = new Set([...store.values()].filter((v) => typeof v === 'string').flatMap((v) => [...handed].filter((n) => v.includes(n))));
  const facts = { aIntentSeenByB: midA.state, handedOver: handed, recordNow: kept && { state: kept.state, ecash: kept.ecash },
    notesKeptAnywhere: [...keptNotes], lostNotes: handed.filter((n) => !keptNotes.has(n)), tabB: tabB.map((x) => x.why), tabA: outA.map((x) => x.why) };
  console.log('FACTS ' + JSON.stringify(facts));
  assert.equal(handed.length, 2, 'both wallets handed their notes over');
  assert.deepEqual(facts.lostNotes, [], `notes that left a wallet are kept nowhere in the browser (lost): ${facts.lostNotes.join(', ')}`);
});
