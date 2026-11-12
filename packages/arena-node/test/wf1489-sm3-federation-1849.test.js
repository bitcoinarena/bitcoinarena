// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 sm3-find-federation 2 (state machine audit, federation): A HALTED FEDERATION THAT COMES BACK DURING THE CLAIM WINDOW.
// The page hands every note of a halted federation's wallet to the arbitration set (presentNotes: sendAllEcash, the bearer string kept
// as 'posted'), and the set's book (liquidation-claims.js offer) keeps only each note's nonce, amount and payout key - the e-cash string
// itself is dropped. The file says "Should the federation come back (2f + 1 guardians return), the notes it bought are redeemed into the
// same escrow - the player was paid already"; but the player is paid only at the window's end (payOutLiquidation), and once the
// guardians move past the halted session no seat lists the federation at GET /liquidations (halts.js proofOf void, a newer OPEN record
// clears `halted`): liquidationOf answers null, plan() answers "not being liquidated", nothing is ever paid; the set holds no notes to
// redeem; and the page's kept record stays 'posted' for good (the door's 409 names no refused note), its notes never received back into
// the wallet. The player's whole balance in that federation is out of the wallet, unpaid, with nothing that ever moves it again.
// Invariant: notes a player handed to a liquidation are either paid from the escrow or back in the player's wallet.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { eventMessage } from '../../arena-protocol/src/arbitration-event.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { createLiquidationClaims } from '../src/liquidation-claims.js';
import { presentNotes, pendingClaimKey } from '../../arena-client/src/liquidation-claim.js';
import { REGTEST_CLOCKS } from '../../arena-protocol/src/federation-slash.js';

const FED = 'ab'.repeat(32);
const NOTES = { 'notes-of-the-wallet': [{ nonce: '02' + 'a1'.repeat(32), amountMsat: 512000n }, { nonce: '02' + 'a2'.repeat(32), amountMsat: 256000n }] };
const SET = (() => {
  const secrets = [1, 2, 3].map((n) => new Uint8Array(32).fill(n));
  const keys = secrets.map((x) => toHex(schnorr.getPublicKey(x)));
  return { terms: { keys, k: 2 }, verify: (sig, msg, key) => schnorr.verify(sig, msg, key),
    sign: (event) => ({ event, signatures: secrets.slice(0, 2).map((x, i) => ({ key: keys[i], sig: toHex(schnorr.sign(eventMessage(event), x)) })) }) };
})();
const LIQ = { federation: FED, haltHeight: 1000, liquidatesAt: 1010, claimWindowCloses: 1020, lateClaimsUntil: 1100, spentNonces: [] };

test('#1489 sm3-federation-2 notes handed to a liquidation are paid or back in the wallet when the federation comes back before the payout', async () => {
  let tip = 1012, recovered = false;
  const saved = [];
  const claims = createLiquidationClaims({
    validate: async (_fid, e) => (NOTES[e] ? { ok: true, notes: NOTES[e], amountMsat: NOTES[e].reduce((a, n) => a + n.amountMsat, 0n) } : { ok: false, why: 'not notes' }),
    // what every seat's GET /liquidations says: the federation HALTED - until its guardians move past the halted session
    liquidationOf: async (fid) => (fid === FED && !recovered ? LIQ : null),
    height: async () => tip, escrowMsatOf: async () => 10_000_000n, clocks: REGTEST_CLOCKS, save: (rows) => saved.push(rows) });
  // the page: one wallet of the halted federation, its notes, the arbitration set's signed liquidation, the door that event names
  let walletMsat = 768000n;
  const received = [];
  const wallet = {
    sendAllEcash: async () => { const m = walletMsat; walletMsat = 0n; return JSON.stringify(m ? { msat: Number(m), ecash: 'notes-of-the-wallet' } : { msat: 0, ecash: null }); },
    receiveEcash: async (e) => { received.push(e); if (NOTES[e]) walletMsat += NOTES[e].reduce((a, n) => a + n.amountMsat, 0n); return JSON.stringify({ state: 'Success' }); },
    pendingOutputs: async () => '[]',
  };
  const store = new Map();
  const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) };
  const fetcher = async (_url, o) => {
    const r = await claims.offer(JSON.parse(o.body));
    return { ok: !!r.ok, status: r.ok ? 200 : (r.status || 409), json: async () => JSON.parse(JSON.stringify(r, (_k, v) => (typeof v === 'bigint' ? String(v) : v))) };
  };
  const event = SET.sign({ kind: 'liquidation', network: 'regtest', federation: FED, status: 'claims open', halt: { height: 1000, proof: null },
    door: 'http://arb.example', firstMs: 1, atMs: 1 });
  const PK = '02' + '33'.repeat(32);
  const pass = (nowMs) => presentNotes({ events: [event], network: 'regtest', arbitration: SET.terms, verify: SET.verify, held: [FED],
    walletFor: async () => wallet, payoutPk: PK, height: tip, storage, fetcher, put: (s, k, v) => s.setItem(k, v), nowMs });

  // in the window: the wallet's notes handed over and taken by the set
  const first = await pass(1_000_000);
  assert.equal(first[0].ok, true, JSON.stringify(first));
  assert.equal(walletMsat, 0n, 'the notes left the wallet');
  assert.equal(JSON.parse(store.get(pendingClaimKey(FED))).state, 'posted');

  // the guardians come back (2f + 1 return, the session moves on): no seat lists the federation as being liquidated any more
  recovered = true;
  tip = 1015;
  const later = [];
  for (let i = 1; i <= 4; i++) later.push(await pass(1_000_000 + i * 3_700_000));   // the page's hourly re-presentations
  tip = 1101;                                                                       // past the claim window and drain_blocks
  later.push(await pass(1_000_000 + 5 * 3_700_000));
  const plan = await claims.plan(FED);
  const book = saved.at(-1) || [];
  const rec = store.get(pendingClaimKey(FED)) ? JSON.parse(store.get(pendingClaimKey(FED))) : null;
  console.log('  FACTS:', JSON.stringify({ walletMsat: String(walletMsat), received, pageRecord: rec && rec.state, plan: { ok: plan.ok, why: plan.why },
    bookRows: book.length, bookKeepsTheEcash: book.some((r) => JSON.stringify(r).includes('notes-of-the-wallet')),
    lastDoorAnswer: later.at(-1)[0] && later.at(-1)[0].why }));
  const paid = plan.ok && (plan.payouts || []).some((p) => p.payoutPk === PK && BigInt(p.msat) > 0n);
  assert.ok(paid || walletMsat === 768000n,
    `the federation came back: the set pays nothing (${plan.why}), holds no e-cash to redeem, and the page keeps its ${rec && rec.state} notes out of the wallet (wallet ${walletMsat} msat)`);
});
