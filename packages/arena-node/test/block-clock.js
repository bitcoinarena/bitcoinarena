// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A CHAIN THAT KEEPS TIME WITH THE TEST (§13A, RULED 2026-09-24: every objection window is blocks at both ends,
// read from the node's own chain view, and every posting, objection and re-run names the block it sits in). The fixtures'
// signer nodes read no bitcoind, so they are handed this: one mined header per `spacingS` seconds of the wall clock, each
// carrying the time five blocks ahead of its own, so the median time past of the block for second s is s. A view is the
// chain AS OF a moment - never a block after it - so a node's tip is the block of that moment: `chainView()` reads the
// real clock (live daemons), `viewAt(ms)` a stubbed one.
//
// Set on a Round as `round.chainView` - never through `chainFor`, which would also make the verifier check the fixtures'
// beacon against this chain.
import { blockHashOf, meetsTarget } from '../../arena-protocol/src/chain.js';

const EASY = 0x207fffff;
const FIRST_HEIGHT = 500000;

function mine(previous, timeS) {
  const h = new Uint8Array(80);
  const v = new DataView(h.buffer);
  v.setUint32(0, 1, true);
  if (previous) h.set(blockHashOf(previous), 4);
  v.setUint32(68, timeS, true);
  v.setUint32(72, EASY, true);
  for (let nonce = 0; nonce < 1e8; nonce++) {
    v.setUint32(76, nonce, true);
    if (meetsTarget(h)) return h;
  }
  throw new Error('no nonce found at the easy target');
}

/** One shared chain. `spacingS`: one block per that many seconds (default 1). */
export function blockClock({ spacingS = 1, startS = null } = {}) {
  const blocks = [];
  const first = startS ?? (Math.floor(Date.now() / 1000 / spacingS) * spacingS - 30 * spacingS);
  let at = first - spacingS;
  const views = new Map();
  const growTo = (s) => {
    while (at + spacingS <= s) {
      at += spacingS;
      blocks.push({ header: mine(blocks.length ? blocks[blocks.length - 1].header : null, at + 5 * spacingS), second: at });
    }
  };
  /** The chain as of `ms`: every block whose own second is at or before it. One view object per tip. */
  const viewAt = (ms) => {
    const s = Math.floor(ms / 1000);
    growTo(s);
    let n = blocks.length;
    while (n > 0 && blocks[n - 1].second > s) n--;
    if (!views.has(n)) views.set(n, { firstHeight: FIRST_HEIGHT, blocks: blocks.slice(0, n), pending: false });
    return views.get(n);
  };
  return {
    viewAt,
    view: () => viewAt(Date.now()),
    /**
     * `round.chainView` for a Round: the chain AS OF THE ROUND'S OWN CLOCK - `this.now()`, the wall clock for a daemon's
     * Round and the stubbed moment for a test's view of it - so a read at a moment sees exactly the blocks of that moment.
     */
    chainView: () => function chainAsOfNow() { return viewAt(this && typeof this.now === 'function' ? this.now() : Date.now()); },
    /** The tip's hash as of `ms`: the block a filing made then names. */
    tipAt: (ms) => { const v = viewAt(ms); return blockHashOf(v.blocks[v.blocks.length - 1].header); },
    /** A block's median time past (ms) by its hash, as a node reads it. */
    mtpOf: (hash) => {
      const hex = Buffer.from(hash).toString('hex');
      const b = blocks.find((x) => Buffer.from(blockHashOf(x.header)).toString('hex') === hex);
      return b ? b.second * 1000 : null;
    },
    /** The end block's time of a window opened at `openMs`: the first block time at or after open + W. */
    endAt: (openMs, W) => Math.ceil((openMs + Number(W)) / (spacingS * 1000)) * spacingS * 1000,
    spacingS,
  };
}

/** One clock per process: every fixture daemon reads the same chain, as signer nodes on one network do. */
export const CLOCK = blockClock();
