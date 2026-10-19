// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A PUBLISHED ROUND FIRST, ITS BEACON AFTER (2026-09-30, the fcb15cca refusal, pick (b)).
//
// Measured on testnet4: the paying runner broadcast round fcb15cca's publication (37af92a0, 2 sat/vB) at 21:48:57Z;
// it sat in the mempool ~3.5 h and confirmed at 154489, after the round's beacon block (~154477). The runner had
// waited for the beacon alone, posted the round once that block was 6 deep, and node 1 refused it - rightly: "there is
// no publication transaction to read" before the beacon - and the runner exited.
//
// So, on a chain nobody here mines, the runner now waits for ITS OWN PUBLICATION first:
//   - while the publication is unconfirmed, no beacon is named and nothing is posted; each new block that comes without
//     it raises its fee (the wallet's bumpfee: the same outputs at a higher rate), so it does not sit for hours;
//   - once it has confirmed, the beacon is named - and only a beacon strictly ABOVE the publication's block counts;
//   - a round whose beacon block came first - no publication below it, or one at or above it: the fcb15cca shape - is
//     NOT a published round. It is never posted or forced through; the caller drafts a new round and publishes that.
import { findPublication } from '../../arena-protocol/src/publication.js';
import { findSeriesPublication } from '../../arena-protocol/src/series.js';
import { beaconFromChain, medianTimePast } from '../../arena-protocol/src/beacon.js';
import { roundId } from '../../arena-protocol/src/contracts.js';
import { toHex } from '../../arena-protocol/src/hash.js';

/** The beacon BLOCK the rule picks in `view` - the first whose median time passes committee_time - at any depth, or null. */
export function beaconBlockIn(contract, view) {
  const headers = view.blocks.map((b) => b.header);
  for (let h = view.firstHeight; h < view.firstHeight + headers.length; h++) {
    const mtp = medianTimePast(headers, view.firstHeight, h);
    if (mtp !== null && BigInt(mtp) * 1000n > contract.committeeTimeMs) return h;
  }
  return null;
}

/**
 * Wait for `contract`'s publication (`txid`, broadcast) to confirm below its beacon, raising its fee while it waits.
 *   view()        -> the chain view to the tip, `{ firstHeight, blocks: [{ header, transactions }] }`
 *   rpc(m, p)     -> the wallet's bitcoind RPC (bumpfee, getmempoolentry)
 * Answers `{ ok: true, named, publishedAt }` once the beacon is named and deep, or `{ ok: false, dead: true, why }` when
 * the beacon block came before the publication. Throws only when `maxLooks` pass with neither.
 */
export async function awaitPublishedBeacon({ contract, txid, view, rpc, feeRate = 2, maxFeeRate = 100, sleepMs = 60000, maxLooks = 240,
  log = (s) => console.log(s), sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const rid = roundId(contract);
  const tag = toHex(rid).slice(0, 16);
  let rate = feeRate;
  let current = txid;
  let bumpedAt = null;
  for (let look = 0; look < maxLooks; look++) {
    const v = await view();
    const tip = v.firstHeight + v.blocks.length - 1;
    if (bumpedAt === null) bumpedAt = tip;
    // A SERIES ROUND (a grid's) IS PUBLISHED BY ITS SERIES' "ARN" SERIES series_id, not one of its own
    const pub = contract.seriesId instanceof Uint8Array ? findSeriesPublication(v, contract.seriesId) : findPublication(v, rid);
    const beaconAt = beaconBlockIn(contract, v);
    // THE BEACON BLOCK CAME FIRST: not a published round, whatever confirms later.
    if (beaconAt !== null && (!pub || pub.height >= beaconAt))
      return { ok: false, dead: true, beaconAt, publishedAt: pub ? pub.height : null, txid: current,
        why: pub ? `round ${tag} was published at ${pub.height}, at or above its beacon block ${beaconAt}: it is not a published round`
          : `round ${tag}'s beacon block ${beaconAt} came while its publication ${current.slice(0, 16)} was unconfirmed: it is not a published round` };
    if (!pub) {
      // UNCONFIRMED: no beacon is named. A block that came without it raises its fee.
      // ONLY A BLOCK THAT TOOK OTHERS' TRANSACTIONS SAYS THE FEE WAS TOO LOW (measured 2026-10-12 07:42-07:43Z:
      // testnet4 blocks 156204-156209 were coinbase-only, minimum-difficulty, 20 min apart in their timestamps - the grid's
      // 0.15 sat/vB was raised to 1.2 for nothing; 156203 before them took a 0.15 sat/vB transaction among 220)
      const tookOthers = v.blocks.slice(Math.max(0, bumpedAt + 1 - v.firstHeight)).some((b) => (b.transactions || []).length > 1);
      if (tip > bumpedAt && !tookOthers) {
        if (look % 10 === 0) log(`[publish] round ${tag}: block ${tip} came empty (coinbase only): no fee raise for it`);
        bumpedAt = tip;
      } else if (tip > bumpedAt && rate < maxFeeRate) {
        // A RAISE THE NODE REFUSES (measured on testnet4, 99ce7662: 4 -> 8 sat/vB refused, "Insufficient total fee ...
        // must be at least" the old fee plus the increment - the replacement's size differs) is doubled again at once,
        // up to the cap, rather than asked the same way at the next block and refused the same way.
        for (let next = Math.min(maxFeeRate, rate * 2); ; next = Math.min(maxFeeRate, next * 2)) {
          try {
            const b = await rpc('bumpfee', [current, { fee_rate: next }]);
            log(`[publish] round ${tag}: block ${tip} came without publication ${current.slice(0, 16)}; fee raised ${rate} -> ${next} sat/vB, now ${String(b.txid).slice(0, 16)}`);
            current = b.txid; rate = next;
            break;
          } catch (e) {
            log(`[publish] round ${tag}: the fee raise to ${next} sat/vB was refused: ${e.message}`);
            if (next >= maxFeeRate) break;
          }
        }
        bumpedAt = tip;
      } else if (look % 10 === 0) log(`[publish] round ${tag}: publication ${current.slice(0, 16)} unconfirmed at ${tip}; no beacon is named until it confirms`);
      await sleep(sleepMs);
      continue;
    }
    const named = beaconFromChain(contract, { headers: v.blocks.map((b) => b.header), firstHeight: v.firstHeight });
    if (named.ok && named.height > pub.height) return { ok: true, named, publishedAt: pub.height, txid: current };
    if (look % 10 === 0) log(`[publish] round ${tag}: published at ${pub.height}; no beacon yet at ${tip}: ${named.why || 'not above the publication'}`);
    await sleep(sleepMs);
  }
  throw new Error(`round ${tag}: neither a beacon above its publication nor a dead round after ${maxLooks} looks`);
}
