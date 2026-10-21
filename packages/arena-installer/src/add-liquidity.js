// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// AN INSTALLED NODE BECOMES A LIQUIDITY PROVIDER FROM ITS OWNER PAGE (kanban #567, the owner 2026-10-21: the Liquidity provider card still
// said "run arena-install again"; owner actions happen in the browser): what the wizard's bond step does for a node that chose the role
// (wizard.js) - the provider service on the node's LND (bin/liquidity-provider.mjs, its node key beside the node's other secrets), the
// custody agent that sends the deposit (5 x L from the node's wallet into LND's, custody-agent.js), 'liquidity' in the node's roles and
// its settings (arena.conf: the claim file the seat serves). No advertisement update: the role is the claim the provider signs.
// It needs the node's own Bitcoin Core and an LND that answers; a node without LND sets it up first (Custody / Lightning).
// Answers { ok, plan } / { ok, plan, done } or { ok: false, why }.
import { join } from 'node:path';
import { LIQUIDITY_TERMS } from '../../arena-protocol/src/liquidity.js';
import { fromHex } from '../../arena-protocol/src/hash.js';
import { walletOf, coinsOf } from './wallet.js';
import { testLnd } from './lnd.js';
import { installProgram } from './service.js';
import { nodeState, seatConf, LIQUIDITY_PROVIDER_PORT } from './state.js';

/** The deposit's fee allowance: the send the custody agent builds (one input or a few, one output and change). */
export const DEPOSIT_FEE_SATS = 1000;

export async function addLiquidityOnNode({ home, release, post = false, state = null, network = 'testnet4', node = process.execPath,
  kit = { coinsOf, testLnd, installProgram }, nowMs = Date.now() }) {
  const st = state || nodeState(home);
  const s = st.read();
  if ((s.roles || []).includes('liquidity')) return { ok: false, why: 'this node is a liquidity provider already' };
  if (!s.chain || s.chain.kind !== 'core') return { ok: false, why: 'a liquidity provider needs your own Bitcoin Core: LND cannot run on an Electrum server' };
  if (!s.lightning || !s.lightning.lnddir) return { ok: false, why: 'this node has no Lightning (LND) set up yet: a provider opens its channels from LND' };
  const t = await kit.testLnd(s.lightning);
  if (!t.ok) return { ok: false, why: `LND does not answer: ${t.why}` };
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
  const plan = { lightningPubkey: t.pubkey, depositSats, walletSats, reservedSats, shortSats, address: w.address,
    channelSats: Number((LIQUIDITY_TERMS[network] || LIQUIDITY_TERMS.testnet4).channelSats) };
  if (!post) return { ok: true, plan };
  // the node key the provider signs its claims with (0600), as the wizard writes it
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(st.path('node.db'), { readOnly: true });
  let secret; try { secret = Buffer.from(db.prepare('SELECT secret FROM identity WHERE one = 0').get().secret).toString('hex'); } finally { db.close(); }
  st.writeSecret('liquidity.key', secret);
  const p = await kit.installProgram({ id: 'liquidity', description: 'The liquidity provider of the Arena node', home: st.home || home, boot: true,
    args: [node, join(release, 'packages', 'arena-installer', 'bin', 'liquidity-provider.mjs'), '--rest', s.lightning.restUrl, '--lnddir', s.lightning.lnddir,
      '--key', st.path('liquidity.key'), '--state', st.path('liquidity-state.json'), '--claim-file', st.path('liquidity-claim.json'), '--listen', String(LIQUIDITY_PROVIDER_PORT)] });
  if (!p.ok) return { ok: false, why: `the provider service did not start: ${p.why}`, plan };
  // the custody agent sends the deposit (a custody node runs it already)
  if (!s.custodyAgent || !s.custodyAgent.installedMs) {
    const a = await kit.installProgram({ id: 'custody', description: 'The custody agent of the Arena node', home: st.home || home, boot: true,
      args: [node, join(release, 'packages', 'arena-installer', 'bin', 'custody-agent.mjs'), '--home', st.home || home] });
    if (!a.ok) return { ok: false, why: `the agent that sends the deposit did not start: ${a.why}`, plan };
    st.save({ custodyAgent: { installedMs: nowMs } });
  }
  const next = st.save({ roles: [...(s.roles || []), 'liquidity'], liquidityAdded: { atMs: nowMs } });
  st.writeSecret('arena.conf', seatConf({ ...next, port: next.port || (next.reach || {}).port, bridgePort: next.bridgePort }, { home: st.home || home, release }));
  return { ok: true, plan, done: { roles: next.roles, claimFile: st.path('liquidity-claim.json') } };
}
