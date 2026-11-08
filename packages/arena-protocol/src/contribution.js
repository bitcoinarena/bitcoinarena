// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// CONTRIBUTION AGREEMENTS: A SHARE EARNED BY RESULTS THE CHAIN CAN READ (spec §27A.4.2, RULED 2026-11-08, kanban #1346).
//
// A person who markets the Arena is paid from the protocol developers' donation set, and the whole agreement lives in the node: every
// target, percentage and date is a record, and his share is what the chain says he has earned. This module is pure: the records (their
// bytes, ids and digests) and the reader that turns facts every seat holds into his vested share_bps at a height.
//
//   ContributionAgreement   an entry of a donation set (§27A.4.1), signed by the contributor's own recipient key too
//   ContributionLeave       his key: the unvested part lapses, the vested part pays for tail_blocks, then ends
//   ContributionTermination the cold admin key, with a cause: the unvested part lapses and the vested part ends at once
//
// THE FACTS (`contributionFacts`): one row per paid entry of a round that COUNTS (kanban #1218) - { height (the round's census height),
// identity (hex, kanban #1276's proof), frontendPk (hex or null), grossMsat }. Rounds a seat cannot check are not facts, for him as for
// the leaderboard. Two seats holding the same facts answer the same share at every height.
import { Writer, Reader } from './encode.js';
import { taggedHash, toHex } from './hash.js';
import { PROTOCOL_VERSION, speaksVersion, TYPE_CONTRIBUTION_AGREEMENT, TYPE_CONTRIBUTION_LEAVE, TYPE_CONTRIBUTION_TERMINATION, TAG } from './constants.js';
// donation.js reads this module (a set entry carries an agreement), so its constants are restated here rather than imported: the same values
const CONTRIB_KEY_BYTES = 33, CONTRIB_BPS_TOTAL = 10000, CONTRIB_DAY_BLOCKS = 144;
const isContribRecipientKey = (b) => b instanceof Uint8Array && b.length === CONTRIB_KEY_BYTES && (b[0] === 0x02 || b[0] === 0x03);

/** The four milestones, in the agreement's tranche order (§27A.4.2's table). */
export const MILESTONES = Object.freeze(['first-paid', 'retention', 'gross-share', 'new-share']);
/** T2: a T1 identity counts once it has a paid entry this many blocks (4 weeks) after its first. */
export const RETENTION_BLOCKS = 4032;
/** T1 and T2's counts, T3's gross share and T4's new-identity share and run of windows (§27A.4.2). */
export const T1_IDENTITIES = 1000, T2_RETAINED = 300, T3_GROSS_BPS = 2000, T4_NEW_BPS = 3000, T4_WINDOWS = 6, T4_WINDOW_BLOCKS = 4320;
/**
 * THE MILESTONES' SCALE PER NETWORK (RULED 2026-11-08, kanban #1349, as LOCK_STALL_BLOCKS is per network): mainnet and testnet4 run §27A.4.2's
 * numbers; regtest and a devnet run the same rules at test scale - T1 3 identities, T2 2 of them back after 6 blocks, T3 20 % over a 12-block
 * window, T4 30 % in 3 windows of 6 blocks, and a read lag of 6 blocks in place of 288. Not fields of the agreement: every agreement on a
 * network reads the same scale. `t3WindowBlocks` null: T3 reads the tranche's own window_blocks.
 */
const SPEC_SCALE = Object.freeze({ t1Identities: T1_IDENTITIES, t2Retained: T2_RETAINED, retentionBlocks: RETENTION_BLOCKS, t3GrossBps: T3_GROSS_BPS,
  t3WindowBlocks: null, t4NewBps: T4_NEW_BPS, t4Windows: T4_WINDOWS, t4WindowBlocks: T4_WINDOW_BLOCKS, lagBlocks: 288 });
const TEST_SCALE = Object.freeze({ t1Identities: 3, t2Retained: 2, retentionBlocks: 6, t3GrossBps: 2000, t3WindowBlocks: 12,
  t4NewBps: 3000, t4Windows: 3, t4WindowBlocks: 6, lagBlocks: 6 });
export const CONTRIBUTION_SCALE = Object.freeze({ mainnet: SPEC_SCALE, testnet4: SPEC_SCALE, regtest: TEST_SCALE, devnet: TEST_SCALE });
/** The scale a network reads (an unknown name reads mainnet's). */
export const contributionScaleOf = (network) => CONTRIBUTION_SCALE[network] || SPEC_SCALE;
/** The reference agreement (§27A.4.2): 2.5 % for time, 4 x 2.5 % for results, a 30 % attribution floor, a 12-month tail, three years to meet a tranche. */
export const REFERENCE_AGREEMENT = Object.freeze({
  base: Object.freeze({ targetBps: 250, cliffBlocks: 26280, days: 730 }),
  tranche: Object.freeze({ bps: 250, windowBlocks: 12960, expiresAfter: 157680 }),
  attributionFloorBps: 3000, tailBlocks: 52560,
});

// a site key is a website payout key, as an Entry Contract's frontend_pk (§22A): 33 bytes, compressed
const CONTRIB_SITE_KEY_BYTES = 33;
const isContribSiteKey = (b) => b instanceof Uint8Array && b.length === CONTRIB_SITE_KEY_BYTES && (b[0] === 2 || b[0] === 3);
const contribHexOf = (k) => (typeof k === 'string' ? k.toLowerCase() : toHex(k));
const isContribU32 = (n) => Number.isInteger(n) && n >= 0 && n <= 0xffffffff;

/** Is this agreement well formed? { ok } or { ok: false, why }. */
export function agreementStands(a) {
  if (!a || !isContribRecipientKey(a.recipientPk)) return { ok: false, why: 'an agreement names the contributor\'s recipient key (33 bytes)' };
  if (!Array.isArray(a.siteKeys) || !a.siteKeys.length || a.siteKeys.length > 256 || !a.siteKeys.every(isContribSiteKey))
    return { ok: false, why: 'an agreement names 1 to 256 site keys, 33-byte compressed keys each' };
  if (new Set(a.siteKeys.map(toHex)).size !== a.siteKeys.length) return { ok: false, why: 'a site key is named twice' };
  if (!isContribU32(a.startHeight)) return { ok: false, why: 'start_height is a block height' };
  const b = a.base || {};
  if (!Number.isInteger(b.targetBps) || b.targetBps < 0 || !isContribU32(b.cliffBlocks) || !Number.isInteger(b.days) || b.days < 1 || b.days > 0xffff)
    return { ok: false, why: 'the base is { target_bps, cliff_blocks, days >= 1 }' };
  if (!Array.isArray(a.tranches) || a.tranches.length !== MILESTONES.length) return { ok: false, why: `an agreement has ${MILESTONES.length} tranches, one per milestone` };
  for (const [i, t] of a.tranches.entries()) {
    if (t.milestone !== MILESTONES[i]) return { ok: false, why: `tranche ${i + 1} is the ${MILESTONES[i]} milestone` };
    if (!Number.isInteger(t.bps) || t.bps < 0 || !isContribU32(t.windowBlocks) || t.windowBlocks < 1 || !isContribU32(t.expiresHeight) || t.expiresHeight <= a.startHeight)
      return { ok: false, why: `tranche ${i + 1} is { bps, window_blocks >= 1, expires_height after start_height }` };
  }
  const total = b.targetBps + a.tranches.reduce((s, t) => s + t.bps, 0);
  if (total > CONTRIB_BPS_TOTAL) return { ok: false, why: `the agreement's base and tranches come to ${total} basis points, more than the whole set` };
  if (!Number.isInteger(a.attributionFloorBps) || a.attributionFloorBps < 0 || a.attributionFloorBps > CONTRIB_BPS_TOTAL) return { ok: false, why: 'the attribution floor is 0 to 10000 basis points' };
  if (!isContribU32(a.tailBlocks)) return { ok: false, why: 'tail_blocks is a block count' };
  return { ok: true, targetBps: total };
}

export function encodeContributionAgreement(a) {
  const s = agreementStands(a);
  if (!s.ok) throw new Error(s.why);
  const w = new Writer();
  w.u8(TYPE_CONTRIBUTION_AGREEMENT);
  w.u16(PROTOCOL_VERSION);
  w.bytes(a.recipientPk, CONTRIB_KEY_BYTES);
  // the site keys in byte order: one agreement, one encoding
  w.vec([...a.siteKeys].sort((x, y) => (toHex(x) < toHex(y) ? -1 : 1)), (k) => w.bytes(k, CONTRIB_SITE_KEY_BYTES));
  w.u32(a.startHeight);
  w.u16(a.base.targetBps); w.u32(a.base.cliffBlocks); w.u16(a.base.days);
  for (const t of a.tranches) { w.u16(t.bps); w.u8(MILESTONES.indexOf(t.milestone)); w.u32(t.windowBlocks); w.u32(t.expiresHeight); }
  w.u16(a.attributionFloorBps);
  w.u32(a.tailBlocks);
  return w.finish();
}

export function decodeContributionAgreement(bytes) {
  const r = new Reader(bytes);
  if (r.u8() !== TYPE_CONTRIBUTION_AGREEMENT) throw new Error('not a contribution agreement');
  if (!speaksVersion(r.u16())) throw new Error('unknown protocol version');
  const recipientPk = r.bytes(CONTRIB_KEY_BYTES);
  const siteKeys = r.vec(() => r.bytes(CONTRIB_SITE_KEY_BYTES));
  const startHeight = r.u32();
  const base = { targetBps: r.u16(), cliffBlocks: r.u32(), days: r.u16() };
  const tranches = MILESTONES.map(() => {
    const bps = r.u16(), m = r.u8();
    if (m >= MILESTONES.length) throw new Error('an unknown milestone');
    return { bps, milestone: MILESTONES[m], windowBlocks: r.u32(), expiresHeight: r.u32() };
  });
  const attributionFloorBps = r.u16();
  const tailBlocks = r.u32();
  if (r.at !== bytes.length) throw new Error('trailing bytes after the contribution agreement');
  const a = { recipientPk, siteKeys, startHeight, base, tranches, attributionFloorBps, tailBlocks };
  const s = agreementStands(a);
  if (!s.ok) throw new Error(s.why);
  return a;
}

/** The agreement's id: what a leave and a termination name, and what the contributor signs. */
export const contributionAgreementId = (a) => taggedHash(TAG.contributionAgreement, encodeContributionAgreement(a));

/** ContributionLeave { agreement_id, at_height }, signed by the contributor's recipient key. */
export function encodeContributionLeave(l) {
  if (!(l.agreementId instanceof Uint8Array) || l.agreementId.length !== 32 || !isContribU32(l.atHeight)) throw new Error('a leave names an agreement and a height');
  const w = new Writer();
  w.u8(TYPE_CONTRIBUTION_LEAVE); w.u16(PROTOCOL_VERSION); w.bytes32(l.agreementId); w.u32(l.atHeight);
  return w.finish();
}
export function decodeContributionLeave(bytes) {
  const r = new Reader(bytes);
  if (r.u8() !== TYPE_CONTRIBUTION_LEAVE) throw new Error('not a contribution leave');
  if (!speaksVersion(r.u16())) throw new Error('unknown protocol version');
  const out = { agreementId: r.bytes32(), atHeight: r.u32() };
  if (r.at !== bytes.length) throw new Error('trailing bytes after the contribution leave');
  return out;
}
export const contributionLeaveDigest = (l) => taggedHash(TAG.contributionLeave, encodeContributionLeave(l));

/** ContributionTermination { agreement_id, at_height, cause }, signed by the cold admin key. The node records who signed what; the cause is the law's. */
export function encodeContributionTermination(t) {
  if (!(t.agreementId instanceof Uint8Array) || t.agreementId.length !== 32 || !isContribU32(t.atHeight)) throw new Error('a termination names an agreement and a height');
  if (typeof t.cause !== 'string' || !t.cause.trim() || t.cause.length > 500) throw new Error('a termination states its cause, at most 500 characters');
  const w = new Writer();
  w.u8(TYPE_CONTRIBUTION_TERMINATION); w.u16(PROTOCOL_VERSION); w.bytes32(t.agreementId); w.u32(t.atHeight); w.str(t.cause);
  return w.finish();
}
export function decodeContributionTermination(bytes) {
  const r = new Reader(bytes);
  if (r.u8() !== TYPE_CONTRIBUTION_TERMINATION) throw new Error('not a contribution termination');
  if (!speaksVersion(r.u16())) throw new Error('unknown protocol version');
  const out = { agreementId: r.bytes32(), atHeight: r.u32(), cause: r.str() };
  if (r.at !== bytes.length) throw new Error('trailing bytes after the contribution termination');
  return out;
}
export const contributionTerminationDigest = (t) => taggedHash(TAG.contributionTermination, encodeContributionTermination(t));

// ---------------------------------------------------------------------------------------------------------------- the reader

/**
 * THE FACTS, READ ONCE: each identity's first paid entry on the network (its height and whether it carried one of `siteKeys`), and its
 * later entries' heights; the gross per height, all and his. `facts` [{ height, identity, frontendPk, grossMsat }], any order.
 */
export function contributionFacts(facts, siteKeys) {
  const mine = new Set((siteKeys || []).map(contribHexOf));
  const rows = [...(facts || [])].map((f) => ({ height: Number(f.height), identity: contribHexOf(f.identity), mineEntry: !!f.frontendPk && mine.has(contribHexOf(f.frontendPk)), grossMsat: BigInt(f.grossMsat || 0) }))
    .sort((a, b) => (a.height - b.height) || (a.identity < b.identity ? -1 : a.identity > b.identity ? 1 : 0));
  const first = new Map();   // identity -> { height, mine }
  const later = new Map();   // identity -> heights after the first, ascending
  for (const r of rows) {
    if (!first.has(r.identity)) { first.set(r.identity, { height: r.height, mine: r.mineEntry }); continue; }
    if (!later.has(r.identity)) later.set(r.identity, []);
    later.get(r.identity).push(r.height);
  }
  // new identities by their first height, ascending: [{ height, mine }]
  const news = [...first.values()].sort((a, b) => a.height - b.height);
  return { rows, first, later, news };
}

const contribCountIn = (sorted, lo, hi) => {   // how many of `sorted` (ascending numbers) lie in [lo, hi]
  const lower = (x) => { let a = 0, b = sorted.length; while (a < b) { const m = (a + b) >> 1; if (sorted[m] < x) a = m + 1; else b = m; } return a; };
  return Math.max(0, lower(hi + 1) - lower(lo));
};

/** THE ATTRIBUTION FLOOR at height `h` over `windowBlocks`: his share of the new identities whose first paid entry lies in (h - window, h]. */
function contribFloorHolds(F, a, h, windowBlocks) {
  const lo = Math.max(a.startHeight, h - windowBlocks + 1);
  const all = contribCountIn(F.newHeights, lo, h), his = contribCountIn(F.myNewHeights, lo, h);
  return all > 0 && his * CONTRIB_BPS_TOTAL >= all * a.attributionFloorBps;
}

/**
 * THE FIRST HEIGHT A TRANCHE'S MILESTONE IS MET, or null - before the attribution floor. T1 and T2 stay met once met; T3 and T4 are read
 * on windows aligned to start_height and are met at a window's last block.
 */
function contribMilestoneHeight(F, a, t, network, main = network === 'mainnet') {
  const S = contributionScaleOf(network);
  const myFirsts = F.myNewHeights;   // first paid entries carrying his keys, since start, ascending
  if (t.milestone === 'first-paid') return myFirsts.length >= S.t1Identities ? myFirsts[S.t1Identities - 1] : null;
  if (t.milestone === 'retention') {
    const back = [];
    for (const [id, f] of F.first) {
      if (!f.mine || f.height < a.startHeight) continue;
      const again = (F.later.get(id) || []).find((h) => h >= f.height + S.retentionBlocks);
      if (again !== undefined) back.push(again);
    }
    back.sort((x, y) => x - y);
    return back.length >= S.t2Retained ? back[S.t2Retained - 1] : null;
  }
  if (t.milestone === 'gross-share') {
    // T3 is mainnet's; a devnet tests it with the `main` flag set (kanban #1349)
    if (!main) return null;
    const W = S.t3WindowBlocks || t.windowBlocks, sums = new Map();
    for (const r of F.rows) {
      if (r.height < a.startHeight) continue;
      const k = Math.floor((r.height - a.startHeight) / W);
      const s = sums.get(k) || { all: 0n, his: 0n };
      s.all += r.grossMsat; if (r.mineEntry) s.his += r.grossMsat;
      sums.set(k, s);
    }
    for (const k of [...sums.keys()].sort((x, y) => x - y)) {
      const s = sums.get(k);
      if (s.all > 0n && s.his * BigInt(CONTRIB_BPS_TOTAL) >= s.all * BigInt(S.t3GrossBps)) return a.startHeight + (k + 1) * W - 1;
    }
    return null;
  }
  if (t.milestone === 'new-share') {
    const W = S.t4WindowBlocks, per = new Map();
    for (const n of F.news) {
      if (n.height < a.startHeight) continue;
      const k = Math.floor((n.height - a.startHeight) / W);
      const s = per.get(k) || { all: 0, his: 0 };
      s.all += 1; if (n.mine) s.his += 1;
      per.set(k, s);
    }
    const last = per.size ? Math.max(...per.keys()) : -1;
    let run = 0;
    for (let k = 0; k <= last; k++) {
      const s = per.get(k);
      run = s && s.his * CONTRIB_BPS_TOTAL >= s.all * S.t4NewBps ? run + 1 : 0;
      if (run >= S.t4Windows) return a.startHeight + (k + 1) * W - 1;
    }
    return null;
  }
  return null;
}

/**
 * WHEN A TRANCHE VESTS: the first height >= its milestone's at which the attribution floor holds over the tranche's window - a height
 * where a new identity enters the window or one leaves it - and never after its expiry, his leave or his termination. Answers the height or null.
 */
function contribTrancheVestsAt(F, a, t, { network, until, main }) {
  const m = contribMilestoneHeight(F, a, t, network, main);
  if (m === null) return null;
  const end = Math.min(t.expiresHeight, until);
  if (m > end) return null;
  const candidates = new Set([m]);
  for (const h of F.newHeights) { if (h > m && h <= end) candidates.add(h); if (h + t.windowBlocks > m && h + t.windowBlocks <= end) candidates.add(h + t.windowBlocks); }
  for (const h of [...candidates].sort((x, y) => x - y)) if (contribFloorHolds(F, a, h, t.windowBlocks)) return h;
  return null;
}

/** THE BASE AT A HEIGHT (§27A.4.2): nothing before start + cliff; at the cliff the days that passed vest at once, then target / days a day. */
export function baseVestedBps(a, height) {
  const { targetBps, cliffBlocks, days } = a.base;
  if (height < a.startHeight + cliffBlocks) return 0;
  const elapsed = Math.min(days, Math.floor((height - a.startHeight) / CONTRIB_DAY_BLOCKS));
  return Math.trunc((targetBps * elapsed) / days);
}

/**
 * HIS VESTED share_bps AT `height`: the base and every tranche vested by then, read from `facts` (see above). `network` ('mainnet' |
 * 'testnet4' | 'regtest' ...: T3 is mainnet's only); `leftAt` the height of his ContributionLeave, `terminatedAt` the admin key's
 * termination (null: none). Answers { shareBps, vestedBps, baseBps, tranches: [{ milestone, bps, metAt, vestedAt }], state }.
 *   leave        the unvested part lapses at leftAt; what was vested then pays until leftAt + tail_blocks, then 0
 *   termination  the unvested part lapses and the vested part ends at terminatedAt
 */
export function contributionShare(a, { facts = [], height, network, main = network === 'mainnet', leftAt = null, terminatedAt = null } = {}) {
  const h = Number(height);
  const stops = [leftAt, terminatedAt].filter((x) => x !== null && x !== undefined).map(Number);
  const until = stops.length ? Math.min(...stops) : Infinity;
  const base = contributionFacts(facts, a.siteKeys);
  const F = { ...base,
    newHeights: base.news.filter((n) => n.height >= a.startHeight).map((n) => n.height),
    myNewHeights: base.news.filter((n) => n.mine && n.height >= a.startHeight).map((n) => n.height) };
  const at = Math.min(h, until);
  const tranches = a.tranches.map((t) => {
    const metAt = contribMilestoneHeight(F, a, t, network, main);
    const vestedAt = contribTrancheVestsAt(F, a, t, { network, until, main });
    return { milestone: t.milestone, bps: t.bps, metAt, vestedAt, vested: vestedAt !== null && vestedAt <= at };
  });
  const baseBps = baseVestedBps(a, at);
  const vestedBps = baseBps + tranches.reduce((s, t) => s + (t.vested ? t.bps : 0), 0);
  let shareBps = vestedBps, state = 'active';
  if (terminatedAt !== null && terminatedAt !== undefined && h >= Number(terminatedAt)) { shareBps = 0; state = 'terminated'; }
  else if (leftAt !== null && leftAt !== undefined && h >= Number(leftAt)) {
    state = h < Number(leftAt) + a.tailBlocks ? 'tail' : 'ended';
    if (state === 'ended') shareBps = 0;
  }
  return { shareBps, vestedBps, baseBps, tranches, state };
}

/**
 * THE SET'S SHARES WITH ITS AGREEMENTS (§27A.4.2 "the payout"): an entry carrying a `contribution` agreement pays its vested share at the
 * height (`shareOf(entry)` -> share_bps, the caller's contributionShare over its facts); what it has not vested goes to the other entries in
 * their own proportions, as §27A.4.1's vesting does; the rest of a basis point to the first other entry as published. A set without
 * agreements is answered as it is.
 */
export function contributionShares(recipients, shareOf) {
  if (!Array.isArray(recipients) || !recipients.some((r) => r && r.contribution)) return recipients;
  const theirs = recipients.map((r) => (r.contribution ? Math.max(0, Math.min(CONTRIB_BPS_TOTAL, Number(shareOf(r)) || 0)) : null));
  const taken = theirs.reduce((t, x) => t + (x === null ? 0 : x), 0);
  const othersBase = recipients.reduce((t, r) => t + (r.contribution ? 0 : r.shareBps), 0);
  const rest = Math.max(0, CONTRIB_BPS_TOTAL - taken);
  const out = recipients.map((r, i) => ({ recipientPk: r.recipientPk, label: r.label,
    shareBps: r.contribution ? theirs[i] : (othersBase > 0 ? Math.floor((r.shareBps * rest) / othersBase) : 0) }));
  const short = CONTRIB_BPS_TOTAL - out.reduce((t, x) => t + x.shareBps, 0);
  const first = recipients.findIndex((r) => !r.contribution);
  if (short && first >= 0) out[first].shareBps += short;
  return out;
}

/**
 * THE FACTS FROM THE ROUNDS THAT COUNT (kanban #1218 / #1153: mergeSignedSeasonAccounts' rounds, accounts carrying round keys and the
 * entries' frontend keys): one fact per paid entry booked to a proven identity (kanban #1276: `player` is an identity, not the bare round
 * key it joined under), at its round's census height (`heightOf(roundIdHex)` -> the contract's census_height, or null when the caller
 * cannot read it). A void round, a bot's entry and a free entry are no facts.
 */
export function factsFromSeasonRounds(rounds, heightOf) {
  const out = [];
  for (const r of rounds || []) {
    if (!r || r.void) continue;
    const h = heightOf(String(r.roundId).toLowerCase());
    if (!Number.isInteger(h)) continue;
    for (const e of r.entries || []) {
      if (!e || e.bot === true || !(BigInt(e.stakeMsat || 0n) > 0n)) continue;
      if (!e.roundKey || String(e.player).toLowerCase() === String(e.roundKey).toLowerCase()) continue;
      out.push({ height: h, identity: String(e.player).toLowerCase(), frontendPk: e.frontendPk || null, grossMsat: BigInt(e.stakeMsat) });
    }
  }
  return out;
}

/**
 * THE SET'S SHARES AT A HEIGHT, VESTING AND AGREEMENTS TOGETHER (§27A.4.1 and §27A.4.2): a vesting entry at its day's step towards its target;
 * an entry carrying a `contribution` at `shareOf(entry)` (its vested share_bps, as the seats agree it for this height); every other entry
 * its share scaled into what those leave, floored, the rest of a basis point to the first of them as published. Answers a plain set.
 */
export function setSharesAt(recipients, height, shareOf = () => 0) {
  if (!Array.isArray(recipients) || !recipients.some((r) => r && (r.vesting || r.contribution))) return recipients;
  const h = Number(height) || 0;
  const now = recipients.map((r) => {
    if (r.contribution) return Math.max(0, Math.min(CONTRIB_BPS_TOTAL, Number(shareOf(r)) || 0));
    if (!r.vesting) return null;
    const { targetBps, startHeight, days } = r.vesting;
    const elapsed = h < startHeight ? 0 : Math.min(days, Math.floor((h - startHeight) / CONTRIB_DAY_BLOCKS));
    return r.shareBps + Math.trunc(((targetBps - r.shareBps) * elapsed) / days);
  });
  const fixed = now.reduce((t, x) => t + (x === null ? 0 : x), 0);
  const othersBase = recipients.reduce((t, r, i) => t + (now[i] === null ? r.shareBps : 0), 0);
  const rest = Math.max(0, CONTRIB_BPS_TOTAL - fixed);
  const out = recipients.map((r, i) => ({ recipientPk: r.recipientPk, label: r.label,
    shareBps: now[i] !== null ? now[i] : (othersBase > 0 ? Math.floor((r.shareBps * rest) / othersBase) : 0) }));
  const short = CONTRIB_BPS_TOTAL - out.reduce((t, x) => t + x.shareBps, 0);
  const first = now.findIndex((x) => x === null);
  if (short > 0 && first >= 0) out[first].shareBps += short;
  return out;
}
