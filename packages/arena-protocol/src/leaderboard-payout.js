// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A LEADERBOARD PAYOUT REQUEST (2026-10-17: "new proposal type, not a withdrawal but re-assign to the federation when
// a specific protocol version is active ... Example: distribution of X sats for the best 10 p&l of last week ... Which game/market/all
// global and the top count. Amount is divided equally or configurable. Time period is last 7 days, last 14 days, last month. Payment
// date is another field ... Same protections apply as it only returns it to the federation and pays out top users ... Voting is 2 weeks,
// no signal period. This is a leaderboard payout request not a pip"; "25% but with weight"; 2026-10-18: "YES >= 25 % of the voting
// weight is enough on its own. Do not also require more YES than NO").
//
//     LeaderboardPayout { network_id, author, published_height, scope, game_name, top, amount_sats, federation_id, split_bps[],
//                         period_days, payment_height, purpose }      signed by its author, anyone; protocol version 12 (2026.0.12)
//
// THE VOTE: the funding proposals' bond-weighted count (funding.js fundingTally over voteWeights), from its publication for 2 weeks -
// no signal period. THE ONLY PASS TEST: YES weight >= 25 % of the voting weight (everyone who could vote). A larger NO does not block
// it; ABSTAIN is not YES; there is no second majority test.
//
// THE PAYOUT, at the payment height: the network season of its scope over [payment time - period, payment time) - the top N by P&L,
// identities only (a player whose entries name a round key that is the player itself is no identity, badges.js's rule: skipped, the
// next one moves up); a tie at the cut shares the places it spans; each winner paid a payout contract to its identity's refund key in
// the federation, from that federation's protocol reserves - at most 10 % of them (funding.js FUNDING_CAP_PCT).
import { Writer, Reader } from './encode.js';
import { taggedHash, toHex } from './hash.js';
import { TYPE_LEADERBOARD_PAYOUT, TAG, LEADERBOARD_VERSION, speaksVersion } from './constants.js';
import { FUNDING_SCHEDULES } from './funding.js';

export const LB_SCOPE = Object.freeze({ ALL: 0, GAME: 1, MARKET: 2 });
export const LB_PERIOD_DAYS = Object.freeze([7, 14, 30]);
export const LB_TOP_MAX = 100;
export const LB_PASS_PCT = 25n;
export const LB_PURPOSE_MAX = 4000;
const lb32 = (b) => b instanceof Uint8Array && b.length === 32;

export function encodeLeaderboardPayout(p) {
  if (!lb32(p.networkId) || !lb32(p.author) || !lb32(p.federationId)) throw new Error('a leaderboard payout names its network, its author and the paying federation by 32 bytes each');
  if (!Number.isInteger(p.publishedHeight) || p.publishedHeight < 0) throw new Error('published_height is a block height');
  if (!Object.values(LB_SCOPE).includes(p.scope)) throw new Error('a leaderboard payout is of all games (0), one game (1) or one market (2)');
  const name = String(p.gameName || '');
  if ((p.scope === LB_SCOPE.ALL) !== (name === '')) throw new Error('a payout of one game or market names it; one of all names none');
  if (name.length > 64) throw new Error('a game\'s name is at most 64 characters');
  if (!Number.isInteger(p.top) || p.top < 1 || p.top > LB_TOP_MAX) throw new Error(`a leaderboard payout pays the top 1 to ${LB_TOP_MAX}`);
  if (typeof p.amountSats !== 'bigint' || p.amountSats < 1n) throw new Error('a leaderboard payout pays at least 1 sat, as a BigInt');
  const split = p.splitBps || [];
  if (split.length && (split.length !== p.top || split.some((b) => !Number.isInteger(b) || b < 1) || split.reduce((t, b) => t + b, 0) !== 10000))
    throw new Error('a split names every place, each at least 1 bps, 10000 bps in all (none: equal)');
  if (!LB_PERIOD_DAYS.includes(p.periodDays)) throw new Error(`a period is ${LB_PERIOD_DAYS.join(', ')} days`);
  if (!Number.isInteger(p.paymentHeight) || p.paymentHeight <= p.publishedHeight) throw new Error('a payment height after its publication');
  if (typeof p.purpose !== 'string' || p.purpose.length > LB_PURPOSE_MAX) throw new Error(`a leaderboard payout says why in at most ${LB_PURPOSE_MAX} characters`);
  const w = new Writer();
  w.u8(TYPE_LEADERBOARD_PAYOUT); w.u16(LEADERBOARD_VERSION);
  w.bytes32(p.networkId); w.bytes32(p.author); w.u32(p.publishedHeight); w.u8(p.scope); w.str(name); w.u8(p.top); w.u64(p.amountSats);
  w.bytes32(p.federationId); w.vec(split, (b, ww) => ww.u16(b)); w.u8(p.periodDays); w.u32(p.paymentHeight); w.str(p.purpose);
  return w.finish();
}
export function decodeLeaderboardPayout(bytes) {
  const r = new Reader(bytes);
  if (r.u8() !== TYPE_LEADERBOARD_PAYOUT) throw new Error('not a leaderboard payout');
  const v = r.u16();
  if (!speaksVersion(v) || v < LEADERBOARD_VERSION) throw new Error(`a leaderboard payout is of protocol ${LEADERBOARD_VERSION} or later, not ${v}`);
  const p = { networkId: r.bytes32(), author: r.bytes32(), publishedHeight: r.u32(), scope: r.u8(), gameName: r.str(), top: r.u8(), amountSats: r.u64(),
    federationId: r.bytes32(), splitBps: r.vec((rr) => rr.u16()), periodDays: r.u8(), paymentHeight: r.u32(), purpose: r.str() };
  if (r.at !== bytes.length) throw new Error('trailing bytes after the leaderboard payout');
  encodeLeaderboardPayout(p);
  return p;
}
export const leaderboardPayoutId = (p) => taggedHash(TAG.leaderboardPayout, encodeLeaderboardPayout(p));

/**
 * ITS VOTE: no signal period - from its publication, `vote` blocks (2 weeks), decided when its last block is `decideDepth` deep.
 * Answers { from, until, last, decidableAt }.
 */
export function leaderboardVotePeriod({ proposal, schedule = FUNDING_SCHEDULES.spec }) {
  const from = proposal.publishedHeight, until = from + schedule.vote;
  return { from, until, last: until - 1, decidableAt: until - 1 + schedule.decideDepth - 1 };
}

/**
 * THE ONLY PASS TEST (2026-10-18): YES weight >= 25 % of the voting weight. `count` funding.js fundingTally's answer over the
 * voting census (voteWeights): `yesSats` the YES weight, `totalSats` the weight of everyone who could vote. A larger NO, ABSTAIN, the
 * share of YES among YES + NO: none of them moves it. Answers the count with `passed` and `yesOfAllPct` as this rule reads them.
 */
export function leaderboardPasses(count) {
  const yes = BigInt(count.yesSats), total = BigInt(count.totalSats);
  const passed = total > 0n && yes * 100n >= LB_PASS_PCT * total;
  return { ...count, passed, rule: `YES >= ${LB_PASS_PCT} % of the voting weight`, yesOfAllPct: total > 0n ? Number((yes * 10000n) / total) / 100 : 0 };
}

/** Each place's amount in msat: equal (the floors' remainder to the first), or by the split's bps (the remainder to the first). */
export function placeAmounts({ amountMsat, top, splitBps = [] }) {
  const total = BigInt(amountMsat);
  const out = splitBps.length ? splitBps.map((b) => (total * BigInt(b)) / 10000n) : Array.from({ length: top }, () => total / BigInt(top));
  out[0] += total - out.reduce((t, x) => t + x, 0n);
  return out;
}

export const leaderboardHex = (p) => toHex(leaderboardPayoutId(p));
