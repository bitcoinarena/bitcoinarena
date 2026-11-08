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
import { decodeHostList, hostListProblem } from './market-check.js';

// SOURCES (kanban #921, the owner 2026-10-31: "Mach einen Prozess mit votings von bonded nodes die eine whitelist führen"): the hosts a market may read. Its "config" is the
// whole list (market-check.js encodeHostList), on a chain of its own from SOURCES_GENESIS: the same deposit, phases and bond-weighted tally, never a game's config
export const CLASS = Object.freeze({ DESIGN: 1, MONEY: 2, UPGRADE: 3, SOURCES: 4 });
export const CHOICE = Object.freeze({ YES: 1, NO: 2, ABSTAIN: 3 });
/** The schedule in blocks (§27A.7.4, §27A.8.2) - genesis parameters; regtest runs 1 / 6 / 1. */
export const SCHEDULES = Object.freeze({
  mainnet: Object.freeze({ [CLASS.DESIGN]: { review: 1008, voting: 1440, cooldown: 2016 }, [CLASS.MONEY]: { review: 1008, voting: 1440, cooldown: 2016 },
    [CLASS.UPGRADE]: { review: 2016, voting: 2016, cooldown: 4320 }, [CLASS.SOURCES]: { review: 144, voting: 288, cooldown: 36 } }),
  regtest: Object.freeze({ [CLASS.DESIGN]: { review: 1, voting: 6, cooldown: 1 }, [CLASS.MONEY]: { review: 1, voting: 6, cooldown: 1 },
    [CLASS.UPGRADE]: { review: 1, voting: 6, cooldown: 1 }, [CLASS.SOURCES]: { review: 1, voting: 6, cooldown: 1 } }),
  // TESTNET4: a day of review and a day of voting for every class (kanban #785, a tester 2026-10-28: "for Testnet you can set the
  // signal and voting periods to 1 day for all types of proposals"); the cooldowns as mainnet's
  testnet4: Object.freeze({ [CLASS.DESIGN]: { review: 144, voting: 144, cooldown: 2016 }, [CLASS.MONEY]: { review: 144, voting: 144, cooldown: 2016 },
    [CLASS.UPGRADE]: { review: 144, voting: 144, cooldown: 4320 }, [CLASS.SOURCES]: { review: 144, voting: 144, cooldown: 36 } }),
});
/**
 * A REPEAL (§27A.7.6): "review 0, voting 720, cooldown 2 - but only if its config is byte-identical to an ancestor that was live
 * before. It can go back, never forward." Regtest's is 0 / 6 / 0 (§27A.7.6). Testnet4 votes a day (144, kanban #785).
 * THE COOLDOWN IS 2 BLOCKS on mainnet and testnet4 (kanban #1152, RULED 2026-11-06 kanban #1196; for a proposal published at
 * or after the network's BALLOT_DEPTH_HEIGHT - before it the old cooldown 0, LEGACY_REPEAL_COOLDOWN): a seat writes an outcome
 * only once the last voting block is 3 deep (arena-node ballot-tally.js MIN_DECIDE_DEPTH), and with no cooldown a repeal was
 * decided at depth 1 - a one-block reorg made it live, or took it back, after rounds were created. 2 = 3 - 1: the outcome
 * lands the block before the activation, as every other proposal's does. A host removal (§27A.7.6 for sources) the same.
 */
export const REPEAL_SCHEDULES = Object.freeze({
  mainnet: Object.freeze({ review: 0, voting: 720, cooldown: 2 }),
  regtest: Object.freeze({ review: 0, voting: 6, cooldown: 0 }),
  testnet4: Object.freeze({ review: 0, voting: 144, cooldown: 2 }),   // a day (kanban #785)
});
/**
 * THE FEWEST CONFIRMATIONS A SEAT DECIDES A BALLOT AT (§27A.7.4, RULED 2026-11-06, kanban #1196, #1152): its last voting block
 * at least 3 deep, so a one- or two-block reorg never activates or undoes a config after rounds were made under it. Regtest keeps
 * depth 1 ("two operators can drive a whole governance cycle through to activation in under a minute").
 */
export const MIN_DECIDE_DEPTH = 3;
export const MIN_DECIDE_DEPTHS = Object.freeze({ mainnet: MIN_DECIDE_DEPTH, testnet4: MIN_DECIDE_DEPTH, regtest: 1 });
/** The depth a schedule's network decides at: regtest's short schedule 1, every other MIN_DECIDE_DEPTH. */
export const minDecideDepthOf = (schedule) => (schedule === SCHEDULES.regtest ? MIN_DECIDE_DEPTHS.regtest : MIN_DECIDE_DEPTH);
/**
 * THE HEIGHT THE #1196 RULE STARTS AT, PER NETWORK (§27A.7.4: "This applies to proposals published at or after the network's
 * BALLOT_DEPTH_HEIGHT ... Older proposals keep the old rule, so seats on older releases never split over them"). A proposal
 * published at or after it: decided no less than MIN_DECIDE_DEPTHS deep, a repeal's (and a host removal's) cooldown is
 * REPEAL_SCHEDULES' (2), and an activation that leaves fewer than MIN_DECIDE_DEPTHS blocks after its last voting block is invalid
 * on its face. A proposal published before it: THE OLD RULE - decided at depth 1 at least, a repeal's cooldown 0, no such check.
 *   regtest   0          every proposal under the rule (with regtest's own depth 1)
 *   mainnet   0          from its first block
 *   testnet4  Infinity   NOT SET YET: "the height its seats roll to this rule" is not known. Until it is, every testnet4
 *                        proposal keeps the old rule, so 2.0 seats decide exactly as the 1.9 seats beside them (1.9 stays at
 *                        depth 1, cooldown 0). SET IT AT THE 2.0 ROLL to the first height the rolled seats count under.
 */
export const BALLOT_DEPTH_HEIGHT = Object.freeze({ mainnet: 0, regtest: 0, testnet4: Number.POSITIVE_INFINITY });
/** The old rule's (before BALLOT_DEPTH_HEIGHT) repeal and host-removal cooldown, and its fewest confirmations. */
export const LEGACY_REPEAL_COOLDOWN = 0;
export const LEGACY_DECIDE_DEPTH = 1;
/** Is a proposal published at `publishedAt` under the #1196 rule, on a network whose BALLOT_DEPTH_HEIGHT is `depthHeight`. */
export const underDepthRule = (publishedAt, depthHeight = 0) => Number(publishedAt) >= Number(depthHeight);
/**
 * Is `p` a repeal (§27A.7.6, RULED 2026-11-07 kanban #1335/#1307): its config byte-identical to the config in force's DIRECT PARENT - `history`
 * the configs that were live, [{ config, since }], the last one in force - and published within one normal cycle (REPEAL_WINDOW_BLOCKS) of the
 * activation it undoes. "Any ancestor that was live before" let a fee config repealed years ago come back in days with no exit window.
 */
export const REPEAL_WINDOW_BLOCKS = 4464;
export function isRepeal(p, history = [], { publishedAt = null } = {}) {
  if (history.length < 2) return false;
  const now = history[history.length - 1], parent = history[history.length - 2];
  if (!parent.config || toHex(parent.config) !== toHex(p.config)) return false;
  if (publishedAt !== null && Number.isInteger(now.since) && Number(publishedAt) > now.since + REPEAL_WINDOW_BLOCKS) return false;
  return true;
}
/** A host dropped from the list goes faster than one added, a day of voting at most: a source gone bad must not stay listed. */
export const HOST_REMOVAL_VOTING = 144;
/** The hosts a list adds to the one live before it. A vote reads each one's example, so one proposal adds few. */
export const SOURCES_ADDED_MAX = 8;
export function addedHosts(p, history = []) {
  const last = history.length ? history[history.length - 1] : null, before = new Set(last ? decodeHostList(last.config) : []);
  return decodeHostList(p.config).filter((h) => !before.has(h));
}
export function isHostRemoval(p, history = []) {
  if (p.class !== CLASS.SOURCES || !history.length) return false;
  const now = new Set(decodeHostList(history[history.length - 1].config)), next = decodeHostList(p.config);
  return next.length < now.size && next.every((h) => now.has(h));
}
/**
 * Thresholds of the bonded capital in the snapshot (§27A.7.4, §27A.8.2): approval of non-abstaining weight, and YES of ALL eligible capital.
 * RULED 2026-11-07 (kanban #1300, #1335): "The turnout floor is replaced by a floor on YES over everyone eligible, so a NO can never cause a pass
 * (the old pair, turnout 40 % and approval 66 %, let 30 % YES pass only when 10 % honest NO showed up)": DESIGN > 50 % and YES >= 15 %; MONEY
 * >= 66 % and YES >= 26 %, counting only bonds of §27A.9.5 rule 1's age (`minAge`); an UPGRADE keeps §27A.8's 34 % (51 % turnout x 66 %).
 */
export const THRESHOLDS = Object.freeze({
  [CLASS.DESIGN]: { turnoutPct: 0n, approvalPct: 50n, strict: true, minYesPct: 15n },     // > 50 %, YES >= 15 % of all
  [CLASS.MONEY]: { turnoutPct: 0n, approvalPct: 66n, strict: false, minYesPct: 26n, minAge: true },   // >= 66 %, YES >= 26 % of rule-1 bonds
  [CLASS.UPGRADE]: { turnoutPct: 0n, approvalPct: 66n, strict: false, minYesPct: 34n },   // >= 66 %, YES >= 34 % of all
  // > 50 %, and yes from at least 25 % of ALL bonded capital (the owner 2026-10-31: "kürzer, 66% ist Zuviel. Quorum auch", "Mindestens 25% des Bond Kapitals"): 20 % turnout alone
  // would let some 10 % of the capital add a host of its own
  [CLASS.SOURCES]: { turnoutPct: 20n, approvalPct: 50n, strict: true, minYesPct: 25n },
});
export const VOTE_MARKER = Uint8Array.from([0x41, 0x52, 0x4e, 0x56]);     // "ARN" 'V'
export const VOTE_BYTES = 4 + 8 + 1 + 64;                                  // 77, inside the 80-byte OP_RETURN limit

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
  if (!className(p.class)) throw new Error(`a proposal's class is DESIGN, MONEY, UPGRADE or SOURCES, not ${p.class}`);
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
export function proposalStands(p, { publishedAt, depositSats, lowestBondMinSats, schedule = SCHEDULES.mainnet, verify, history = null, repealSchedule = REPEAL_SCHEDULES.mainnet,
  depthHeight = 0, minDecideDepth = minDecideDepthOf(schedule) }) {
  try { encodeConfigProposalBody(p); } catch (e) { return { ok: false, why: e.message }; }
  // THE HASH IT NAMES IS THE HASH OF THE CONFIG IT CARRIES (27A.7.1), or nobody voted on the config it would make live
  const named = toHex(p.configHash), carried = toHex(configHashOf(p.config));
  if (named !== carried) return { ok: false, why: `config_hash ${named} is not the hash of the config the proposal carries (${carried}): config_hash = H(canonical(game_config)), 27A.7.1` };
  if (typeof verify !== 'function' || !verify(p.signature, proposalBodyId(p), p.proposer)) return { ok: false, why: 'the proposal is not signed by the node it names as proposer' };
  // a config the network already ran - before the current one - is a repeal, on the short schedule (§27A.7.6)
  if (p.class === CLASS.SOURCES) {
    const bad = hostListProblem(p.config); if (bad) return { ok: false, why: bad };
    if (history && addedHosts(p, history).length > SOURCES_ADDED_MAX) return { ok: false, why: `One proposal adds at most ${SOURCES_ADDED_MAX} hosts` };
  }
  const removal = !!history && isHostRemoval(p, history);
  const repeal = removal || (!!history && isRepeal(p, history, { publishedAt }));
  // THE #1196 RULE (BALLOT_DEPTH_HEIGHT): a repeal's cooldown 2 from that height, 0 before it - an older proposal keeps the old rule
  const ruled = underDepthRule(publishedAt, depthHeight);
  const repealCooldown = ruled ? repealSchedule.cooldown : LEGACY_REPEAL_COOLDOWN;
  const s = removal ? { review: 0, voting: Math.min(HOST_REMOVAL_VOTING, repealSchedule.voting), cooldown: repealCooldown }
    : repeal ? { ...repealSchedule, cooldown: repealCooldown } : schedule[p.class];
  const earliest = publishedAt + s.review + s.voting + s.cooldown;
  if (p.activationHeight < earliest) return { ok: false, why: `activation_height ${p.activationHeight} is before the end of cooldown (${earliest}): invalid on its face` };
  // FEWER THAN `minDecideDepth` BLOCKS AFTER ITS LAST VOTING BLOCK (§27A.7.4, kanban #1196): it could only be decided shallower than a
  // seat decides, so a 1- or 2-block reorg could activate or undo it. Invalid on its face, under the rule only
  const votingUntil = publishedAt + s.review + s.voting;
  if (ruled && p.activationHeight - (votingUntil - 1) < minDecideDepth)
    return { ok: false, why: `activation_height ${p.activationHeight} leaves ${p.activationHeight - (votingUntil - 1)} block(s) after its last voting block (${votingUntil - 1}), fewer than the ${minDecideDepth} a ballot is decided at: invalid on its face` };
  const cap = BigInt(lowestBondMinSats) / 100n;
  if (BigInt(depositSats) > cap) return { ok: false, why: `a deposit of ${depositSats} sat is over the cap of ${cap} (bond_min of the lowest bracket / 100)` };
  return { ok: true, id: proposalId(p), class: className(p.class), repeal, votingFrom: publishedAt + s.review, votingUntil, activationHeight: p.activationHeight };
}

/** What a bond key signs to vote: H(proposal_id || choice). */
export const voteMessage = (id, choice) => taggedHash(TAG.vote, Uint8Array.from([...id, choice]));
/** THE OP_RETURN PAYLOAD (§27A.7.3): "ARN" 'V', proposal_id[0:8], choice, the bond key's signature - 77 bytes. */
export function encodeVote({ proposalId: id, choice, signature }) {
  if (!isVoteBytes32(id)) throw new Error('a vote names a 32-byte proposal id');
  if (!Object.values(CHOICE).includes(choice)) throw new Error('a vote is YES, NO or ABSTAIN');
  if (!(signature instanceof Uint8Array) || signature.length !== 64) throw new Error('a vote carries a 64-byte signature');
  const out = new Uint8Array(VOTE_BYTES);
  out.set(VOTE_MARKER, 0); out.set(id.subarray(0, 8), 4); out[12] = choice; out.set(signature, 13);
  return out;
}
export function decodeVote(payload) {
  if (!(payload instanceof Uint8Array) || payload.length !== VOTE_BYTES) return null;
  if (VOTE_MARKER.some((b, i) => payload[i] !== b)) return null;
  if (!Object.values(CHOICE).includes(payload[12])) return null;
  return { idPrefix: payload.slice(4, 12), choice: payload[12], signature: payload.slice(13) };
}

/**
 * THE TALLY (§27A.7.3-4). `census`: the bonds active at the proposal's publication - [{ pubkey, outpoint, bondSats }];
 * `votes`: the vote outputs found on chain - [{ payload, height, txid }]. A vote counts for every bond whose key its signature
 * verifies under, only inside the voting phase; per bond outpoint the last by height wins (ties inside a block: lower txid).
 * ABSTAIN counts for turnout, not approval. Weight is the bond amount. Answers the weights, the percentages and `passed`.
 */
export function tally({ proposal, standing, census: all, votes, verify, ageBlocks = null }) {
  const id = standing.id;
  // A MONEY VOTE COUNTS ONLY BONDS OF RULE 1'S AGE (kanban #1335): at least `ageBlocks` old at the proposal's publication, so rented capital
  // does not set the fee - for the votes and for "all eligible capital" alike. A bond with no height is not counted.
  const aged = THRESHOLDS[proposal.class] && THRESHOLDS[proposal.class].minAge && Number.isInteger(ageBlocks) && Number.isInteger(standing.publishedAt);
  const census = aged ? (all || []).filter((b) => Number.isInteger(b.height) && b.height <= standing.publishedAt - ageBlocks) : all;
  const prefix = toHex(id.subarray(0, 8));
  const latest = new Map();                          // outpoint -> { choice, height, txid, weight }
  for (const v of votes || []) {
    const d = decodeVote(v.payload);
    if (!d || toHex(d.idPrefix) !== prefix) continue;
    if (v.height < standing.votingFrom || v.height >= standing.votingUntil) continue;
    const msg = voteMessage(id, d.choice);
    for (const b of census || []) {
      let good = false; try { good = !!verify(d.signature, msg, b.pubkey); } catch { good = false; }
      if (!good) continue;
      const had = latest.get(b.outpoint);
      const later = !had || v.height > had.height || (v.height === had.height && String(v.txid) < String(had.txid));
      if (later) latest.set(b.outpoint, { choice: d.choice, height: v.height, txid: v.txid, weight: BigInt(b.bondSats) });
    }
  }
  const total = (census || []).reduce((a, b) => a + BigInt(b.bondSats), 0n);
  let yes = 0n, no = 0n, abstain = 0n;
  for (const x of latest.values()) { if (x.choice === CHOICE.YES) yes += x.weight; else if (x.choice === CHOICE.NO) no += x.weight; else abstain += x.weight; }
  const t = THRESHOLDS[proposal.class];
  const turnout = yes + no + abstain;
  const quorum = total > 0n && turnout * 100n >= (t.turnoutPct || 0n) * total;
  const decided = yes + no;
  const approved = decided > 0n && (t.strict ? yes * 100n > t.approvalPct * decided : yes * 100n >= t.approvalPct * decided) && (!t.minYesPct || yes * 100n >= t.minYesPct * total);
  return { totalSats: total, yesSats: yes, noSats: no, abstainSats: abstain, bondsVoted: latest.size, quorum, approved, passed: quorum && approved,
    turnoutPct: total > 0n ? Number((turnout * 10000n) / total) / 100 : 0, approvalPct: decided > 0n ? Number((yes * 10000n) / decided) / 100 : 0 };
}
