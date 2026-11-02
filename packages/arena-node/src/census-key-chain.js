// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// WHICH CENSUS KEYS STAND, READ FROM THIS NODE'S OWN CHAIN (5A.3B, kanban #972, #1041).
//
//   THE SCAN      forward from the network's CENSUS_KEY_FIRST_HEIGHT, every block once, what it found kept across restarts. No lookback window: a key is named by bonds for
//                 years, and #820 is what a window does. Bounded as the ballot's tally is: at most `maxBlocksPerPass` blocks a pass
//   THE BODY      in the anchor's own witness, so nothing is fetched from anyone and a census stays a pure function of the chain. An anchor whose witness carries no body
//                 that stands is refused and the next valid one counts, which is also the answer to a relay that strips a body's signatures: the witness is not in the
//                 txid and the record's hash does not cover them, so anyone may post the record again
//   THE JUDGING   in chain order. A record's census is below its anchor, and that census reads only keys standing below itself, so by the time an anchor is judged everything it
//                 depends on already has been. A census that cannot be read stops the pass before its height is written, and the same block is read next pass
//   A REORG       the scan keeps the hashes of the last `keepHashes` blocks. The top one is asked each pass; moved, the kept heights are walked down to one still on the chain
//                 and everything above it is forgotten. Past all of them it starts again from the first height
import { censusKeyAnchorIn, censusKeyBodyIn, censusKeyRecordDue, censusKeyShares, censusKeyRecordStands, standingCensusKeys, decodeCensusKeyBody, encodeCensusKeyBody,
  censusKeyDrawHeight } from '../../arena-protocol/src/census-key.js';
import { splitBlock } from '../../arena-protocol/src/block.js';
import { parseTransaction } from '../../arena-protocol/src/tx.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';

const MARK = Buffer.from([0x6a, 36, 0x41, 0x52, 0x4e, 0x4b]);       // OP_RETURN, a 36-byte push, "ARN" 'K'

/** Every "ARN" 'K' anchor of a block, in block order: [{ height, index, txid, id, body }], `body` null where the witness carries none. */
export function censusKeyAnchorsInBlock(raw, height) {
  const out = [];
  splitBlock(raw).transactions.forEach((t, index) => {
    let tx; try { tx = parseTransaction(t); } catch { return; }
    const id = censusKeyAnchorIn(tx.outputs);
    if (id) out.push({ height, index, txid: toHex(Uint8Array.from(tx.txid).reverse()), id, body: censusKeyBodyIn(tx, id) });
  });
  return out;
}

/**
 * `store`: CensusKeyStore. `tipHeight()`; `blockHashAt(height)` the hash bitcoind prints, null above the tip; `blockAt(hash)` the raw block; `censusEntriesAt(height)` the
 * census at a height (censusKeyContract's), which throws or answers null while it cannot be read; `verify(signature, digest, key)`; `genesisKey` mainnet's key 0.
 */
export function createCensusKeyScan({ store, network, networkId, firstHeight, censusConfirmations, genesis = null, genesisKey = null, tipHeight, blockHashAt, blockAt, censusEntriesAt,
  verify, sharesMax = undefined, maxBlocksPerPass = 64, keepHashes = 288, log = () => {} }) {
  let keys = [];
  let running = false;

  const standingFrom = (rows) => standingCensusKeys({ genesisKey, anchors: rows.filter((a) => a.stands), judge: (id) => {
    const row = rows.find((a) => a.stands && toHex(a.id) === toHex(id));
    return row ? { ok: true, record: decodeCensusKeyBody(row.body).record } : { ok: false };
  } });
  const refresh = () => { keys = standingFrom(store.anchors()); };
  refresh();

  /** One anchor: { stands, why }. Throws while its census or block hash cannot be read. */
  async function judge(anchor, taken) {
    if (!anchor.body) return { stands: false, why: 'its witness carries no body for that record' };
    const { record, signatures } = anchor.body;
    if (toHex(record.networkId) !== toHex(networkId)) return { stands: false, why: 'that record is for another network' };
    const due = censusKeyRecordDue({ record, height: anchor.height, network, firstHeight, censusConfirmations });
    if (!due.ok) return { stands: false, why: due.why };
    if (taken.has(record.epoch)) return { stands: false, why: `epoch ${record.epoch} already has its key` };
    const hash = await blockHashAt(censusKeyDrawHeight(record.epoch, network));
    const entries = await censusEntriesAt(due.censusHeight);
    if (!hash || !entries) throw new Error(`the census at ${due.censusHeight} cannot be read yet`);
    const shares = censusKeyShares({ entries, network, genesis, blockHash: fromHex(String(hash)), ...(sharesMax ? { sharesMax } : {}) });
    const stands = censusKeyRecordStands({ record, signatures, networkId, shares, verify });
    return { stands: stands.ok, why: stands.ok ? null : stands.why };
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
        const found = Buffer.from(raw.buffer, raw.byteOffset, raw.length).includes(MARK) ? censusKeyAnchorsInBlock(raw, height) : [];
        const taken = new Set(keys.map((k) => k.epoch));
        const out = [];
        for (const a of found) {
          const said = await judge(a, taken);
          if (said.stands) taken.add(a.body.record.epoch);
          out.push({ ...a, ...said, bodyBytes: said.stands ? encodeCensusKeyBody(a.body) : null });
          log(`[census-key] anchor ${a.txid.slice(0, 16)} at ${height}: ${said.stands ? `epoch ${a.body.record.epoch} stands` : `refused: ${said.why}`}`);
        }
        store.scanned(height, hash, out, keepHashes);
        if (out.some((a) => a.stands)) refresh();
        read += 1; height += 1;
      }
    } finally { running = false; }
    return { read };
  }

  return {
    pass,
    /** The keys that stand on this node's chain, oldest first: [{ epoch, publicKey, height }], the census' `bond.standingKeys`. */
    standing: () => keys,
    /** The highest height read, null before the first. */
    scannedTo: () => { const t = store.scanTop(); return t ? t.height : null; },
    status: () => ({ firstHeight, scannedTo: (store.scanTop() || { height: null }).height,
      keys: keys.map((k) => ({ epoch: k.epoch, publicKey: toHex(k.publicKey), height: k.height })),
      anchors: store.anchors().map((a) => ({ height: a.height, index: a.index, txid: a.txid, recordId: toHex(a.id), stands: a.stands, why: a.why })) }),
  };
}
