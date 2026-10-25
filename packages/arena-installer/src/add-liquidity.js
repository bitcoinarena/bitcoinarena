// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// AN INSTALLED NODE BECOMES A LIQUIDITY PROVIDER FROM ITS OWNER PAGE (kanban #567, 2026-10-21: the Liquidity provider card still
// said "run arena-install again"; owner actions happen in the browser): what the wizard's bond step does for a node that chose the role
// (wizard.js) - the provider service on the node's LND (bin/liquidity-provider.mjs, its node key beside the node's other secrets), the
// custody agent that sends the deposit (5 x L from the node's wallet into LND's, custody-agent.js), 'liquidity' in the node's roles and
// its settings (arena.conf: the claim file the seat serves). No advertisement update: the role is the claim the provider signs.
// It needs the node's own Bitcoin Core. A node without LND gets it here as in the wizard's Lightning step (lnd-setup.js): the confirm
// installs and starts it and answers `waiting`; the page confirms again until LND answers, then the provider is set up.
// Answers { ok, plan } / { ok, plan, waiting } / { ok, plan, done } or { ok: false, why }.
import { join } from 'node:path';
import { LIQUIDITY_TERMS } from '../../arena-protocol/src/liquidity.js';
import { fromHex } from '../../arena-protocol/src/hash.js';
import { walletOf, coinsOf } from './wallet.js';
import { testLnd } from './lnd.js';
import { setUpOwnLnd, lndReady } from './lnd-setup.js';
import { installProgram } from './service.js';
import { nodeState, seatConf, LIQUIDITY_PROVIDER_PORT, ownCoreOf } from './state.js';

/** The deposit's fee allowance: the send the custody agent builds (one input or a few, one output and change). */
export const DEPOSIT_FEE_SATS = 1000;

export async function addLiquidityOnNode({ home, release, post = false, state = null, network = 'testnet4', node = process.execPath,
  kit = { coinsOf, testLnd, installProgram, setUpOwnLnd, lndReady }, nowMs = Date.now() }) {
  const st = state || nodeState(home);
  let s = st.read();
  if ((s.roles || []).includes('liquidity')) return { ok: false, why: 'this node is a liquidity provider already' };
  if (!s.chain || !ownCoreOf(s)) return { ok: false, why: 'a liquidity provider needs your own Bitcoin Core: LND cannot run on an Electrum server' };
  // its LND: to install here, installed and still starting (no pubkey yet), or running and answering
  const lightning = !s.lightning || !s.lightning.lnddir ? 'install' : !s.lightning.pubkey ? 'starting' : 'running';
  let t = { ok: true, pubkey: null };
  if (lightning === 'running') {
    t = await kit.testLnd(s.lightning);
    if (!t.ok) return { ok: false, why: `LND does not answer: ${t.why}` };
  }
  const seedHex = st.readSecret('seed.hex');
  if (!seedHex) return { ok: false, why: 'the wallet seed is not in this node\'s home' };
  const w = walletOf(fromHex(seedHex));
  const { coins } = await kit.coinsOf(s.chain, w.spk);
  const walletSats = coins.reduce((a, c) => a + Number(c.sats), 0);
  const depositSats = Number((LIQUIDITY_TERMS[network] || LIQUIDITY_TERMS.testnet4).depositSats);
  // a custody node's peg-in and ring channel come from the same wallet: the deposit is sent only from what is left above them
  const custody = (s.roles || []).includes('custody');
  const reservedSats = custody && !(s.custody || {}).pegIn ? Number((s.custody || {}).pegInSats || 0) : 0;
  const shortSats = Math.max(0, depositSats + DEPOSIT_FEE_SATS + reservedSats - walletSats);
  const plan = { lightning, lightningPubkey: t.pubkey, depositSats, walletSats, reservedSats, shortSats, address: w.address,
    channelSats: Number((LIQUIDITY_TERMS[network] || LIQUIDITY_TERMS.testnet4).channelSats) };
  if (!post) return { ok: true, plan };
  if (lightning === 'install') {
    const r = await kit.setUpOwnLnd({ state: st, release, boot: true });
    if (!r.ok) return { ok: false, why: `LND could not be installed: ${r.why}`, plan };
    return { ok: true, plan, waiting: `LND is installed and starting (${r.peers})` };
  }
  if (lightning === 'starting') {
    const r = await kit.lndReady({ state: st });
    if (!r.ok) return r.waiting ? { ok: true, plan, waiting: `LND is starting: ${r.why}` } : { ok: false, why: `LND does not answer: ${r.why}`, plan };
    plan.lightningPubkey = r.pubkey;
    s = st.read();
  }
  // the node key the provider signs its claims with (0600), as the wizard writes it
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(st.path('node.db'), { readOnly: true });
  let secret; try { secret = Buffer.from(db.prepare('SELECT secret FROM identity WHERE one = 0').get().secret).toString('hex'); } finally { db.close(); }
  st.writeSecret('liquidity.key', secret);
  const p = await kit.installProgram({ id: 'liquidity', description: 'Bitcoin Arena: liquidity provider', home: st.home || home, boot: true,
    args: [node, join(release, 'packages', 'arena-installer', 'bin', 'liquidity-provider.mjs'), '--rest', s.lightning.restUrl, '--lnddir', s.lightning.lnddir,
      '--key', st.path('liquidity.key'), '--state', st.path('liquidity-state.json'), '--claim-file', st.path('liquidity-claim.json'), '--listen', String(LIQUIDITY_PROVIDER_PORT)] });
  if (!p.ok) return { ok: false, why: `the provider service did not start: ${p.why}`, plan };
  // the custody agent sends the deposit (a custody node runs it already)
  if (!s.custodyAgent || !s.custodyAgent.installedMs) {
    const a = await kit.installProgram({ id: 'custody', description: 'Bitcoin Arena: custody agent', home: st.home || home, boot: true,
      args: [node, join(release, 'packages', 'arena-installer', 'bin', 'custody-agent.mjs'), '--home', st.home || home] });
    if (!a.ok) return { ok: false, why: `the agent that sends the deposit did not start: ${a.why}`, plan };
    st.save({ custodyAgent: { installedMs: nowMs } });
  }
  const next = st.save({ roles: [...(s.roles || []), 'liquidity'], liquidityAdded: { atMs: nowMs } });
  st.writeSecret('arena.conf', seatConf({ ...next, port: next.port || (next.reach || {}).port, bridgePort: next.bridgePort }, { home: st.home || home, release }));
  return { ok: true, plan, done: { roles: next.roles, claimFile: st.path('liquidity-claim.json') } };
}
