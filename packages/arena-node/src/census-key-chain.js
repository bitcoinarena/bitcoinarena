// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// WHICH CENSUS KEYS STAND, AND WHO HOLDS THEM, READ FROM THIS NODE'S OWN CHAIN (5A.3B, kanban #972, #1041, #1048).
//
//   THE SCAN      forward from the network's CENSUS_KEY_FIRST_HEIGHT, every block once, what it found kept across restarts. No lookback window: a key is named by bonds for
//                 years, and #820 is what a window does. Bounded as the ballot's tally is: at most `maxBlocksPerPass` blocks a pass
//   THE BODY      in the leaf the anchor's transaction spends, so nothing is fetched from anyone and a census stays a pure function of the chain, and no relay can strip it. An anchor
//                 that carries no body, or one that does not stand, is refused and the next valid one counts
//   THE JUDGING   in chain order. A record's census is below its anchor, and that census reads only keys standing below itself, so by the time an anchor is judged everything it
//                 depends on already has been. A census that cannot be read stops the pass before its height is written, and the same block is read next pass
//   A RESHARE     the chain says it all (#1048 answer 1). The plan of an epoch is a function of the keys standing at its first block and that epoch's census: the oldest live key
//                 held under 80 %. Its 'R' anchor is a list of old holders covering the old threshold, the first valid one of a run is `present`, and its 'K' anchor is a CensusKeyRecord
//                 naming the same public key, by the new census, signed by holders of the new threshold. No 'R' anchor, no reshare: such a record is refused
//   A REORG       the scan keeps the hashes of the last `keepHashes` blocks. The top one is asked each pass; moved, the kept heights are walked down to one still on the chain
//                 and everything above it is forgotten. Past all of them it starts again from the first height
import { censusKeyAnchorIn, censusKeyBodyIn, censusKeyRecordDue, censusKeyShares, censusKeyRecordStands, standingCensusKeys, decodeCensusKeyBody, encodeCensusKeyBody,
  censusKeyDrawHeight, censusKeyPlan, censusHeightOfEpoch, decodeReshareList, encodeReshareList, reshareAnchorIn, reshareListIn, reshareListStands,
  reshareWindow } from '../../arena-protocol/src/census-key.js';
import { BOND_TEMPLATE_V3 } from '../../arena-protocol/src/bond-script.js';
import { splitBlock } from '../../arena-protocol/src/block.js';
import { parseTransaction } from '../../arena-protocol/src/tx.js';
import { merkleBranchOf } from '../../arena-protocol/src/chain.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';

const MARK_K = Buffer.from([0x6a, 36, 0x41, 0x52, 0x4e, 0x4b]);       // OP_RETURN, a 36-byte push, "ARN" 'K'
const MARK_R = Buffer.from([0x6a, 36, 0x41, 0x52, 0x4e, 0x52]);       // and "ARN" 'R'

/** Every "ARN" 'K' and "ARN" 'R' anchor of a block, in block order: [{ height, index, txid, kind, id, body }], `body` null where the transaction carries none. */
export function censusKeyAnchorsInBlock(raw, height) {
  const out = [];
  splitBlock(raw).transactions.forEach((t, index) => {
    let tx; try { tx = parseTransaction(t); } catch { return; }
    const txid = toHex(Uint8Array.from(tx.txid).reverse());
    const k = censusKeyAnchorIn(tx.outputs);
    if (k) { out.push({ height, index, txid, kind: 'K', id: k, body: censusKeyBodyIn(tx, k) }); return; }
    const r = reshareAnchorIn(tx.outputs);
    if (r) out.push({ height, index, txid, kind: 'R', id: r, body: reshareListIn(tx, r) });
  });
  return out;
}

/**
 * `store`: CensusKeyStore. `tipHeight()`; `blockHashAt(height)` the hash bitcoind prints, null above the tip; `blockAt(hash)` the raw block; `censusEntriesAt(height)` the
 * census at a height (censusKeyContract's), which throws or answers null while it cannot be read; `verify(signature, digest, key)`; `genesisKey` mainnet's key 0.
 */
export function createCensusKeyScan({ store, network, networkId, firstHeight, foundingWindow, censusConfirmations, genesis = null, genesisKey = null, tipHeight, blockHashAt, blockAt,
  censusEntriesAt, verify, sharesMax = undefined, maxBlocksPerPass = 64, keepHashes = 288, log = () => {} }) {
  let keys = [];
  let generations = new Map();          // key hex -> [{ epoch, censusHeight, height }] oldest first, the records that named who holds it
  let lists = new Map();                // `${key hex}:${run}` -> { height, present }
  let plans = new Map();                // epoch -> the plan, until the chain or the keys move
  let running = false;

  /** The anchors that stand are the whole of it: everything below is read from them, so a restart and a reorg need nothing else. */
  const refresh = () => {
    const rows = store.anchors().filter((a) => a.stands);
    const fresh = rows.filter((a) => a.kind === 'K');
    keys = standingCensusKeys({ genesisKey, anchors: fresh, judge: (id) => {
      const row = fresh.find((a) => toHex(a.id) === toHex(id));
      return row ? { ok: true, record: decodeCensusKeyBody(row.body).record } : { ok: false };
    } });
    generations = new Map();
    lists = new Map();
    for (const a of rows) {
      if (a.kind === 'R') {
        const list = decodeReshareList(a.body);
        lists.set(`${toHex(list.key)}:${list.run}`, { height: a.height, present: list.signatures.map((s) => toHex(s.key)) });
        continue;
      }
      const { record } = decodeCensusKeyBody(a.body);
      const k = toHex(record.publicKey);
      generations.set(k, [...(generations.get(k) || []), { epoch: record.epoch, censusHeight: record.censusHeight, height: a.height }]);
    }
    plans = new Map();
  };
  refresh();

  const sharesOf = async (epoch, censusHeight) => {
    const hash = await blockHashAt(censusKeyDrawHeight(epoch, network));
    const entries = await censusEntriesAt(censusHeight);
    if (!hash || !entries) throw new Error(`the census at ${censusHeight} cannot be read yet`);
    return { entries, shares: censusKeyShares({ entries, network, genesis, blockHash: fromHex(String(hash)), ...(sharesMax ? { sharesMax } : {}) }) };
  };
  const generationAt = (keyHex, height) => (generations.get(keyHex) || []).filter((g) => g.height <= height).pop() || null;

  /**
   * WHAT AN EPOCH DOES ABOUT ITS KEYS, from the chain alone, so every node reads the same: the keys standing at its first block, each one's holders as its newest record there
   * names them, and that epoch's census. Answers { newKey, reshare } with `reshare` null or { publicKey, key, epoch, generation, holders, threshold, total }.
   * Throws while a census cannot be read.
   */
  async function planAt(epoch) {
    if (plans.has(epoch)) return plans.get(epoch);
    const start = censusKeyDrawHeight(epoch, network);
    const census = censusHeightOfEpoch(epoch, network, censusConfirmations);
    if (census === null) return { newKey: false, reshare: null };
    const entries = await censusEntriesAt(census);
    if (!entries) throw new Error(`the census at ${census} cannot be read yet`);
    const here = new Set(entries.map((e) => toHex(e.pubkey)));
    const named = (k) => entries.filter((e) => e.advert && e.advert.bondScriptTemplateVersion === BOND_TEMPLATE_V3 && e.advert.censusKey && toHex(e.advert.censusKey) === toHex(k.publicKey)).length;
    const read = [];
    for (const k of keys.filter((x) => x.height <= start)) {
      const generation = generationAt(toHex(k.publicKey), start);
      // KEY 0 HAS NO RECORD, and genesis names only its public key: no chain reader can say who holds it, so it is never reshared from here
      if (!generation) { read.push({ ...k, named: named(k), heldNow: 0, totalShares: 0, threshold: 0 }); continue; }
      const { shares } = await sharesOf(generation.epoch, generation.censusHeight);
      read.push({ ...k, named: named(k), generation, holders: shares.holders, threshold: shares.threshold, totalShares: shares.total,
        heldNow: shares.holders.reduce((n, h) => n + (here.has(h.key) ? h.shares : 0), 0) });
    }
    const plan = censusKeyPlan({ keys: read, epochStart: true });
    const r = plan.reshare;
    const out = { newKey: plan.newKey, dead: plan.dead.length, retired: plan.retired.length, reshare: r ? { publicKey: r.publicKey, key: toHex(r.publicKey), epoch: r.epoch, generation: r.generation,
      holders: r.holders, threshold: r.threshold, total: r.totalShares, heldNow: r.heldNow } : null };
    plans.set(epoch, out);
    return out;
  }

  /** A 'K' anchor: { stands, kind, why }. A record naming a key that stands is a reshare's. Throws while its census or block hash cannot be read. */
  async function judgeRecord(anchor, taken) {
    if (!anchor.body) return { stands: false, kind: 'K', why: 'its transaction carries no body for that record' };
    const { record, signatures } = anchor.body;
    const key = toHex(record.publicKey);
    const kind = keys.some((k) => toHex(k.publicKey) === key) ? 'G' : 'K';
    if (toHex(record.networkId) !== toHex(networkId)) return { stands: false, kind, why: 'that record is for another network' };
    const due = censusKeyRecordDue({ record, height: anchor.height, network, firstHeight, censusConfirmations });
    if (!due.ok) return { stands: false, kind, why: due.why };
    if (kind === 'K' && taken.has(record.epoch)) return { stands: false, kind, why: `epoch ${record.epoch} already has its key` };
    if (kind === 'G') {
      const list = lists.get(`${key}:${record.epoch}`);
      if (!list || list.height > anchor.height) return { stands: false, kind, why: `key ${key.slice(0, 16)} stands, and no list of its run ${record.epoch} is anchored: no anchor, no reshare` };
      if (taken.has(`${key}:${record.epoch}`) || (generationAt(key, anchor.height) || { epoch: -1 }).epoch >= record.epoch) return { stands: false, kind, why: `run ${record.epoch} of that key already has its record` };
    }
    const { shares } = await sharesOf(record.epoch, due.censusHeight);
    const stands = censusKeyRecordStands({ record, signatures, networkId, shares, verify });
    return { stands: stands.ok, kind, why: stands.ok ? null : stands.why };
  }

  /** An 'R' anchor. Only the run's first valid one counts, and only for the key that epoch's plan names. */
  async function judgeList(anchor, taken) {
    if (!anchor.body) return { stands: false, kind: 'R', why: 'its transaction carries no body for that list' };
    const list = anchor.body;
    const key = toHex(list.key);
    if (toHex(list.networkId) !== toHex(networkId)) return { stands: false, kind: 'R', why: 'that list is for another network' };
    const w = reshareWindow(list.run, network, foundingWindow);
    if (w.start < firstHeight) return { stands: false, kind: 'R', why: `run ${list.run} starts before this network's first key height` };
    if (anchor.height < w.start || anchor.height >= w.midpoint) return { stands: false, kind: 'R', why: `that list was anchored at ${anchor.height}, and run ${list.run} takes one from ${w.start} until ${w.midpoint}` };
    if (taken.has(`${key}:${list.run}`) || lists.has(`${key}:${list.run}`)) return { stands: false, kind: 'R', why: `run ${list.run} of that key already has its list` };
    const plan = await planAt(list.run);
    if (!plan.reshare || plan.reshare.key !== key) return { stands: false, kind: 'R', why: `epoch ${list.run} reshares ${plan.reshare ? plan.reshare.key.slice(0, 16) : 'no key'}` };
    const stands = reshareListStands({ list, networkId, holders: plan.reshare.holders, threshold: plan.reshare.threshold, verify });
    return { stands: stands.ok, kind: 'R', why: stands.ok ? null : stands.why };
  }

  /** Answers whether the chain moved. */
  async function followReorg() {
    const top = store.scanTop();
    if (!top || String(await blockHashAt(top.height)) === top.hash) return false;
    let keep = null;
    for (const k of store.scanHashes()) if (String(await blockHashAt(k.height)) === k.hash) { keep = k.height; break; }
    store.forgetAbove(keep);
    refresh();
    log(`[census-key] the chain moved under the scan: read again from ${keep === null ? firstHeight : keep + 1}`);
    return true;
  }

  /** One pass, forward from where the last one stopped. Answers how many blocks it read. */
  async function pass() {
    if (running || firstHeight === null || firstHeight === undefined) return { read: 0, skipped: true };
    running = true;
    let read = 0;
    try {
      const tip = Number(await tipHeight());
      await followReorg();
      const top = store.scanTop();
      let height = top ? top.height + 1 : firstHeight;
      while (height <= tip && read < maxBlocksPerPass) {
        const hash = String(await blockHashAt(height));
        const raw = await blockAt(hash);
        const bytes = Buffer.from(raw.buffer, raw.byteOffset, raw.length);
        const found = bytes.includes(MARK_K) || bytes.includes(MARK_R) ? censusKeyAnchorsInBlock(raw, height) : [];
        const taken = new Set(keys.map((k) => k.epoch));
        const out = [];
        for (const a of found) {
          const said = a.kind === 'R' ? await judgeList(a, taken) : await judgeRecord(a, taken);
          if (said.stands) taken.add(a.kind === 'K' && said.kind === 'K' ? a.body.record.epoch : a.kind === 'R' ? `${toHex(a.body.key)}:${a.body.run}` : `${toHex(a.body.record.publicKey)}:${a.body.record.epoch}`);
          out.push({ ...a, ...said, bodyBytes: !said.stands ? null : a.kind === 'R' ? encodeReshareList(a.body) : encodeCensusKeyBody(a.body) });
          log(`[census-key] anchor ${a.txid.slice(0, 16)} '${said.kind}' at ${height}: ${said.stands ? 'stands' : `refused: ${said.why}`}`);
        }
        store.scanned(height, hash, out, keepHashes);
        if (out.some((a) => a.stands)) refresh();
        read += 1; height += 1;
      }
    } finally { running = false; }
    return { read };
  }

  /** The anchors of the keys, each with what puts it in a block: what a page checks for itself (GET /census-key/records). */
  async function recordProofs() {
    const out = [];
    for (const a of store.anchors().filter((x) => x.stands && x.kind === 'K')) {
      const { transactions } = splitBlock(await blockAt(a.blockHash));
      const txids = transactions.map((t) => parseTransaction(t).txid);
      out.push({ height: a.height, censusHeight: decodeCensusKeyBody(a.body).record.censusHeight, transaction: toHex(transactions[a.index]), position: a.index, branch: merkleBranchOf(txids, a.index).map(toHex) });
    }
    return out;
  }

  return {
    pass, planAt, recordProofs,
    /** The keys that stand on this node's chain, oldest first: [{ epoch, publicKey, height }], the census' `bond.standingKeys`. */
    standing: () => keys,
    /** The highest height read, null before the first. */
    scannedTo: () => { const t = store.scanTop(); return t ? t.height : null; },
    /** The newest record of a key on the chain, a reshare's or its own, or null. */
    generationOf: (keyHex) => { const list = generations.get(keyHex) || []; return list[list.length - 1] || null; },
    /** The first valid list of a run: { height, present }, or null. */
    reshareList: (keyHex, run) => lists.get(`${keyHex}:${run}`) || null,
    status: () => ({ firstHeight, scannedTo: (store.scanTop() || { height: null }).height,
      keys: keys.map((k) => ({ epoch: k.epoch, publicKey: toHex(k.publicKey), height: k.height, holdersFrom: (generations.get(toHex(k.publicKey)) || []).slice(-1).map((g) => g.epoch)[0] ?? null })),
      anchors: store.anchors().map((a) => ({ height: a.height, index: a.index, kind: a.kind, txid: a.txid, recordId: toHex(a.id), stands: a.stands, why: a.why })) }),
  };
}
