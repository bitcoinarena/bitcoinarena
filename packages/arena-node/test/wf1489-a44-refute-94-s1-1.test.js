// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 a44 refute of #1849 (variant 1): THE SET LISTED THE CLAIM AS ACCEPTED, THEN THE FEDERATION CAME BACK BEFORE THE PAYOUT.
// The #1849 return runs only `!taken`, and a posted record is dropped as soon as a signed event lists its payout key accepted
// (kanban #1230). The set lists claims as it takes them, during the window; once 2f + 1 guardians return before the window's end,
// no seat lists the federation HALTED, plan() answers "not being liquidated" and pays nothing - and the page has already dropped
// the e-cash string, so nothing can ever receive it back. Same effect as #1849: the whole balance out of the wallet, unpaid.
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

test('#1489 a44-refute-94-s1-1 a claim the set listed as accepted is paid or back in the wallet when the federation comes back before the payout', async () => {
  let tip = 1012, recovered = false;
  const claims = createLiquidationClaims({
    validate: async (_fid, e) => (NOTES[e] ? { ok: true, notes: NOTES[e], amountMsat: NOTES[e].reduce((a, n) => a + n.amountMsat, 0n) } : { ok: false, why: 'not notes' }),
    liquidationOf: async (fid) => (fid === FED && !recovered ? LIQ : null),
    height: async () => tip, escrowMsatOf: async () => 10_000_000n, clocks: REGTEST_CLOCKS });
  let walletMsat = 768000n;
  const wallet = {
    sendAllEcash: async () => { const m = walletMsat; walletMsat = 0n; return JSON.stringify(m ? { msat: Number(m), ecash: 'notes-of-the-wallet' } : { msat: 0, ecash: null }); },
    receiveEcash: async (e) => { if (NOTES[e]) walletMsat += NOTES[e].reduce((a, n) => a + n.amountMsat, 0n); return JSON.stringify({ state: 'Success' }); },
    pendingOutputs: async () => '[]',
  };
  const store = new Map();
  const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) };
  const fetcher = async (_url, o) => {
    const r = await claims.offer(JSON.parse(o.body));
    return { ok: !!r.ok, status: r.ok ? 200 : (r.status || 409), json: async () => JSON.parse(JSON.stringify(r, (_k, v) => (typeof v === 'bigint' ? String(v) : v))) };
  };
  const PK = '02' + '33'.repeat(32);
  const base = { kind: 'liquidation', network: 'regtest', federation: FED, status: 'claims open', halt: { height: 1000, proof: null }, door: 'http://arb.example', firstMs: 1 };
  const opened = SET.sign({ ...base, atMs: 1 });
  // the set's next signed event lists what it took so far: this payout key's claim, accepted
  const listed = SET.sign({ ...base, atMs: 2, claims: { accepted: [{ payoutPk: PK, nonce: NOTES['notes-of-the-wallet'][0].nonce, amountMsat: '512000' }, { payoutPk: PK, nonce: NOTES['notes-of-the-wallet'][1].nonce, amountMsat: '256000' }] } });
  const pass = (events, nowMs) => presentNotes({ events, network: 'regtest', arbitration: SET.terms, verify: SET.verify, held: [FED],
    walletFor: async () => wallet, payoutPk: PK, height: tip, storage, fetcher, put: (s, k, v) => s.setItem(k, v), nowMs });

  const first = await pass([opened], 1_000_000);
  assert.equal(first[0].ok, true, JSON.stringify(first));
  assert.equal(walletMsat, 0n);
  tip = 1013;
  const second = await pass([listed], 1_000_000 + 3_700_000);
  // the guardians come back before the window's end: nobody lists the federation as being liquidated any more
  recovered = true;
  const later = [];
  for (let i = 2; i <= 5; i++) { tip = 1013 + i; later.push(await pass([listed], 1_000_000 + i * 3_700_000)); }
  tip = 1101;
  later.push(await pass([listed], 1_000_000 + 6 * 3_700_000));
  const plan = await claims.plan(FED);
  const rec = store.get(pendingClaimKey(FED));
  console.log('  FACTS:', JSON.stringify({ second, walletMsat: String(walletMsat), pageRecord: rec ? JSON.parse(rec).state : null, plan: { ok: plan.ok, why: plan.why }, last: later.at(-1) }));
  const paid = plan.ok && (plan.payouts || []).some((p) => p.payoutPk === PK && BigInt(p.msat) > 0n);
  assert.ok(paid || walletMsat === 768000n, `accepted, then the federation came back: the set pays nothing (${plan.why}), the page dropped its notes (wallet ${walletMsat} msat, record ${rec})`);
});
