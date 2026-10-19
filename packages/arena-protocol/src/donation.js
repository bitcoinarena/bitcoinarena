// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// Protected by LICENSE section 2: no copy or fork may change the network id or the protocol developers' donation set here.
// 22A: THE PLAYER'S DONATION, WHICH GOES TO A SET AND NOT TO AN ADDRESS.
//
// "A donation goes to a set of recipients with declared shares, not to one
// address... `share_bps` are basis points and MUST sum to exactly 10000."
//
// `donationMsat` has been on every Entry Contract since it was written and
// read by nothing - the same state `feeMsat` was in before the fee table.
// This is the arithmetic and the one rule that decides where the money does
// NOT go when a payment fails.
//
// THE ROUNDING IS NOT THE FEE'S ROUNDING, and that is deliberate rather than
// an oversight to be tidied. 22A gives the node fee's remainder to the
// ascending `H(round_id || node_pubkey)` order and gives the donation's to
// "the first recipient in the set as published. Deterministic, and the
// amounts are too small for anything cleverer to be worth its complexity."
// Two rules, written down separately, and copying either onto the other would
// be inventing a third.
//
// WHAT IS DELIBERATELY NOT HERE. 22A also says the set "is named in the Round
// Contract and its hash is part of the contract hash". That is a signed field
// and it moves every round id, so it is a decision before it is work - the
// same split the fee table took before `feeMsat`. And there is no Lightning
// here: a recipient is an opaque `lnurl` string, because this package pays
// nobody and inventing a payment layer to test one would be inventing a
// second protocol.
import { Writer, Reader } from './encode.js';
import { taggedHash, toHex } from './hash.js';
import { PROTOCOL_VERSION, speaksVersion, TYPE_DONATION_SET, TYPE_DONATION_SET_KEYS, TYPE_DONATION_SET_KEYS_VESTING, TAG } from './constants.js';
import { isRefund } from './payout.js';

/** Basis points, and 22A's MUST: the shares sum to exactly this. */
export const DONATION_BPS_TOTAL = 10000;

/**
 * AN LNURL IS BECH32, AND BECH32 DECIDES ITS OWN CASE RULES.
 *
 * Two of them, and both are the encoding's, not this file's invention:
 * a string may not be MIXED case, and case carries no meaning - `LNURL1ABC`
 * and `lnurl1abc` are one address.
 *
 * Treating the string as opaque bytes instead was measured and was a hole:
 * `[{LNURL1ABC, 5000}, {lnurl1abc, 5000}]` stood, which is ONE PARTY HOLDING
 * TWO SHARES - exactly what the duplicate check exists to prevent - and the
 * same payee produced two different set ids, so two honest nodes handed the
 * same recipients in different case disagreed about which set was used.
 *
 * FOLDED IN ASCII AND NOT BY `toLowerCase`, deliberately. `toLowerCase` is
 * Unicode and in a Turkish locale maps `I` to a dotless `ı`, so two
 * implementations of this protocol could canonicalise one address two ways and
 * disagree about who is being paid. Bech32 is ASCII; the fold is ASCII.
 */
const upper = (c) => c >= 65 && c <= 90;
const lower = (c) => c >= 97 && c <= 122;

export function canonicalLnurl(lnurl) {
  let out = '';
  for (let i = 0; i < lnurl.length; i++) {
    const c = lnurl.charCodeAt(i);
    out += upper(c) ? String.fromCharCode(c + 32) : lnurl[i];
  }
  return out;
}

export function isMixedCase(lnurl) {
  let hasUpper = false;
  let hasLower = false;
  for (let i = 0; i < lnurl.length; i++) {
    const c = lnurl.charCodeAt(i);
    if (upper(c)) hasUpper = true;
    else if (lower(c)) hasLower = true;
  }
  return hasUpper && hasLower;
}

/**
 * DOES THIS SET STAND?
 *
 * A set whose shares do not sum to exactly 10000 is not a division of the
 * player's donation: under it money is either left over with nobody named to
 * receive it, or promised twice. Either way the player's chosen amount is not
 * what the set hands out, and 22A says MUST.
 *
 * Answered rather than thrown, like every other decision in this package.
 */
/** A recipient key: a compressed secp256k1 point, as the claim key (claim-key.js). */
export const RECIPIENT_KEY_BYTES = 33;
/** A recipient's label is for the screen, short: at most this many characters. */
export const RECIPIENT_LABEL_MAX = 48;
export const isRecipientKey = (b) => b instanceof Uint8Array && b.length === RECIPIENT_KEY_BYTES && (b[0] === 0x02 || b[0] === 0x03);
/** Does this set pay keys in the federation (FEDERATION.md, 2026-10-03) rather than LNURLs? */
const paysKeys = (recipients) => Array.isArray(recipients) && recipients.length > 0
  && recipients.some((r) => r && r.recipientPk !== undefined);

/**
 * A ROUND'S TWO DONATION SETS (§0A.8): `{ network, game }` - the network's protocol-dev set (the one the
 * contract names, signed by the network's authority) and the round's game's set (the one its manifest names, signed by
 * the game's developer through the manifest). Every donation path that took one set takes this; one set alone is the
 * walk-away's 25% (lock-settlement.js), which stays the network's (2026-10-07).
 */
export const isTwoSets = (r) => !!r && !Array.isArray(r) && Array.isArray(r.network) && Array.isArray(r.game);

/** Whether a donation of this round pays keys in its federation - both sets of a two-set target, or the one set. */
export const donationSetPaysKeys = (recipients) => (isTwoSets(recipients)
  ? paysKeys(recipients.network) && paysKeys(recipients.game) : paysKeys(recipients));

export function donationSetStands(recipients) {
  if (!Array.isArray(recipients) || !recipients.length)
    return { ok: false, why: 'a donation goes to a set, and this names nobody' };
  if (donationSetPaysKeys(recipients)) return keySetStands(recipients);

  let sum = 0;
  const seen = new Set();
  for (const [at, r] of recipients.entries()) {
    if (!r || typeof r.lnurl !== 'string' || !r.lnurl.length)
      return { ok: false, why: `recipient ${at} has no address to be paid at` };
    if (!Number.isInteger(r.shareBps) || r.shareBps < 0)
      return { ok: false, why: `recipient ${at} has no whole share in basis points` };

    // BECH32 FORBIDS MIXED CASE, so an address in it is not an address.
    if (isMixedCase(r.lnurl))
      return {
        ok: false,
        why: `recipient ${at} is mixed case, which bech32 does not allow in an address`,
      };

    // ONE RECIPIENT LISTED TWICE IS TWO SHARES FOR ONE PARTY, and the set is
    // "a parameter the network can hold an opinion about" - an opinion it
    // cannot form if the same address can appear under two weights.
    //
    // COMPARED CANONICALLY, because case carries no meaning in bech32: the two
    // spellings of one payee are one payee, and listing both was measured
    // standing before this line existed.
    const key = canonicalLnurl(r.lnurl);
    if (seen.has(key))
      return {
        ok: false,
        why: `${r.lnurl} is listed twice, which is one party with two shares`,
      };
    seen.add(key);
    sum += r.shareBps;
  }

  if (sum !== DONATION_BPS_TOTAL)
    return {
      ok: false,
      why: `those shares sum to ${sum} basis points and 22A says exactly `
        + `${DONATION_BPS_TOTAL}: the player's donation is not what that set hands out`,
    };
  return { ok: true, why: `${recipients.length} recipients sharing exactly ${sum} basis points` };
}

/**
 * A SET OF KEYS, JUDGED (2026-10-03): every recipient a key - never a set of keys and LNURLs mixed, which would pay
 * half a donation in the federation and half over Lightning - each key once, each label short, the shares summing to
 * exactly 10000 as for an LNURL set.
 */
function keySetStands(recipients) {
  let sum = 0;
  const seen = new Set();
  for (const [at, r] of recipients.entries()) {
    if (!r || r.lnurl !== undefined)
      return { ok: false, why: `recipient ${at} names an LNURL in a set of keys: a set pays keys or LNURLs, never both` };
    if (!isRecipientKey(r.recipientPk))
      return { ok: false, why: `recipient ${at} is no 33-byte compressed secp256k1 key` };
    if (!Number.isInteger(r.shareBps) || r.shareBps < 0)
      return { ok: false, why: `recipient ${at} has no whole share in basis points` };
    if (typeof r.label !== 'string' || r.label.length > RECIPIENT_LABEL_MAX)
      return { ok: false, why: `recipient ${at} has no label of at most ${RECIPIENT_LABEL_MAX} characters` };
    const key = toHex(r.recipientPk);
    if (seen.has(key)) return { ok: false, why: `key ${key.slice(0, 16)}… is listed twice, which is one party with two shares` };
    seen.add(key);
    sum += r.shareBps;
    if (r.vesting !== undefined && r.vesting !== null) {
      const v = r.vesting;
      if (!Number.isInteger(v.targetBps) || v.targetBps < 0 || v.targetBps > DONATION_BPS_TOTAL) return { ok: false, why: `recipient ${at} vests to no share in basis points` };
      if (!Number.isInteger(v.startHeight) || v.startHeight < 0) return { ok: false, why: `recipient ${at} vests from no block height` };
      if (!Number.isInteger(v.days) || v.days < 1 || v.days > 65535) return { ok: false, why: `recipient ${at} vests over no whole number of days (1-65535)` };
    }
  }
  if (sum !== DONATION_BPS_TOTAL)
    return { ok: false, why: `those shares sum to ${sum} basis points and 22A says exactly ${DONATION_BPS_TOTAL}` };
  // AT FULL VESTING THE REST STILL HOLD SOMETHING TO GIVE (§27A.4.1): the vesting entries' targets, the others' shares scaled into the rest
  const vesting = recipients.filter((r) => r.vesting);
  if (vesting.length) {
    const target = vesting.reduce((t, r) => t + r.vesting.targetBps, 0);
    const others = recipients.filter((r) => !r.vesting).reduce((t, r) => t + r.shareBps, 0);
    if (target > DONATION_BPS_TOTAL) return { ok: false, why: `the vesting targets sum to ${target} basis points, more than ${DONATION_BPS_TOTAL}` };
    if (target < DONATION_BPS_TOTAL && others === 0) return { ok: false, why: 'the vesting targets leave a rest and no other recipient holds a share to scale into it' };
  }
  return { ok: true, why: `${recipients.length} keys sharing exactly ${sum} basis points` };
}

/** One share's recipient as the set names it: its LNURL, or its key and label. */
const payeeOf = (r) => (r && r.recipientPk !== undefined ? { recipientPk: r.recipientPk, label: r.label } : { lnurl: r && r.lnurl });

/**
 * WHAT EACH RECIPIENT IS OWED OF ONE PLAYER'S DONATION.
 *
 * "Rounding: compute in millisatoshis, floor each share, and give the
 * remainder to the first recipient in the set AS PUBLISHED."
 *
 * So the split is EXACT - the remainder is handed to a named party rather than
 * dropped - and the sum of the shares is the donation, to the millisatoshi.
 * That is a different property from the node fee, where each entry's own floor
 * can collect less than the round's table owes; here there is nothing to
 * collect less of, and no gap for anybody to keep.
 *
 * A PLAYER WHO DONATES NOTHING PAYS NOTHING, and the set is irrelevant to that
 * entry - 22A says so - so a zero donation is answered without judging the
 * set at all.
 *
 * THE ANSWER IS `owed`, NOT `ok`, and the difference is the whole reason it
 * was renamed. A zero donation returns successfully with a set that would NOT
 * stand, because 22A says the set is irrelevant to that entry - and a field
 * called `ok` invites a caller to read that as "this set stands", which it
 * does not say and must never be taken to. `owed` says what this function
 * actually answers: what each recipient is owed. Whether a set stands is
 * `donationSetStands`, and it is a different question with a different name.
 */
export function splitDonation({ donationMsat, recipients }) {
  if (isTwoSets(recipients)) return splitTwoSets({ donationMsat, networkSet: recipients.network, gameSet: recipients.game });
  if (typeof donationMsat !== 'bigint')
    return { owed: false, why: 'a donation is BigInt millisatoshi' };
  if (donationMsat < 0n)
    return { owed: false, why: 'a donation cannot be negative' };

  if (donationMsat === 0n)
    return {
      owed: true,
      shares: (Array.isArray(recipients) ? recipients : []).map((r) => ({
        ...payeeOf(r), amountMsat: 0n,
      })),
      why: 'donations are off for this entry, and the set is irrelevant to it',
    };

  const stands = donationSetStands(recipients);
  if (!stands.ok) return { owed: false, why: stands.why };

  const shares = recipients.map((r) => ({
    ...payeeOf(r),
    amountMsat: (donationMsat * BigInt(r.shareBps)) / BigInt(DONATION_BPS_TOTAL),
  }));

  // The remainder to the first as published - not to the largest share, not
  // to a hash order, and not dropped.
  const handed = shares.reduce((sum, s) => sum + s.amountMsat, 0n);
  shares[0].amountMsat += donationMsat - handed;

  const total = shares.reduce((sum, s) => sum + s.amountMsat, 0n);
  if (total !== donationMsat)
    throw new Error(`donation split broken: ${total} of ${donationMsat}`);

  return { owed: true, shares, why: `${donationMsat} split over ${shares.length} recipients` };
}

/**
 * A DONATION SPLIT OVER A ROUND'S TWO SETS (§0A.8, RULED 2026-10-06): HALF TO THE PROTOCOL DEVS - the
 * network's set - and HALF TO THE GAME DEV - the game's set; the protocol half floored, the game half the rest, so the two
 * halves are the donation to the millisatoshi. Each half is split over its own set exactly as one set is (`splitDonation`:
 * floors by share_bps, the remainder to the first as published). Then ONE SHARE PER RECIPIENT: a recipient in both sets
 * (nextblock's protocol dev is its game dev) is paid once, the sum of its two shares - the shares are still computed
 * separately, so the split is the same whoever the recipients are. Order: the network set's recipients as published, then
 * the game set's that are not in it. `protocol` and `game` are the two halves' own shares, for whoever shows them.
 */
export function splitTwoSets({ donationMsat, networkSet, gameSet }) {
  if (typeof donationMsat !== 'bigint') return { owed: false, why: 'a donation is BigInt millisatoshi' };
  if (donationMsat < 0n) return { owed: false, why: 'a donation cannot be negative' };
  if (donationMsat > 0n && paysKeys(networkSet) !== paysKeys(gameSet))
    return { owed: false, why: 'a round\'s two donation sets pay keys or LNURLs alike, never one of each' };
  const protocolMsat = donationMsat / 2n;
  const protocol = splitDonation({ donationMsat: protocolMsat, recipients: networkSet });
  if (!protocol.owed) return { owed: false, why: `the protocol devs' set: ${protocol.why}` };
  const game = splitDonation({ donationMsat: donationMsat - protocolMsat, recipients: gameSet });
  if (!game.owed) return { owed: false, why: `the game dev's set: ${game.why}` };
  const keyOf = (sh) => (sh.recipientPk instanceof Uint8Array ? `k:${toHex(sh.recipientPk)}` : `l:${canonicalLnurl(sh.lnurl)}`);
  const merged = new Map();
  for (const sh of [...protocol.shares, ...game.shares]) {
    const k = keyOf(sh);
    if (merged.has(k)) merged.get(k).amountMsat += sh.amountMsat;
    else merged.set(k, { ...sh });
  }
  const shares = [...merged.values()];
  const total = shares.reduce((t, sh) => t + sh.amountMsat, 0n);
  if (total !== donationMsat) throw new Error(`two-set donation split broken: ${total} of ${donationMsat}`);
  return { owed: true, shares, protocol: protocol.shares, game: game.shares, protocolMsat, gameMsat: donationMsat - protocolMsat,
    why: `${donationMsat} msat: ${protocolMsat} to the protocol devs, ${donationMsat - protocolMsat} to the game dev, ${shares.length} recipient(s)` };
}

/**
 * THE DONATION OUTPUTS AN ENTRY MUST NAME, AND WHICH IS WHICH (2026-10-03): for a set of keys, one federation
 * output per share above 0 msat, in the set's order, each a payout contract to that share's key for exactly its amount.
 * Answers the pairs a signer node checks against the federation ([{ outpoint, recipientPk, amountMsat }]), or why the
 * entry's list is not the set's: a missing or extra outpoint, or donation outpoints where nothing is donated or the set
 * pays LNURLs. Zero shares (a donation too small to reach a recipient) name no output.
 */
export function donationOutputsExpected(entry, recipients) {
  const named = (entry && entry.donationOutpoints) || [];
  if (!entry || typeof entry.donationMsat !== 'bigint') return { ok: false, why: 'that entry names no donation' };
  if (!donationSetPaysKeys(recipients)) {
    if (named.length) return { ok: false, why: 'that round\'s donation set pays LNURLs, and the entry names donation outputs' };
    return { ok: true, outputs: [], why: 'the set pays LNURLs: no output in the federation' };
  }
  const split = splitDonation({ donationMsat: entry.donationMsat, recipients });
  if (!split.owed) return { ok: false, why: split.why };
  const owed = split.shares.filter((sh) => sh.amountMsat > 0n);
  if (named.length !== owed.length)
    return { ok: false, why: `that entry names ${named.length} donation output(s) and its donation of ${entry.donationMsat} msat owes ${owed.length}` };
  return { ok: true, outputs: owed.map((sh, i) => ({ outpoint: named[i], recipientPk: sh.recipientPk, amountMsat: sh.amountMsat })),
    why: `${owed.length} donation output(s), ${entry.donationMsat} msat` };
}

/**
 * WHAT ACTUALLY MOVES WHEN A PAYMENT FAILS, and where it does NOT go.
 *
 * 22A: "Payment failure to one recipient does not void the entry or the round.
 * A donation is voluntary and outside the pool; an unreachable LNURL is a
 * failed payment and nothing more. Clients SHOULD report it and MUST NOT
 * redirect the share to the remaining recipients, WHICH WOULD LET ONE
 * UNREACHABLE ENDPOINT QUIETLY REDISTRIBUTE OTHER PEOPLE'S MONEY."
 *
 * So an unpaid share stays unpaid. Every other recipient is owed exactly what
 * it was owed before, and the failure changes one number: what was paid. This
 * is the money-law clause and not a retry policy - whether a client tries
 * again is its business, and where the money may go is not.
 *
 * The entry stands either way: a donation is outside the pool, so a failure
 * here can neither void a round nor touch a stake.
 */
export function donationAfterFailures({ shares, failed = [] }) {
  const out = new Set(failed);
  const paid = [];
  const unpaid = [];
  for (const s of shares) (out.has(s.lnurl) ? unpaid : paid).push({ ...s });

  return {
    paid,
    unpaid,
    paidMsat: paid.reduce((sum, s) => sum + s.amountMsat, 0n),
    unpaidMsat: unpaid.reduce((sum, s) => sum + s.amountMsat, 0n),
    entryStands: true,
    why: unpaid.length
      ? `${unpaid.length} recipient(s) unreachable; their share is not redistributed`
      : 'every recipient was paid its share',
  };
}

/**
 * The donations of a round, for the rounds where somebody wants the total.
 * Refunded entries are excluded for the reason the fee base excludes them: a
 * VOID entry is money that never moved.
 */
export const donatedMsat = (entries) =>
  entries.filter((e) => !isRefund(e.outcome)).reduce((sum, e) => sum + e.donationMsat, 0n);

/**
 * THE SET AS BYTES, so a committee can check one instead of being handed an
 * array.
 *
 * Every other object here that decides money encodes and carries a tagged id -
 * the payout table, the settlement record, the fee claim, the service record,
 * the slash proof - and until this the donation set was the only one that did
 * not. That is what stopped two independent nodes agreeing on WHICH set a
 * player donated under, and nothing could be bound to one.
 *
 * THE ORDER IS PART OF THE SET AND IS NOT SORTED. Everywhere else in this
 * package a vector is sorted so that two honest callers agree - the payout
 * table by pubkey, the committee by key - and here that would be a bug: 22A
 * gives the remainder to "the first recipient in the set AS PUBLISHED", so the
 * order decides who is topped up. A set reordered is a set that pays somebody
 * else the odd millisatoshi, and it must therefore be a different set with a
 * different id.
 *
 * A SET THAT DOES NOT STAND DOES NOT ENCODE. There would otherwise be bytes
 * with a real tagged id naming shares that sum to 9999 - an object that looks
 * exactly as published as an honest one and hands out a different amount than
 * the player chose. Refused at the encoder, so no such id can exist.
 */
export function encodeDonationSet(recipients) {
  const stands = donationSetStands(recipients);
  if (!stands.ok) throw new Error(`that set does not stand: ${stands.why}`);
  if (donationSetPaysKeys(recipients) && recipients.some((r) => r.vesting)) {
    // A SET OF KEYS THAT VESTS (§27A.4.1): each entry's key, share now, label, and - when it vests - its target, its
    // first block and its length in days; a set without vesting keeps the plain encoding below, and so its id
    const w = new Writer();
    w.u8(TYPE_DONATION_SET_KEYS_VESTING);
    w.u16(PROTOCOL_VERSION);
    w.vec(recipients, (r, ww) => { ww.bytes(r.recipientPk, RECIPIENT_KEY_BYTES); ww.u16(r.shareBps); ww.str(r.label);
      if (r.vesting) { ww.u8(1); ww.u16(r.vesting.targetBps); ww.u32(r.vesting.startHeight); ww.u16(r.vesting.days); } else ww.u8(0); });
    return w.finish();
  }
  if (donationSetPaysKeys(recipients)) {
    // A SET OF KEYS: the key, the share, the label - in the order published (the remainder rule reads it)
    const w = new Writer();
    w.u8(TYPE_DONATION_SET_KEYS);
    w.u16(PROTOCOL_VERSION);
    w.vec(recipients, (r, ww) => { ww.bytes(r.recipientPk, RECIPIENT_KEY_BYTES); ww.u16(r.shareBps); ww.str(r.label); });
    return w.finish();
  }

  const w = new Writer();
  w.u8(TYPE_DONATION_SET);
  w.u16(PROTOCOL_VERSION);
  w.vec(recipients, (r, ww) => {
    // THE ADDRESS, CANONICALLY. 22A's "the client MUST show every recipient
    // before wallet approval - a donation to an undisclosed address is not a
    // donation" is about WHICH payee, and bech32 says case is not part of
    // that: the same list typed in upper and in lower is the same set and must
    // therefore hash to one id, or two honest nodes disagree over spelling.
    ww.str(canonicalLnurl(r.lnurl));
    ww.u16(r.shareBps);
  });
  return w.finish();
}

export function decodeDonationSet(bytes) {
  const r = new Reader(bytes);
  const type = r.u8();
  if (type === TYPE_DONATION_SET_KEYS) {
    if (!speaksVersion(r.u16())) throw new Error('unknown protocol version');
    const recipients = r.vec((rr) => ({ recipientPk: rr.bytes(RECIPIENT_KEY_BYTES), shareBps: rr.u16(), label: rr.str() }));
    if (r.at !== bytes.length) throw new Error('trailing bytes after the donation set');
    const stands = donationSetStands(recipients);
    if (!stands.ok) throw new Error(`that set does not stand: ${stands.why}`);
    return recipients;
  }
  if (type === TYPE_DONATION_SET_KEYS_VESTING) {
    if (!speaksVersion(r.u16())) throw new Error('unknown protocol version');
    const recipients = r.vec((rr) => {
      const x = { recipientPk: rr.bytes(RECIPIENT_KEY_BYTES), shareBps: rr.u16(), label: rr.str() };
      const has = rr.u8();
      if (has > 1) throw new Error('a vesting flag is 0 or 1');
      if (has) x.vesting = { targetBps: rr.u16(), startHeight: rr.u32(), days: rr.u16() };
      return x;
    });
    if (r.at !== bytes.length) throw new Error('trailing bytes after the donation set');
    if (!recipients.some((x) => x.vesting)) throw new Error('a vesting set names no vesting entry: it is the plain set');
    const stands = donationSetStands(recipients);
    if (!stands.ok) throw new Error(`that set does not stand: ${stands.why}`);
    return recipients;
  }
  if (type !== TYPE_DONATION_SET) throw new Error('not a donation set');
  if (!speaksVersion(r.u16())) throw new Error('unknown protocol version');
  const recipients = r.vec((rr) => ({ lnurl: rr.str(), shareBps: rr.u16() }));
  if (r.at !== bytes.length) throw new Error('trailing bytes after the donation set');

  // Checked on the way in as well as on the way out: bytes are where a set
  // arrives from a stranger, and a stranger is exactly who might send one that
  // does not stand.
  const stands = donationSetStands(recipients);
  if (!stands.ok) throw new Error(`that set does not stand: ${stands.why}`);

  // AND THE BYTES THEMSELVES MUST BE CANONICAL, or one set has two of them.
  //
  // The encoder folds, so nothing this package writes is ever uppercase - but
  // a stranger does not use this encoder. Hand-crafted bytes spelling the
  // payee `LNURL1ABC` decoded happily and stood, which left ONE SET WITH TWO
  // BYTE STRINGS: a committee comparing what it received, or hashing it
  // directly instead of re-encoding, would see two different sets and
  // disagree - the very disagreement folding was adopted to remove. Measured
  // before this check existed.
  //
  // Refused rather than quietly folded on the way in: bytes that are not the
  // set's own encoding are not that set, and accepting them would make the id
  // depend on who did the hashing.
  for (const [at, r] of recipients.entries())
    if (r.lnurl !== canonicalLnurl(r.lnurl))
      throw new Error(
        `recipient ${at} is not canonical: a set has one encoding, and these `
        + 'bytes are not it');

  return recipients;
}

/** What 22A means by naming a set: one hash, over the recipients as published. */
export const donationSetId = (recipients) =>
  taggedHash(TAG.donationSet, encodeDonationSet(recipients));

/**
 * IS THIS THE SET THE ROUND NAMED? 22A's binding, checked.
 *
 * "The set is named in the Round Contract and its hash is part of the contract
 * hash, SO IT CANNOT CHANGE AFTER ENTRY." A set with an id and nothing naming
 * which one applies leaves two honest nodes able to agree on a set's bytes and
 * still disagree about whether it was this round's - and a player's donation
 * split by a list nobody signed up to.
 *
 * Answered rather than thrown, like every other decision here: a set that does
 * not stand has no id at all, and that is a refusal rather than a crash.
 */
export function donationSetMatchesRound(contract, recipients) {
  if (!contract || !(contract.donationSetId instanceof Uint8Array)
      || contract.donationSetId.length !== 32)
    return { ok: false, why: 'that round names no donation set' };

  let id;
  try { id = donationSetId(recipients); }
  catch (e) { return { ok: false, why: e.message }; }

  const same = id.every((b, i) => b === contract.donationSetId[i]);
  return same
    ? { ok: true, why: 'that is the set this round named' }
    : {
      ok: false,
      why: 'that set is not the one this round named, and 22A says it cannot '
        + 'change after entry',
    };
}

/** A day of vesting, in blocks (§27A.4.1: "vesting is daily", 2026-10-16). */
export const VESTING_DAY_BLOCKS = 144;
/**
 * THE SHARES A VESTING SET PAYS AT A HEIGHT (§27A.4.1): each vesting entry has moved from its share towards its target
 * by one day's step per VESTING_DAY_BLOCKS since its start (floored to whole basis points, at most its target); every other entry
 * holds its share scaled into what the vesting entries leave, floored, the rest of a basis point to the first of them as
 * published. A set without vesting is answered as it is. The answer is a plain set: keys, labels, shares summing to 10000.
 */
export function vestedShares(recipients, height) {
  if (!Array.isArray(recipients) || !recipients.some((r) => r && r.vesting)) return recipients;
  const h = Number(height) || 0;
  const now = recipients.map((r) => {
    if (!r.vesting) return null;
    const { targetBps, startHeight, days } = r.vesting;
    const elapsed = h < startHeight ? 0 : Math.min(days, Math.floor((h - startHeight) / VESTING_DAY_BLOCKS));
    return r.shareBps + Math.trunc(((targetBps - r.shareBps) * elapsed) / days);
  });
  const vested = now.reduce((t, x) => t + (x === null ? 0 : x), 0);
  const othersBase = recipients.reduce((t, r) => t + (r.vesting ? 0 : r.shareBps), 0);
  const rest = DONATION_BPS_TOTAL - vested;
  const out = recipients.map((r, i) => ({ recipientPk: r.recipientPk, label: r.label,
    shareBps: r.vesting ? now[i] : (othersBase > 0 ? Math.floor((r.shareBps * rest) / othersBase) : 0) }));
  const short = DONATION_BPS_TOTAL - out.reduce((t, x) => t + x.shareBps, 0);
  const first = recipients.findIndex((r) => !r.vesting);
  if (short && first >= 0) out[first].shareBps += short;
  return out;
}
