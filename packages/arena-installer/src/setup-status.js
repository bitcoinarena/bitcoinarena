// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// WHAT THE INSTALLER LEFT RUNNING, AND HOW FAR IT IS (kanban #635, 2026-10-25: "Bond und alles kann gepostet werden im installiert als
// Vorbereitung, der Status und completion ist dann im Dashboards", "in dem public Node Dashboard ein Panel einblenden mit dem Status der
// node anzeigen wieviel confirmations Bond und peg in haben. Das selbe auch beim owner Dashboard"). The installer no longer waits for
// confirmations or for Bitcoin Core's sync; this reads, for the node's dashboards, where each stands:
//   core    Bitcoin Core installed here: syncing (blocks, progress, ETA - the chain-switch keeper's chain-switch.json) or switched to
//   bond    its transaction, confirmations, the height it must confirm by to count (bond.js bondCounts), whether it counts
//   pegIn   the gateway's peg-in (custody): confirmations against the federation's finality (PEG_IN_FINALITY)
// AND EVERYTHING ELSE STILL UNDER WAY (2026-10-25: "a section of installation status to show confirmations on bond, peg in and lnd
// status and everything else that may be in progress" - "Fix that"):
//   lnd       LND set up here: answering, synced to the chain, its height, open and pending channels
//   gateway   the Lightning gateway: answering, its Lightning node, the federations it joined
//   address   the node's public address answering as this node
//   faucet    the test coins the Arena faucet sent: confirmations
//   updates   advertisement updates and bonds posted since (the newest games and protocols, a roles change, the move to the key from the
//             words): confirmations against the 6 they need to count
//   oldBonds  bonds left under a key the node moved away from: the block they can be taken back at
// AND HOW LONG EACH STILL TAKES (the owner's playtest 2026-10-25: "Include an ETA how long it'll take ... one big number on top until the
// node is ready, and for each item individual etas"): `etas` - Core's sync from its own ETA, LND from how fast it caught up since the
// last read, confirmations from how fast blocks came lately, the gateway from LND plus the peg-in's 100 blocks until it pegs in.
// Confirmations come from the node's own chain the way its deposit was found (wallet.js): an Electrum server's history of the node's
// address, or bitcoind (the unspent output, or the mempool). Nothing here is secret: txids, heights, progress.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { coreRpc, electrumSession } from './chain-test.js';
import { scriptHash, walletOf, fromHex } from './wallet.js';
import { bondCounts, lockOf } from './bond.js';

/** The confirmations a federation waits for before it credits a peg-in (Fedimint's testnet4 default, on both of ours: measured on #326). */
export const PEG_IN_FINALITY = 100;
/** The confirmations a bond and an advertisement update need before the node counts with them (the owner's playtest 2026-10-25: "Say how
 *  many confirmations the bond takes, 10 min is not enough"). */
export const COUNTS_AT = 6;

const readJson = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } };

/** How many blocks the block speed is read over. */
export const BLOCK_SPEED_SPAN = 12;
/** The block time assumed while none was measured: testnet4's target. */
export const TARGET_BLOCK_MS = 600000;

/** The time a block header names (bytes 68-71, little endian), in ms. */
const headerTimeMs = (hex) => Buffer.from(hex, 'hex').readUInt32LE(68) * 1000;

/** { tip, heightOf(txid) -> height | 0 (in the mempool) | null (not seen), blockMs() -> the mean time between the last blocks } from the node's chain. */
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
    const timeAt = async (h) => Number((await rpc('getblockheader', [await rpc('getblockhash', [h])])).time) * 1000;
    const blockMs = async () => (await timeAt(tip) - await timeAt(tip - BLOCK_SPEED_SPAN)) / BLOCK_SPEED_SPAN;
    return { tip, heightOf, blockMs, close: () => {} };
  }
  const s = await session({ ...chain, timeoutMs: 20000 });
  const tip = (await s.call('blockchain.headers.subscribe', [])).height;
  const history = await s.call('blockchain.scripthash.get_history', [scriptHash(spk)]);
  const heightOf = async (txid) => { const h = history.find((x) => x.tx_hash === txid); return h ? Math.max(0, h.height) : null; };
  const timeAt = async (h) => headerTimeMs(await s.call('blockchain.block.header', [h]));
  const blockMs = async () => (await timeAt(tip) - await timeAt(tip - BLOCK_SPEED_SPAN)) / BLOCK_SPEED_SPAN;
  return { tip, heightOf, blockMs, close: () => s.close() };
}

const confs = (tip, height) => (height ? tip - height + 1 : 0);

/**
 * The status for the dashboards of the node installed at `home`. Answers { ok, core, bond, pegIn, tip } (each part null when the
 * node has none) or { ok: false, why }.
 */
export async function setupStatus({ home, reader = chainReader, nowMs = Date.now(), services = servicesOf }) {
  const s = readJson(join(home, 'state.json'));
  if (!s) return { ok: false, why: 'no installer state here' };
  const more = await services(s).catch((e) => ({ lnd: null, gateway: null, address: { ok: false, why: e.message } }));
  const base = await chainParts({ home, s, reader, nowMs });
  if (!base.ok) return { ...base, ...more };
  const lndPerMs = lndSpeed(home, more.lnd, nowMs);
  const blockMs = base.blockMs || TARGET_BLOCK_MS;
  return { ...base, ...more, blockMs, blockMsMeasured: !!base.blockMs, etas: setupEtas({ ...base, ...more }, { blockMs, lndPerMs }) };
}

// LND's last heights read (per node home), to tell how fast it catches up: blocks per ms between two reads at least a minute apart
const LND_SEEN = new Map();
function lndSpeed(home, l, nowMs) {
  if (!l || !l.ok || !Number.isFinite(Number(l.height))) return null;
  const seen = LND_SEEN.get(home) || [];
  const old = seen.find((x) => nowMs - x.atMs >= 60000 && Number(l.height) > x.height);
  LND_SEEN.set(home, [...seen.filter((x) => nowMs - x.atMs < 15 * 60000), { height: Number(l.height), atMs: nowMs }].slice(-30));
  return old ? (Number(l.height) - old.height) / (nowMs - old.atMs) : null;
}

/**
 * HOW LONG EACH PART STILL TAKES, in ms: 0 when done, null when it cannot be told (a problem, or nothing measured yet); `ready` the
 * longest of them - the node is ready when its slowest part is.
 */
export function setupEtas(st, { blockMs = TARGET_BLOCK_MS, lndPerMs = null } = {}) {
  const blocks = (k) => Math.max(0, k) * blockMs;
  const c = st.core || null;
  const core = !c ? null : !c.interim ? 0 : c.sync && Number.isFinite(c.sync.etaMs) ? c.sync.etaMs : null;
  const l = st.lnd || null;
  let lnd = null;
  if (l && l.ok) {
    if (l.synced) lnd = 0;
    else {
      // LND reads its blocks from this node's Bitcoin Core: it cannot be through before Core is
      const top = c && c.interim && c.sync ? Number(c.sync.headers) : Number(st.tip || 0);
      const own = lndPerMs > 0 && top > Number(l.height) ? (top - Number(l.height)) / lndPerMs : null;
      lnd = own === null ? core : Math.max(own, core || 0);
    }
  }
  const p = st.pegIn || null;
  const pegIn = !p ? null : p.credited ? 0 : blocks(p.needed - p.confirmations);
  const g = st.gateway || null;
  // the gateway is ready once its peg-in is credited: not started yet, it waits for LND and then the peg-in's 100 blocks
  let gateway = null;
  if (g) {
    if (g.ok && g.federations > 0) gateway = 0;
    else if (p) gateway = pegIn;                                   // started: its peg-in's blocks
    else if (g.ok) gateway = blocks(PEG_IN_FINALITY);              // running, its peg-in not sent yet
    else if (g.syncing && lnd !== null) gateway = lnd + blocks(PEG_IN_FINALITY);
  }
  const b = st.bond || null;
  const bond = !b ? null : b.counts === false ? null : blocks((b.needed || COUNTS_AT) - (b.confirmations || 0));
  const f = st.faucet || null;
  const faucet = !f ? null : f.confirmations > 0 || (b && b.confirmations > 0) ? 0 : blockMs;
  const updates = (st.updates || []).map((u) => (u.counts ? 0 : blocks(u.needed - u.confirmations)));
  const address = !st.address ? null : st.address.ok ? 0 : null;
  const parts = [[c, core], [l, lnd], [p, pegIn], [g, gateway], [b, bond], [f, faucet], [st.address, address], ...updates.map((u) => [true, u])].filter(([has]) => has);
  const known = parts.map(([, e]) => e).filter((e) => e !== null);
  return { core, lnd, gateway, pegIn, bond, faucet, address, updates, ready: known.length ? Math.max(...known) : null,
    // a part whose time cannot be told (a problem, or nothing measured yet): `ready` is then at least that long
    partial: parts.some(([, e]) => e === null) };
}

/** LND, the gateway and the public address, asked now (each null when the node has none). */
export async function servicesOf(s, { fetcher = fetch } = {}) {
  let lnd = null, gateway = null, address = null;
  if (s.lightning && s.lightning.restUrl) {
    try {
      const { testLnd, lndChannels } = await import('./lnd.js');
      const t = await testLnd(s.lightning);
      const c = t.ok ? await lndChannels(s.lightning).catch(() => null) : null;
      // HOW OTHER LIGHTNING NODES REACH IT: the open port measured from outside, else the onion address Tor gives it, else not at all
      const r = s.lnReach || {}, onion = (t.uris || []).find((u) => /\.onion:/.test(u));
      const via = r.reached ? { how: 'direct', at: `${r.address}:${r.port}` } : onion ? { how: 'tor', at: onion.split('@')[1] } : { how: 'none', why: (s.tor || {}).why || r.why || null };
      lnd = t.ok ? { ok: true, synced: t.syncedToChain, height: t.blockHeight, channels: c && c.ok ? c.open.length : null, pending: c && c.ok ? c.pending.length : null, via }
        : { ok: false, why: t.why };
    } catch (e) { lnd = { ok: false, why: e.message }; }
  }
  if (s.gateway && s.gateway.apiUrl) {
    try {
      const { testGateway } = await import('./gateway.js');
      const t = await testGateway({ apiUrl: s.gateway.apiUrl, passwordFile: s.gateway.passwordFile, fetcher });
      gateway = t.ok ? { ok: true, federations: (t.federations || []).length } : { ok: false, syncing: !!t.syncing, why: t.why };
    } catch (e) { gateway = { ok: false, why: e.message }; }
  }
  if (s.reach && s.reach.url && s.service && s.service.identity) {
    try {
      const r = await fetcher(`${String(s.reach.url).replace(/\/+$/, '')}/identity`, { signal: AbortSignal.timeout(10000) });
      const id = r.status === 200 ? Buffer.from(await r.arrayBuffer()).toString('hex') : null;
      address = id && id.endsWith(String(s.service.identity).slice(-64)) ? { ok: true, url: s.reach.url } : { ok: false, url: s.reach.url, why: r.status === 200 ? 'another node answers there' : `it answered ${r.status}` };
    } catch (e) { address = { ok: false, url: s.reach.url, why: e.cause ? e.cause.code || e.message : e.message }; }
  }
  return { lnd, gateway, address };
}

async function chainParts({ home, s, reader, nowMs }) {
  const sw = readJson(join(home, 'chain-switch.json'));
  const core = s.core ? { dir: s.core.dir || home, interim: !!s.core.interim, switchedAtMs: s.core.switchedAtMs || null,
    state: s.core.interim ? ((sw && sw.state) || 'syncing') : 'done', sync: (sw && sw.sync) || null, why: (sw && sw.why) || null, atMs: (sw && sw.atMs) || null } : null;
  const b = s.bond && s.bond.txid ? s.bond : null;
  const p = s.custody && s.custody.pegIn && s.custody.pegIn.txid ? s.custody.pegIn : null;
  // the other transactions setup or the owner page sent, newest first: what each was for and its txid
  const sent = [['gamesUpdate', 'the newest games and protocols in the advertisement'], ['rolesUpdate', 'the roles change'], ['keySwitch', 'the move to the key from the 24 words']]
    .map(([k, what]) => (s[k] && (s[k].txid || s[k].bond) ? { kind: k, what, txid: s[k].txid || s[k].bond, atMs: s[k].atMs || null } : null)).filter(Boolean);
  const faucet = s.faucet && s.faucet.txid ? s.faucet : null;
  const oldBonds = (s.oldBonds || []).map((o) => ({ txid: o.txid, sats: o.sats, maturity: o.maturity }));
  if (!b && !p && !faucet) return { ok: true, core, bond: null, pegIn: null, faucet: null, updates: [], oldBonds, tip: null };
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
        confirmBy: b.maturity - offset, counts: counted ? counted.counts : null, blocksToMaturity: Math.max(0, b.maturity - r.tip), needed: COUNTS_AT };
    }
    if (p) {
      const height = await r.heightOf(p.txid);
      const c = confs(r.tip, height);
      pegIn = { txid: p.txid, sats: p.sats, federationId: p.federationId, height, confirmations: c, seen: height !== null, needed: PEG_IN_FINALITY, credited: c >= PEG_IN_FINALITY };
    }
    let fau = null;
    if (faucet) { const h = await r.heightOf(faucet.txid); fau = { txid: faucet.txid, sats: faucet.sats, seen: h !== null, confirmations: confs(r.tip, h) }; }
    const updates = [];
    for (const u of sent) { const h = await r.heightOf(u.txid); updates.push({ ...u, seen: h !== null, confirmations: confs(r.tip, h), needed: COUNTS_AT, counts: confs(r.tip, h) >= COUNTS_AT }); }
    const old = oldBonds.map((o) => ({ ...o, blocksLeft: Math.max(0, Number(o.maturity) - r.tip), back: r.tip >= Number(o.maturity) }));
    let blockMs = null; try { blockMs = r.blockMs ? await r.blockMs() : null; } catch { blockMs = null; }
    return { ok: true, core, bond, pegIn, faucet: fau, updates, oldBonds: old, tip: r.tip, blockMs: blockMs > 0 ? Math.round(blockMs) : null };
  } finally { r.close(); }
}
