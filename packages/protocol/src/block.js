// A BLOCK AS A NODE SERVES IT.
//
// Kept out of `tx.js` on purpose: the client bundles the transaction parser
// and never reads a block, and 2.4 KB of code nobody calls is 2.4 KB shipped
// to every player. The census reads blocks; the client reads transactions.
import { readVarint } from './tx.js';

function need(bytes, at, n, what) {
  const end = at + n;
  if (!Number.isInteger(at) || at < 0 || end > bytes.length)
    throw new Error(`the block ends inside its ${what}`);
  return end;
}

function readSlice(bytes, at, what) {
  const { value, next } = readVarint(bytes, at);
  return { next: need(bytes, next, value, what) };
}

/**
 * WHERE ONE TRANSACTION ENDS INSIDE A BLOCK.
 *
 * `parseTransaction` refuses leftover bytes on purpose - a transaction handed
 * over with something after it is not a transaction anybody agreed on - so it
 * cannot be pointed at the middle of a block. This walks the same structure to
 * find the span, and the span is then handed back to `parseTransaction`, which
 * re-reads it under that exact rule. A span computed wrongly does not slip
 * through: the slice fails to parse, or its txid is wrong and the block's own
 * merkle root refuses it in `chainViewOf`.
 */
function transactionSpan(raw, from) {
  let at = need(raw, from, 4, 'version');
  const segwit = raw[at] === 0x00 && raw[at + 1] === 0x01;
  if (segwit) at += 2;

  const ins = readVarint(raw, at);
  if (ins.value === 0) throw new Error('a transaction with no inputs');
  at = ins.next;
  for (let i = 0; i < ins.value; i++) {
    at = readSlice(raw, need(raw, at, 36, 'outpoint'), 'input script').next;
    at = need(raw, at, 4, 'sequence');
  }

  const outs = readVarint(raw, at);
  at = outs.next;
  for (let i = 0; i < outs.value; i++)
    at = readSlice(raw, need(raw, at, 8, 'value'), 'output script').next;

  if (segwit) {
    for (let i = 0; i < ins.value; i++) {
      const items = readVarint(raw, at);
      at = items.next;
      for (let k = 0; k < items.value; k++) at = readSlice(raw, at, 'witness item').next;
    }
  }
  return need(raw, at, 4, 'locktime');
}

/**
 * A BLOCK AS BITCOIN SERVES IT: eighty header bytes, a count, and the
 * transactions back to back.
 *
 * This is what makes a chain view something a node can be ASKED for rather
 * than something a fixture composes. The census checks the header links and
 * the merkle root itself (`chainViewOf`), so nothing here has to be trusted:
 * this only says where the bytes divide.
 */
export function splitBlock(raw) {
  if (!(raw instanceof Uint8Array) || raw.length < 81)
    throw new Error(`a block is more than ${raw && raw.length} bytes`);
  const header = raw.slice(0, 80);
  const count = readVarint(raw, 80);
  if (count.value === 0) throw new Error('a block has at least a coinbase');

  const transactions = [];
  let at = count.next;
  for (let i = 0; i < count.value; i++) {
    const end = transactionSpan(raw, at);
    transactions.push(raw.slice(at, end));
    at = end;
  }
  if (at !== raw.length)
    throw new Error(`${raw.length - at} bytes left over after ${count.value} transactions`);
  return { header, transactions };
}
