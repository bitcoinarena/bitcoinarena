// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A LARGER BOND, IN ONE STEP: the bond the wizard posted, from its maturity on, plus the wallet's coins become one
// new, larger bond with a new lock (bond.js buildBond with `oldBond`). `arena-install --rebond <sats>` shows the plan; with --yes it
// broadcasts and records the new bond. Measured 2026-10-18 against testnet4 Bitcoin Core: test host seat 1's matured bond (50,000 sat,
// maturity 156,193) plus a 5,000 sat wallet coin into a 53,500 sat bond - both transactions accepted by testmempoolaccept (196 vB at
// 402 sat, 302 vB at 768 sat), never broadcast.
import { DatabaseSync } from 'node:sqlite';
import { walletOf, payoutKeyOf, coinsOf, broadcast, txSeen } from './wallet.js';
import { buildBond, lockOf, BOND_MIN_SATS } from './bond.js';
import { fromHex } from '../../arena-protocol/src/hash.js';
import { onchainAction, resumeOpen } from './onchain-action.js';

/**
 * Plan (and with `post`, broadcast) the larger bond. Answers { ok, plan } / { ok, bond } or { ok: false, why }.
 * THE POST IS AN ON-CHAIN ACTION (kanban #1165, onchain-action.js), once per bond replaced: written before it is sent, finished - never
 * built again - when asked again; the first output replaced in the bonds as they are when it is through.
 */
export async function rebond({ state, bondSats, post = false, chainKit = { coinsOf, broadcast, seen: txSeen }, softwareHash, feeRate = 2, guardianEndpoint = null }) {
  await resumeOpen(state, { chainKit });   // a rebond (or any action of the wallet) sent before and not recorded: finished first
  const s = state.read();
  const old = s.bond;
  if (!old || !old.txid) return { ok: false, why: 'this node has no posted bond to increase: post one in the wizard first' };
  const seedHex = state.readSecret('seed.hex');
  if (!seedHex) return { ok: false, why: 'the wallet seed is not in this node\'s home' };
  const seed = fromHex(seedHex);
  const w = walletOf(seed);
  let want;
  try { want = BigInt(bondSats); } catch { return { ok: false, why: `not an amount of sat: ${bondSats}` }; }
  if (want <= BigInt(old.sats)) return { ok: false, why: `the bond holds ${old.sats} sat already: name a larger amount` };
  if (want < BOND_MIN_SATS) return { ok: false, why: `a bond is at least ${BOND_MIN_SATS} sat` };
  const planOf = async (s) => {
    const { tip, coins } = await chainKit.coinsOf(s.chain, w.spk);
    const db = new DatabaseSync(state.path('node.db'), { readOnly: true });
    let nodeSecret;
    try { nodeSecret = new Uint8Array(db.prepare('SELECT secret FROM identity WHERE one = 0').get().secret); } finally { db.close(); }
    let built;
    try {
      built = buildBond({ hostedGames: s.hostedGames, wallet: w, nodeSecret, coins, tip, bondSats: want, operatorId: `op-${s.owner.pubkey.slice(0, 12)}`, roles: s.roles,
        endpoint: s.reach.url, payoutPubkey: payoutKeyOf(seed), softwareHash, feeRate, guardianEndpoint,
        oldBond: { txid: old.txid, vout: old.vout || 0, sats: old.sats, maturity: old.maturity } });
    } catch (e) { return { ok: false, why: e.message }; }
    const plan = { from: { txid: old.txid, sats: String(old.sats), maturity: old.maturity }, coins: coins.map((c) => ({ txid: c.txid, vout: c.vout, sats: c.sats })),
      bondSats: String(built.bondSats), changeSats: String(built.changeSats), fees: { funding: String(built.fees.funding), bond: String(built.fees.bond) },
      maturity: built.maturity, lock: lockOf(tip, { maturity: built.maturity }), tip };
    return { ok: true, plan, built, tip };
  };
  if (!post) { const p = await planOf(s); return p.ok ? { ok: true, plan: p.plan } : p; }
  const r = await onchainAction({ state, kind: `rebond ${old.txid}:${old.vout || 0}`, once: true, chainKit,
    build: async (s2) => {
      // compare-and-set: the bond this was asked for is still the first output
      if (!s2.bond || s2.bond.txid !== old.txid) return { ok: false, why: `the bond is ${s2.bond ? s2.bond.txid : 'gone'} now, not ${old.txid}: plan again` };
      const p = await planOf(s2);
      if (!p.ok) return p;
      const { built, tip, plan } = p;
      const bond = { txid: built.bond.txid, vout: 0, fundingTxid: built.funding.txid, sats: String(built.bondSats), maturity: built.maturity, advertId: built.advertId, postedAtTip: tip,
        lock: plan.lock, atMs: Date.now(), replaced: { txid: old.txid, sats: String(old.sats), maturity: old.maturity } };
      // the first output is the one replaced; outputs added beside it (add-bond.js) stay as they are
      return { ok: true, tip, txs: [{ name: 'funding', hex: built.funding.hex }, { name: 'bond', hex: built.bond.hex }],
        ops: [{ op: 'replace-first', value: bond }], result: { plan, bond } };
    } });
  if (!r.ok) return r;
  return { ok: true, plan: r.result.plan, bond: r.result.bond, ...(r.already ? { already: true } : {}) };
}
