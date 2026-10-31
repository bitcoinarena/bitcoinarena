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
export function tally({ proposal, standing, census, votes, verify }) {
  const id = standing.id;
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
  const quorum = total > 0n && turnout * 100n >= t.turnoutPct * total;
  const decided = yes + no;
  const approved = decided > 0n && (t.strict ? yes * 100n > t.approvalPct * decided : yes * 100n >= t.approvalPct * decided);
  return { totalSats: total, yesSats: yes, noSats: no, abstainSats: abstain, bondsVoted: latest.size, quorum, approved, passed: quorum && approved,
    turnoutPct: total > 0n ? Number((turnout * 10000n) / total) / 100 : 0, approvalPct: decided > 0n ? Number((yes * 10000n) / decided) / 100 : 0 };
}
