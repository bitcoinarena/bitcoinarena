// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE SEAT'S ARENA INDEX (kanban #925 part 2 step 1, spec ruling #1101 A: "Every network reads every unspent bond since its first
// block ... the index is a seat's cache: reorg-safe, rebuildable and persisted").
//
// Every reader of the chain walks whole blocks today: chainViewOf wants each block's whole transaction list (§25.1 omit but not
// forge), and about ten readers compute merkle branches from every txid. On mainnet a census from genesis_height would read every
// block since, every census. This index reads each block ONCE, as it arrives, and keeps of it only what a reader looks at:
//
//   headers  every height from the network's first block (census.js CENSUS_WHOLE): the 80 bytes, the hash, the transaction count
//   txs      every transaction that carries a Bitcoin Arena output (arena-kinds.js arenaKindsOf, the readers' own recognisers),
//            or spends an output the index watches: its raw bytes, its position in the block and its merkle branch
//   watch    the outputs whose spend matters to a census: each bond candidate's outpoint (census.js bondCandidateOf), and output 0
//            of a transaction that spends one - a template-3 slash start's hold output, which is still the bond (census.js
//            holdOfStart) until it is spent in turn
//
// WHAT READS IT: viewOf(from, to) is the proven partial view (census.js partialViewOf, step 2), and main.js reads a census from it
// from the height indexServesCensus names, with ARENA_ARENA_INDEX=1 (step 3); below that height, and with the switch off, a census
// reads whole blocks as before.
//
// REORG-SAFE. A block is added only on the one before it: its header names the hash this index holds for the height below, or
// addBlock answers `reorg` and adds nothing. syncArenaIndex asks bitcoind for the hash of the highest height held before each
// pass, walks down while it differs, and rolls every row from the fork height back - headers, transactions and watched outputs
// alike - then reads forward again.
//
// REBUILDABLE. rebuild() drops every row and starts again at the first height. range() checks every branch it hands out against
// its header's merkle root, the transaction's bytes against its txid and the headers' links; a row that fails for no known
// reason marks the index for a rebuild, and the next sync starts from the first block.
//
// PERSISTED in the seat's store (node:sqlite DatabaseSync, the tables named arena_index_*), or in a file of its own. The network
// and first height are kept beside the rows: an index opened for another network or another first height starts empty.
import { DatabaseSync } from 'node:sqlite';
import { parseTransaction, blockMerkleRoot } from '../../arena-protocol/src/tx.js';
import { blockHashOf, previousHashOf, merkleRootOf, merkleBranchOf, provesTransaction, meetsTarget } from '../../arena-protocol/src/chain.js';
import { CENSUS_WHOLE, partialViewOf } from '../../arena-protocol/src/census.js';
import { arenaKindsOf } from '../../arena-protocol/src/arena-kinds.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { blocksOver } from './chain-rpc.js';

export const ARENA_INDEX_SCHEMA = 1;

const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
const keyOf = (txid, vout) => `${toHex(txid)}:${vout}`;
/** bitcoind names a block hash in display order: the bytes reversed. */
export const displayHash = (hash) => toHex(Uint8Array.from(hash).reverse());
const joinBranch = (branch) => { const out = new Uint8Array(branch.length * 32); branch.forEach((s, i) => out.set(s, i * 32)); return out; };
const splitBranch = (bytes) => { const out = []; for (let i = 0; i < bytes.length; i += 32) out.push(Uint8Array.from(bytes.subarray(i, i + 32))); return out; };
const u8 = (x) => (x instanceof Uint8Array && x.constructor === Uint8Array ? x : Uint8Array.from(x));

/** The height a network's index starts at: its census's first block (census.js CENSUS_WHOLE), mainnet's genesis_height. */
export function indexFirstHeight(network, { genesisHeight = null } = {}) {
  const whole = Object.hasOwn(CENSUS_WHOLE, String(network)) ? CENSUS_WHOLE[network] : null;
  if (!whole) throw new Error(`no census rule for the network ${network}, so no first block to index from (kanban #925)`);
  if (whole.firstBlock !== 'genesis') return whole.firstBlock;
  if (!Number.isInteger(genesisHeight) || genesisHeight < 0) throw new Error(`the ${network} index starts at genesis_height, and none was given`);
  return genesisHeight;
}

/**
 * DOES A CENSUS AT THIS HEIGHT READ THE INDEX (kanban #925 step 3)? From the height its network's whole-census rule starts at
 * (census.js CENSUS_WHOLE: testnet4 158,226, regtest and mainnet from their first block); below it, a census reads a window of whole
 * blocks as before.
 */
export function indexServesCensus(network, censusHeight) {
  const whole = Object.hasOwn(CENSUS_WHOLE, String(network)) ? CENSUS_WHOLE[network] : null;
  return !!whole && Number.isInteger(censusHeight) && censusHeight >= whole.fromHeight;
}

/**
 * Opens (or creates) the index. `db`: a DatabaseSync (the seat's store) - or `path` for a file of its own (':memory:' by default).
 * `network`: 'regtest' | 'testnet4' | 'mainnet'. `firstHeight`: where it starts (indexFirstHeight unless given).
 */
export function openArenaIndex({ db = null, path = ':memory:', network, firstHeight = undefined, genesisHeight = null } = {}) {
  if (!network) throw new Error('an index names its network');
  const first = firstHeight === undefined ? indexFirstHeight(network, { genesisHeight }) : firstHeight;
  if (!Number.isInteger(first) || first < 0) throw new Error('an index starts at a whole height');
  const own = !db;
  if (own) {
    db = new DatabaseSync(path);
    db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS arena_index_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    -- every height from the first block: its header, its hash (hashing order) and how many transactions it holds
    CREATE TABLE IF NOT EXISTS arena_index_headers (
      height INTEGER PRIMARY KEY, hash BLOB NOT NULL, header BLOB NOT NULL, tx_count INTEGER NOT NULL);
    -- a kept transaction: where it is (height, position), its txid (hashing order), its bytes, why it was kept, its merkle branch
    -- (the steps, 32 bytes each, back to back)
    CREATE TABLE IF NOT EXISTS arena_index_txs (
      height INTEGER NOT NULL, position INTEGER NOT NULL, txid BLOB NOT NULL, raw BLOB NOT NULL, kinds TEXT NOT NULL,
      branch BLOB NOT NULL, PRIMARY KEY (height, position));
    CREATE INDEX IF NOT EXISTS arena_index_txs_txid ON arena_index_txs (txid);
    -- an output whose spend the index keeps: a bond candidate's outpoint ('bond'), or output 0 of a spend of one ('hold');
    -- height is the block that created the row, so a reorg takes it back with the block
    CREATE TABLE IF NOT EXISTS arena_index_watch (
      txid BLOB NOT NULL, vout INTEGER NOT NULL, kind TEXT NOT NULL, height INTEGER NOT NULL, PRIMARY KEY (txid, vout));
    CREATE INDEX IF NOT EXISTS arena_index_watch_height ON arena_index_watch (height);
  `);
  const getMeta = (k) => { const r = db.prepare('SELECT value FROM arena_index_meta WHERE key = ?').get(k); return r ? r.value : null; };
  const setMeta = (k, v) => db.prepare('INSERT INTO arena_index_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, String(v));

  let inTx = false;
  const atomically = (fn) => {
    // inside a transaction the store already holds open, the rows go with it
    if (inTx || db.isTransaction) return fn();
    db.exec('BEGIN IMMEDIATE');
    inTx = true;
    try { const out = fn(); db.exec('COMMIT'); return out; }
    catch (e) { try { db.exec('ROLLBACK'); } catch { /* already gone */ } throw e; }
    finally { inTx = false; }
  };

  const wipe = () => atomically(() => {
    db.exec('DELETE FROM arena_index_headers; DELETE FROM arena_index_txs; DELETE FROM arena_index_watch;');
    setMeta('schema', ARENA_INDEX_SCHEMA); setMeta('network', network); setMeta('first_height', first); setMeta('rebuild', 0);
  });
  if (getMeta('schema') !== String(ARENA_INDEX_SCHEMA) || getMeta('network') !== String(network) || getMeta('first_height') !== String(first)) wipe();

  // the watched outputs, held in memory too: every transaction of every new block asks about each of its inputs
  let watched = new Map();
  const loadWatch = () => {
    watched = new Map();
    for (const r of db.prepare('SELECT txid, vout, kind FROM arena_index_watch').all()) watched.set(keyOf(r.txid, r.vout), r.kind);
  };
  loadWatch();

  const top = () => {
    const r = db.prepare('SELECT height, hash FROM arena_index_headers ORDER BY height DESC LIMIT 1').get();
    return r ? { height: r.height, hash: u8(r.hash) } : null;
  };
  const headerAt = (height) => {
    const r = db.prepare('SELECT height, hash, header, tx_count FROM arena_index_headers WHERE height = ?').get(height);
    return r ? { height: r.height, hash: u8(r.hash), header: u8(r.header), txCount: r.tx_count } : null;
  };
  const next = () => { const t = top(); return t ? t.height + 1 : first; };

  /**
   * ONE BLOCK, READ ONCE: `block` { header, transactions } as chain-rpc.js splitBlock gives it, at `height` (the next one).
   * Answers { ok: true, kept } | { ok: false, reorg: true } (its header does not follow the block held below it: nothing added) |
   * { ok: false, why } (bytes that are not that block).
   */
  function addBlock(height, block) {
    if (height !== next()) throw new Error(`the index takes height ${next()} next, not ${height}`);
    if (!block || !(block.header instanceof Uint8Array) || block.header.length !== 80 || !Array.isArray(block.transactions))
      return { ok: false, why: 'a block is { header, transactions }' };
    const hash = blockHashOf(block.header);
    if (height > first) {
      const below = headerAt(height - 1);
      if (!same(previousHashOf(block.header), below.hash)) return { ok: false, reorg: true, at: height };
    }
    if (!meetsTarget(block.header)) return { ok: false, why: `block ${height}'s header does not meet its own target` };
    let txs;
    try { txs = block.transactions.map((raw) => ({ raw, tx: parseTransaction(raw) })); }
    catch (e) { return { ok: false, why: `block ${height} carries something that is not a transaction: ${e.message}` }; }
    if (!txs.length) return { ok: false, why: `block ${height} is offered with no transactions` };
    const txids = txs.map((t) => t.tx.txid);
    if (!same(blockMerkleRoot(txids), merkleRootOf(block.header)))
      return { ok: false, why: `block ${height} does not contain the transactions offered with it` };

    const kept = [];
    const watchAdd = [];
    const pending = new Map();         // outputs this block starts watching: a later transaction of the same block may spend one
    const watching = (k) => watched.get(k) || pending.get(k);
    txs.forEach(({ raw, tx }, position) => {
      const { kinds, bond } = arenaKindsOf(tx, network);
      let spendsBond = false;
      for (const input of tx.inputs) {
        const w = watching(keyOf(input.previousTxid, input.previousVout));
        if (!w) continue;
        if (!kinds.includes('spend')) kinds.push('spend');
        if (w === 'bond') spendsBond = true;
      }
      if (!kinds.length) return;
      if (bond) { const k = keyOf(tx.txid, bond.vout); if (!watching(k)) { pending.set(k, 'bond'); watchAdd.push({ txid: tx.txid, vout: bond.vout, kind: 'bond' }); } }
      if (spendsBond && tx.outputs.length) {
        const k = keyOf(tx.txid, 0);
        if (!watching(k)) { pending.set(k, 'hold'); watchAdd.push({ txid: tx.txid, vout: 0, kind: 'hold' }); }
      }
      kept.push({ position, txid: tx.txid, raw, kinds });
    });
    atomically(() => {
      db.prepare('INSERT INTO arena_index_headers (height, hash, header, tx_count) VALUES (?, ?, ?, ?)').run(height, hash, block.header, txs.length);
      const put = db.prepare('INSERT INTO arena_index_txs (height, position, txid, raw, kinds, branch) VALUES (?, ?, ?, ?, ?, ?)');
      for (const k of kept) put.run(height, k.position, k.txid, k.raw, k.kinds.join(','), joinBranch(merkleBranchOf(txids, k.position)));
      const w = db.prepare('INSERT OR IGNORE INTO arena_index_watch (txid, vout, kind, height) VALUES (?, ?, ?, ?)');
      for (const x of watchAdd) w.run(x.txid, x.vout, x.kind, height);
    });
    for (const [k, v] of pending) watched.set(k, v);
    return { ok: true, height, kept: kept.length };
  }

  /** Every row from `fromHeight` up goes: headers, kept transactions, watched outputs. */
  function rollback(fromHeight) {
    atomically(() => {
      db.prepare('DELETE FROM arena_index_headers WHERE height >= ?').run(fromHeight);
      db.prepare('DELETE FROM arena_index_txs WHERE height >= ?').run(fromHeight);
      db.prepare('DELETE FROM arena_index_watch WHERE height >= ?').run(fromHeight);
    });
    loadWatch();
  }

  function rebuild() { wipe(); loadWatch(); }

  const rowOf = (r) => ({ height: r.height, position: r.position, txid: u8(r.txid), raw: u8(r.raw), kinds: r.kinds.split(','), branch: splitBranch(u8(r.branch)) });

  /**
   * WHAT A READER OF HEIGHTS `from`..`to` NEEDS: { ok, firstHeight, tipHeight, headers: [{ height, header, txCount }],
   * transactions: [{ height, position, txid, raw, kinds, branch }] } in chain order - or { ok: false, why } for heights the index
   * does not hold. With `check` (the default) every branch is proved into its header, every transaction's bytes hash to its txid
   * and the headers link; a failure marks the index for a rebuild and answers { ok: false, rebuild: true, why }.
   */
  function range(from, to, { check = true } = {}) {
    const t = top();
    if (!Number.isInteger(from) || !Number.isInteger(to) || from > to) return { ok: false, why: 'a range is two whole heights, low to high' };
    if (from < first) return { ok: false, why: `the index starts at ${first}, not ${from}` };
    if (!t || to > t.height) return { ok: false, why: `the index holds up to ${t ? t.height : first - 1}, not ${to}` };
    const headers = db.prepare('SELECT height, header, tx_count FROM arena_index_headers WHERE height BETWEEN ? AND ? ORDER BY height').all(from, to)
      .map((r) => ({ height: r.height, header: u8(r.header), txCount: r.tx_count }));
    const transactions = db.prepare('SELECT height, position, txid, raw, kinds, branch FROM arena_index_txs WHERE height BETWEEN ? AND ? ORDER BY height, position')
      .all(from, to).map(rowOf);
    const out = { ok: true, firstHeight: from, tipHeight: to, headers, transactions };
    if (!check) return out;
    const bad = verifyRows(headers, transactions, from > first ? headerAt(from - 1) : null);
    if (bad) { setMeta('rebuild', 1); return { ok: false, rebuild: true, why: bad }; }
    return out;
  }

  /**
   * THE PROVEN PARTIAL VIEW OF HEIGHTS `from`..`to` (census.js partialViewOf, kanban #925 step 2): every header, and of each block the
   * kept transactions with their positions and branches - checked here first (range), then by chainViewOf like any view. Throws for
   * heights the index does not hold or rows that do not prove (the index is then marked for a rebuild).
   */
  function viewOf(from, to) {
    const r = range(from, to);
    if (!r.ok) throw new Error(`the index cannot give ${from}-${to}: ${r.why}`);
    return partialViewOf(r);
  }

  /** The kept transaction with that txid (hashing order), or null. */
  function transaction(txid) {
    const r = db.prepare('SELECT height, position, txid, raw, kinds, branch FROM arena_index_txs WHERE txid = ? ORDER BY height LIMIT 1').get(txid);
    return r ? rowOf(r) : null;
  }

  const counts = () => ({
    headers: db.prepare('SELECT COUNT(*) AS n FROM arena_index_headers').get().n,
    transactions: db.prepare('SELECT COUNT(*) AS n FROM arena_index_txs').get().n,
    watched: watched.size,
  });

  return {
    network, firstHeight: first, db,
    top, next, headerAt, addBlock, rollback, rebuild, range, viewOf, transaction, counts,
    needsRebuild: () => getMeta('rebuild') === '1',
    markForRebuild: () => setMeta('rebuild', 1),
    watchedKind: (txid, vout) => watched.get(keyOf(txid, vout)) || null,
    close: () => { if (own) db.close(); },
  };
}

/** Does a kept row's branch put its transaction in that header? (chain.js provesTransaction, and the bytes are that txid's.) */
export function provesRow(row, header) {
  let tx;
  try { tx = parseTransaction(row.raw); } catch { return false; }
  return same(tx.txid, row.txid) && provesTransaction(header, row.txid, row.branch, row.position);
}

/** The first thing wrong with these rows, or null: headers that do not link, a row whose branch or bytes do not prove. */
function verifyRows(headers, transactions, below) {
  let prev = below ? below.header : null;
  const byHeight = new Map();
  for (const h of headers) {
    if (prev && !same(previousHashOf(h.header), blockHashOf(prev))) return `the header at ${h.height} does not follow the one below it`;
    prev = h.header;
    byHeight.set(h.height, h);
  }
  for (const r of transactions) {
    const h = byHeight.get(r.height);
    if (!h) return `a transaction at ${r.height} has no header`;
    if (r.position >= h.txCount) return `a transaction at ${r.height}:${r.position} is past the block's ${h.txCount}`;
    if (!provesRow(r, h.header)) return `the transaction at ${r.height}:${r.position} does not prove into its header`;
  }
  return null;
}

/**
 * ONE PASS AGAINST BITCOIND (`call(method, params)`, chain-rpc.js bitcoindRpc): follow a reorg back, then read forward up to
 * `maxBlocks` new blocks, `batch` at a time through chain-rpc.js blocksOver (sharing a blockCache when one is given). An index
 * marked for a rebuild starts again from its first block. Answers { ok, tip, added, rolledBackFrom, top }.
 */
export async function syncArenaIndex(index, call, { cache = null, maxBlocks = 2016, batch = 64 } = {}) {
  let rebuilt = false;
  if (index.needsRebuild()) { index.rebuild(); rebuilt = true; }
  let rolledBackFrom = null, added = 0, tip = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    tip = Number(await call('getblockcount', []));
    // THE HIGHEST HEIGHT HELD, STILL ON BITCOIND'S CHAIN? Walk down while not: the fork is just above the first that is.
    let t = index.top();
    let fork = null;
    while (t) {
      const hash = t.height <= tip ? String(await call('getblockhash', [t.height])) : null;
      if (hash === displayHash(t.hash)) break;
      fork = t.height;
      t = t.height > index.firstHeight ? index.headerAt(t.height - 1) : null;
    }
    if (fork !== null) { index.rollback(fork); rolledBackFrom = rolledBackFrom === null ? fork : Math.min(rolledBackFrom, fork); }
    let reorg = false;
    for (let from = index.next(); from <= tip && added < maxBlocks && !reorg; from = index.next()) {
      const to = Math.min(tip, from + batch - 1, from + (maxBlocks - added) - 1);
      const { blocks } = await blocksOver(call, from, to, { cache });
      for (let i = 0; i < blocks.length; i++) {
        const got = index.addBlock(from + i, blocks[i]);
        if (got.reorg) { reorg = true; break; }
        if (!got.ok) throw new Error(`the index refused block ${from + i}: ${got.why}`);
        added++;
      }
    }
    if (!reorg) break;
  }
  const top = index.top();
  return { ok: true, tip, added, rolledBackFrom, rebuilt, top: top ? top.height : null };
}
