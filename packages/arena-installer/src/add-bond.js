// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// ADD TO BOND - THE DEFAULT WAY TO RAISE A BOND (kanban #544, 2026-10-19 ~22:15Z: "This needs to be possible so add the ticket,
// this is also the default way. E.g increase your bond by 32000 sats"; spec §5A "Multiple bond outputs"): a second bond output
// beside the first, built by the same buildBond with no old bond - its own advertisement, the same node key and operator, its own
// maturity - and the first bond untouched. From protocol 19 the census counts a node's outputs as their sum (census.js nodeBonds).
// `arena-install --add-bond <sats>` and the owner page's "Add to bond" show the plan (the amount, the fees, the new total, the
// maturity); with --yes / the confirm it is posted and recorded in the state's `bonds`.
import { DatabaseSync } from 'node:sqlite';
import { walletOf, payoutKeyOf, coinsOf, broadcast } from './wallet.js';
import { buildBond, lockOf, MARKER_SATS, EMERGENCY_IN_ADVERT } from './bond.js';
import { bondsOf } from './state.js';
import { emergencyOf } from './seed.js';
import { fromHex } from '../../arena-protocol/src/hash.js';

/**
 * Plan (and with `post`, broadcast) an added bond output of `addSats`. `guardianOf` the node's guardian seats as its newest
 * advertisement names them - from protocol 19 the newest advertisement over all a node's outputs decides, so the added one repeats
 * them. Answers { ok, plan } / { ok, plan, bond, bonds } or { ok: false, why }.
 */
export async function addBond({ state, addSats, post = false, chainKit = { coinsOf, broadcast }, softwareHash, feeRate = 2, guardianEndpoint = null,
  guardianOf = [], nowMs = Date.now() }) {
  const s = state.read();
  const outputs = bondsOf(s);
  if (!outputs.length) return { ok: false, why: 'this node has no posted bond to add to: post one in the wizard first' };
  let add;
  try { add = BigInt(addSats); } catch { return { ok: false, why: `not an amount of sat: ${addSats}` }; }
  // the dust floor of a taproot output, the only floor an added output has: the round's bond_min is the sum's (protocol 19)
  if (add < MARKER_SATS) return { ok: false, why: `an added bond output is at least ${MARKER_SATS} sat` };
  const seedHex = state.readSecret('seed.hex');
  if (!seedHex) return { ok: false, why: 'the wallet seed is not in this node\'s home' };
  const seed = fromHex(seedHex);
  const w = walletOf(seed);
  const { tip, coins } = await chainKit.coinsOf(s.chain, w.spk);
  const db = new DatabaseSync(state.path('node.db'), { readOnly: true });
  let nodeSecret;
  try { nodeSecret = new Uint8Array(db.prepare('SELECT secret FROM identity WHERE one = 0').get().secret); } finally { db.close(); }
  let built;
  try {
    built = buildBond({ hostedGames: s.hostedGames, wallet: w, nodeSecret, coins, tip, bondSats: add, operatorId: `op-${s.owner.pubkey.slice(0, 12)}`, roles: s.roles,
      endpoint: s.reach.url, payoutPubkey: payoutKeyOf(seed), softwareHash, feeRate, guardianEndpoint, nowMs, guardianOf,
      emergencyPubkey: EMERGENCY_IN_ADVERT ? fromHex(emergencyOf(seed).pubkey) : null });
  } catch (e) { return { ok: false, why: e.message }; }
  const now = outputs.reduce((a, b) => a + BigInt(b.sats), 0n);
  const plan = { addSats: String(add), outputs: outputs.map((b) => ({ txid: b.txid, vout: b.vout || 0, sats: String(b.sats), maturity: b.maturity })),
    bondSats: String(now), totalSats: String(now + add), coins: coins.map((c) => ({ txid: c.txid, vout: c.vout, sats: c.sats })),
    changeSats: String(built.changeSats), fees: { funding: String(built.fees.funding), bond: String(built.fees.bond), total: String(built.fees.funding + built.fees.bond) },
    maturity: built.maturity, lock: lockOf(tip, { maturity: built.maturity }), tip, countsAfter: 6,
    funding: { txid: built.funding.txid, hex: built.funding.hex }, bondTx: { txid: built.bond.txid, hex: built.bond.hex } };
  if (!post) return { ok: true, plan };
  const fundingTxid = await chainKit.broadcast(s.chain, built.funding.hex);
  const bondTxid = await chainKit.broadcast(s.chain, built.bond.hex);
  const bond = { txid: bondTxid, vout: 0, fundingTxid, sats: String(built.bondSats), maturity: built.maturity, advertId: built.advertId, postedAtTip: tip,
    lock: plan.lock, atMs: Date.now(), added: true };
  const bonds = [...outputs, bond];
  state.save({ bonds });
  return { ok: true, plan, bond, bonds };
}

/**
 * ADD TO BOND ON AN INSTALLED NODE: `home` the installer's home, `release` the release folder it runs - the software hash of its
 * COMMIT, its guardian endpoint and (a custody node's) guardian seat for the added output's advertisement, as the wizard's bond has
 * them. Used by `arena-install --add-bond` and the owner page (POST /owner/add-bond).
 */
export async function addBondOnNode({ home, release, addSats, post = false, chainKit, state = null }) {
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { sha256 } = await import('../../arena-protocol/src/hash.js');
  const { nodeState, guardianSetupOf } = await import('./state.js');
  const st = state || nodeState(home);
  let softwareHash; try { softwareHash = sha256(readFileSync(join(release, 'COMMIT'))); } catch { softwareHash = new Uint8Array(32); }
  const s = st.read();
  let guardianOf = [];
  if ((s.custody || {}).guardianOf) {
    try {
      const { guardianOfEntry } = await import('./custody-agent.js');
      const g = guardianOfEntry(st.path('node.db.guardian'));
      if (g) guardianOf = [{ federationId: fromHex(g.federationId), guardianKey: fromHex(g.guardianKey) }];
    } catch { /* no guardian seat to repeat */ }
  }
  return addBond({ state: st, addSats, post, softwareHash, guardianOf, guardianEndpoint: (guardianSetupOf(s, { release }) || {}).endpoint || null,
    ...(chainKit ? { chainKit } : {}) });
}
