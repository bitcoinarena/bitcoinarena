// PROJECT FUNDING PROPOSALS AND THEIR SIGNAL (§27A.9.3 stage 1, kanban #397 slice 6, the owner 2026-10-16: "a signed proposal names
// purpose, amount, LNURL and a bonded author. Seats keep and pass on proposals, signed comments and node signals. The signal passes at
// 15 % or more of the nodes that served a round in the last 432 blocks, after 1008 blocks"; signals are "signed messages kept and
// passed on by the seats. Not on-chain signals. A signal weighs one per node and moves no money").
//
//     FundingProposal { network_id, author, published_height, amount_sats, lnurl, purpose }     signed by the author, a bonded node
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

/** The blocks of a signal, and the window that makes a node active (§27A.9.3). The short schedule is a live proof's only. */
export const FUNDING_SCHEDULES = Object.freeze({
  spec: Object.freeze({ signal: 1008, activeWindow: 432 }),
  short: Object.freeze({ signal: 1, activeWindow: 432 }),
});
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
