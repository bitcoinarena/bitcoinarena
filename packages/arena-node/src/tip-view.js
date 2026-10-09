// THE CHAIN A WINDOW IS READ ON FOLLOWS THE TIP (testnet4 2026-09-30, the first paid series round fbd8294e).
//
// Measured: the round closed FAILED, all 7 signer nodes agreed and posted, and the settlement never came - 17 min past
// the close every node still said "PROVISIONALLY_FINAL, settle=not-final". The §13A windows are blocks (RULED 2026-09-24):
// one opens at the block the postings name and ends at the first later block whose median time past reaches open + W.
// An attached node (main.js) answered `round.chainView` from the round's census view, and that view stops at the beacon
// plus the round's depth and is kept for good: no block after it ever came into view, so no window could end, the tip a
// posting or re-run names was that stale block, and no §13C result window could open. round-2of2's view moves with the
// tip; main.js's did not.
//
// So the window chain is its own view, headers only, `back` blocks below the tip when first read and grown by the new
// blocks after that - one read in flight, at most every `everyMs`, about two RPC calls a new block (the 07:10Z flood was
// full blocks per round id, re-asked; this is one header view per node). A block that does not link to the last one
// held (a reorg) drops the last `reorgDepth` held and reads them again.
import { blockHashOf } from '../../arena-protocol/src/chain.js';
import { fromHex } from '../../arena-protocol/src/hash.js';

const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

/** `() => view` for `round.chainView`: `{ firstHeight, blocks: [{ header }] }` to the tip, or `{ pending: true }` before the first read. */
export function tipHeaderView({ call, back = 432, everyMs = 30000, reorgDepth = 12, now = () => Date.now(), log = () => {} }) {
  let headers = [];
  let firstHeight = 0;
  let view = null;
  let reading = null;
  let readAt = -Infinity;
  const headerAt = async (h) => fromHex(await call('getblockheader', [await call('getblockhash', [h]), false]));
  const read = async () => {
    const tip = Number(await call('getblockcount'));
    if (!headers.length) { firstHeight = Math.max(0, tip - back); }
    const had = headers.length;
    let changed = false;
    let next = firstHeight + headers.length;
    for (; next <= tip; next++) {
      const hdr = await headerAt(next);
      if (headers.length && !same(hdr.subarray(4, 36), blockHashOf(headers[headers.length - 1]))) {
        headers = headers.slice(0, Math.max(0, headers.length - reorgDepth));
        changed = true;
        log(`[tip-view] block ${next} does not link to the one held below it: the last ${reorgDepth} are read again`);
        next = firstHeight + headers.length - 1;
        continue;
      }
      headers.push(hdr);
    }
    // A NEW VIEW ONLY WHEN THE CHAIN MOVED: its readers index a view once (finality.js chainIndex).
    if (!view || changed || headers.length !== had) view = { firstHeight, blocks: headers.map((header) => ({ header })) };
  };
  return () => {
    if (!reading && now() - readAt >= everyMs) {
      readAt = now();
      reading = read().catch((e) => log(`[tip-view] the tip could not be read: ${e.message}`)).finally(() => { reading = null; });
    }
    return view || { pending: true };
  };
}
