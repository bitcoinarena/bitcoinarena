// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// ADD TO BOND - THE DEFAULT WAY TO RAISE A BOND (kanban #544, 2026-10-19 ~22:15Z: "This needs to be possible so add the ticket,
// this is also the default way. E.g increase your bond by 32000 sats"; spec §5A "Multiple bond outputs"): a second bond output
// beside the first, built by the same buildBond with no old bond - its own advertisement, the same node key and operator, its own
// maturity - and the first bond untouched. From protocol 19 the census counts a node's outputs as their sum (census.js nodeBonds).
// `arena-install --add-bond <sats>` and the owner page's "Add to bond" show the plan (the amount, the fees, the new total, the
// maturity); with --yes / the confirm it is posted and recorded in the state's `bonds`.
import { DatabaseSync } from 'node:sqlite';
import { walletOf, payoutKeyOf, coinsOf, broadcast, txSeen } from './wallet.js';
import { buildBond, lockOf, MARKER_SATS, EMERGENCY_IN_ADVERT } from './bond.js';
import { bondsOf } from './state.js';
import { onchainAction, resumeOpen, openActionOf } from './onchain-action.js';

/** The same "Add" asked again within this long - the owner page's double click, an answer lost - is the one done, not a second output
 *  (kanban #1165); a page that names its own `key` for each confirm is told apart by it instead. */
export const ADD_BOND_SAME_MS = 10 * 60000;
/** The transactions' bytes stay on the machine: a plan as the owner page is answered. */
const planWithoutBytes = ({ funding, bondTx, ...plan }) => plan;
import { emergencyOf } from './seed.js';
import { fromHex } from '../../arena-protocol/src/hash.js';

/**
 * Plan (and with `post`, broadcast) an added bond output of `addSats`. `guardianOf` the node's guardian seats as its newest
 * advertisement names them - from protocol 19 the newest advertisement over all a node's outputs decides, so the added one repeats
 * them. Answers { ok, plan } / { ok, plan, bond, bonds } or { ok: false, why }.
 * THE POST IS AN ON-CHAIN ACTION (kanban #1165, onchain-action.js): written before it is sent, finished - never built again - when asked
 * again; the same add asked again (`key`, else the same amount within ADD_BOND_SAME_MS) answers the one done; the output is added to
 * the bonds as they are when it is through (the outputs read before the broadcast are never written back).
 */
export async function addBond({ state, addSats, post = false, chainKit = { coinsOf, broadcast, seen: txSeen }, softwareHash, feeRate = 2, guardianEndpoint = null,
  guardianOf = [], nowMs = Date.now(), key = null }) {
  let add;
  try { add = BigInt(addSats); } catch { return { ok: false, why: `not an amount of sat: ${addSats}` }; }
  // the dust floor of a taproot output, the only floor an added output has: the round's bond_min is the sum's (protocol 19)
  if (add < MARKER_SATS) return { ok: false, why: `an added bond output is at least ${MARKER_SATS} sat` };
  if (!post) {
    await resumeOpen(state, { chainKit });   // an add sent before and not through yet: finished first, so the plan reads the coins after it
    const p = await addBondPlan({ state, s: state.read(), add, chainKit, softwareHash, feeRate, guardianEndpoint, guardianOf, nowMs });
    return p.ok ? { ok: true, plan: p.plan } : p;
  }
  const r = await onchainAction({ state, kind: 'add-bond', key: key ? `key ${key}` : `${add} sat`, sameWithinMs: key ? 0 : ADD_BOND_SAME_MS, chainKit,
    build: async (s) => {
      const p = await addBondPlan({ state, s, add, chainKit, softwareHash, feeRate, guardianEndpoint, guardianOf, nowMs });
      if (!p.ok) return p;
      const { built, tip, plan } = p;
      const bond = { txid: built.bond.txid, vout: 0, fundingTxid: built.funding.txid, sats: String(built.bondSats), maturity: built.maturity, advertId: built.advertId, postedAtTip: tip,
        lock: plan.lock, atMs: Date.now(), added: true };
      return { ok: true, tip, txs: [{ name: 'funding', hex: built.funding.hex }, { name: 'bond', hex: built.bond.hex }],
        ops: [{ op: 'push', key: 'bonds', values: [bond] }], result: { plan: planWithoutBytes(plan), bond } };
    } });
  if (!r.ok) return r;
  return { ok: true, plan: r.result.plan, bond: r.result.bond, bonds: bondsOf(state.read()), ...(r.already ? { already: true } : {}) };
}

/** The plan of an added output on the state `s`: { ok, plan, built, tip } or { ok: false, why }. */
async function addBondPlan({ state, s, add, chainKit, softwareHash, feeRate, guardianEndpoint, guardianOf, nowMs }) {
  const outputs = bondsOf(s);
  if (!outputs.length) return { ok: false, why: 'this node has no bond yet: set up its first bond in the owner area (Bond)' };
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
  return { ok: true, plan, built, tip };
}

/**
 * ADD TO BOND ON AN INSTALLED NODE: `home` the installer's home, `release` the release folder it runs - the software hash of its
 * COMMIT, its guardian endpoint and (a custody node's) guardian seat for the added output's advertisement, as the wizard's bond has
 * them. Used by `arena-install --add-bond` and the owner page (POST /owner/add-bond).
 */
export async function addBondOnNode({ home, release, addSats, post = false, chainKit, state = null, key = null }) {
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
  return addBond({ state: st, addSats, post, key, softwareHash, guardianOf, guardianEndpoint: (guardianSetupOf(s, { release }) || {}).endpoint || null,
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
export async function firstBond({ state, post = false, chainKit = { coinsOf, broadcast, seen: txSeen }, softwareHash, guardianEndpoint = null, askMinimum = null,
  startAgent = null, feeRate = 2, nowMs = Date.now() }) {
  // A FIRST BOND SENT AND NOT RECORDED (kanban #1165: a crash, a lost answer, the wizard's post beside this one): finished first - the Bond
  // panel asks every 30 s, so a bond broadcast before a crash is recorded within the minute - and never built a second time
  if (openActionOf(state.read())) await resumeOpen(state, { chainKit });
  let s = state.read();
  // A BONDED CUSTODY OR LIQUIDITY NODE WITHOUT ITS AGENT (kanban #2464, #1489 sm1-node-4): the bond is recorded by its on-chain action
  // before the agent is installed, so a seat that died between the two (or an install that failed once) answered "done" here for good and
  // the agent was never installed (no guardian_of, no peg-in, no deposit). Every ask on a recorded bond now installs a missing agent first.
  if (bondsOf(s).length) {
    const agent = await agentIfMissing({ state, startAgent, nowMs });
    return { ok: true, done: true, bond: s.bond || bondsOf(s)[0], ...(agent ? { agent } : {}) };
  }
  if (!(s.done || {}).service) return { ok: false, why: 'this node is not installed yet: its bond is signed with its own key' };
  const seedHex = state.readSecret('seed.hex');
  if (!seedHex) return { ok: false, why: 'the wallet seed is not in this node\'s home' };
  const { depositParts, bondMinimumOf, CUSTODY_PEG_IN_SATS } = await import('./wizard.js');
  if (askMinimum && !(s.bondMinimum && nowMs - Number(s.bondMinimum.atMs || 0) < 600000)) {
    try { const m = await askMinimum(); if (m && Number(m.sats) > 0) s = state.save({ bondMinimum: { sats: m.sats, from: m.from || [], why: m.why || null, atMs: nowMs } }); } catch { /* the one kept */ }
  }
  const seed = fromHex(seedHex);
  const w = walletOf(seed);
  const planOf = async (s, light) => {
    // THE PLAN IS A LIGHT READ (the 2026.1.9.11 install test: the Bond panel asks it every 30 s and each answer took 14-18 s): the UTXO scan of
    // this tip is used again (wallet.js coinsOf reuseScan), the mempool still read; the post reads the chain afresh
    const { tip, coins } = await chainKit.coinsOf(s.chain, w.spk, ...(light ? [{ reuseScan: true }] : []));
    const custody = (s.roles || []).includes('custody');
    const parts = depositParts(s, custody ? Math.max(0, Math.floor(Number((s.custody || {}).pegInSats ?? CUSTODY_PEG_IN_SATS))) : 0);
    const needSats = Object.values(parts).reduce((a, x) => a + Number(x), 0);
    const walletSats = coins.reduce((a, c) => a + Number(c.sats), 0);
    const confirmingSats = coins.filter((c) => !(Number(c.height) > 0)).reduce((a, c) => a + Number(c.sats), 0);
    const bondSats = BigInt(bondMinimumOf(s));
    return { tip, coins, bondSats, plan: { address: w.address, bondSats: String(bondSats), minimumWhy: (s.bondMinimum || {}).why || null, parts, needSats, walletSats, confirmingSats,
      shortSats: Math.max(0, needSats - walletSats), enough: walletSats >= needSats, tip, lock: lockOf(tip), countsAfter: 6 } };
  };
  if (!post) {
    const { plan } = await planOf(s, true);
    const open = openActionOf(state.read());
    return { ok: true, plan: open ? { ...plan, sending: { kind: open.kind, txids: open.txs.map((t) => t.txid), why: open.why || null } } : plan };
  }
  let planned = null;
  const { SUPPORTED_PROTOCOL_VERSIONS } = await import('../../arena-protocol/src/constants.js');
  // THE FIRST BOND IS AN ON-CHAIN ACTION OF ITS OWN KIND (kanban #1165), built only on a state with no bond (compare-and-set): the wizard's bond step posts the same kind ('first-bond')
  const r = await onchainAction({ state, kind: 'first-bond', chainKit,
    build: async (s2) => {
      if (bondsOf(s2).length) return { ok: false, alreadyBond: s2.bond || bondsOf(s2)[0] };   // recorded meanwhile (an older wizard, another tab)
      const { tip, coins, bondSats, plan } = await planOf(s2, false);
      planned = plan;
      if (!plan.enough) return { ok: false, why: `the wallet holds ${plan.walletSats} sat: send ${plan.shortSats} sat more to ${w.address} first`, plan };
      const db = new DatabaseSync(state.path('node.db'), { readOnly: true });
      let nodeSecret;
      try { nodeSecret = new Uint8Array(db.prepare('SELECT secret FROM identity WHERE one = 0').get().secret); } finally { db.close(); }
      let built;
      try {
        built = buildBond({ hostedGames: s2.hostedGames, wallet: w, nodeSecret, coins, tip, bondSats, operatorId: `op-${s2.owner.pubkey.slice(0, 12)}`, roles: s2.roles,
          endpoint: s2.reach.url, payoutPubkey: payoutKeyOf(seed), softwareHash, feeRate, guardianEndpoint, nowMs,
          emergencyPubkey: EMERGENCY_IN_ADVERT ? fromHex(emergencyOf(seed).pubkey) : null });
      } catch (e) { return { ok: false, why: e.message, plan }; }
      const bond = { txid: built.bond.txid, vout: 0, fundingTxid: built.funding.txid, sats: String(built.bondSats), maturity: built.maturity, advertId: built.advertId, postedAtTip: tip,
        lock: lockOf(tip, { maturity: built.maturity }), atMs: nowMs, fromOwnerArea: true };
      // the wizard's mark('bond'): the step done, and what its advertisement declares (change-roles refreshHostedGames)
      return { ok: true, tip, txs: [{ name: 'funding', hex: built.funding.hex }, { name: 'bond', hex: built.bond.hex }],
        ops: [{ op: 'set', key: 'bond', value: bond }, { op: 'set', key: 'advertProtocols', value: [...SUPPORTED_PROTOCOL_VERSIONS] }, { op: 'done', step: 'bond' }], result: { plan, bond } };
    } });
  if (r.alreadyBond) return { ok: true, done: true, bond: r.alreadyBond };
  if (!r.ok) return r.plan || !planned ? r : { ...r, plan: planned };
  const plan = r.result.plan, bond = r.result.bond;
  // A CUSTODY OR LIQUIDITY NODE'S AGENT, as the wizard's bond step starts it (custody-agent.js: guardian_of, the peg-in, the deposit)
  const agent = await agentIfMissing({ state, startAgent, nowMs });
  return { ok: true, plan, bond, agent };
}

/**
 * The custody agent of a bonded custody or liquidity node, installed when it is not recorded installed (kanban #2464): idempotent (the
 * install is a service unit written again), a failed install kept as { why } with no installedMs - tried again at the next ask. Not on a
 * node whose custody is still to be added to its bond's advertisement (the wizard's custody-advert step installs it then). Null when
 * nothing was to do.
 */
async function agentIfMissing({ state, startAgent, nowMs }) {
  const s = state.read();
  if (!startAgent || !bondsOf(s).length || ((s.custodyAgent || {}).installedMs)) return null;
  const custody = (s.roles || []).includes('custody');
  if (!custody && !(s.roles || []).includes('liquidity')) return null;
  if (custody && s.custodyLater && !(s.bond || {}).custodyAdvert) return null;
  let agent;
  try { agent = await startAgent(); } catch (e) { agent = { ok: false, why: e.message }; }
  state.save({ custodyAgent: agent && agent.ok ? { installedMs: nowMs } : { why: (agent && agent.why) || 'not started' } });
  return agent;
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
