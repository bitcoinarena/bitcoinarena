// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE HELD PROOF (spec §23A.3a, kanban #998, rulings #1029 and #1030): a peg-in proves money went in, not that the gateway still holds it, so a
// gateway that wants peg-in weight in an epoch locks its e-cash in the federation for a moment and the guardians read that lock. Only one
// shape counts, the one nobody can spend before it expires: claim_pk a point nobody holds a key for, the payment image fixed by the
// gateway and the epoch, the refund key the gateway's claim key. A lock vanishes from the guardians' view once refunded, so the read
// itself travels: each seated guardian signs a HeldRead inside the read window, and the claim carries at least the threshold of them.
// A guardian that was down checks those signatures and signs the same amount. It costs the gateway a few hundred msat and about 6
// blocks of tied-up money.
import { Writer } from './encode.js';
import { taggedHash, fromHex, toHex } from './hash.js';
import { GATEWAY_EPOCH_BLOCKS } from './gateway-seats.js';

export const HELD_PROOF_TAG = 'ARENA/v1/HeldProof';
export const HELD_CLAIM_KEY_TAG = 'ARENA/v1/HeldProofClaimKey';
export const HELD_READ_TAG = 'ARENA/v1/HeldRead';
export const HELD_ASK_TAG = 'ARENA/v1/HeldAsk';

/** proof_height = the epoch's first height + this. */
export const HELD_PROOF_OFFSET = 72;
/** The read window: Bitcoin tip in [proof_height - HELD_READ_WINDOW, proof_height]. */
export const HELD_READ_WINDOW = 3;
/** A lock holds at a read with at least this many blocks left, in the guardians' count: 3 for the window, 3 of margin. */
export const HELD_MIN_BLOCKS_LEFT = 6;

/**
 * claim_pk OF A HELD LOCK: 02 || x for the first tagged_hash(HELD_CLAIM_KEY_TAG, u32 i) that is the x of a curve point (i = 2). Nobody knows
 * its discrete log, so nobody can sign a forfeit or a claim for it. test/held-proof.test.js derives it again.
 */
export const HELD_CLAIM_PK = '024a1b3d92f9e2b15ae602a4c3e574814467f86a30babb04fa420c5f60253a58d6';

const HEX32 = /^[0-9a-f]{64}$/, OUTPOINT = /^[0-9a-f]{64}:\d{1,5}$/, DIGITS = /^\d{1,19}$/;
const lower = (x) => String(x ?? '').toLowerCase();

/** The height an epoch's held proof is read at. */
export const heldProofHeight = (epoch, epochBlocks = GATEWAY_EPOCH_BLOCKS) => Number(epoch) * epochBlocks + HELD_PROOF_OFFSET;

/** The read window of an epoch: { from, to }, both Bitcoin heights, both inside it. */
export function heldReadWindow(epoch, epochBlocks = GATEWAY_EPOCH_BLOCKS) {
  const to = heldProofHeight(epoch, epochBlocks);
  return { from: to - HELD_READ_WINDOW, to };
}

/** Whether a Bitcoin tip is inside an epoch's read window. */
export function heldWindowOpen(epoch, tip, epochBlocks = GATEWAY_EPOCH_BLOCKS) {
  const { from, to } = heldReadWindow(epoch, epochBlocks);
  return Number.isInteger(tip) && tip >= from && tip <= to;
}

/** The payment image of a gateway's lock in an epoch: tagged_hash("ARENA/v1/HeldProof", gateway node key || epoch). */
export function heldPaymentImage(node, epoch) {
  const w = new Writer();
  w.bytes32(fromHex(lower(node))); w.u32(Number(epoch));
  return taggedHash(HELD_PROOF_TAG, w.finish());
}

/**
 * THE ONE CONTRACT THAT COUNTS, as the stake-lock port's contractId takes it (stake-lock-port.js contractArgs). `node` is the gateway's x-only
 * claim key; its 33-byte form with the even prefix is the refund key, and the key the gateway signs the refund with.
 */
export function heldLockFields({ node, epoch, amountMsat, expiration }) {
  return { paymentImage: { kind: 'hash', bytes: heldPaymentImage(node, epoch) }, amountMsat: BigInt(amountMsat),
    claimPk: fromHex(HELD_CLAIM_PK), refundPk: fromHex('02' + lower(node)), expiration: Number(expiration) };
}

function outpointBytes(w, outpoint) {
  const [txid, vout] = String(outpoint).split(':');
  w.bytes32(fromHex(txid)); w.u32(Number(vout));
}

/** The 32 bytes a HeldRead's signature covers. */
export function heldReadHash(r) {
  const w = new Writer();
  w.bytes32(fromHex(lower(r.federationId))); w.u32(Number(r.epoch)); w.bytes32(fromHex(lower(r.gateway)));
  outpointBytes(w, lower(r.outpoint)); w.bytes32(fromHex(lower(r.contractId)));
  w.u64(BigInt(r.amountMsat)); w.u64(BigInt(r.blocksLeft)); w.u32(Number(r.tipHeight));
  return taggedHash(HELD_READ_TAG, w.finish());
}

/** A guardian's HeldRead: `fields` { federationId, epoch, gateway, outpoint, contractId, amountMsat, blocksLeft, tipHeight }, signed by its node key. */
export function signHeldRead(fields, guardian, sign) {
  const r = { federationId: lower(fields.federationId), epoch: Number(fields.epoch), gateway: lower(fields.gateway), outpoint: lower(fields.outpoint),
    contractId: lower(fields.contractId), amountMsat: String(fields.amountMsat), blocksLeft: Number(fields.blocksLeft), tipHeight: Number(fields.tipHeight) };
  return { ...r, guardian: lower(guardian), signature: toHex(sign(heldReadHash(r))) };
}

/** The 32 bytes of a gateway's ask for a read. */
export function heldAskHash(a) {
  const w = new Writer();
  w.bytes32(fromHex(lower(a.federationId))); w.u32(Number(a.epoch)); w.bytes32(fromHex(lower(a.node)));
  outpointBytes(w, lower(a.outpoint)); w.u64(BigInt(a.amountMsat)); w.u64(BigInt(a.expiration));
  return taggedHash(HELD_ASK_TAG, w.finish());
}

/** A gateway's ask: signed by its node key, so a stranger cannot send a guardian reading made-up outpoints. */
export function signHeldAsk(fields, sign) {
  const a = { federationId: lower(fields.federationId), epoch: Number(fields.epoch), node: lower(fields.node), outpoint: lower(fields.outpoint),
    amountMsat: String(fields.amountMsat), expiration: Number(fields.expiration) };
  return { ...a, signature: toHex(sign(heldAskHash(a))) };
}

/** Whether `a` is a well-formed ask signed by its gateway. `verify(sig, hash, key)`. Answers { ok, why }. */
export function checkHeldAsk(a, verify) {
  if (!a || !HEX32.test(a.federationId || '') || !HEX32.test(a.node || '')) return { ok: false, why: 'an ask names a federation and a gateway node key' };
  if (!Number.isInteger(a.epoch) || a.epoch < 0) return { ok: false, why: 'an ask names an epoch' };
  if (!OUTPOINT.test(a.outpoint || '')) return { ok: false, why: 'an ask names the lock\'s outpoint, txid:index' };
  if (!DIGITS.test(String(a.amountMsat ?? '')) || BigInt(a.amountMsat) === 0n) return { ok: false, why: 'an ask names the lock\'s amount in msat' };
  if (!Number.isInteger(a.expiration) || a.expiration <= 0) return { ok: false, why: 'an ask names the lock\'s expiration' };
  if (!/^[0-9a-f]{128}$/.test(a.signature || '')) return { ok: false, why: 'an ask is signed' };
  let good = false;
  try { good = verify(fromHex(a.signature), heldAskHash(a), fromHex(a.node)); } catch { good = false; }
  return good ? { ok: true } : { ok: false, why: 'that ask is not signed by its gateway\'s node key' };
}

/** Whether one read stands by itself for this federation, epoch and gateway: the window, the margin and the signature. */
function readStands(r, { federationId, epoch, node, set, epochBlocks, verify }) {
  if (!r || lower(r.federationId) !== federationId || r.epoch !== epoch || lower(r.gateway) !== node) return false;
  if (!set.has(lower(r.guardian)) || !OUTPOINT.test(lower(r.outpoint)) || !HEX32.test(lower(r.contractId))) return false;
  if (!Number.isInteger(r.blocksLeft) || r.blocksLeft < HELD_MIN_BLOCKS_LEFT || !heldWindowOpen(epoch, r.tipHeight, epochBlocks)) return false;
  if (!DIGITS.test(String(r.amountMsat ?? '')) || !/^[0-9a-f]{128}$/.test(r.signature || '')) return false;
  try { return verify(fromHex(r.signature), heldReadHash(r), fromHex(lower(r.guardian))); } catch { return false; }
}

/**
 * WHAT A CLAIM'S held_lock COUNTS FOR, IN SAT (rulings #1030): `heldLock` { outpoint, contractId, amountMsat, reads }, judged against `seated` (node
 * keys hex) and `threshold` of the federation record in force at the proof height. Each read stands on its own, and only reads naming the
 * lock's own outpoint, contract and amount are counted, once per guardian; fewer than the threshold count 0. It reads no chain and no
 * guardian, so a guardian that was down gets the same answer as one that read the lock. Answers { sats, signers, why }.
 */
export function heldLockCounted({ heldLock, federationId, epoch, node, seated, threshold, verify, epochBlocks = GATEWAY_EPOCH_BLOCKS }) {
  const none = (why, signers = 0) => ({ sats: 0n, signers, why });
  if (!heldLock) return none('this claim names no held lock');
  const outpoint = lower(heldLock.outpoint), contractId = lower(heldLock.contractId), amount = String(heldLock.amountMsat ?? '');
  if (!OUTPOINT.test(outpoint) || !HEX32.test(contractId) || !DIGITS.test(amount)) return none('that held lock is malformed');
  if (!Array.isArray(seated) || !Number.isInteger(threshold) || threshold < 1) return none('no federation record to judge that held lock by');
  if (!Array.isArray(heldLock.reads)) return none('that held lock carries no reads');
  const set = new Set(seated.map(lower));
  const ctx = { federationId: lower(federationId), epoch: Number(epoch), node: lower(node), set, epochBlocks, verify };
  const signers = new Set();
  for (const r of heldLock.reads.slice(0, 2 * set.size)) {
    if (lower(r && r.outpoint) !== outpoint || lower(r && r.contractId) !== contractId || String(r && r.amountMsat) !== amount) continue;
    if (readStands(r, ctx)) signers.add(lower(r.guardian));
  }
  if (signers.size < threshold) return none(`${signers.size} guardian(s) read that lock, and it needs ${threshold}`, signers.size);
  return { sats: BigInt(amount) / 1000n, signers: signers.size, why: `${signers.size} guardians read it` };
}
