// A CHAIN OF REAL, MINED HEADERS, FOR TESTS AND VECTORS.
//
// NOT part of the protocol: nothing in `src/` imports it, the same rule
// `bond.js` beside it follows. A node does not mine.
//
// Not a fixture generator for convenience: the census now refuses a header
// whose hash does not meet the target it claims, and refuses a block whose
// transactions do not hash to the root its header commits to. A test that
// wanted to hand it blocks therefore has to MINE them, at a target easy enough
// to hit in a few tries - `0x207fffff`, which is regtest's, so almost any
// nonce works and the arithmetic is still Bitcoin's.
import { hash256, parseTransaction, blockMerkleRoot } from '../src/tx.js';
import { blockHashOf, meetsTarget } from '../src/chain.js';
import { serializeSpend } from '../src/bond-spend.js';
import { publicationOutput } from '../src/publication.js';
import { roundId } from '../src/contracts.js';

const EASY = 0x207fffff;
// Harder, and still findable in a test: about 2^16 tries rather than mainnet's
// 2^32. Enough that one HARD header outweighs several EASY ones, which is what
// a most-work comparison has to be shown on.
const HARD = 0x1f00ffff;

/**
 * The first fixture block's time, and ten minutes a block after it.
 *
 * Every header used to carry ONE timestamp, which was fine while nothing read
 * it and wrong the moment something did: letter 32 picks the block whose
 * MEDIAN TIME PAST is first after `committee_time`, and on a chain where every
 * block claims the same second there is no such block and no order to find it
 * in. Ten minutes apart is Bitcoin's own average and makes the median move.
 */
const FIRST_TIME = 1788700000;
const SPACING = 600;

/** One mined header over these transactions, following `previous`. */
function mine(transactions, previous, bits, at = 0, timeOf = (i) => FIRST_TIME + i * SPACING) {
  const h = new Uint8Array(80);
  const view = new DataView(h.buffer);
  view.setUint32(0, 1, true);
  if (previous) h.set(blockHashOf(previous), 4);
  if (transactions.length)
    h.set(blockMerkleRoot(transactions.map((raw) => parseTransaction(raw).txid)), 36);
  view.setUint32(68, timeOf(at), true);
  view.setUint32(72, bits, true);
  for (let nonce = 0; nonce < 1e8; nonce++) {
    view.setUint32(76, nonce, true);
    if (meetsTarget(h)) return h;
  }
  throw new Error('no nonce found, which should not happen at this target');
}

/**
 * A chain view over `blocks`, each `{ transactions }`, starting at
 * `firstHeight`. `bits` picks how much work every header carries, so two
 * views can compete. `timeOf(at)` (seconds) mines it at another clock - around a round's own committee time (the
 * bonded-chain fixture, 2026-09-25); unset, every header is where it always was.
 */
export function chainOf(blocks, firstHeight, { bits = EASY, timeOf = (i) => FIRST_TIME + i * SPACING } = {}) {
  const out = [];
  let previous = null;
  for (const [at, block] of blocks.entries()) {
    const header = mine(block.transactions || [], previous, bits, at, timeOf);
    out.push({ header, transactions: block.transactions || [] });
    previous = header;
  }
  return { blocks: out, firstHeight };
}

/**
 * A ROUND'S PUBLICATION, as one real transaction a fixture block can carry:
 * OP_RETURN "ARN" ROUND round_id (5A.5, v4.6.2). Its input names the round id
 * as a previous txid, so two rounds' publications are two transactions.
 */
export function publicationOf(contract) {
  const rid = roundId(contract);
  return serializeSpend({
    inputs: [{ txid: rid, vout: 0, sequence: 0xffffffff }],
    outputs: [publicationOutput(rid)],
    witnesses: [[new Uint8Array(64)]],
  });
}

export { EASY, HARD, mine, hash256, FIRST_TIME, SPACING };
