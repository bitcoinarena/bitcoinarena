// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE PARTS OF A PROVEN PARTIAL VIEW (kanban #925 part 2 step 2): which blocks of a view are partial, and where a transaction of one
// stands. census.js chainViewOf proves them (see the note there: a branch proves inclusion, not completeness); the readers that need a
// transaction's position or branch (advert-update.js, reaffirm.js, the seat's evidence and presence proofs) ask here, and a whole block
// answers as it always did.
import { parseTransaction } from './tx.js';
import { merkleBranchOf } from './chain.js';

const PARTIAL_BLOCKS = new WeakSet();
/** Registers a block object as partial (census.js chainViewOf and partialViewOf alone call it). */
export const markPartial = (block) => { PARTIAL_BLOCKS.add(block); return block; };
export const isPartialBlock = (block) => !!block && typeof block === 'object' && PARTIAL_BLOCKS.has(block);
/** Where a view's block's `i`-th transaction stands in its block: its index for a whole block, its kept position for a partial one. */
export const positionIn = (block, i) => (isPartialBlock(block) ? block.positions[i] : i);
/** How many transactions the block holds (a partial block says, as its own index read it). */
export const txCountOf = (block) => (isPartialBlock(block) ? block.txCount : (block.transactions || []).length);
/** The merkle branch of a view's block's `i`-th transaction: kept for a partial block, computed from `txids` (all of them) for a whole one. */
export function branchIn(block, i, txids = null) {
  if (isPartialBlock(block)) return block.branches[i];
  return merkleBranchOf(txids || block.transactions.map((raw) => parseTransaction(raw).txid), i);
}

/**
 * THE VIEW OF AN INDEX RANGE: `range` is arena-index.js range(from, to) - { firstHeight, headers: [{ height, header, txCount }],
 * transactions: [{ height, position, raw, branch }] } in chain order. Answers `{ blocks, firstHeight }`, one block per header, which
 * chainViewOf proves as above and every census reader reads as it reads whole blocks.
 */
export function partialViewOf(range) {
  if (!range || !Array.isArray(range.headers) || !range.headers.length || !Number.isInteger(range.firstHeight)) throw new Error('a partial view is an index range: its headers from a first height');
  const blocks = range.headers.map((h, i) => {
    if (h.height !== range.firstHeight + i) throw new Error(`the index range has no header at ${range.firstHeight + i}`);
    const b = { header: h.header, transactions: [], positions: [], branches: [], txCount: h.txCount };
    return markPartial(b);
  });
  for (const t of range.transactions || []) {
    const b = blocks[t.height - range.firstHeight];
    if (!b) throw new Error(`the index range holds a transaction at ${t.height}, outside its headers`);
    b.transactions.push(t.raw); b.positions.push(t.position); b.branches.push(t.branch);
  }
  return { blocks, firstHeight: range.firstHeight, partial: true };
}

