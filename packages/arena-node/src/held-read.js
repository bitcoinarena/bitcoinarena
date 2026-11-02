// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A GUARDIAN READS A GATEWAY'S HELD LOCK (spec §23A.3a, kanban #998, rulings #1030): POST /held-read. Inside the epoch's read window it
// recomputes the contract id from the fixed fields, so any other lock counts 0, asks its federation what stands at that outpoint, and signs a
// HeldRead if the lock holds with at least 6 blocks left in the guardians' count. It reads a lock once: asked again it answers what it signed.
import { heldLockFields, heldProofHeight, heldWindowOpen, signHeldRead, checkHeldAsk, HELD_MIN_BLOCKS_LEFT } from '../../arena-protocol/src/held-proof.js';
import { GATEWAY_EPOCH_BLOCKS } from '../../arena-protocol/src/gateway-seats.js';
import { fromHex } from '../../arena-protocol/src/hash.js';

/** Where a claim file's held lock is kept: beside it, so the claim's hourly renewal does not drop it. */
export const heldLockFileOf = (claimFile) => `${claimFile}.held-lock.json`;

/** A claim with the held lock kept for its federation, if one is (`readJson(path)` -> the object, or throws). The claim's signature does not cover it: its reads are signed. */
export function withHeldLock(claim, claimFile, readJson) {
  let h = null; try { h = readJson(heldLockFileOf(claimFile)); } catch { h = null; }
  return claim && h && String(h.federationId || '').toLowerCase() === String(claim.federationId || '').toLowerCase() ? { ...claim, heldLock: h } : claim;
}

const MAX_ASKS = 12;   // per gateway and epoch, the reads a refused ask may still cost a guardian

/**
 * `me` this guardian's node key (hex); `sign(hash)` by it; `tip()` its Bitcoin tip; `portOf(fid)` its stake-lock port of that federation;
 * `setFor(fid, epoch)` -> { seated: [node hex], threshold } | null; `rulesOn(epoch)` whether the seating rules apply to that epoch.
 */
export function createHeldReads({ me, sign, tip, portOf, setFor, verify, rulesOn = () => true, epochBlocks = GATEWAY_EPOCH_BLOCKS }) {
  const signed = new Map(), asks = new Map();
  const refuse = (code, why) => ({ code, body: { ok: false, why } });
  async function answer(ask) {
    const c = checkHeldAsk(ask, verify);
    if (!c.ok) return refuse(400, c.why);
    if (!rulesOn(ask.epoch)) return refuse(409, 'the seating rules do not apply to that epoch on this network');
    let height; try { height = Number(await tip()); } catch { return refuse(503, 'this seat cannot read its Bitcoin tip'); }
    if (!Number.isInteger(height)) return refuse(503, 'this seat cannot read its Bitcoin tip');
    if (Math.floor(height / epochBlocks) !== ask.epoch || !heldWindowOpen(ask.epoch, height, epochBlocks))
      return refuse(409, `tip ${height} is outside the read window of epoch ${ask.epoch}, which ends at ${heldProofHeight(ask.epoch, epochBlocks)}`);
    const set = await setFor(ask.federationId, ask.epoch);
    if (!set) return refuse(503, 'this seat holds no record of that federation');
    if (!set.seated.includes(me)) return refuse(409, 'this node is not a seated guardian of that federation');
    if (!set.seated.includes(ask.node)) return refuse(409, 'only a seated guardian stands for a gateway seat');
    for (const k of [...signed.keys(), ...asks.keys()]) if (Number(k.split(':')[0]) < ask.epoch) { signed.delete(k); asks.delete(k); }
    const key = `${ask.epoch}:${ask.federationId}:${ask.node}:${ask.outpoint}:${ask.amountMsat}:${ask.expiration}`;
    if (signed.has(key)) return { code: 200, body: signed.get(key) };
    const counter = `${ask.epoch}:${ask.federationId}:${ask.node}`;
    if ((asks.get(counter) || 0) >= MAX_ASKS) return refuse(429, 'that gateway has asked often enough in this epoch');
    asks.set(counter, (asks.get(counter) || 0) + 1);
    let port = null; try { port = await portOf(ask.federationId); } catch { port = null; }
    if (!port) return refuse(503, 'this seat reaches no client of that federation');
    const [txid, outIdx] = ask.outpoint.split(':');
    let id, st;
    try {
      id = await port.contractId(heldLockFields({ node: ask.node, epoch: ask.epoch, amountMsat: ask.amountMsat, expiration: ask.expiration }));
      st = await port.status({ txid: fromHex(txid), outIdx: Number(outIdx) });
    } catch (e) { return refuse(503, `the federation did not answer: ${String(e && e.message || e).slice(0, 200)}`); }
    if (!st || !st.stored) return refuse(409, 'the federation holds no lock at that outpoint');
    if (String(st.stored.contractId).toLowerCase() !== String(id).toLowerCase()) return refuse(409, 'the lock at that outpoint is not the held proof\'s contract');
    if (!(st.stored.blocksLeft >= HELD_MIN_BLOCKS_LEFT)) return refuse(409, `that lock has ${st.stored.blocksLeft} blocks left, and a read needs ${HELD_MIN_BLOCKS_LEFT}`);
    const read = signHeldRead({ federationId: ask.federationId, epoch: ask.epoch, gateway: ask.node, outpoint: ask.outpoint, contractId: id, amountMsat: ask.amountMsat,
      blocksLeft: st.stored.blocksLeft, tipHeight: height }, me, sign);
    signed.set(key, read);
    return { code: 200, body: read };
  }
  return { answer };
}
