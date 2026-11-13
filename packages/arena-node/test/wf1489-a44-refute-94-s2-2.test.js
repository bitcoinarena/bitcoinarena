// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 a44 refute of #1849, skeptic 2 (attacker: ONE SEAT). GET /liquidations is any seat's list - it "can withhold, not forge".
// During a second halt of the same federation one seat lists only the FIRST halt's signed event (it lists this payout key accepted) and
// withholds the second halt's. standingLiquidation stands on the newest event it is shown, `taken` reads that old acceptance, and the
// second halt's posted record - which the set never listed - is moved to the taken notes and let go at once on the first halt's payout
// (GET /liquidation-payouts names no halt). The federation comes back before the second window's end: nothing paid, nothing to receive back.
// Invariant: notes a player handed to a liquidation are either paid from the escrow or back in the player's wallet.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { eventMessage } from '../../arena-protocol/src/arbitration-event.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { createLiquidationClaims } from '../src/liquidation-claims.js';
import { presentNotes, pendingClaimKey, takenClaimKey } from '../../arena-client/src/liquidation-claim.js';
import { REGTEST_CLOCKS } from '../../arena-protocol/src/federation-slash.js';

const FED = 'ab'.repeat(32);
const PK = '02' + '33'.repeat(32);
const NOTES = {
  'notes-halt-1': [{ nonce: '02' + 'a1'.repeat(32), amountMsat: 512000n }],
  'notes-halt-2': [{ nonce: '02' + 'b1'.repeat(32), amountMsat: 512000n }, { nonce: '02' + 'b2'.repeat(32), amountMsat: 256000n }],
};
const SET = (() => {
  const secrets = [1, 2, 3].map((n) => new Uint8Array(32).fill(n));
  const keys = secrets.map((x) => toHex(schnorr.getPublicKey(x)));
  return { terms: { keys, k: 2 }, verify: (sig, msg, key) => schnorr.verify(sig, msg, key),
    sign: (event) => ({ event, signatures: secrets.slice(0, 2).map((x, i) => ({ key: keys[i], sig: toHex(schnorr.sign(eventMessage(event), x)) })) }) };
})();
const LIQ1 = { federation: FED, haltHeight: 1000, liquidatesAt: 1010, claimWindowCloses: 1020, lateClaimsUntil: 1100, spentNonces: [] };
const LIQ2 = { federation: FED, haltHeight: 2000, liquidatesAt: 2010, claimWindowCloses: 2020, lateClaimsUntil: 2100, spentNonces: [] };
const sum = (e) => NOTES[e].reduce((a, n) => a + n.amountMsat, 0n);

test('#1489 a44-refute-94-s2-2 one seat replaying the first halt\'s signed event does not make the page let a second halt\'s notes go', async () => {
  let tip = 1012, liq = LIQ1;
  const claims = createLiquidationClaims({
    validate: async (_fid, e) => (NOTES[e] ? { ok: true, notes: NOTES[e], amountMsat: sum(e) } : { ok: false, why: 'not notes' }),
    liquidationOf: async (fid) => (fid === FED ? liq : null),
    height: async () => tip, escrowMsatOf: async () => 10_000_000n, clocks: REGTEST_CLOCKS });
  const payouts = [];   // the set's GET /liquidation-payouts book: federation, payoutPk, msat - no halt named
  let walletMsat = 512000n, walletNotes = 'notes-halt-1';
  const wallet = {
    sendAllEcash: async () => { const m = walletMsat, e = walletNotes; walletMsat = 0n; walletNotes = null; return JSON.stringify(m ? { msat: Number(m), ecash: e } : { msat: 0, ecash: null }); },
    receiveEcash: async (e) => { if (NOTES[e]) walletMsat += sum(e); return JSON.stringify({ state: 'Success' }); },
    pendingOutputs: async () => '[]',
  };
  const store = new Map();
  const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) };
  const fetcher = async (url, o) => {
    if (String(url).includes('/liquidation-payouts')) return { ok: true, status: 200, json: async () => ({ network: 'regtest', payouts: payouts.filter((p) => p.federation === FED) }) };
    const r = await claims.offer(JSON.parse(o.body));
    return { ok: !!r.ok, status: r.ok ? 200 : (r.status || 409), json: async () => JSON.parse(JSON.stringify(r, (_k, v) => (typeof v === 'bigint' ? String(v) : v))) };
  };
  const ev = (h, atMs, accepted) => SET.sign({ kind: 'liquidation', network: 'regtest', federation: FED, status: 'claims open', halt: { height: h, proof: null },
    door: 'http://arb.example', firstMs: 1, atMs, ...(accepted ? { claims: { accepted: accepted.map((n) => ({ payoutPk: PK, nonce: n.nonce, amountMsat: String(n.amountMsat) })) } } : {}) });
  const pass = (events, nowMs) => presentNotes({ events, network: 'regtest', arbitration: SET.terms, verify: SET.verify, held: [FED],
    walletFor: async () => wallet, payoutPk: PK, height: tip, storage, fetcher, put: (s, k, v) => s.setItem(k, v), nowMs });

  // HALT 1: handed over, accepted, paid (the set locked 512000 msat to PK) - the page lets the taken notes go
  await pass([ev(1000, 1)], 1_000_000);
  tip = 1013; await pass([ev(1000, 2, NOTES['notes-halt-1'])], 1_000_000 + 3_700_000);
  payouts.push({ federation: FED, into: 'cd'.repeat(32), payoutPk: PK, msat: '512000', txid: 'ee'.repeat(32), outIdx: 0 });
  tip = 1101; await pass([ev(1000, 2, NOTES['notes-halt-1'])], 1_000_000 + 2 * 3_700_000);
  assert.equal(store.get(takenClaimKey(FED, PK)), undefined, 'halt 1 paid: its taken notes let go');

  // the guardians came back; the player plays again and holds 768000 msat of new notes. HALT 2 of the same federation.
  liq = LIQ2; walletMsat = 768000n; walletNotes = 'notes-halt-2'; tip = 2012;
  const h2a = await pass([ev(1000, 2, NOTES['notes-halt-1']), ev(2000, 10)], 10_000_000);
  assert.equal(walletMsat, 0n, JSON.stringify(h2a));
  tip = 2013;
  // the seat this pass reads lists only halt 1's event (signed, real) - halt 2's withheld
  const h2b = await pass([ev(1000, 2, NOTES['notes-halt-1'])], 10_000_000 + 3_700_000);
  // halt 2's guardians come back before the window's end
  liq = null;
  const later = [];
  for (let i = 2; i <= 5; i++) { tip = 2013 + i; later.push(await pass([ev(1000, 2, NOTES['notes-halt-1']), ev(2000, 11, NOTES['notes-halt-2'])], 10_000_000 + i * 3_700_000)); }
  const plan = await claims.plan(FED);
  console.log('  FACTS:', JSON.stringify({ h2b, walletMsat: String(walletMsat), record: store.get(pendingClaimKey(FED)) ?? null, taken: store.get(takenClaimKey(FED, PK)) ?? null, plan: { ok: plan.ok, why: plan.why }, last: later.at(-1) }));
  const paid2 = plan.ok && (plan.payouts || []).some((p) => p.payoutPk === PK && BigInt(p.msat) >= 768000n);
  assert.ok(paid2 || walletMsat === 768000n, `halt 2: accepted, then the federation came back - the set pays nothing (${plan.why}), and one seat's replay of halt 1's event had the page let the notes go (wallet ${walletMsat} msat)`);
});
