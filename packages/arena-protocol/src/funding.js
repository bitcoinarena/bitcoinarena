// PROJECT FUNDING PROPOSALS AND THEIR SIGNAL (§27A.9.3 stage 1, kanban #397 slice 6, the owner 2026-10-16: "a signed proposal names
// purpose, amount, LNURL and a bonded author" - since 2026-10-17 any author: "Anyone can do a proposal to pay out". Seats keep and pass on proposals, signed comments and node signals. The signal passes at
// 15 % or more of the nodes that served a round in the last 432 blocks, after 1008 blocks"; signals are "signed messages kept and
// passed on by the seats. Not on-chain signals. A signal weighs one per node and moves no money").
//
//     FundingProposal { network_id, author, published_height, amount_sats, lnurl, purpose }     signed by the author, anyone (the owner 2026-10-17)
//     FundingComment  { proposal_id, parent_id, author, at_height, text }                       signed by its writer, anyone
//     FundingSignal   { proposal_id, node, at_height }                                          signed by the node
//
// Signatures are BIP340 over the object's id (its tagged hash), by the 32-byte x-only key it names; the verifier is injected.
//
// THE SIGNAL (signalOutcome): the signal runs [published_height, published_height + signal) - 1008 blocks by the rule, 1 on the short
// schedule of a live proof. When it ends, the ACTIVE nodes are those that served a round - a signed FINAL (served-nodes.js) - in the
// 432 blocks before its end: the window [time(end - 432), time(end)) on the chain's median time, which every seat reads alike and
// which never runs backwards. A signal counts when it was given inside the signal period by an active node, once per node, whatever
// its bond; the proposal passes when those nodes are at least 15 % of the active ones. Nothing is paid on a signal.
import { Writer, Reader } from './encode.js';
import { taggedHash, toHex } from './hash.js';
import { PROTOCOL_VERSION, speaksVersion, TYPE_FUNDING_PROPOSAL, TYPE_FUNDING_COMMENT, TYPE_FUNDING_SIGNAL, TAG } from './constants.js';
import { servedNodes } from './served-nodes.js';
import { decodeVote, voteMessage, CHOICE } from './ballot.js';

/** The blocks of a signal, and the window that makes a node active (§27A.9.3). The short schedule is a live proof's only. */
// THE HIJACK DEFENCES (§27A.9.5, kanban #397, the owner 2026-10-17: "Take D1-D6 as proposed"), in blocks:
//   season          D1  a bond votes (and a node signals) only if it confirmed this long before the proposal was published (~6 months)
//   lockAfterVote   D2  ... and only if its CLTV maturity is at least this far past the vote's last block (~3 months)
//   fullLock            its weight is bond x min(1, maturity - last / fullLock) - full weight at a year's lock
//   delay, trancheEvery D5  the first payment is due `delay` after the vote's last block (~2 weeks), the next ones `trancheEvery` apart
//   capWindow       D3  the window of the 25 % cap (~90 days)
//   week            D6  a node is active when it served rounds in 3 of the 4 weeks before the signal ends
// The short schedule is a live proof's only (the T3 federation), scaled to its few blocks.
export const FUNDING_SCHEDULES = Object.freeze({
  spec: Object.freeze({ signal: 1008, activeWindow: 432, vote: 2016, decideDepth: 6,
    season: 26208, lockAfterVote: 12960, fullLock: 52560, delay: 2016, trancheEvery: 4320, capWindow: 12960, week: 1008 }),
  short: Object.freeze({ signal: 1, activeWindow: 432, vote: 6, decideDepth: 6,
    season: 24, lockAfterVote: 48, fullLock: 144, delay: 6, trancheEvery: 6, capWindow: 144, week: 108 }),
});
export const FUNDING_ABSOLUTE_PCT = 20n;        // D4: YES of all seasoned bonded capital
export const FUNDING_CAP_PCT = 10n;             // D3: one proposal of the paying federation's reserves
export const FUNDING_CAP_WINDOW_PCT = 25n;      // D3: all payments of a window of the reserves at its start
export const FUNDING_LARGE_PCT = 1n;            // D5: above this share of the reserves a payment goes out in tranches
export const FUNDING_TRANCHES = 4;
export const FUNDING_ACTIVE_WEEKS = 4, FUNDING_ACTIVE_WEEKS_NEEDED = 3;   // D6
/** The vote's rule (§27A.9.3 stage 2, RULED the owner 2026-10-16): turnout of the snapshot's bonded capital, and YES of YES + NO. */
export const FUNDING_TURNOUT_PCT = 30n;
export const FUNDING_APPROVAL_PCT = 60n;
export const FUNDING_SIGNAL_PCT = 15;
export const FUNDING_PURPOSE_MAX = 4000;
export const FUNDING_COMMENT_MAX = 4000;
export const FUNDING_LNURL_MAX = 512;
export const FUNDING_SIG_BYTES = 64;

const f32 = (b) => b instanceof Uint8Array && b.length === 32;
const ZERO32 = new Uint8Array(32);
/** An LNURL (bech32 "lnurl1...") or a Lightning address (user@host): where the amount would be paid. */
export function lnurlStands(s) {
  if (typeof s !== 'string' || !s.length || s.length > FUNDING_LNURL_MAX) return false;
  if (/^lnurl1[02-9ac-hj-np-z]{20,}$/i.test(s)) return true;
  return /^[a-z0-9._+-]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(s);
}

export function encodeFundingProposal(p) {
  if (!f32(p.networkId) || !f32(p.author)) throw new Error('a funding proposal names its network and its author by 32 bytes each');
  if (!Number.isInteger(p.publishedHeight) || p.publishedHeight < 0) throw new Error('published_height is a block height');
  if (typeof p.amountSats !== 'bigint' || p.amountSats < 1n) throw new Error('a funding proposal asks at least 1 sat, as a BigInt');
  if (!lnurlStands(p.lnurl)) throw new Error('a funding proposal names an LNURL or a Lightning address to be paid at');
  if (typeof p.purpose !== 'string' || !p.purpose.trim() || p.purpose.length > FUNDING_PURPOSE_MAX) throw new Error(`a funding proposal says what the money is for, in at most ${FUNDING_PURPOSE_MAX} characters`);
  const w = new Writer();
  w.u8(TYPE_FUNDING_PROPOSAL); w.u16(PROTOCOL_VERSION);
  w.bytes32(p.networkId); w.bytes32(p.author); w.u32(p.publishedHeight); w.u64(p.amountSats); w.str(p.lnurl); w.str(p.purpose);
  return w.finish();
}
export function decodeFundingProposal(bytes) {
  const r = new Reader(bytes);
  if (r.u8() !== TYPE_FUNDING_PROPOSAL) throw new Error('not a funding proposal');
  if (!speaksVersion(r.u16())) throw new Error('unknown protocol version');
  const p = { networkId: r.bytes32(), author: r.bytes32(), publishedHeight: r.u32(), amountSats: r.u64(), lnurl: r.str(), purpose: r.str() };
  if (r.at !== bytes.length) throw new Error('trailing bytes after the funding proposal');
  encodeFundingProposal(p);                       // the same rules on the way in
  return p;
}
export const fundingProposalId = (p) => taggedHash(TAG.fundingProposal, encodeFundingProposal(p));

export function encodeFundingComment(c) {
  if (!f32(c.proposalId) || !f32(c.author)) throw new Error('a comment names its proposal and its writer by 32 bytes each');
  const parent = c.parentId === undefined || c.parentId === null ? ZERO32 : c.parentId;
  if (!f32(parent)) throw new Error('a comment answers a 32-byte comment id, or none');
  if (!Number.isInteger(c.atHeight) || c.atHeight < 0) throw new Error('at_height is a block height');
  if (typeof c.text !== 'string' || !c.text.trim() || c.text.length > FUNDING_COMMENT_MAX) throw new Error(`a comment says something, in at most ${FUNDING_COMMENT_MAX} characters`);
  const w = new Writer();
  w.u8(TYPE_FUNDING_COMMENT); w.u16(PROTOCOL_VERSION);
  w.bytes32(c.proposalId); w.bytes32(parent); w.bytes32(c.author); w.u32(c.atHeight); w.str(c.text);
  return w.finish();
}
export function decodeFundingComment(bytes) {
  const r = new Reader(bytes);
  if (r.u8() !== TYPE_FUNDING_COMMENT) throw new Error('not a funding comment');
  if (!speaksVersion(r.u16())) throw new Error('unknown protocol version');
  const c = { proposalId: r.bytes32(), parentId: r.bytes32(), author: r.bytes32(), atHeight: r.u32(), text: r.str() };
  if (r.at !== bytes.length) throw new Error('trailing bytes after the comment');
  encodeFundingComment(c);
  return c;
}
export const fundingCommentId = (c) => taggedHash(TAG.fundingComment, encodeFundingComment(c));

export function encodeFundingSignal(s) {
  if (!f32(s.proposalId) || !f32(s.node)) throw new Error('a signal names its proposal and its node by 32 bytes each');
  if (!Number.isInteger(s.atHeight) || s.atHeight < 0) throw new Error('at_height is a block height');
  const w = new Writer();
  w.u8(TYPE_FUNDING_SIGNAL); w.u16(PROTOCOL_VERSION);
  w.bytes32(s.proposalId); w.bytes32(s.node); w.u32(s.atHeight);
  return w.finish();
}
export function decodeFundingSignal(bytes) {
  const r = new Reader(bytes);
  if (r.u8() !== TYPE_FUNDING_SIGNAL) throw new Error('not a funding signal');
  if (!speaksVersion(r.u16())) throw new Error('unknown protocol version');
  const s = { proposalId: r.bytes32(), node: r.bytes32(), atHeight: r.u32() };
  if (r.at !== bytes.length) throw new Error('trailing bytes after the signal');
  return s;
}
export const fundingSignalId = (s) => taggedHash(TAG.fundingSignal, encodeFundingSignal(s));

/** The object of a signed hex (body || 64-byte signature) of `kind` 'proposal' | 'comment' | 'signal', its id, and whether its signer signed it. */
export function readSignedFunding(kind, bytes, verify) {
  if (typeof verify !== 'function') throw new Error('a funding object is checked with a BIP340 verifier, and none was injected');
  if (!(bytes instanceof Uint8Array) || bytes.length <= FUNDING_SIG_BYTES) return { ok: false, why: 'no signature' };
  const body = bytes.slice(0, -FUNDING_SIG_BYTES), signature = bytes.slice(-FUNDING_SIG_BYTES);
  let obj, id, signer;
  try {
    if (kind === 'proposal') { obj = decodeFundingProposal(body); id = fundingProposalId(obj); signer = obj.author; }
    else if (kind === 'comment') { obj = decodeFundingComment(body); id = fundingCommentId(obj); signer = obj.author; }
    else if (kind === 'signal') { obj = decodeFundingSignal(body); id = fundingSignalId(obj); signer = obj.node; }
    else return { ok: false, why: 'a proposal, a comment or a signal' };
  } catch (e) { return { ok: false, why: `that is no funding ${kind}: ${e.message}` }; }
  let good = false; try { good = verify(signature, id, signer) === true; } catch { good = false; }
  if (!good) return { ok: false, why: `the ${kind}'s signature does not verify` };
  return { ok: true, kind, obj, id, signature };
}

/**
 * THE NODES ACTIVE BEFORE A SIGNAL ENDS: those that served a round (a signed FINAL) in [time(end - window), time(end)), `timeOf(height)`
 * the chain's median time in ms at that height. `rounds` as servedNodes takes them. Answers servedNodes' list with the window's heights.
 */
export function activeNodesBefore({ rounds, endHeight, timeOf, verify, windowBlocks = FUNDING_SCHEDULES.spec.activeWindow }) {
  if (!Number.isInteger(endHeight) || endHeight < windowBlocks) throw new Error('a signal ends at a height above the active window');
  const fromMs = BigInt(timeOf(endHeight - windowBlocks)), toMs = BigInt(timeOf(endHeight));
  return { ...servedNodes({ rounds, fromMs, toMs: toMs > fromMs ? toMs : fromMs + 1n, verify }), fromHeight: endHeight - windowBlocks, toHeight: endHeight };
}

/**
 * THE SIGNAL OF ONE PROPOSAL. `proposal` decoded; `signals` [{ node (hex), atHeight }] whose signatures were checked; `active` the
 * active nodes' keys (hex) at the signal's end, or null before it; `tip` this seat's height. Answers { state: 'signalling' |
 * 'passed' | 'failed', signalEnd, supporters, active, pct, needed } - `needed` the supporters 15 % of the active nodes asks.
 */
export function signalOutcome({ proposal, signals = [], active = null, tip, schedule = FUNDING_SCHEDULES.spec }) {
  const signalEnd = proposal.publishedHeight + schedule.signal;
  const inPeriod = signals.filter((s) => s.atHeight >= proposal.publishedHeight && s.atHeight < signalEnd);
  const signers = new Set(inPeriod.map((s) => String(s.node).toLowerCase()));
  if (!(Number.isInteger(tip) && tip >= signalEnd) || active === null)
    return { state: 'signalling', signalEnd, signals: signers.size, supporters: null, active: null, pct: null, needed: null };
  const act = new Set([...active].map((k) => String(k).toLowerCase()));
  const supporters = [...signers].filter((k) => act.has(k)).length;
  const needed = Math.ceil((act.size * FUNDING_SIGNAL_PCT) / 100);
  const passed = act.size > 0 && supporters * 100 >= FUNDING_SIGNAL_PCT * act.size;
  return { state: passed ? 'passed' : 'failed', signalEnd, signals: signers.size, supporters, active: act.size,
    pct: act.size ? Math.round((supporters * 10000) / act.size) / 100 : 0, needed: Math.max(needed, 1) };
}

/**
 * THE VOTE OF A PROPOSAL WHOSE SIGNAL PASSED (§27A.9.3 stage 2, kanban #397 slice 7): its period [signalEnd, signalEnd + vote) and
 * its last block; when a seat may decide it - that last block `decideDepth` deep, counting the block itself (as #329's tally:
 * decided at tip >= last + depth - 1). A failed or open signal has no vote.
 */
export function votePeriodOf({ proposal, signal, schedule = FUNDING_SCHEDULES.spec }) {
  if (!signal || signal.state !== 'passed') return null;
  const from = proposal.publishedHeight + schedule.signal;
  const until = from + schedule.vote;
  return { from, until, last: until - 1, decidableAt: until - 1 + schedule.decideDepth - 1 };
}

/**
 * THE COUNT (§27A.9.3 stage 2), #329's vote read for a funding proposal: `census` the bonds active at the vote's start -
 * [{ pubkey, outpoint, bondSats }]; `votes` the "ARN" 'V' outputs found on chain - [{ payload, height, txid }]. A vote counts for every
 * bond whose key its signature verifies under, only inside [from, until); per bond outpoint the last by height wins, a tie inside one
 * block going to the lower txid. ABSTAIN counts for turnout only. Passed: turnout >= 30 % of the bonded capital and YES >= 60 % of
 * YES + NO. Answers the weights in sat, the percentages, the bonds voted and `passed`.
 */
export function fundingTally({ proposalId, census = [], votes = [], from, until, verify, seasonedSats = null }) {
  const prefix = toHex(proposalId.subarray(0, 8));
  const latest = new Map();
  for (const v of votes) {
    const d = decodeVote(v.payload instanceof Uint8Array ? v.payload : null);
    if (!d || toHex(d.idPrefix) !== prefix) continue;
    if (!(v.height >= from && v.height < until)) continue;
    const msg = voteMessage(proposalId, d.choice);
    for (const b of census) {
      let good = false; try { good = verify(d.signature, msg, b.pubkey) === true; } catch { good = false; }
      if (!good) continue;
      const had = latest.get(b.outpoint);
      const later = !had || v.height > had.height || (v.height === had.height && String(v.txid) < String(had.txid));
      if (later) latest.set(b.outpoint, { choice: d.choice, height: v.height, txid: v.txid, weight: BigInt(b.weight ?? b.bondSats) });
    }
  }
  const total = census.reduce((a, b) => a + BigInt(b.weight ?? b.bondSats), 0n);
  let yes = 0n, no = 0n, abstain = 0n;
  for (const x of latest.values()) { if (x.choice === CHOICE.YES) yes += x.weight; else if (x.choice === CHOICE.NO) no += x.weight; else abstain += x.weight; }
  const turnout = yes + no + abstain;
  const quorum = total > 0n && turnout * 100n >= FUNDING_TURNOUT_PCT * total;
  const decided = yes + no;
  const approved = decided > 0n && yes * 100n >= FUNDING_APPROVAL_PCT * decided;
  // D4: YES also at least 20 % of all seasoned bonded capital (when the caller names it)
  const absolute = seasonedSats === null ? true : BigInt(seasonedSats) > 0n && yes * 100n >= FUNDING_ABSOLUTE_PCT * BigInt(seasonedSats);
  return { totalSats: String(total), yesSats: String(yes), noSats: String(no), abstainSats: String(abstain), bondsVoted: latest.size, quorum, approved, absolute,
    seasonedSats: seasonedSats === null ? null : String(seasonedSats), passed: quorum && approved && absolute, turnoutPct: total > 0n ? Number((turnout * 10000n) / total) / 100 : 0, approvalPct: decided > 0n ? Number((yes * 10000n) / decided) / 100 : 0 };
}

/**
 * D1 + D2: THE VOTE WEIGHT OF EACH BOND. `census` [{ pubkey, outpoint, bondSats, height (confirmation), maturity (CLTV height, or
 * null when the bond names none) }]; `publishedHeight` the proposal's; `last` the vote's last block. A bond is SEASONED when it
 * confirmed at least `season` blocks before publication (D1); it VOTES when it is seasoned and its maturity is at least
 * `lockAfterVote` past `last` (D2), with weight bondSats x min(fullLock, maturity - last) / fullLock. Answers the voting census (each
 * with its `weight`) and `seasonedSats`, the seasoned bonded capital whatever its lock (D4's base).
 */
export function voteWeights({ census = [], publishedHeight, last, schedule = FUNDING_SCHEDULES.spec }) {
  const voters = []; let seasonedSats = 0n;
  for (const b of census) {
    if (!(Number.isInteger(b.height) && b.height <= publishedHeight - schedule.season)) continue;
    seasonedSats += BigInt(b.bondSats);
    const left = Number.isInteger(b.maturity) ? b.maturity - last : -1;
    if (left < schedule.lockAfterVote) continue;
    voters.push({ ...b, weight: (BigInt(b.bondSats) * BigInt(Math.min(left, schedule.fullLock))) / BigInt(schedule.fullLock) });
  }
  return { voters, seasonedSats };
}

/** D6: the nodes ACTIVE for a signal: served rounds in at least 3 of the 4 weeks before its end, `weeks` [Set of node hex] newest first. */
export function activeInWeeks(weeks) {
  const n = new Map();
  for (const w of weeks.slice(0, FUNDING_ACTIVE_WEEKS)) for (const k of w) n.set(String(k).toLowerCase(), (n.get(String(k).toLowerCase()) || 0) + 1);
  return [...n.entries()].filter(([, c]) => c >= FUNDING_ACTIVE_WEEKS_NEEDED).map(([k]) => k);
}

/**
 * D5: THE PAYMENTS OF A PASSED PROPOSAL. One payment, or - above 1 % of the paying federation's reserves (`reservesSats`) - four
 * tranches; payment k is due at `last + delay + k x trancheEvery` and may be made once that block is `decideDepth` deep and a count
 * over every vote up to it still passes (a NO, or a YES turned NO, in the delay cancels it and every later one).
 */
export function trancheSchedule({ amountSats, reservesSats, last, schedule = FUNDING_SCHEDULES.spec }) {
  const amount = BigInt(amountSats);
  const n = BigInt(reservesSats) > 0n && amount * 100n > FUNDING_LARGE_PCT * BigInt(reservesSats) ? FUNDING_TRANCHES : 1;
  const each = amount / BigInt(n);
  return Array.from({ length: n }, (_, k) => {
    const dueAt = last + schedule.delay + k * schedule.trancheEvery;
    return { k, of: n, amountSats: k === n - 1 ? amount - each * BigInt(n - 1) : each, dueAt, payableAt: dueAt + schedule.decideDepth - 1 };
  });
}

/**
 * D3: MAY THIS PAYMENT GO NOW. One proposal at most 10 % of the paying federation's reserves (its whole amount, `proposalSats`,
 * against the reserves held now plus what it already paid); everything paid in the last `capWindow` blocks (`paidInWindowSats`) plus
 * this payment at most 25 % of what the reserves held at the window's start (held now + paid in the window). A payment over the
 * window cap waits for the window to move; a proposal over its own cap is never paid.
 */
export function capStands({ proposalSats, paymentSats, reservesSats, paidByProposalSats = 0n, paidInWindowSats = 0n }) {
  const held = BigInt(reservesSats), base = held + BigInt(paidByProposalSats);
  if (BigInt(proposalSats) * 100n > FUNDING_CAP_PCT * base) return { ok: false, final: true, why: `the proposal asks ${proposalSats} sat, more than ${FUNDING_CAP_PCT} % of the ${base} sat reserves` };
  const start = held + BigInt(paidInWindowSats);
  if ((BigInt(paidInWindowSats) + BigInt(paymentSats)) * 100n > FUNDING_CAP_WINDOW_PCT * start)
    return { ok: false, final: false, why: `${paidInWindowSats} sat paid in the window and ${paymentSats} now is more than ${FUNDING_CAP_WINDOW_PCT} % of ${start} sat` };
  return { ok: true };
}
