// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE ARENA LOCK: A STAKE OR FEE LOCK WHOSE CLAIM NAMES ITS SIGNERS (protocol 27, kanban #1044 B1, rulings #1131 and #1134).
//
// From NAMED_CLAIM_HEIGHT (the round's census height decides, never a clock or a build) a round's stake and fee locks are the fork's LNv2
// variant ArenaLockContract, not a stock OutgoingContract to a per-round FROST claim_pk:
//   payment_image  Hash | Point, as LNv2
//   amount         msat
//   expiration     LNv2's consensus block count
//   round_id       32 bytes: a lock is self-describing, a proof needs no lookup
//   claim_keys     the round's settlement seats' node keys (BIP-340 x-only, the keys their bonds name), in seat order, at most 7
//   threshold      t (5 of 7)
//   refund_pk      the player's key (02 || player_pubkey), as today
// contract_id = tagged_hash("ARENA/v1/LockContract", Fedimint consensus encoding). A claim names exactly t seats by ascending index and the
// guardians take as its key the BIP-327 KeyAgg of exactly those keys (each lifted to 02 || x, index order, no tweak), so an accepted claim
// names its signers. Below the height everything stays as before: stock LNv2 and the FROST claim_pk.
//
// The federation must run the variant: its LNv2 module consensus version >= 1.100, read from a threshold of its guardians agreeing
// (module_consensus_version; RULED #1134 1). From the height a seat neither opens, lists nor enters a round in a federation without it.
//
// Pure: encoding, ids, the rules a seat checks. The MuSig2 math is the seat's (arena-node/src/named-claim.js).
import { taggedHash, toHex, fromHex } from './hash.js';
import { lockMatchesEntry } from './stake-lock.js';
import { STAKE_EXPIRY_BLOCKS, networkOf } from './constants.js';
import { receiptsNeeded } from './threshold.js';

/** The protocol version of the named claim. */
export const NAMED_CLAIM_VERSION = 27;
/**
 * THE FIRST CENSUS HEIGHT WHOSE ROUNDS LOCK TO AN ARENA LOCK (RULED #1131 6). ONE CONSTANT PER NETWORK; a network not named here, or null:
 * never. Regtest and devnet 0 so the code stays run; mainnet from its genesis; testnet4 null until its seats and guardians roll, then a height
 * above the tip at that time.
 */
export const NAMED_CLAIM_HEIGHT = Object.freeze({ mainnet: 0, testnet4: null, regtest: 0, devnet: 0 });
/** The point of `network` ('testnet' is testnet4), null on a network that names none. */
export const namedClaimPoint = (network) => {
  const n = network === 'testnet' ? 'testnet4' : String(network || '');
  return Object.prototype.hasOwnProperty.call(NAMED_CLAIM_HEIGHT, n) ? NAMED_CLAIM_HEIGHT[n] : null;
};
/** Does a round at `censusHeight` on `network` lock to an Arena lock? `pointOf` a harness's own. */
export function namedClaimsAt(network, censusHeight, pointOf = namedClaimPoint) {
  const p = pointOf(network);
  return p !== null && p !== undefined && Number.isInteger(censusHeight) && censusHeight >= p;
}

/**
 * DOES THIS ROUND LOCK TO AN ARENA LOCK? Written at protocol 27 or above, and at a census height at or above its network's NAMED_CLAIM_HEIGHT,
 * as every gated rule reads its round (stall.js stallsOut). A protocol-26 round keeps stock LNv2 and the FROST claim_pk at any height.
 */
export function namedClaims(contract, pointOf = namedClaimPoint) {
  if (!contract || !(Number(contract.protocolVersion) >= NAMED_CLAIM_VERSION)) return false;
  let net; try { net = networkOf(contract.networkId); } catch { return false; }
  return namedClaimsAt(net, Number(contract.censusHeight), pointOf);
}

/**
 * THE KEYS A ROUND'S ARENA LOCKS NAME: its settlement seats' node keys in seat order (the round contract's `nodes`, the keys their bonds name) and
 * the threshold its settlement takes (receiptsNeeded of its settlement slots: 5 of 7).
 */
export function namedClaimKeys(contract) {
  const seatKeys = (contract && contract.nodes) || [];
  return { seatKeys, threshold: receiptsNeeded(Number.isInteger(contract && contract.settlementSlots) && contract.settlementSlots > 0 ? contract.settlementSlots : seatKeys.length) };
}

/** The LNv2 module consensus version that carries the variant (fedimint-lnv2-common ARENA_LOCK_CONSENSUS_VERSION). */
export const ARENA_LOCK_MODULE_VERSION = Object.freeze({ major: 1, minor: 100 });
/** Does a module consensus version { major, minor } (as the threshold of guardians answered it) carry the Arena lock? */
export function runsArenaLock(version) {
  if (!version || !Number.isInteger(version.major) || !Number.isInteger(version.minor)) return false;
  return version.major === ARENA_LOCK_MODULE_VERSION.major && version.minor >= ARENA_LOCK_MODULE_VERSION.minor;
}
/**
 * THE GATE (RULED #1134 1): a round from the height is opened, listed and entered only in a federation that runs the variant. `version` is
 * the module version a threshold of its guardians agreed on, or null when no threshold answered. Answers null (open) or why not.
 */
export function namedClaimRefusal({ network, censusHeight, version, pointOf = namedClaimPoint }) {
  if (!namedClaimsAt(network, censusHeight, pointOf)) return null;
  if (runsArenaLock(version)) return null;
  const v = version && Number.isInteger(version.major) ? `${version.major}.${version.minor}` : 'no threshold answer';
  return `this round locks to an Arena lock (protocol ${NAMED_CLAIM_VERSION}) and its federation does not run it: LNv2 module version ${v}, needs 1.100 from a threshold of its guardians`;
}

export const ARENA_LOCK_CONTRACT_TAG = 'ARENA/v1/LockContract';
export const ARENA_LOCK_MAX_KEYS = 7;

/** Fedimint's integer encoding (lightning BigSize, big-endian). */
function lockBigsize(n) {
  const v = BigInt(n);
  if (v < 0n) throw new Error('BigSize is unsigned');
  if (v < 0xfdn) return Uint8Array.of(Number(v));
  const be = (bytes) => { const out = new Uint8Array(bytes); let x = v; for (let i = bytes - 1; i >= 0; i--) { out[i] = Number(x & 0xffn); x >>= 8n; } return out; };
  if (v <= 0xffffn) return Uint8Array.from([0xfd, ...be(2)]);
  if (v <= 0xffffffffn) return Uint8Array.from([0xfe, ...be(4)]);
  if (v <= 0xffffffffffffffffn) return Uint8Array.from([0xff, ...be(8)]);
  throw new Error('BigSize is at most 64 bits');
}
const lockCat = (...parts) => { const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0)); let at = 0; for (const p of parts) { out.set(p, at); at += p.length; } return out; };
const lockSized = (b, n, what) => { if (!(b instanceof Uint8Array) || b.length !== n) throw new Error(`${what} is ${n} bytes`); return b; };

/**
 * THE CONTRACT'S CONSENSUS ENCODING, byte for byte as the fork's derive writes it: the payment image an enum (variant BigSize, then its bytes
 * length-prefixed), amount and expiration BigSize, round_id raw, claim_keys a BigSize count then 32 bytes each, threshold one byte, refund_pk 33.
 */
export function encodeArenaLockContract(f) {
  const img = f.paymentImage || {};
  const image = img.kind === 'hash' ? lockCat(lockBigsize(0), lockBigsize(32), lockSized(img.bytes, 32, 'a hash image'))
    : img.kind === 'point' ? lockCat(lockBigsize(1), lockBigsize(33), lockSized(img.bytes, 33, 'a point image'))
      : (() => { throw new Error('a payment image is a point or a hash'); })();
  if (!Array.isArray(f.claimKeys)) throw new Error('a lock names its claim keys');
  if (!Number.isInteger(f.threshold) || f.threshold < 0 || f.threshold > 255) throw new Error('a threshold is one byte');
  return lockCat(image, lockBigsize(f.amountMsat), lockBigsize(f.expiration), lockSized(f.roundId, 32, 'a round id'), lockBigsize(f.claimKeys.length),
    ...f.claimKeys.map((k) => lockSized(k, 32, 'a claim key')), Uint8Array.of(f.threshold), lockSized(f.refundPk, 33, 'a refund key'));
}
/** The contract id the guardians store the lock under (and its forfeit message). */
export const arenaLockContractId = (f) => taggedHash(ARENA_LOCK_CONTRACT_TAG, encodeArenaLockContract(f));

/** The module's output rule: 1..7 distinct keys, 1 <= t <= n. { ok } or { ok: false, why }. */
export function arenaLockValid(f) {
  const n = Array.isArray(f.claimKeys) ? f.claimKeys.length : 0;
  if (n === 0) return { ok: false, why: 'the lock names no claim keys' };
  if (n > ARENA_LOCK_MAX_KEYS) return { ok: false, why: `the lock names ${n} claim keys, at most ${ARENA_LOCK_MAX_KEYS}` };
  if (new Set(f.claimKeys.map(toHex)).size !== n) return { ok: false, why: 'the lock names a claim key twice' };
  if (!Number.isInteger(f.threshold) || f.threshold < 1) return { ok: false, why: 'the lock\'s threshold is zero' };
  if (f.threshold > n) return { ok: false, why: `the lock's threshold ${f.threshold} is above its ${n} claim keys` };
  return { ok: true };
}

/** The JSON the page, the wasm lock client and a seat exchange (the wasm client's own field names). */
export function arenaLockFieldsFromJson(j) {
  if (!j || typeof j !== 'object') throw new Error('an Arena lock is a JSON object');
  const img = j.paymentImage || {};
  if (img.kind !== 'point' && img.kind !== 'hash') throw new Error('a payment image is a point or a hash');
  const f = {
    paymentImage: { kind: img.kind, bytes: fromHex(String(img.bytes || '')) },
    amountMsat: BigInt(String(j.amountMsat)),
    expiration: Number(j.expiration),
    roundId: fromHex(String(j.roundId || '')),
    claimKeys: (Array.isArray(j.claimKeys) ? j.claimKeys : []).map((k) => fromHex(String(k))),
    threshold: Number(j.threshold),
    refundPk: fromHex(String(j.refundPk || '')),
  };
  if (!Number.isSafeInteger(f.expiration) || f.expiration < 0) throw new Error('an expiration is a block height');
  return f;
}
export const arenaLockFieldsToJson = (f) => ({
  paymentImage: { kind: f.paymentImage.kind, bytes: toHex(f.paymentImage.bytes) }, amountMsat: String(f.amountMsat), expiration: f.expiration,
  roundId: toHex(f.roundId), claimKeys: f.claimKeys.map(toHex), threshold: f.threshold, refundPk: toHex(f.refundPk),
});

/** The lock a client builds for an entry of a protocol-27 round: everything but its expiration, which the guardians' count gives. */
export function arenaLockFor({ kind, entry, roundId, seatKeys, threshold, amountMsat, imageBytes }) {
  return {
    paymentImage: { kind: kind === 'stake' ? 'point' : 'hash', bytes: imageBytes },
    amountMsat: BigInt(amountMsat), roundId, claimKeys: seatKeys.slice(), threshold, refundPk: Uint8Array.from([0x02, ...entry.playerPubkey]),
  };
}

/**
 * §23.1 STEP 5 FOR AN ARENA LOCK: every field the stock lock is checked on (image, amount, refund key, freshness - stake-lock.js), and in place
 * of the attested claim_pk: claim_keys equal to the round's settlement seats' node keys in seat order, the round's threshold, and the round's id.
 * A client checks the same against the round's published, verified seating. { ok } or { ok: false, why }.
 */
export function arenaLockMatchesEntry({ lock, entry, kind, roundId, seatKeys, threshold, height, expiryBlocks = STAKE_EXPIRY_BLOCKS } = {}) {
  if (!lock) return { ok: false, why: 'there is no lock to compare' };
  const valid = arenaLockValid(lock);
  if (!valid.ok) return valid;
  if (!(roundId instanceof Uint8Array) || toHex(lock.roundId || new Uint8Array()) !== toHex(roundId))
    return { ok: false, why: `that ${kind} lock names another round than this one` };
  if (!Array.isArray(seatKeys) || lock.claimKeys.length !== seatKeys.length || lock.claimKeys.some((k, i) => toHex(k) !== toHex(seatKeys[i])))
    return { ok: false, why: `that ${kind} lock's claim keys are not this round's settlement seats in seat order` };
  if (lock.threshold !== threshold) return { ok: false, why: `that ${kind} lock's threshold ${lock.threshold} is not the round's ${threshold}` };
  // the stock checks, with the claim key out of the comparison (the named keys above stand in for it)
  const none = new Uint8Array(33);
  return lockMatchesEntry({ lock: { ...lock, claimPk: none }, entry, kind, claimPk: none, height, expiryBlocks });
}

/**
 * THE SIGNER SET (RULED #1131 3): the t lowest seat indices that sent a valid signed SettlementCommit for this txid, so every seat computes the
 * same set; a seat that drops out of a session is left out of the next, which takes the next t. `committed` the seat indices with a valid
 * commit, `dropped` those that failed this txid's earlier sessions. Answers the ascending set, or null when fewer than t are left.
 */
export function namedSignerSet({ committed, threshold, dropped = [] }) {
  const out = new Set(dropped.map(Number));
  const left = [...new Set([...committed].map(Number))].filter((i) => Number.isInteger(i) && i >= 0 && !out.has(i)).sort((a, b) => a - b);
  return left.length >= threshold ? left.slice(0, threshold) : null;
}

/**
 * THE NONCES A SEAT COMMITS TO (protocol 27): its BIP-327 public nonce, R1 || R2 (33 bytes each), split as the SettlementCommit carries two
 * nonce points - the commit's body hashes them as it hashed FROST's hiding and binding (settlement-ack.js settlementCommitBody), so the commit's
 * bytes do not change.
 */
export function commitNoncesOf(pubnonce) {
  // (protocol 27 settlements commit to one nonce pair per message: settlement-ack.js settlementCommitBody `nonces`)
  lockSized(pubnonce, 66, 'a public nonce');
  return { hiding: pubnonce.slice(0, 33), binding: pubnonce.slice(33) };
}

/**
 * THE SIGNER SET'S PLACEHOLDER KEY Z (ruling #1135 1): 02 || x for the first tagged_hash("ARENA/v1/SignerSetKey", u32 i, big-endian) that is a curve
 * point's x - the stake-lock tool's arena-z-key. Nobody holds its key. A settlement body writes it wherever the plan puts KeyAgg(claim_keys[S]).
 */
export const zKey = (() => {
  let z = null;
  // on the curve: x below p and x^3 + 7 a square mod p (Euler's criterion) - plain BigInt, so the page's bundle carries no curve library
  const P = 2n ** 256n - 2n ** 32n - 977n;
  const pow = (b, e) => { let r = 1n; b %= P; while (e > 0n) { if (e & 1n) r = (r * b) % P; b = (b * b) % P; e >>= 1n; } return r; };
  const onCurve = (x) => { if (x >= P) return false; const y2 = (pow(x, 3n) + 7n) % P; return y2 === 0n || pow(y2, (P - 1n) / 2n) === 1n; };
  return () => {
    if (z) return z.slice();
    for (let i = 0; ; i++) {
      const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, i);
      const x = taggedHash('ARENA/v1/SignerSetKey', b);
      if (onCurve(BigInt('0x' + toHex(x)))) { z = Uint8Array.from([0x02, ...x]); return z.slice(); }
    }
  };
})();
