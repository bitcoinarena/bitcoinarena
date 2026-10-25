// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A DONATION TO THE DEVELOPERS, OUTSIDE ANY ROUND (2026-10-17: "donate to developer, a popup opens with an amount to
// choose from 100, 500, 1000, 5000 satoshis or custom"; "B e cash").
//
// The player's wallet pays the amount in ONE federation transaction whose outputs are pre-expired payout contracts to the keys of a
// donation set, split by share exactly as a round's donation is (splitDonation: floor each share, the remainder to the first
// recipient, no 0 msat output) - the item shop's payment (paySubmit), with no item. The donor signs a record of it: which set (a
// game's, by its developer and name, or the network's protocol developers'), the federation, the transaction, every output, the
// total and when. A seat keeps it only when the outputs are that split of that total over the set it holds and the federation holds
// each output as built; then it indexes them under each recipient key (GET /donations?key=), where the developer's own client
// already finds a round's donations, and hands the record on to every seat.
import { Writer, Reader } from './encode.js';
import { taggedHash, toHex } from './hash.js';
import { splitDonation, splitTwoSets, DONATION_BPS_TOTAL } from './donation.js';
import { refundKeyOf } from './stake-lock.js';

export const TAG_DONATION_GIFT = 'ARENA/v1/DonationGift';
export const TYPE_DONATION_GIFT = 0x44;          // 'D'
export const DONATION_GIFT_VERSION = 1;
export const GIFT_TO_NETWORK = 0, GIFT_TO_GAME = 1;
/**
 * HALF TO THE PROTOCOL DEVELOPERS, HALF TO THE APP'S (kanban #672, 2026-10-25: "when clicking donate on the main Testnet site the donation
 * goes too 100% to protocol devs. If it's within an app 50% to protocol devs, 50% to game devs. That donation is tagged so we know its
 * origin"): a gift naming the app as a game gift does, split over both sets as a round's donation is (splitTwoSets).
 */
export const GIFT_TO_BOTH = 3;
/** A record with an origin (or to both sets) is version 2: the origin follows its time. Version 1 records keep their bytes and ids. */
export const DONATION_GIFT_VERSION_ORIGIN = 2;
/** Where a gift was given, said by the page: "site", "app:<name>" - at most this many characters. */
export const GIFT_ORIGIN_MAX = 64;
/**
 * A ZAP FROM THE SEASON BOARD (2026-10-17: "zaps in the leaderboard go to the federation's account of the user not
 * an external lightning payment"): a gift whose 32-byte target is the player's identity key - the key the board names - and whose
 * one output is a pre-expired payout contract to refundKeyOf(identity) in the donor's federation, which only that player's page
 * can spend (its identity secret). No set: the player is the whole of it. The name field stays empty.
 */
export const GIFT_TO_PLAYER = 2;
export const playerGiftRecipients = (identity) => [{ recipientPk: refundKeyOf(identity), shareBps: DONATION_BPS_TOTAL, label: 'player' }];
/** The amounts the popup offers, in sat (2026-10-17), and the smallest and largest custom amount. */
export const GIFT_CHOICES_SAT = Object.freeze([100, 500, 1000, 5000]);
export const GIFT_MIN_SAT = 1, GIFT_MAX_SAT = 10_000_000;
/** How far a record may be dated ahead of a seat's clock. */
export const GIFT_SKEW_MS = 10 * 60 * 1000;

const giftIs32 = (b) => b instanceof Uint8Array && b.length === 32;
const giftIs33 = (b) => b instanceof Uint8Array && b.length === 33;
const GIFT_ZERO32 = new Uint8Array(32);

export function encodeDonationGift(g) {
  if (g.target !== GIFT_TO_NETWORK && g.target !== GIFT_TO_GAME && g.target !== GIFT_TO_PLAYER && g.target !== GIFT_TO_BOTH)
    throw new Error('a gift is to the network\'s developers (0), a game\'s (1), a player (2) or the network\'s and a game\'s, half each (3)');
  const origin = String(g.origin || '');
  if (origin.length > GIFT_ORIGIN_MAX || /[\u0000-\u001f]/.test(origin)) throw new Error(`a gift's origin is at most ${GIFT_ORIGIN_MAX} printable characters`);
  const version = origin || g.target === GIFT_TO_BOTH ? DONATION_GIFT_VERSION_ORIGIN : DONATION_GIFT_VERSION;
  const dev = g.target === GIFT_TO_NETWORK ? GIFT_ZERO32 : g.gameDevPubkey;
  if (g.target === GIFT_TO_PLAYER && (!giftIs32(dev) || dev.every((b) => b === 0) || g.gameName)) throw new Error('a zap names its player by a 32-byte identity key, and no game');
  const toGame = g.target === GIFT_TO_GAME || g.target === GIFT_TO_BOTH;
  const name = toGame ? String(g.gameName || '') : '';
  if (!giftIs32(dev) || (toGame && !name)) throw new Error('a gift to a game names its developer by 32 bytes and its name');
  if (!giftIs32(g.donor) || !giftIs32(g.federationId) || !giftIs32(g.txid)) throw new Error('a gift names its donor, its federation and its transaction by 32 bytes each');
  if (typeof g.totalMsat !== 'bigint' || g.totalMsat < 1000n) throw new Error('a gift is at least 1 sat, in msat as a BigInt');
  if (!Array.isArray(g.outputs) || g.outputs.length < 1 || g.outputs.length > 255) throw new Error('a gift pays 1 to 255 outputs');
  for (const o of g.outputs) if (!Number.isInteger(o.outIdx) || o.outIdx < 0 || !giftIs33(o.pk) || typeof o.msat !== 'bigint' || o.msat < 1n)
    throw new Error('an output names its index, its recipient\'s 33-byte key and its msat');
  const w = new Writer();
  w.u8(TYPE_DONATION_GIFT); w.u16(version);
  w.u8(g.target); w.bytes32(dev); w.str(name);
  w.bytes32(g.donor); w.bytes32(g.federationId); w.bytes32(g.txid); w.u64(g.totalMsat);
  w.vec(g.outputs, (o, ww) => { ww.u32(o.outIdx); ww.bytes(o.pk, 33); ww.u64(o.msat); }, { sortedBy: (a, b) => a.outIdx - b.outIdx });
  w.u64(BigInt(g.atMs));
  if (version === DONATION_GIFT_VERSION_ORIGIN) w.str(origin);
  return w.finish();
}

export function decodeDonationGift(bytes) {
  const r = new Reader(bytes);
  if (r.u8() !== TYPE_DONATION_GIFT) throw new Error('not a donation gift');
  const v = r.u16(); if (v !== DONATION_GIFT_VERSION && v !== DONATION_GIFT_VERSION_ORIGIN) throw new Error(`a donation gift of version ${v}`);
  const g = { target: r.u8(), gameDevPubkey: r.bytes32(), gameName: r.str(), donor: r.bytes32(), federationId: r.bytes32(), txid: r.bytes32(), totalMsat: r.u64(),
    outputs: r.vec((rr) => ({ outIdx: rr.u32(), pk: rr.bytes(33), msat: rr.u64() })), atMs: r.u64() };
  if (v === DONATION_GIFT_VERSION_ORIGIN) g.origin = r.str();
  if (v === DONATION_GIFT_VERSION_ORIGIN && !g.origin && g.target !== GIFT_TO_BOTH) throw new Error('a version 2 gift names its origin');
  if (r.at !== bytes.length) throw new Error('trailing bytes after the donation gift');
  encodeDonationGift(g);                       // the same rules on the way in
  return g;
}

export const donationGiftId = (g) => taggedHash(TAG_DONATION_GIFT, encodeDonationGift(g));

/**
 * The outputs a gift of `totalMsat` must pay over a set of keys, in the set's order: [{ pk, msat }], none of 0 msat. A gift to both sets
 * (`networkSet` and `gameSet`) pays half over each, a key in both once (splitTwoSets, as a round's donation).
 */
export function giftOutputs({ totalMsat, recipients, networkSet = null, gameSet = null }) {
  const split = networkSet && gameSet ? splitTwoSets({ donationMsat: totalMsat, networkSet, gameSet }) : splitDonation({ donationMsat: totalMsat, recipients });
  if (!split.owed) throw new Error(`the gift cannot be split over this set: ${split.why}`);
  const out = [];
  for (const s of split.shares) {
    if (s.amountMsat <= 0n) continue;
    if (!(s.recipientPk instanceof Uint8Array)) throw new Error('a gift is paid in the federation: the set must pay keys, not LNURLs');
    out.push({ pk: s.recipientPk, msat: s.amountMsat });
  }
  return out;
}

/**
 * WHETHER A GIFT STANDS against the set a seat holds for its target (`recipients`): the donor's signature, and its outputs exactly
 * the split of its total over that set - the same keys, the same amounts, in the set's order, output index i the i-th. Answers
 * { ok, id } or { ok: false, why }. The federation's own check of each output is the seat's (it reaches the federation).
 */
export function giftStands(g, { recipients, networkSet = null, gameSet = null, verify, nowMs = Date.now() }) {
  let id;
  try { id = donationGiftId(g); } catch (e) { return { ok: false, why: e.message }; }
  if (Number(g.atMs) > nowMs + GIFT_SKEW_MS) return { ok: false, why: 'that gift is dated ahead of this seat\'s clock' };
  let good = false; try { good = verify(g.signature, id, g.donor) === true; } catch { good = false; }
  if (!good) return { ok: false, why: 'the donor\'s signature does not verify' };
  let want;
  if (g.target === GIFT_TO_BOTH && !(networkSet && gameSet)) return { ok: false, why: 'a gift to both sets is checked against both' };
  try { want = g.target === GIFT_TO_BOTH ? giftOutputs({ totalMsat: g.totalMsat, networkSet, gameSet }) : giftOutputs({ totalMsat: g.totalMsat, recipients }); } catch (e) { return { ok: false, why: e.message }; }
  const got = [...g.outputs].sort((a, b) => a.outIdx - b.outIdx);
  if (got.length !== want.length) return { ok: false, why: `the gift pays ${got.length} output(s), and its total split over the set is ${want.length}` };
  for (let i = 0; i < want.length; i++) {
    if (got[i].outIdx !== i) return { ok: false, why: `output ${i} is missing: a gift's outputs are its transaction's 0..${want.length - 1}` };
    if (toHex(got[i].pk) !== toHex(want[i].pk) || got[i].msat !== want[i].msat)
      return { ok: false, why: `output ${i} pays ${got[i].msat} msat to ${toHex(got[i].pk).slice(0, 16)}…, and the set's share is ${want[i].msat} msat to ${toHex(want[i].pk).slice(0, 16)}…` };
  }
  return { ok: true, id };
}
