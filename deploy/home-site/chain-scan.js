// THE WORKER'S READ OF BITCOIN (kanban #272): every testnet4 transaction paying a bond marker, through mempool.space, with
// what a page needs to check each one itself - the raw transaction, its merkle branch and position, its block's header -
// and which outputs of each are spent. Run every 2 minutes; a transaction already read keeps its bytes and proof, only the
// spent outputs are asked again. The page (www/js/chain-nodes.js) believes none of it without checking.
//
// The two markers are the protocol's constants (arena-protocol constants.js bondMarker('testnet'); ancestor.js
// ancestorMarker('testnet')), as mempool.space indexes scripts: sha256 of the P2TR script 5120 || program, hex, not
// reversed. They name no node.
export const MARKER_SCRIPTHASHES = {
  arena: '4d593f6c6f2a48ff90237cd37faf66d3ad265dce9e6e5820e09c2fc549484bca',
  ancestor: '50862a7cd7c0e6f8d0ecb8cdc89c775b7bcf566eea8ba79be8894f3f33c5a3fb',
};
export const SOURCE = 'https://mempool.space/testnet4/api';
import { bondVoutOf } from './www/js/chain-nodes.js';

// A WORKER RUN MAY FETCH 50 TIMES (the free plan's subrequest limit): a run stops asking at BUDGET and keeps the rest of
// the previous read; the next run, 2 minutes later, goes on. Once read, a transaction costs one fetch a run, and only if
// it is a bond not yet spent.
const BUDGET = 45;
let spent = 0;
class OverBudget extends Error {}
async function get(url) {
  if (spent >= BUDGET) throw new OverBudget('budget');
  spent++;
  const r = await fetch(url); if (!r.ok) throw new Error(`${url.slice(SOURCE.length)} answered ${r.status}`); return r;
}
const json = async (url) => (await get(url)).json();
const text = async (url) => (await (await get(url)).text()).trim();

/** Every confirmed transaction paying `scripthash`, newest first, paged as mempool.space pages them (25 at a time). */
async function txsOf(scripthash) {
  const all = [];
  let page = await json(`${SOURCE}/scripthash/${scripthash}/txs`);
  for (let i = 0; i < 40; i++) {
    const confirmed = page.filter((t) => t.status && t.status.confirmed);
    all.push(...confirmed);
    if (confirmed.length < 25) break;
    page = await json(`${SOURCE}/scripthash/${scripthash}/txs/chain/${confirmed[confirmed.length - 1].txid}`);
  }
  return all;
}

/** The read: { at, source, tip, txs: [{ txid, marker, hex, height, pos, merkle, header, outspends }], errors }. */
export async function scanChain(previous = null) {
  const kept = new Map(((previous && previous.txs) || []).map((t) => [t.txid, t]));
  const headers = new Map();
  const errors = [];
  const txs = [];
  const t0 = Date.now();
  spent = 0;
  let partial = false;
  const note = (what, e) => { if (e instanceof OverBudget) partial = true; else errors.push(`${what}: ${e.message}`); };
  let tip = null;
  try { tip = Number(await text(`${SOURCE}/blocks/tip/height`)); } catch (e) { note('tip', e); }
  const listed = [];
  for (const [marker, scripthash] of Object.entries(MARKER_SCRIPTHASHES)) {
    try { for (const s of await txsOf(scripthash)) listed.push({ s, marker }); }
    catch (e) { note(marker, e); for (const t of (previous && previous.txs) || []) if (t.marker === marker) listed.push({ s: { txid: t.txid }, marker, only: t }); }
  }
  // 1. the transactions not read yet: bytes, merkle branch, block header
  for (const { s, marker, only } of listed) {
    let t = only || kept.get(s.txid);
    if (!t || !t.hex || !t.header) {
      try {
        const hex = await text(`${SOURCE}/tx/${s.txid}/hex`);
        const proof = await json(`${SOURCE}/tx/${s.txid}/merkle-proof`);
        let header = headers.get(s.status.block_hash);
        if (!header) { header = await text(`${SOURCE}/block/${s.status.block_hash}/header`); headers.set(s.status.block_hash, header); }
        t = { txid: s.txid, marker, hex, height: proof.block_height, pos: proof.pos, merkle: proof.merkle, header, bondVout: bondVoutOf(hex) };
      } catch (e) { note(s.txid.slice(0, 12), e); continue; }
    }
    txs.push({ ...t, marker });
  }
  // 2. each bond's output, every run: a spent bond stops counting at once
  for (const t of txs) {
    if (!t.hex) continue;
    const vout = t.bondVout !== undefined ? t.bondVout : bondVoutOf(t.hex);
    t.bondVout = vout;
    if (vout === null || (Array.isArray(t.outspends) && t.outspends[vout] === true)) continue;   // not a bond, or spent for good
    try {
      const o = await json(`${SOURCE}/tx/${t.txid}/outspend/${vout}`);
      t.outspends = Array.isArray(t.outspends) ? [...t.outspends] : [];
      t.outspends[vout] = !!o.spent;
      for (let i = 0; i < t.outspends.length; i++) if (t.outspends[i] === undefined) t.outspends[i] = null;
    } catch (e) { note(t.txid.slice(0, 12), e); }
  }
  return { at: new Date().toISOString(), source: SOURCE, tip, txs, errors, partial, fetches: spent, ms: Date.now() - t0 };
}
