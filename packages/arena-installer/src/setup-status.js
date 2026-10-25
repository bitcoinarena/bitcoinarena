// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// WHAT THE INSTALLER LEFT RUNNING, AND HOW FAR IT IS (kanban #635, the owner 2026-10-25: "Bond und alles kann gepostet werden im installiert als
// Vorbereitung, der Status und completion ist dann im Dashboards", "in dem public Node Dashboard ein Panel einblenden mit dem Status der
// node anzeigen wieviel confirmations Bond und peg in haben. Das selbe auch beim owner Dashboard"). The installer no longer waits for
// confirmations or for Bitcoin Core's sync; this reads, for the node's dashboards, where each stands:
//   core    Bitcoin Core installed here: syncing (blocks, progress, ETA - the chain-switch keeper's chain-switch.json) or switched to
//   bond    its transaction, confirmations, the height it must confirm by to count (bond.js bondCounts), whether it counts
//   pegIn   the gateway's peg-in (custody): confirmations against the federation's finality (PEG_IN_FINALITY)
// Confirmations come from the node's own chain the way its deposit was found (wallet.js): an Electrum server's history of the node's
// address, or bitcoind (the unspent output, or the mempool). Nothing here is secret: txids, heights, progress.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { coreRpc, electrumSession } from './chain-test.js';
import { scriptHash, walletOf, fromHex } from './wallet.js';
import { bondCounts, lockOf } from './bond.js';

/** The confirmations a federation waits for before it credits a peg-in (Fedimint's testnet4 default, on both of ours: measured on #326). */
export const PEG_IN_FINALITY = 100;

const readJson = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } };

/** { tip, heightOf(txid) -> height | 0 (in the mempool) | null (not seen) } from the node's chain. */
async function chainReader(chain, spk, { session = electrumSession, fetcher = fetch } = {}) {
  if (chain.kind === 'core') {
    const rpc = coreRpc({ ...chain, fetcher, timeoutMs: 30000 });
    const tip = await rpc('getblockcount');
    const heightOf = async (txid) => {
      for (let vout = 0; vout < 4; vout++) {
        let o = null; try { o = await rpc('gettxout', [txid, vout, true]); } catch { o = null; }
        if (o) return o.confirmations ? tip - o.confirmations + 1 : 0;
      }
      try { await rpc('getmempoolentry', [txid]); return 0; } catch { return null; }
    };
    return { tip, heightOf, close: () => {} };
  }
  const s = await session({ ...chain, timeoutMs: 20000 });
  const tip = (await s.call('blockchain.headers.subscribe', [])).height;
  const history = await s.call('blockchain.scripthash.get_history', [scriptHash(spk)]);
  const heightOf = async (txid) => { const h = history.find((x) => x.tx_hash === txid); return h ? Math.max(0, h.height) : null; };
  return { tip, heightOf, close: () => s.close() };
}

const confs = (tip, height) => (height ? tip - height + 1 : 0);

/**
 * The status for the dashboards of the node installed at `home`. Answers { ok, core, bond, pegIn, tip } (each part null when the
 * node has none) or { ok: false, why }.
 */
export async function setupStatus({ home, reader = chainReader, nowMs = Date.now() }) {
  const s = readJson(join(home, 'state.json'));
  if (!s) return { ok: false, why: 'no installer state here' };
  const sw = readJson(join(home, 'chain-switch.json'));
  const core = s.core ? { dir: s.core.dir || home, interim: !!s.core.interim, switchedAtMs: s.core.switchedAtMs || null,
    state: s.core.interim ? ((sw && sw.state) || 'syncing') : 'done', sync: (sw && sw.sync) || null, why: (sw && sw.why) || null, atMs: (sw && sw.atMs) || null } : null;
  const b = s.bond && s.bond.txid ? s.bond : null;
  const p = s.custody && s.custody.pegIn && s.custody.pegIn.txid ? s.custody.pegIn : null;
  if (!b && !p) return { ok: true, core, bond: null, pegIn: null, tip: null };
  let seed; try { seed = fromHex(readFileSync(join(home, 'seed.hex'), 'utf8').trim()); } catch { seed = null; }
  if (!s.chain || !seed) return { ok: true, core, bond: b ? { txid: b.txid, sats: b.sats, maturity: b.maturity, why: 'the node\'s chain cannot be read here' } : null, pegIn: null, tip: null };
  let r;
  try { r = await reader(s.chain, walletOf(seed).spk); } catch (e) { return { ok: false, why: `the chain did not answer: ${e.message}`, core }; }
  try {
    let bond = null, pegIn = null;
    if (b) {
      const height = await r.heightOf(b.txid);
      const offset = lockOf(r.tip, { nowMs, maturity: b.maturity }).offset;
      const counted = height ? bondCounts({ maturity: b.maturity, confirmedAt: height }) : null;
      bond = { txid: b.txid, sats: b.sats, maturity: b.maturity, height, confirmations: confs(r.tip, height), seen: height !== null,
        confirmBy: b.maturity - offset, counts: counted ? counted.counts : null, blocksToMaturity: Math.max(0, b.maturity - r.tip) };
    }
    if (p) {
      const height = await r.heightOf(p.txid);
      const c = confs(r.tip, height);
      pegIn = { txid: p.txid, sats: p.sats, federationId: p.federationId, height, confirmations: c, seen: height !== null, needed: PEG_IN_FINALITY, credited: c >= PEG_IN_FINALITY };
    }
    return { ok: true, core, bond, pegIn, tip: r.tip };
  } finally { r.close(); }
}
