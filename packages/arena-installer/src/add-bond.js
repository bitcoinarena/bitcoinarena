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
  if (!outputs.length) return { ok: false, why: 'this node has no bond yet: set up its first bond in the owner area (Bond)' };
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

/**
 * THE FIRST BOND, FROM THE OWNER AREA (kanban #728, 2026-10-27, the owner: "Du hast die Option es zu skippen und dann später einzurichten,
 * was aber nicht geht - Bug. Du musst in der Lage sein, den Bond später zu konfigurieren"): the installer's "I'll post it later" left the
 * node without a bond, and no owner door could post one (add-bond needs a bond to add to; the wizard that posts the first is gone once
 * the setup is finished). This is the wizard's bond step again: the node's own wallet (its seed's address), at least the network's
 * minimum, signed with the node's key. Without `post` the plan - the address, what to send, what has arrived; with `post` the funding and
 * bond transactions broadcast and kept as the state's `bond` (the dashboards then count its confirmations), and on a custody or
 * liquidity node its agent started, as the wizard starts it. `askMinimum` asks the seats the network's minimum (install-minimum.js), at
 * most every 10 minutes. Answers { ok, plan } / { ok, plan, bond } / { ok, done: true, bond } when a bond is posted already, or { ok: false, why }.
 */
export async function firstBond({ state, post = false, chainKit = { coinsOf, broadcast }, softwareHash, guardianEndpoint = null, askMinimum = null,
  startAgent = null, feeRate = 2, nowMs = Date.now() }) {
  let s = state.read();
  if (bondsOf(s).length) return { ok: true, done: true, bond: s.bond || bondsOf(s)[0] };
  if (!(s.done || {}).service) return { ok: false, why: 'this node is not installed yet: its bond is signed with its own key' };
  const seedHex = state.readSecret('seed.hex');
  if (!seedHex) return { ok: false, why: 'the wallet seed is not in this node\'s home' };
  const { depositParts, bondMinimumOf, CUSTODY_PEG_IN_SATS } = await import('./wizard.js');
  if (askMinimum && !(s.bondMinimum && nowMs - Number(s.bondMinimum.atMs || 0) < 600000)) {
    try { const m = await askMinimum(); if (m && Number(m.sats) > 0) s = state.save({ bondMinimum: { sats: m.sats, from: m.from || [], why: m.why || null, atMs: nowMs } }); } catch { /* the one kept */ }
  }
  const seed = fromHex(seedHex);
  const w = walletOf(seed);
  // THE PLAN IS A LIGHT READ (the 2026.1.9.11 install test: the Bond panel asks it every 30 s and each answer took 14-18 s): the UTXO scan of
  // this tip is used again (wallet.js coinsOf reuseScan), the mempool still read; the post reads the chain afresh
  const { tip, coins } = await chainKit.coinsOf(s.chain, w.spk, ...(post ? [] : [{ reuseScan: true }]));
  const custody = (s.roles || []).includes('custody');
  const parts = depositParts(s, custody ? Math.max(0, Math.floor(Number((s.custody || {}).pegInSats ?? CUSTODY_PEG_IN_SATS))) : 0);
  const needSats = Object.values(parts).reduce((a, x) => a + Number(x), 0);
  const walletSats = coins.reduce((a, c) => a + Number(c.sats), 0);
  const confirmingSats = coins.filter((c) => !(Number(c.height) > 0)).reduce((a, c) => a + Number(c.sats), 0);
  const bondSats = BigInt(bondMinimumOf(s));
  const plan = { address: w.address, bondSats: String(bondSats), minimumWhy: (s.bondMinimum || {}).why || null, parts, needSats, walletSats, confirmingSats,
    shortSats: Math.max(0, needSats - walletSats), enough: walletSats >= needSats, tip, lock: lockOf(tip), countsAfter: 6 };
  if (!post) return { ok: true, plan };
  if (!plan.enough) return { ok: false, why: `the wallet holds ${walletSats} sat: send ${plan.shortSats} sat more to ${w.address} first`, plan };
  const db = new DatabaseSync(state.path('node.db'), { readOnly: true });
  let nodeSecret;
  try { nodeSecret = new Uint8Array(db.prepare('SELECT secret FROM identity WHERE one = 0').get().secret); } finally { db.close(); }
  let built;
  try {
    built = buildBond({ hostedGames: s.hostedGames, wallet: w, nodeSecret, coins, tip, bondSats, operatorId: `op-${s.owner.pubkey.slice(0, 12)}`, roles: s.roles,
      endpoint: s.reach.url, payoutPubkey: payoutKeyOf(seed), softwareHash, feeRate, guardianEndpoint, nowMs,
      emergencyPubkey: EMERGENCY_IN_ADVERT ? fromHex(emergencyOf(seed).pubkey) : null });
  } catch (e) { return { ok: false, why: e.message, plan }; }
  const fundingTxid = await chainKit.broadcast(s.chain, built.funding.hex);
  const bondTxid = await chainKit.broadcast(s.chain, built.bond.hex);
  const bond = { txid: bondTxid, vout: 0, fundingTxid, sats: String(built.bondSats), maturity: built.maturity, advertId: built.advertId, postedAtTip: tip,
    lock: lockOf(tip, { maturity: built.maturity }), atMs: nowMs, fromOwnerArea: true };
  const { SUPPORTED_PROTOCOL_VERSIONS } = await import('../../arena-protocol/src/constants.js');
  // the wizard's mark('bond'): the step done, and what its advertisement declares (change-roles refreshHostedGames)
  state.save({ bond, advertProtocols: [...SUPPORTED_PROTOCOL_VERSIONS], done: { ...(state.read().done || {}), bond: nowMs } });
  // A CUSTODY OR LIQUIDITY NODE'S AGENT, as the wizard's bond step starts it (custody-agent.js: guardian_of, the peg-in, the deposit)
  let agent = null;
  if ((custody || (s.roles || []).includes('liquidity')) && startAgent && !((state.read().custodyAgent || {}).installedMs)) {
    try { agent = await startAgent(); } catch (e) { agent = { ok: false, why: e.message }; }
    state.save({ custodyAgent: agent && agent.ok ? { installedMs: nowMs } : { why: (agent && agent.why) || 'not started' } });
  }
  return { ok: true, plan, bond, agent };
}

/** THE FIRST BOND ON AN INSTALLED NODE (kanban #728): POST /owner/first-bond - the release's software hash and guardian endpoint, as addBondOnNode. */
// ONE PLAN READ AT A TIME PER NODE (the 2026.1.9.11 install test, kanban #728): a second ask while one runs (two tabs, a reload) waits for that
// one's answer instead of reading the chain again; the post is never shared
const planReads = new Map();   // home -> Promise
export async function firstBondOnNode(o) {
  if (o.post) return firstBondOnNodeNow(o);
  const key = String(o.home || (o.state && o.state.home) || '');
  if (planReads.has(key)) return planReads.get(key);
  const p = firstBondOnNodeNow(o).finally(() => planReads.delete(key));
  planReads.set(key, p);
  return p;
}
async function firstBondOnNodeNow({ home, release, post = false, chainKit, state = null, askMinimum, startAgent }) {
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { sha256 } = await import('../../arena-protocol/src/hash.js');
  const { nodeState, guardianSetupOf } = await import('./state.js');
  const st = state || nodeState(home);
  let softwareHash; try { softwareHash = sha256(readFileSync(join(release, 'COMMIT'))); } catch { softwareHash = new Uint8Array(32); }
  const ask = askMinimum !== undefined ? askMinimum : async () => (await import('./install-minimum.js')).installMinimum({});
  const start = startAgent !== undefined ? startAgent : async () => (await import('./service.js')).installProgram({ id: 'custody', description: 'Bitcoin Arena: custody agent',
    home: st.home || home, boot: true, args: [process.execPath, join(release, 'packages', 'arena-installer', 'bin', 'custody-agent.mjs'), '--home', st.home || home] });
  return firstBond({ state: st, post, softwareHash, guardianEndpoint: (guardianSetupOf(st.read(), { release }) || {}).endpoint || null, askMinimum: ask, startAgent: start,
    ...(chainKit ? { chainKit } : {}) });
}
