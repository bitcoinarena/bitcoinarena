// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE SECOND MARK OF A THEFT: AN UNBACKED SPEND (kanban #1093 part 2, ruling #1106, 2026-11-03): "a reserve UTXO spent on the chain, 6 deep, by no
// peg-out in the signed history." Gateway peg-outs and drain moves are consensus transactions and so are in the history; nothing needs recording.
//
// Our federations run walletv2: the whole reserve is one output, which a threshold of guardians names (federation_wallet: { value, outpoint }),
// and every legitimate move of it - a peg-in swept, a peg-out paid, a drain - is a transaction the federation signed in consensus, so its txid is
// in the signed history (reserve-audit.js keeps those txids). One pass:
//   1. the outpoint the threshold names now is remembered with the height it was seen unspent;
//   2. an outpoint seen before that is now spent on the chain: its spender is found in the blocks since it was last seen unspent;
//   3. once that spend is 6 deep: if the signed history (read up to now) names the spender's txid, it was the federation's own move; if not, it
//      is a mark - the federation's alarm is raised (reserve-alarms.js `unbacked-spend`, with the spender's txid), and deposits stop.
// A spend not yet 6 deep, or a history not read past the spend yet, waits; nothing is raised on a guess.
export const UNBACKED_DEPTH = 6;

/**
 * `walletOutpoint(fid)` -> 'txid:vout' | null: the outpoint a threshold of guardians names now (federation-reserve.js readReserve, walletv2).
 * `isSpent(outpoint)` -> true | false | null (unknown); `spenderOf(outpoint, fromHeight, toHeight)` -> { txid, height } | null, from the blocks.
 * `historyTxids(fid)` -> { txids: Set, startedAtMs, lastSession } the wallet transactions the signed history names (reserve-audit.js), when the
 * audit pass that read it started, and the last session it read. `load(fid)` / `save(fid, row)`: { seen: { outpoint: height }, spends: { outpoint: { txid, height, seenAtMs } } }.
 */
export function createReserveSpendWatch({ walletOutpoint, isSpent, spenderOf, historyTxids, tip, load, save, alarms, nowMs = () => Date.now(), depth = UNBACKED_DEPTH, say = () => {} }) {
  async function watchOne(fid) {
    const f = String(fid).toLowerCase();
    const row = load(f) || { seen: {}, spends: {} };
    const h = Number(await tip());
    let now = null; try { now = await walletOutpoint(f); } catch { now = null; }
    // a new outpoint is remembered; a known one's height moves only when the chain says it is still unspent (below), so its spender is
    // looked for from the last block it was seen unspent - the one the threshold still names too: a guardian set that stole names its old output
    if (now && !(now in row.seen)) row.seen[now] = h;
    // 2. outpoints seen before and spent since: find the spender
    for (const [op, lastUnspent] of Object.entries(row.seen)) {
      if (row.spends[op]) continue;
      let spent = null; try { spent = await isSpent(op); } catch { spent = null; }
      if (spent !== true) { if (spent === false) row.seen[op] = h; continue; }
      let by = null; try { by = await spenderOf(op, Number(lastUnspent), h); } catch { by = null; }
      if (by && by.txid) row.spends[op] = { txid: String(by.txid).toLowerCase(), height: Number(by.height), seenAtMs: nowMs() };
    }
    // 3. each spend 6 deep: the federation's own move, or a mark
    const out = [];
    const hist = (await historyTxids(f)) || { txids: new Set(), readAtMs: 0 };
    for (const [op, s] of Object.entries(row.spends)) {
      if (s.judged) continue;
      if (h - s.height + 1 < depth) { out.push({ outpoint: op, wait: `the spend is ${h - s.height + 1} deep, ${depth} needed` }); continue; }
      if (hist.txids.has(s.txid)) { s.judged = 'consensus'; delete row.seen[op]; out.push({ outpoint: op, consensus: s.txid }); continue; }
      // A HISTORY READ AFTER THE SPEND WAS SEEN IS NOT ENOUGH (kanban #1108, measured on the regtest devnet 2026-11-04 09:57Z: the federation's
      // own consolidation 98a886cc, 6 deep, raised a false alarm - the audit had read after the spend was seen, but only the sessions finished
      // before it; the session holding the consolidation's `Signatures` was still open and was read 3 s later). The transaction is signed in a
      // session no later than the one open when its spend was seen (O). A pass that STARTED after the sighting read up to at least O - 1
      // (`baseSession`); once a later pass reads a session past that, session O is in the history, and only then is an unnamed spender a mark.
      if (!(Number(hist.startedAtMs ?? hist.readAtMs) > s.seenAtMs) || !Number.isInteger(hist.lastSession)) { out.push({ outpoint: op, wait: 'the signed history is not read past the spend yet' }); continue; }
      if (!Number.isInteger(s.baseSession)) s.baseSession = hist.lastSession;
      if (!(hist.lastSession > s.baseSession)) { out.push({ outpoint: op, wait: `the session open when the spend was seen is not in the history yet (read to ${hist.lastSession}, past ${s.baseSession} needed)` }); continue; }
      s.judged = 'unbacked';
      const r = alarms.raise({ federation: f, kind: 'unbacked-spend', height: s.height, txid: s.txid });
      say({ federation: f.slice(0, 16), unbackedSpend: s.txid, outpoint: op, height: s.height, kept: r.kept });
      out.push({ outpoint: op, unbacked: s.txid });
    }
    save(f, row);
    return { federation: f, now, results: out };
  }
  return { watchOne };
}

/**
 * THE SEAT'S READS FOR THE WATCH (kanban #1108), from what it already holds:
 *   walletOutpoint  the federation's guardians (`endpointsOf(fid)` -> Map peer -> endpoint), asked through `readReserve` (federation-reserve.js):
 *                   the walletv2 output a threshold names, null for a stock-wallet federation or no agreement
 *   isSpent         `chainTxOut(txid, vout)` (main.js gettxout, confirmed set): null -> spent, an output -> unspent
 *   spenderOf       `chainSpenderOf(txid, vout, from, to)` (main.js: the blocks from..to, verbosity 2), at most `maxBlocks` of them
 *   historyTxids    the reserve audit's kept row (reserve-audit.js): its signed bitcoin txids and when it was read
 */
export function spendWatchReads({ endpointsOf, readReserve, thresholdOf, chainTxOut, chainSpenderOf, auditRow, maxBlocks = 2016 }) {
  const split = (op) => { const i = String(op).lastIndexOf(':'); return [String(op).slice(0, i), Number(String(op).slice(i + 1))]; };
  return {
    walletOutpoint: async (fid) => {
      const m = await endpointsOf(fid);
      const endpoints = m ? [...m.values()].filter(Boolean) : [];
      if (!endpoints.length) return null;
      const r = await readReserve({ endpoints, threshold: thresholdOf(endpoints.length) });
      return r && r.ok && r.outpoint ? String(r.outpoint).toLowerCase() : null;
    },
    isSpent: async (op) => { const [t, v] = split(op); const o = await chainTxOut(t, v); return o === null ? true : o ? false : null; },
    spenderOf: async (op, from, to) => { const [t, v] = split(op); return chainSpenderOf(t, v, Math.max(from, to - maxBlocks + 1), to); },
    historyTxids: async (fid) => {
      const row = auditRow(fid);
      // when the pass that read it STARTED (a pass reads only the sessions finished by then), and how far it read
      return { txids: new Set((row && row.pegOutTxids) || []), startedAtMs: Number((row && (row.startedAtMs ?? 0)) || 0),
        lastSession: row && Number.isInteger(row.lastSession) ? row.lastSession : null };
    },
  };
}
