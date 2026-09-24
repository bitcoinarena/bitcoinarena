// A CHAIN THAT KEEPS TIME WITH THE TEST (RULED the owner 2026-09-24: every finality window counts from a block instant -
// the median time past of the first block at or after the moment - read from the node's own chain view, failing closed
// without one). The fixtures' signer nodes read no bitcoind, so they are handed this: one mined header per second of the
// wall clock, each carrying the second five ahead of its own, so the median time past of the block for second s is s.
// A moment a thus has the instant ceil(a / 1000) * 1000 at every signer node that reads the one chain - which is the
// point: two nodes that saw the same thing at different moments inside one second place it at one instant. The chain is
// mined a minute ahead of the clock so a block at the round's confirmation depth (the fixtures ask for 1) is there.
//
// Set on a Round as `round.chainView` - never through `chainFor`, which would also make the verifier check the
// fixtures' beacon against this chain.
import { blockHashOf, meetsTarget } from '../../protocol/src/chain.js';

const EASY = 0x207fffff;
const AHEAD_S = 60;
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

/** One shared chain; `view()` extends it to the clock and returns the same object, its blocks grown in place. */
// `spacingS`: one block per that many seconds (default 1). A coarser clock - real chains are - is how two moments a
// second or two apart fall under one block and get one instant.
export function blockClock({ now = () => Date.now(), spacingS = 1, startS = null } = {}) {
  const blocks = [];
  const first = startS ?? (Math.floor(Date.now() / 1000 / spacingS) * spacingS - 12 * spacingS);
  let at = first - spacingS;
  const view = { firstHeight: FIRST_HEIGHT, blocks, pending: false };
  const grow = () => {
    const to = Math.floor(now() / 1000) + Math.max(AHEAD_S, 2 * spacingS);
    while (at < to) {
      at += spacingS;
      blocks.push({ header: mine(blocks.length ? blocks[blocks.length - 1].header : null, at + 5 * spacingS), second: at });
    }
  };
  return {
    view: () => { grow(); return view; },
    /** The instant a moment gets on this chain: the first block time at or after it. */
    instantOf: (ms) => Math.ceil(ms / (spacingS * 1000)) * spacingS * 1000,
    /** `round.chainView` for a Round. */
    chainView() { return () => { grow(); return view; }; },
  };
}

/** One clock per process: every fixture daemon reads the same chain, as signer nodes on one network do. */
export const CLOCK = blockClock();
