// A SECOND, INDEPENDENT VIEW OF THE CHAIN (§5A.4, §25.1, kanban #299): "paying rounds need headers from >= 2 independent sources". By
// default both of a page's header sources are the round's own nodes (join.js) - two parties, but both of the network being checked.
// An Esplora-style block explorer (mempool.space and its kind: GET /block-height/<h> -> the block hash) is a party outside it. It serves
// no header blob, so it is asked as a SPOT CHECK: the block the agreed chain has at a height - the census height, the tip - must be the
// block the explorer names there. A mismatch refuses the round by name; an explorer that cannot be reached is said, not taken as agreement.
import { toHex } from '../../arena-protocol/src/hash.js';

/** The display hash (big-endian hex, as explorers write it) of a block hash in internal byte order. */
export const displayHash = (internal) => toHex(Uint8Array.from(internal).reverse());

/**
 * Does the explorer at `base` name the same block at each of `points` [{ height, hash (internal bytes) }]? Answers { ok, checked,
 * why } - ok false with `mismatch` when it names another block, with `unreachable` when it could not be asked.
 */
export async function explorerAgrees({ base, points, fetcher = fetch, timeoutMs = 8000 } = {}) {
  if (!base) return { ok: false, unreachable: true, checked: 0, why: 'no explorer is configured' };
  let checked = 0;
  for (const p of points || []) {
    const want = displayHash(p.hash);
    let said;
    try {
      const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
      const timer = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : null;
      const r = await fetcher(`${String(base).replace(/\/+$/, '')}/block-height/${p.height}`, ctl ? { signal: ctl.signal } : {});
      if (timer) clearTimeout(timer);
      if (!r.ok) return { ok: false, unreachable: true, checked, why: `the explorer answered ${r.status} for block ${p.height}` };
      said = String(await r.text()).trim().toLowerCase();
    } catch (e) { return { ok: false, unreachable: true, checked, why: `the explorer could not be asked for block ${p.height}: ${e.message}` }; }
    if (said !== want) return { ok: false, mismatch: true, checked, why: `the explorer names block ${said.slice(0, 16)}… at height ${p.height} and the nodes' chain ${want.slice(0, 16)}…: not one chain, the round is refused` };
    checked++;
  }
  return { ok: true, checked, why: `the explorer names the same block at ${checked} height${checked === 1 ? '' : 's'}` };
}
