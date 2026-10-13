// THE BALLOT READ OFF THE CHAIN, AND ACTIVATION (spec §27A.7.3, §27A.7.5, kanban #329), the second slice.
//
//   VOTES      every OP_RETURN output of a block whose push is a 77-byte "ARN" 'V' vote (ballot.js decodeVote), with the height and
//              txid the tally needs - the tally then decides which bond, which phase, which one is last
//   ACTIVATION the config live at a height: from genesis, each PASSED proposal at its activation_height, in order of height (ties:
//              lower proposal id). "parent serialises competing proposals. Both may pass; the first to activate becomes the
//              config, and the second is void at its activation height because its parent is no longer current" (§27A.7.2)
//
// What is live is a pure function of the passed proposals and a height; which proposals passed is the tally's.
import { splitBlock } from './block.js';
import { parseTransaction, commitmentsOf } from './tx.js';
import { decodeVote } from './ballot.js';
import { toHex } from './hash.js';

/** The vote outputs of one raw block at `height`: [{ payload, height, txid }], txid hex in Bitcoin's display order. */
export function votesInBlock(raw, height) {
  const out = [];
  for (const t of splitBlock(raw).transactions) {
    let tx; try { tx = parseTransaction(t); } catch { continue; }
    for (const payload of commitmentsOf(tx)) {
      if (!decodeVote(payload)) continue;
      out.push({ payload, height, txid: toHex(Uint8Array.from(tx.txid).reverse()) });
    }
  }
  return out;
}

/**
 * THE CONFIG LIVE AT `height`. `genesis`: { configHash, config }; `passed`: [{ id, parent, configHash, config, activationHeight }]
 * - proposals the tally passed. Answers { configHash, history: [{ configHash, config, since, by }], void: [{ id, why }] };
 * `history` (genesis first) is what isRepeal reads.
 */
export function liveConfig({ genesis, passed = [], height }) {
  const history = [{ configHash: genesis.configHash, config: genesis.config, since: 0, by: null }];
  const voided = [];
  const due = passed.filter((p) => p.activationHeight <= height)
    .sort((a, b) => (a.activationHeight - b.activationHeight) || (toHex(a.id) < toHex(b.id) ? -1 : 1));
  for (const p of due) {
    const current = history[history.length - 1];
    if (toHex(p.parent) !== toHex(current.configHash)) {
      voided.push({ id: p.id, why: `its parent ${toHex(p.parent).slice(0, 16)} is not the config live at ${p.activationHeight} (${toHex(current.configHash).slice(0, 16)})` });
      continue;
    }
    history.push({ configHash: p.configHash, config: p.config, since: p.activationHeight, by: p.id });
  }
  return { configHash: history[history.length - 1].configHash, history, void: voided };
}
