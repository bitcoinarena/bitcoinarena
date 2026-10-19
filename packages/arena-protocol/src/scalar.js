// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// SCALAR MARKETS (feature 8, docs/PLATFORM-RESEARCH.md item 8; protocol 2026.0.7): "a numeric outcome (a price, a
// count) paid linearly between bounds. Richer questions than buckets; one market instead of many."
//
// THE SHAPE. The market's manifest names a scalar (manifest.js `scalar`, marker 0x06): bounds low < high, whole numbers in a named
// unit, and its two outcomes are the SIDES - LONG (pick 0) and SHORT (pick 1). A round of it is an attested round like any
// other: no round byte changes, its entries pick a side. Its attestors - k of n, as for any attested market - sign the VALUE V
// they observed:
//
//     ValueAttestation {
//       round_id, value (i64, in the manifest's unit), observed_at_ms,
//       signatures[] - each { attestor key, signature by it over the body's id }
//     }
//
// A MESSAGE OF ITS OWN: its type byte (0x2a, TYPE_VALUE_ATTESTATION) is not an outcome attestation's (0x1d), its body is written
// at version 7 or later and its id is taken under its own tag (ARENA/v1/ValueAttestation). So an outcome attestation can never be
// replayed as a value or a value as an outcome: the bytes do not decode as the other kind, and a signature over one id is no
// signature over the other's. And each door asks the kind its market reads: attested.js attestationStands refuses an index for a
// scalar market, valueAttestationStands a value for any other.
//
// THE PAYOUT (scalarPayoutTable): V clamped to [low, high]; of the whole net pool T (every entry's stake less its fee and its
// donation, as for any attested round - §0A.8), the LONG side's share is T * (V - low) / (high - low) and the SHORT side's the
// rest; each side's share is split pari-mutuel over that side's own net stakes. Integer msat only, every remainder named:
//   - the two sides' shares are each FLOORED; the at most 1 msat the floors leave goes to the side of the entry FIRST in
//     ascending entry id (among the entries that staked anything) - so the LONG total is ceil or floor of its exact share,
//     never moving against V, and the rule reads the same with the sides swapped and V mirrored;
//   - within a side each entry gets floor(share * net / side_net); the msats those floors leave go one each to that side's
//     entries in ascending entry id - as pariMutuelTable hands out its own.
// Nothing is invented and nothing is kept: fees + donations + payouts = gross, payouts = T, every payout >= 0.
//
// ONE SIDE ONLY (decided here): a market where nobody backed one side has no counterparty - the side's share of a value it
// did not reach would belong to nobody. It is REFUNDED: every net stake back to its own entry, its fee too, exactly as a
// pari-mutuel round "nobody picked" (2026-10-09: "refund the fees too"; lock-settlement.js claims nothing).
// Likewise a market with no entry. A round where both sides staked nothing (a free round) is not a refund: each gets its 0.
//
// NO VALUE BY THE DEADLINE, OR TWO DIFFERENT VALUES: VOID, every stake back - attested.js marketVoided reads a value's standing
// as it reads an outcome's (outcomeStanding).
//
// NO CURVE, as everywhere in this package: `verify(signature, digest, key)` is injected - Ed25519, the attestors' scheme.
import { Writer, Reader } from './encode.js';
import { taggedHash, toHex } from './hash.js';
import { SCALAR_VERSION, speaksVersion, TYPE_VALUE_ATTESTATION, TAG } from './constants.js';
import { isScalar, SCALAR_LONG, SCALAR_SHORT, SCALAR_SIDES, SCALAR_I64_MIN, SCALAR_I64_MAX } from './manifest.js';
import { protocolVersionName } from './protocol-version.js';

export const VALUE_SIGNATURE_BYTES = 64;

const scIs32 = (b) => b instanceof Uint8Array && b.length === 32;
const scSame = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
const scSum = (xs) => xs.reduce((t, x) => t + x, 0n);

/** The bytes a scalar market's attestors sign: the round, the value they observed (in the manifest's unit), when. */
export function encodeValueAttestationBody(a) {
  if (!scIs32(a.roundId)) throw new Error('a value attestation names its 32-byte round');
  if (typeof a.value !== 'bigint' || a.value < SCALAR_I64_MIN || a.value > SCALAR_I64_MAX) throw new Error('a value attestation names its value as a signed 64-bit BigInt');
  if (typeof a.observedAtMs !== 'bigint' || a.observedAtMs < 0n) throw new Error('observed_at_ms is a BigInt of milliseconds');
  const w = new Writer();
  w.u8(TYPE_VALUE_ATTESTATION);
  // WRITTEN AT THE VERSION THAT READS IT: no build below 2026.0.7 decodes a value attestation
  w.u16(SCALAR_VERSION);
  w.bytes32(a.roundId);
  w.i64(a.value);
  w.u64(a.observedAtMs);
  return w.finish();
}

/** The digest every attestor of a scalar market signs - under its own tag, never the outcome attestation's. */
export const valueAttestationBodyId = (a) => taggedHash(TAG.valueAttestation, encodeValueAttestationBody(a));

/** The value attestation on the wire: its body, then its signatures (key, signature), in the order given. */
export function encodeValueAttestation(a) {
  const w = new Writer();
  w.bytes(encodeValueAttestationBody(a));
  const sigs = a.signatures || [];
  if (!Array.isArray(sigs)) throw new Error('a value attestation carries a list of signatures');
  w.vec(sigs, (s, ww) => {
    if (!scIs32(s.key)) throw new Error('a signature names its 32-byte attestor key');
    if (!(s.signature instanceof Uint8Array) || s.signature.length !== VALUE_SIGNATURE_BYTES) throw new Error(`an attestor's signature is ${VALUE_SIGNATURE_BYTES} bytes`);
    ww.bytes32(s.key); ww.bytes(s.signature);
  });
  return w.finish();
}

/** Is this the start of a value attestation's bytes (its type byte)? What a door reads to tell the two kinds apart. */
export const isValueAttestationBytes = (bytes) => bytes instanceof Uint8Array && bytes.length > 0 && bytes[0] === TYPE_VALUE_ATTESTATION;

export function decodeValueAttestation(bytes) {
  const r = new Reader(bytes);
  if (r.u8() !== TYPE_VALUE_ATTESTATION) throw new Error('not a value attestation');
  const version = r.u16();
  // REFUSED BELOW 7: a value attestation exists from 2026.0.7 on; one naming an older version is no message any build wrote
  if (!speaksVersion(version) || version < SCALAR_VERSION)
    throw new Error(`a value attestation is written at protocol version ${protocolVersionName(SCALAR_VERSION)} or later; this one names ${protocolVersionName(version)}`);
  const a = { roundId: r.bytes32(), value: r.i64(), observedAtMs: r.u64() };
  a.signatures = r.vec((rr) => ({ key: rr.bytes32(), signature: rr.bytes(VALUE_SIGNATURE_BYTES) }));
  r.end();
  return a;
}

/** Do these bounds make a scalar market: BigInt low below BigInt high? `low >= high` is refused by name. */
export function scalarBoundsFit(bounds) {
  if (!bounds || typeof bounds.low !== 'bigint' || typeof bounds.high !== 'bigint') return { ok: false, why: 'a scalar market\'s bounds are { low, high }, BigInt whole numbers' };
  if (bounds.low >= bounds.high) return { ok: false, why: `a scalar market's low bound is below its high bound; this one names low ${bounds.low} and high ${bounds.high}` };
  return { ok: true };
}

/** V clamped to [low, high]: a value at or beyond a bound pays as that bound. */
export function scalarClamp(value, { low, high }) {
  if (typeof value !== 'bigint') throw new Error('a scalar market\'s value is a BigInt');
  return value < low ? low : value > high ? high : value;
}

/**
 * DOES THIS VALUE ATTESTATION STAND FOR THIS ROUND? The round's game is a scalar market; the attestation is for this round; and at
 * least the manifest's threshold of DISTINCT attestors it names signed its body. The value itself is any signed 64-bit number -
 * one beyond a bound is not refused but clamped when the table is made (`clamped` says where it pays). Each refusal by name;
 * answers, never throws. Whether it came in time is attested.js attestationTimely, read on its observed_at_ms as for any market.
 */
export function valueAttestationStands(a, { manifest, roundIdBytes, verify }) {
  if (!isScalar(manifest)) return { ok: false, why: `game "${manifest && manifest.gameName}" is not a scalar market: its outcome is an index its attestors sign, and a value decides nothing of it` };
  let digest;
  try { digest = valueAttestationBodyId(a); } catch (e) { return { ok: false, why: `that value attestation does not encode: ${e.message}` }; }
  if (!scIs32(roundIdBytes) || !scSame(a.roundId, roundIdBytes))
    return { ok: false, why: `that value attestation is for round ${toHex(a.roundId).slice(0, 16)}, not this round ${scIs32(roundIdBytes) ? toHex(roundIdBytes).slice(0, 16) : ''}`.trim() };
  if (typeof verify !== 'function') return { ok: false, why: 'no verifier to check the attestors\' signatures' };
  const named = new Set(manifest.attestors.map(toHex));
  const signed = new Set();
  for (const s of a.signatures || []) {
    const k = toHex(s.key);
    if (!named.has(k)) return { ok: false, why: `that value attestation is signed by key ${k.slice(0, 16)}, which game "${manifest.gameName}" does not name as an attestor` };
    let good = false;
    try { good = verify(s.signature, digest, s.key) === true; } catch { good = false; }
    if (!good) return { ok: false, why: `attestor ${k.slice(0, 16)}'s signature on that value attestation does not verify` };
    signed.add(k);
  }
  if (signed.size < manifest.attestThreshold)
    return { ok: false, why: `that value attestation carries ${signed.size} attestor signature(s), and game "${manifest.gameName}" asks ${manifest.attestThreshold} of its ${manifest.attestors.length}` };
  const sc = manifest.scalar;
  const clamped = scalarClamp(a.value, sc);
  return { ok: true, value: a.value, clamped, signers: signed.size,
    why: `value ${a.value} ${sc.unit}${clamped !== a.value ? ` (paid as ${clamped}, its bound)` : ''}, signed by ${signed.size} of ${manifest.attestors.length} attestors (threshold ${manifest.attestThreshold})` };
}

/** One row per entry: its id as hex, its amounts, its net stake and its side - refused by name when an entry is not a side's. */
function scalarRows(entries) {
  return entries.map((e) => {
    const id = typeof e.entryId === 'string' ? e.entryId : toHex(e.entryId);
    if (typeof e.stakeMsat !== 'bigint' || typeof e.feeMsat !== 'bigint' || typeof e.donationMsat !== 'bigint')
      throw new Error(`entry ${id.slice(0, 16)}: stakes are BigInt millisatoshi - its stake, its fee and its donation`);
    const net = e.stakeMsat - e.feeMsat - e.donationMsat;
    if (net < 0n) throw new Error(`entry ${id.slice(0, 16)} pays more in fee and donation than it stakes`);
    if (e.pick !== SCALAR_LONG && e.pick !== SCALAR_SHORT) throw new Error(`entry ${id.slice(0, 16)} backs no side of a scalar market: its pick is ${SCALAR_LONG} (LONG) or ${SCALAR_SHORT} (SHORT)`);
    return { entryId: id, stakeMsat: e.stakeMsat, feeMsat: e.feeMsat, donationMsat: e.donationMsat, netMsat: net, pick: e.pick, side: SCALAR_SIDES[e.pick] };
  }).sort((x, y) => (x.entryId < y.entryId ? -1 : x.entryId > y.entryId ? 1 : 0));
}

/**
 * IS A SCALAR ROUND REFUNDED WHATEVER ITS VALUE? No entry; nobody on one side; or a pool with stakes on one side only. Answers
 * { refunded, why }. One rule, read by the table and by a seat's return door (arena-node forfeit.js), which decides from its
 * entries before any table is made.
 */
export function scalarOneSided(entries) {
  const rows = scalarRows(entries);
  const longs = rows.filter((r) => r.pick === SCALAR_LONG), shorts = rows.filter((r) => r.pick === SCALAR_SHORT);
  const L = scSum(longs.map((r) => r.netMsat)), S = scSum(shorts.map((r) => r.netMsat));
  if (!rows.length) return { refunded: true, why: 'nobody entered: nothing to settle' };
  if (!longs.length || !shorts.length || (L + S > 0n && (L === 0n || S === 0n)))
    return { refunded: true, why: `only the ${L > 0n || (longs.length && !shorts.length) ? 'LONG' : 'SHORT'} side staked: no counterparty, every stake comes back, its fee too` };
  return { refunded: false };
}

/**
 * THE SCALAR TABLE. `entries`: [{ entryId (hex or bytes), stakeMsat, feeMsat, donationMsat, pick (0 LONG, 1 SHORT) }] - each
 * entry's fee and donation come out of its stake as pariMutuelTable takes them (§0A.8, checked at the door); `value` the
 * attested V (BigInt, any signed 64-bit number); `bounds` { low, high } - the manifest's scalar. Answers the table: per row its
 * `payoutMsat` and `won` (true when it gets back at least its net stake - its lock is its own, the excess paid from the claimed
 * locks; false when it gets back less - its lock is claimed and the rest paid back to it: lock-settlement.js
 * attestedLockSettlement), the two sides' pools and shares, `refunded` for a one-sided round. Pure; throws on bounds that do
 * not fit, an entry backing no side, or a table that would not balance.
 */
export function scalarPayoutTable({ entries, value, bounds }) {
  const fit = scalarBoundsFit(bounds);
  if (!fit.ok) throw new Error(fit.why);
  const clamped = scalarClamp(value, bounds);
  const rows = scalarRows(entries);
  const longs = rows.filter((r) => r.pick === SCALAR_LONG), shorts = rows.filter((r) => r.pick === SCALAR_SHORT);
  const longPool = scSum(longs.map((r) => r.netMsat)), shortPool = scSum(shorts.map((r) => r.netMsat));
  const pool = longPool + shortPool;
  const span = bounds.high - bounds.low, reach = clamped - bounds.low;
  const one = scalarOneSided(entries);
  let longShare = longPool, shortShare = shortPool;
  if (one.refunded) {
    // NO COUNTERPARTY: every net stake back to its own entry
    for (const r of rows) r.payoutMsat = r.netMsat;
  } else {
    // THE SIDES: each share floored, the one msat the two floors may leave to the side of the first entry that staked
    longShare = (pool * reach) / span;
    shortShare = (pool * (span - reach)) / span;
    const left = pool - longShare - shortShare;
    if (left > 0n) {
      const first = rows.find((r) => r.netMsat > 0n);
      if (first.pick === SCALAR_LONG) longShare += left; else shortShare += left;
    }
    // WITHIN A SIDE: pari-mutuel over its own net stakes, floored, the leftover one msat each in ascending entry id
    const split = (side, share, sideNet) => {
      let given = 0n;
      for (const r of side) { r.payoutMsat = sideNet > 0n ? (share * r.netMsat) / sideNet : 0n; given += r.payoutMsat; }
      let rest = share - given;
      const staked = side.filter((r) => r.netMsat > 0n);
      for (let i = 0; rest > 0n; i = (i + 1) % staked.length, rest--) staked[i].payoutMsat += 1n;
    };
    split(longs, longShare, longPool);
    split(shorts, shortShare, shortPool);
  }
  for (const r of rows) r.won = r.payoutMsat >= r.netMsat;
  const gross = scSum(rows.map((r) => r.stakeMsat));
  const fees = scSum(rows.map((r) => r.feeMsat));
  const donations = scSum(rows.map((r) => r.donationMsat));
  const paid = scSum(rows.map((r) => r.payoutMsat));
  // NEVER MORE OUT THAN IN, NOTHING KEPT: the net pool exactly, every msat of the gross accounted for, no negative payout
  if (paid !== pool || fees + donations + paid !== gross || rows.some((r) => r.payoutMsat < 0n))
    throw new Error(`the scalar table does not balance: ${fees} + ${donations} + ${paid} is not the gross ${gross} (pool ${pool})`);
  return { value, clamped, low: bounds.low, high: bounds.high, refunded: one.refunded, ...(one.refunded ? { why: one.why } : {}),
    grossMsat: gross, feesMsat: fees, donationsMsat: donations, poolMsat: pool, longPoolMsat: longPool, shortPoolMsat: shortPool,
    longShareMsat: longShare, shortShareMsat: shortShare, payoutsMsat: paid, rows };
}
