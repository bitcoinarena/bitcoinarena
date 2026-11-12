// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE CONFIG BALLOT (spec §27A.7.2-§27A.7.5), its first slice: the proposal object, the vote a bond key signs into
// a Bitcoin OP_RETURN, and the tally - "a pure function of chain state. Every participant computes the same result, and
// disagreement about the outcome reduces to disagreement about Bitcoin." Reading the chain (finding the proposal's publication
// and the vote outputs) and activation (§27A.7.5) are the next slices; nothing here reads a chain or signs with a bond.
//
// NO CURVE, as everywhere in this package: `verify(signature, digest, pubkey)` is injected (BIP-340 over the node keys).
//
// Two choices the spec leaves open, made here and named:
//   - the config travels as its bytes with the config_hash it declares, and the two must agree (configHashOf, 27A.7.1)
//   - the vote's marker is "ARN" 'V' (RULED 2026-10-13: "ARN", not the spec's "BLW" - one prefix finds all of the
//     network's data on chain), with a kind byte as every other ARN payload has: a bare "ARN" vote would be 76 bytes, the same as
//     a fork re-affirmation ("ARN" 'F', reaffirm.js), so the kind byte keeps them apart. 77 bytes, inside the 80-byte limit
import { Writer, Reader } from './encode.js';
import { taggedHash, toHex } from './hash.js';
import { TAG, PROTOCOL_VERSION, TYPE_CONFIG_PROPOSAL } from './constants.js';

export const CLASS = Object.freeze({ DESIGN: 1, MONEY: 2, UPGRADE: 3 });
export const CHOICE = Object.freeze({ YES: 1, NO: 2, ABSTAIN: 3 });
/** The schedule in blocks (§27A.7.4, §27A.8.2) - genesis parameters; regtest runs 1 / 6 / 1. */
export const SCHEDULES = Object.freeze({
  mainnet: Object.freeze({ [CLASS.DESIGN]: { review: 1008, voting: 1440, cooldown: 2016 }, [CLASS.MONEY]: { review: 1008, voting: 1440, cooldown: 2016 },
    [CLASS.UPGRADE]: { review: 2016, voting: 2016, cooldown: 4320 } }),
  regtest: Object.freeze({ [CLASS.DESIGN]: { review: 1, voting: 6, cooldown: 1 }, [CLASS.MONEY]: { review: 1, voting: 6, cooldown: 1 },
    [CLASS.UPGRADE]: { review: 1, voting: 6, cooldown: 1 } }),
});
/**
 * A REPEAL (§27A.7.6): "review 0, voting 720, cooldown 0 - but only if its config is byte-identical to an ancestor that was live
 * before. It can go back, never forward." Regtest's is 0 / 6 / 0 (a choice made here, named: its voting phase as for the others).
 */
export const REPEAL_SCHEDULES = Object.freeze({
  mainnet: Object.freeze({ review: 0, voting: 720, cooldown: 0 }),
  regtest: Object.freeze({ review: 0, voting: 6, cooldown: 0 }),
});
/** Is `p` a repeal: its config byte-identical to one in `history` - the configs that were live before, [{ config }] - other than the current. */
export function isRepeal(p, history = []) {
  const mine = toHex(p.config);
  return history.slice(0, -1).some((h) => h.config && toHex(h.config) === mine);
}
/** Thresholds of the bonded capital in the snapshot (§27A.7.4, §27A.8.2): turnout percent, approval of non-abstaining weight. */
export const THRESHOLDS = Object.freeze({
  [CLASS.DESIGN]: { turnoutPct: 30n, approvalPct: 50n, strict: true },     // > 50 %
  [CLASS.MONEY]: { turnoutPct: 40n, approvalPct: 66n, strict: false },     // >= 66 %
  [CLASS.UPGRADE]: { turnoutPct: 51n, approvalPct: 66n, strict: false },   // >= 66 %
});
export const VOTE_MARKER = Uint8Array.from([0x41, 0x52, 0x4e, 0x56]);     // "ARN" 'V'
export const VOTE_BYTES = 4 + 8 + 1 + 64;                                  // 77, inside the 80-byte OP_RETURN limit
/**
 * THE BOUND VOTE (ruled 2026-11-12, kanban #2125, closes #1490 / #1734): the bond key signs H(proposal_id || choice || seq), seq
 * a u32 (big-endian) the holder raises with each vote, and per bond the highest seq mined inside the voting phase counts. Its
 * payload: "ARN" 'V', proposal_id[0:7], choice, seq, signature - 80 bytes, the OP_RETURN limit. A choice made here, named: the
 * id prefix gives up its eighth byte so the u32 fits (the prefix only finds the proposal; the signature covers the whole id).
 * The two formats are told apart by length; which one a proposal reads is fixed by its publication height (BALLOT_BIND_HEIGHT).
 */
export const VOTE_BOUND_PREFIX = 7;
export const VOTE_BOUND_BYTES = 4 + VOTE_BOUND_PREFIX + 1 + 4 + 64;        // 80
/**
 * THE GATE OF THE BINDING (ruled 2026-11-12, #2125 votes + deposits, #2012 the chain check): a proposal whose deposit confirmed at
 * or above its network's height is read bound - its deposit must commit to its proposer and bytes (ballot-chain.js depositOf), its
 * votes are the 80-byte seq votes; below it, the old reading byte for byte (77-byte votes, last by height, the #1608 tip check).
 * regtest from 0, mainnet from its first block, testnet4 at the roll after 2026-11-12 (tip then ~160 925): 161 400.
 */
export const BALLOT_BIND_HEIGHT = Object.freeze({ regtest: 0, testnet4: 161400, mainnet: 0 });
/** The gate of a network by name ('regtest' | 'testnet4'); any other network is read as mainnet (bound from its first block). */
export const ballotBindHeight = (network) => (Object.prototype.hasOwnProperty.call(BALLOT_BIND_HEIGHT, network) ? BALLOT_BIND_HEIGHT[network] : BALLOT_BIND_HEIGHT.mainnet);

/**
 * THE HASH A CONFIG IS NAMED BY (§27A.7.1): "config_hash = H(canonical(game_config))" - the tagged hash of the config's bytes,
 * the hash every config of the network is named by (nextblock config/game-config.js TAG_GAME_CONFIG; the ballot's genesis
 * 2170f250 is exactly this over its bytes, ballot-genesis.test.js). A proposal carries the FULL config and the hash it names,
 * and the two must be one: otherwise a ballot could make live a hash whose bytes nobody voted on (the hole).
 */
export const TAG_GAME_CONFIG = 'BLWP/v1/GameConfig';
export const configHashOf = (config) => taggedHash(TAG_GAME_CONFIG, config);

const isVoteBytes32 = (b) => b instanceof Uint8Array && b.length === 32;
const className = (c) => Object.keys(CLASS).find((k) => CLASS[k] === c);

/** THE BODY THE PROPOSER SIGNS (§27A.7.2): network, parent config, the full config, class, activation, proposer, deposit. */
export function encodeConfigProposalBody(p) {
  if (!isVoteBytes32(p.networkId) || !isVoteBytes32(p.parent) || !isVoteBytes32(p.configHash) || !isVoteBytes32(p.proposer) || !isVoteBytes32(p.depositTxid))
    throw new Error('a proposal names its network, parent config, config hash, proposer and deposit txid in 32 bytes each');
  if (!(p.config instanceof Uint8Array) || !p.config.length) throw new Error('a proposal carries the FULL config, never a diff (27A.7.2)');
  if (!className(p.class)) throw new Error(`a proposal's class is DESIGN, MONEY or UPGRADE, not ${p.class}`);
  if (!Number.isInteger(p.activationHeight) || p.activationHeight < 1 || p.activationHeight > 0xffffffff) throw new Error('activation_height is a block height');
  const w = new Writer();
  w.u8(TYPE_CONFIG_PROPOSAL); w.u16(PROTOCOL_VERSION);
  w.bytes32(p.networkId); w.bytes32(p.parent); w.bytes32(p.configHash);
  w.vec([...p.config], (x, ww) => ww.u8(x));
  w.u8(p.class); w.u32(p.activationHeight); w.bytes32(p.proposer); w.bytes32(p.depositTxid);
  return w.finish();
}
export function decodeConfigProposalBody(bytes) {
  const r = new Reader(bytes);
  if (r.u8() !== TYPE_CONFIG_PROPOSAL) throw new Error('not a config proposal');
  if (r.u16() !== PROTOCOL_VERSION) throw new Error('unknown protocol version');
  const p = { networkId: r.bytes32(), parent: r.bytes32(), configHash: r.bytes32(), config: Uint8Array.from(r.vec((rr) => rr.u8())),
    class: r.u8(), activationHeight: r.u32(), proposer: r.bytes32(), depositTxid: r.bytes32() };
  r.end();
  encodeConfigProposalBody(p);
  return p;
}
export const proposalBodyId = (p) => taggedHash(TAG.configProposalBody, encodeConfigProposalBody(p));
/**
 * WHAT A BOUND DEPOSIT COMMITS TO (ruled #2125 / #2012): "H(proposal bytes)" - the body with its deposit_txid zeroed, since the
 * txid hashes this commitment and cannot be inside it (nor can the signature, which signs the txid). It pins the network, parent,
 * config, class, activation and proposer at the deposit's confirmation.
 */
export const proposalCommitment = (p) => taggedHash(TAG.configProposalCommit, encodeConfigProposalBody({ ...p, depositTxid: new Uint8Array(32) }));
/** proposal_id = H(canonical(config_proposal)): the body and the proposer's signature together. */
export function proposalId(p) {
  if (!(p.signature instanceof Uint8Array) || p.signature.length !== 64) throw new Error('a proposal carries its proposer\'s 64-byte signature');
  const body = encodeConfigProposalBody(p);
  const out = new Uint8Array(body.length + 64); out.set(body, 0); out.set(p.signature, body.length);
  return taggedHash(TAG.configProposal, out);
}

/**
 * A PROPOSAL ON ITS FACE (§27A.7.2, §27A.7.4): signed by its proposer, activation at or after the end of cooldown counted from
 * the height it was published at, and its deposit within the cap - at most bond_min of the lowest bracket over 100.
 */
export function proposalStands(p, { publishedAt, depositSats, lowestBondMinSats, schedule = SCHEDULES.mainnet, verify, history = null, repealSchedule = REPEAL_SCHEDULES.mainnet }) {
  try { encodeConfigProposalBody(p); } catch (e) { return { ok: false, why: e.message }; }
  // THE HASH IT NAMES IS THE HASH OF THE CONFIG IT CARRIES (27A.7.1), or nobody voted on the config it would make live
  const named = toHex(p.configHash), carried = toHex(configHashOf(p.config));
  if (named !== carried) return { ok: false, why: `config_hash ${named} is not the hash of the config the proposal carries (${carried}): config_hash = H(canonical(game_config)), 27A.7.1` };
  if (typeof verify !== 'function' || !verify(p.signature, proposalBodyId(p), p.proposer)) return { ok: false, why: 'the proposal is not signed by the node it names as proposer' };
  // a config the network already ran - before the current one - is a repeal, on the short schedule (§27A.7.6)
  const repeal = !!history && isRepeal(p, history);
  const s = repeal ? repealSchedule : schedule[p.class];
  const earliest = publishedAt + s.review + s.voting + s.cooldown;
  if (p.activationHeight < earliest) return { ok: false, why: `activation_height ${p.activationHeight} is before the end of cooldown (${earliest}): invalid on its face` };
  const cap = BigInt(lowestBondMinSats) / 100n;
  if (BigInt(depositSats) > cap) return { ok: false, why: `a deposit of ${depositSats} sat is over the cap of ${cap} (bond_min of the lowest bracket / 100)` };
  return { ok: true, id: proposalId(p), class: className(p.class), repeal, votingFrom: publishedAt + s.review, votingUntil: publishedAt + s.review + s.voting, activationHeight: p.activationHeight };
}

const u32be = (n) => Uint8Array.from([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);
const isSeq = (n) => Number.isInteger(n) && n >= 0 && n <= 0xffffffff;
/** What a bond key signs to vote: H(proposal_id || choice), and for a bound vote (`seq` given) H(proposal_id || choice || seq). */
export const voteMessage = (id, choice, seq = null) => (seq === null || seq === undefined
  ? taggedHash(TAG.vote, Uint8Array.from([...id, choice]))
  : taggedHash(TAG.vote, Uint8Array.from([...id, choice, ...u32be(seq)])));
/**
 * THE OP_RETURN PAYLOAD (§27A.7.3): "ARN" 'V', proposal_id[0:8], choice, the bond key's signature - 77 bytes; with `seq`, the
 * bound vote: "ARN" 'V', proposal_id[0:7], choice, seq, signature - 80 bytes.
 */
export function encodeVote({ proposalId: id, choice, signature, seq = null }) {
  if (!isVoteBytes32(id)) throw new Error('a vote names a 32-byte proposal id');
  if (!Object.values(CHOICE).includes(choice)) throw new Error('a vote is YES, NO or ABSTAIN');
  if (!(signature instanceof Uint8Array) || signature.length !== 64) throw new Error('a vote carries a 64-byte signature');
  if (seq !== null && seq !== undefined) {
    if (!isSeq(seq)) throw new Error('a bound vote\'s seq is a u32');
    const out = new Uint8Array(VOTE_BOUND_BYTES);
    out.set(VOTE_MARKER, 0); out.set(id.subarray(0, VOTE_BOUND_PREFIX), 4); out[11] = choice; out.set(u32be(seq), 12); out.set(signature, 16);
    return out;
  }
  const out = new Uint8Array(VOTE_BYTES);
  out.set(VOTE_MARKER, 0); out.set(id.subarray(0, 8), 4); out[12] = choice; out.set(signature, 13);
  return out;
}
/** Either format: { idPrefix, choice, signature, seq, bound } - `seq` null and `bound` false for the 77-byte vote - or null. */
export function decodeVote(payload) {
  if (!(payload instanceof Uint8Array) || (payload.length !== VOTE_BYTES && payload.length !== VOTE_BOUND_BYTES)) return null;
  if (VOTE_MARKER.some((b, i) => payload[i] !== b)) return null;
  if (payload.length === VOTE_BOUND_BYTES) {
    if (!Object.values(CHOICE).includes(payload[11])) return null;
    const seq = ((payload[12] << 24) | (payload[13] << 16) | (payload[14] << 8) | payload[15]) >>> 0;
    return { idPrefix: payload.slice(4, 11), choice: payload[11], seq, signature: payload.slice(16), bound: true };
  }
  if (!Object.values(CHOICE).includes(payload[12])) return null;
  return { idPrefix: payload.slice(4, 12), choice: payload[12], signature: payload.slice(13), seq: null, bound: false };
}

/**
 * EACH BOND'S LAST VOTE (§27A.7.3), the one rule both bond-weighted counts read: the ballot's tally() and the funding vote's
 * fundingTally() (funding.js, §27A.9.3 stage 2). `votes` [{ payload, height, txid }] as found on chain; a vote counts only inside
 * [from, until) and for every census bond whose key its signature verifies under H(proposal_id || choice); per bond outpoint the
 * last by height wins, a tie inside one block going to the lower txid. Answers Map outpoint -> { choice, height, txid, weight },
 * weight = weightOf(bond).
 *
 * A REPLAYED VOTE COUNTS ONCE, AT ITS FIRST OCCURRENCE (kanban #1489, #1668, #1734): the signature covers H(proposal_id || choice)
 * only, not the transaction or the height, so anyone could copy a bond's old 77 bytes into a later transaction of his own and make
 * them that bond's "last vote" - undoing its change of mind for a tx fee. Byte-identical payloads are one vote: only the copy that
 * ranks lowest under the rule above (lowest height; inside one block the higher txid) is kept, whatever order `votes` comes in, so
 * a copy can never move a vote later. One helper so the two counts cannot drift apart again (#1734: the funding vote had kept the
 * replay hole after the ballot's fix).
 */
export function lastVotes({ proposalId: id, census, votes, from, until, verify, weightOf, bound = false }) {
  if (bound) return boundVotes({ proposalId: id, census, votes, from, until, verify, weightOf });
  const prefix = toHex(id.subarray(0, 8));
  const first = new Map();                           // payload hex -> the occurrence of those bytes that ranks lowest
  for (const v of votes || []) {
    if (!(v?.payload instanceof Uint8Array)) continue;
    const k = toHex(v.payload), had = first.get(k);
    if (!had || v.height < had.height || (v.height === had.height && String(v.txid) > String(had.txid))) first.set(k, v);
  }
  const latest = new Map();                          // outpoint -> { choice, height, txid, weight }
  for (const v of first.values()) {
    const d = decodeVote(v.payload);
    if (!d || d.bound || toHex(d.idPrefix) !== prefix) continue;     // the old reading: 77-byte votes only, as before
    if (!(v.height >= from && v.height < until)) continue;
    const msg = voteMessage(id, d.choice);
    for (const b of census || []) {
      let good = false; try { good = verify(d.signature, msg, b.pubkey) === true; } catch { good = false; }
      if (!good) continue;
      const had = latest.get(b.outpoint);
      const later = !had || v.height > had.height || (v.height === had.height && String(v.txid) < String(had.txid));
      if (later) latest.set(b.outpoint, { choice: d.choice, height: v.height, txid: v.txid, weight: weightOf(b) });
    }
  }
  return latest;
}

/**
 * EACH BOND'S VOTE UNDER THE BINDING (ruled 2026-11-12, kanban #2125; closes #1490 / #1734): only 80-byte seq votes, inside
 * [from, until), each counting for every census bond whose key verifies it under H(proposal_id || choice || seq). Per bond outpoint
 * the HIGHEST seq wins, whatever block it lands in - so neither a copy of old bytes nor a YES replaced by RBF and mined later by a
 * stranger beats the holder's later vote with a higher seq. Two votes with the one highest seq and different choices: the bond
 * counts as ABSTAIN (it signed both). Same answer shape as lastVotes; height / txid are of the first such vote by (height, txid).
 */
function boundVotes({ proposalId: id, census, votes, from, until, verify, weightOf }) {
  const prefix = toHex(id.subarray(0, VOTE_BOUND_PREFIX));
  const best = new Map();                            // outpoint -> { seq, choice, conflicted, height, txid, weight }
  for (const v of votes || []) {
    if (!(v?.payload instanceof Uint8Array)) continue;
    const d = decodeVote(v.payload);
    if (!d || !d.bound || toHex(d.idPrefix) !== prefix) continue;
    if (!(v.height >= from && v.height < until)) continue;
    const msg = voteMessage(id, d.choice, d.seq);
    for (const b of census || []) {
      let good = false; try { good = verify(d.signature, msg, b.pubkey) === true; } catch { good = false; }
      if (!good) continue;
      const had = best.get(b.outpoint);
      if (!had || d.seq > had.seq) { best.set(b.outpoint, { seq: d.seq, choice: d.choice, conflicted: false, height: v.height, txid: v.txid, weight: weightOf(b) }); continue; }
      if (d.seq < had.seq) continue;
      if (d.choice !== had.choice) had.conflicted = true;
      if (v.height < had.height || (v.height === had.height && String(v.txid) < String(had.txid))) { had.height = v.height; had.txid = v.txid; }
    }
  }
  const out = new Map();
  for (const [k, x] of best) out.set(k, { choice: x.conflicted ? CHOICE.ABSTAIN : x.choice, seq: x.seq, height: x.height, txid: x.txid, weight: x.weight });
  return out;
}

/**
 * THE TALLY (§27A.7.3-4). `census`: the bonds active at the proposal's publication - [{ pubkey, outpoint, bondSats }];
 * `votes`: the vote outputs found on chain - [{ payload, height, txid }]. A vote counts for every bond whose key its signature
 * verifies under, only inside the voting phase; per bond outpoint the last by height wins (ties inside a block: lower txid).
 * ABSTAIN counts for turnout, not approval. Weight is the bond amount. Answers the weights, the percentages and `passed`.
 *
 * A replayed vote counts once, at its first occurrence (kanban #1489): see lastVotes. The vote bytes and their signature are
 * unchanged; a bond that changes its mind signs anew (BIP-340 with fresh aux randomness gives new bytes).
 */
export function tally({ proposal, standing, census, votes, verify, bound = false }) {
  // `bound`: the proposal is read under the binding (its deposit at or above BALLOT_BIND_HEIGHT): highest seq wins (boundVotes)
  const latest = lastVotes({ proposalId: standing.id, census, votes, from: standing.votingFrom, until: standing.votingUntil, verify,
    weightOf: (b) => BigInt(b.bondSats), bound });
  const total = (census || []).reduce((a, b) => a + BigInt(b.bondSats), 0n);
  let yes = 0n, no = 0n, abstain = 0n;
  for (const x of latest.values()) { if (x.choice === CHOICE.YES) yes += x.weight; else if (x.choice === CHOICE.NO) no += x.weight; else abstain += x.weight; }
  const t = THRESHOLDS[proposal.class];
  const turnout = yes + no + abstain;
  const quorum = total > 0n && turnout * 100n >= t.turnoutPct * total;
  const decided = yes + no;
  const approved = decided > 0n && (t.strict ? yes * 100n > t.approvalPct * decided : yes * 100n >= t.approvalPct * decided);
  return { totalSats: total, yesSats: yes, noSats: no, abstainSats: abstain, bondsVoted: latest.size, quorum, approved, passed: quorum && approved,
    turnoutPct: total > 0n ? Number((turnout * 10000n) / total) / 100 : 0, approvalPct: decided > 0n ? Number((yes * 10000n) / decided) / 100 : 0 };
}
