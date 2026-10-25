// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// The two artifacts everything else hangs off.
//
// A RoundContract is what every participant must agree on byte for byte before
// a round can start; its digest IS the round_id. An EntryContract is one
// player's commitment to that round.
//
// Field order is protocol. Adding a field means a new version, not an append -
// an old implementation reading a new contract must fail rather than silently
// mis-parse, which is why the version comes second, right after the type.

import { Writer, Reader } from './encode.js';
import { taggedHash } from './hash.js';
import { stakeExpiryFits } from './lock-expiry.js';
import { utf8Encode } from './utf8.js';
// THE RUN LENGTH IS THE CORE'S. `genesis.js` already reads it from the same
// place and writes it into the config hash a contract's network_id commits to;
// restating the number here would be the second clock letter 21 forbade.
import {
  TAG, PROTOCOL_VERSION, speaksVersion, SUPPORTED_PROTOCOL_VERSIONS, namesNoDraw, takesAnyFederation, TYPE_ROUND_CONTRACT, TYPE_ENTRY_CONTRACT, ROLES,
  GAME_MARKET_VERSION,
  SCALAR_TEMPLATE_VERSION,
  CUSTODY, custodyByte, custodyName, slashRemainderByte, slashRemainderOf, MIN_ENTRY_WINDOW_MS,
  STAKE_EXPIRY_BLOCKS, START_DEADLINE_TICKS, OBJECTION_WINDOW_MS,
  SCORE_SCALE,
} from './constants.js';

/**
 * The balance constants live in the contract because 18A.7 says they must:
 * a contract that leaves the rank curve flat or exposure additive is one whose
 * safe route is +EV, and a client has to be able to see that before entering.
 */
export function encodeRoundContract(c) {
  // A CUSTODY THIS NETWORK HAS FIRST (§23.6): anything but FEDERATION throws that it is not one - before any
  // question that only a FEDERATION round is asked.
  custodyByte(c.custody);
  // A PAYING FEDERATION ROUND NAMES ITS FEDERATION, or it is not a contract (M3 W7).
  const named = federationIsNamed(c);
  if (!named.ok) throw new Error(named.why);
  const w = new Writer();
  w.u8(TYPE_ROUND_CONTRACT);
  // THE ROUND'S VERSION (2026.0.2): a contract that names one is written at it - a v2 round's rules differ -
  // and one that names none at this build's PROTOCOL_VERSION, as before
  const version = c.protocolVersion === undefined || c.protocolVersion === null ? PROTOCOL_VERSION : c.protocolVersion;
  if (!speaksVersion(version)) throw new Error(`protocol version ${version}, this build speaks ${SUPPORTED_PROTOCOL_VERSIONS.join(', ')}`);
  w.u16(version);

  // WHICH NETWORK THIS ROUND IS FOR, section 27A.4: "Round Contracts carry it,
  // nodes and clients reject contracts that do not match the one they were
  // built for, and censuses are per-network."
  //
  // AND WHICH RULES IT RUNS UNDER, 27A.7.5: "A round is bound to the config it
  // was created under. The Round Contract carries `config_hash` alongside
  // `network_id`. A round created before activation and still running after it
  // keeps its own rules to the end."
  //
  // Both are here before anything uses them, which is the point: adding a
  // field to something signed is a format break, and after the first bond
  // exists a break costs every node its census entry. Neither VALUE can be
  // computed in this package - `networkAnchor()` and `genesisConfigHash()`
  // both refuse - but the fields are on version one, where they have to be.
  //
  // 27A.4 and 27A.7.5 both say the contract carries `network_id`; section 6's
  // field list does not name it, and predates them. They pair the two, so the
  // two sit together, ahead of the code hash: which network, then which rules,
  // then which build - a decoder can refuse a foreign contract before parsing
  // anything else about it.
  w.bytes32(c.networkId);
  // WHICH GAME (§0A.3, §6 game_id): the exact GameManifest this round plays, by its id. After the network
  // and before the rules: the manifest says which cores and configs the round may name (manifest.js roundFitsManifest),
  // and a node that does not host this game refuses the round by it before reading anything the game decides.
  if (!(c.gameId instanceof Uint8Array) || c.gameId.length !== 32) throw new Error('a round names the 32-byte id of the game it plays (game_id, §0A.3)');
  w.bytes32(c.gameId);
  w.bytes32(c.configHash);

  w.bytes32(c.simCoreHash);
  w.u64(c.startTimeMs);
  w.u64(c.entryCloseMs);

  // HOW LONG ANYONE HAS TO OBJECT, in milliseconds. Section 13A: "the window
  // W (reference: 10 minutes, CONTRACT-DEFINED)". It is in the contract and
  // not a constant here because a window the caller chooses is a window the
  // operator chooses - and the operator is the party a veto exists against.
  // The player signs up to it with the rest of the round.
  w.u64(c.objectionWindowMs);

  // WHICH CUSTODY CONSTRUCTION THE STAKE SITS IN, section 23.6: "The Round
  // Contract names which construction it uses." The two have the same residual
  // and different maturity, and a player is entitled to know which one they
  // staked into before they pay. Naming it is not implementing it.
  w.u8(custodyByte(c.custody));

  // WHICH FEDERATION HOLDS THE STAKE LOCKS, AND HOW LONG A LOCK MUST RUN,
  // section 6 (v4.6.2): "federation_id - the federation holding the stake
  // locks" and "stake_expiry_blocks - replaces htlc_cltv_days; 144 (§23.1)".
  // In the id because a custodian named after entry is one the creator picked
  // after seeing who entered, and a shorter expiry lets a loser refund before
  // settlement. All zeros names no federation: no stake lock is wired into the
  // node or the client yet, and a made-up id would claim one.
  w.bytes32(c.federationId);
  w.u32(c.stakeExpiryBlocks);

  // WHAT A NODE HAS TO HAVE DONE TO EARN ITS FEE SHARE, section 22A: "A
  // selected node earns its share only if it performed the CONTRACT-DEFINED
  // minimum service". It was an argument to the slashing check until this
  // field existed, and a minimum the caller chooses is a minimum the operator
  // chooses - the same fault the objection window was moved in here to fix,
  // and worse, because this one decides whether a bond is taken.
  w.u32(c.slashMinimumServed);

  // AND WHERE THE OTHER HALF OF A SLASHED BOND GOES, section 5A.3: "half to the
  // affected players of that round; the other half 75% evenly to the active
  // census nodes at the slashing height minus the round's own seats (the
  // witnesses) and 25% to the donation set of §22A - the developers". The
  // witnesses are the set the rule SUBTRACTS, not one it pays. The halves are
  // the spec's own numbers
  // and are a constant, because a contract that could move them would let an
  // operator write itself the whole bond.
  w.u8(slashRemainderByte(c.slashRemainder));

  // WHICH DONATION SET THIS ROUND'S ENTRIES WERE MADE UNDER, section 22A:
  // "The set is named in the Round Contract and its HASH IS PART OF THE
  // CONTRACT HASH, so it cannot change after entry."
  //
  // The id and not the set itself, which is what the spec asks for and keeps
  // the contract small. Before this a set had an id and nothing named which
  // one applied, so two honest nodes could agree on a set's bytes and still
  // disagree about whether it was the round's - the last way one player's
  // donation could be split by a list nobody signed up to.
  //
  // A SET THAT DOES NOT STAND CANNOT REACH HERE, because `donationSetId`
  // refuses to hash one: shares that do not sum to 10000, a payee listed
  // twice, or a mixed-case address all throw before there is an id to name.
  w.bytes32(c.donationSetId);

  w.u32(c.censusHeight);

  // HOW DEEP A BOND HAS TO BE, section 5A.11: "The Round Contract contains:
  // census_height, census_confirmations". It sits next to the height because
  // 5A.11 puts it there and because the two answer one question together.
  //
  // It was a caller argument on every census function, beside a height that
  // was already taken off the contract on purpose. A caller who picks the
  // depth picks which bonds are in the census, and the census picks the
  // committee - the same fault the version filter had, in the same file.
  w.u32(c.censusConfirmations);

  w.bytes32(c.censusRoot);

  // WHEN THE COMMITTEE COMES INTO EXISTENCE, and where its randomness comes
  // from. Section 6 lists both; this contract carried neither, and in their
  // place it carried a `committee_seed` - thirty-two bytes the AUTHOR wrote,
  // which the lottery read. That is the grinding attack 5A.5 exists to close:
  // 34 offline tries were enough to assign a chosen pair out of eight bonded
  // nodes. The seed is derived from the beacon now, so the field is gone, and
  // these two say WHICH beacon and WHEN - never its value, which does not
  // exist yet when a round is published.
  //
  // "committee_time  beacon value appears -> committees selected & verified"
  w.u64(c.committeeTimeMs);
  w.str(c.randomnessRule);

  // WHERE TRANSCRIPTS, ATTESTATIONS AND OBJECTIONS ARE POSTED, section 6
  // (v4.6.2) and 13A: a result is FINAL only once >=5 settlement signer nodes have
  // posted its transcript to these. "Data in the contract - any URL, any
  // relay, several - never infrastructure of this protocol." In the author's
  // order, because that order is what they signed.
  //
  // `publication_txid` is NOT here although section 6 lists it: it is the id
  // of a transaction carrying H(RoundContract), so a contract holding it has
  // no fixed point - like `round_id` and `creator_signature`, it rides beside
  // the contract, not in it.
  if (!Array.isArray(c.publicationRelays))
    throw new Error('publicationRelays is a list of URLs, and it may be empty');
  w.vec(c.publicationRelays, (s, ww) => ww.str(s));

  // HOW MANY SIGNER NODES EACH POOL HAS, section 5A.7: "GAME/VERIFY: 7 slots... 
  // SETTLEMENT: 7 slots". Section 6 carries them and says what they mean:
  // "echoed for readability; MUST equal genesis_parameters, which network_id
  // commits to. A contract disagreeing with the network it names is invalid,
  // NOT A SMALLER COMMITTEE."
  //
  // That last clause is why they are here. `selectCommittee` took `slots` from
  // whoever called it, so nobody had to forge a census to shrink a committee -
  // they could pass a smaller number. Five of seven is the whole security
  // argument; five of two is not.
  w.u8(c.gameVerifySlots);
  w.u8(c.settlementSlots);

  w.u64(c.stakeMsat);
  w.u64(c.bondMinSats);
  w.u16(c.blockTicks);

  // balance, all integers
  w.u32(c.exposureReference);
  w.u32(c.corridorHalfWidth);
  w.u32(c.spawnFreeRadius);
  w.u32(c.timeFloor);
  w.u32(c.timeCeil);
  w.u32(c.minScore);
  w.u8(c.rankNumerator);          // 3 of 4 = the 0.75 curve
  w.u8(c.rankDenominator);

  w.vec([...c.nodes].sort(compare32), (n, ww) => ww.bytes32(n), { sortedBy: compare32 });

  // THE START DEADLINE (§16), in ticks after a player's join tick - and LAST,
  // AND ONLY WHEN IT IS NOT THE DEFAULT. A round that names none (or names
  // START_DEADLINE_TICKS) encodes exactly as it did before the field existed,
  // so every round id already published stays what it was; one encoding per
  // contract, because the default and its omission are the same round.
  if (c.startDeadlineTicks !== undefined && c.startDeadlineTicks !== START_DEADLINE_TICKS) {
    if (!Number.isInteger(c.startDeadlineTicks) || c.startDeadlineTicks < 1 || c.startDeadlineTicks >= c.blockTicks)
      throw new Error(`startDeadlineTicks is a whole number of ticks from 1 to below the round's ${c.blockTicks}`);
    w.u32(c.startDeadlineTicks);
  }
  // THE SERIES AND THE INDEX, present only on a round of a series (ALL-BUT-MIN-1727; multiplayer_p2p.md "Round i of a
  // series is derived, never authored": round_id(i) = H(series_id || i)). Written after the deadline and only when
  // named, so every contract that names no series keeps its bytes and its id.
  if (c.seriesId !== undefined && c.seriesId !== null) {
    if (!(c.seriesId instanceof Uint8Array) || c.seriesId.length !== 32) throw new Error('a round of a series names its 32-byte series id');
    if (!Number.isInteger(c.roundIndex) || c.roundIndex < 0 || c.roundIndex > 0xffffffff) throw new Error('a round of a series names its index');
    w.bytes32(c.seriesId);
    w.u32(c.roundIndex);
  } else if (c.roundIndex !== undefined && c.roundIndex !== null) throw new Error('a round index without its series');
  // THE RULES IT IS SETTLED UNDER (§6 equivocation_rule_hash ... bond_min per role, 's sibling; 2026.0.3): after their
  // own marker, before the creator's key, only when named - 148 bytes: four rule hashes, disconnect_rule, claim_window_days, and the
  // bond floor of each role (rules.js). Every tail length that can follow stays distinct, so a contract naming none keeps its id.
  if (c.rules !== undefined && c.rules !== null) {
    if (!(version >= CREATOR_VERSION)) throw new Error(`a round names its rules from protocol version ${CREATOR_VERSION} on`);
    const r = c.rules;
    for (const k of ['equivocation', 'noQuorum', 'finality', 'slashing'])
      if (!(r[k] instanceof Uint8Array) || r[k].length !== 32) throw new Error(`a round names its ${k} rule by a 32-byte hash`);
    if (!Number.isInteger(r.disconnect) || r.disconnect < 0 || r.disconnect > 255) throw new Error('disconnect_rule is a byte');
    if (!Number.isInteger(r.claimWindowDays) || r.claimWindowDays < 0 || r.claimWindowDays > 0xffff) throw new Error('claim_window_days is 0 to 65535');
    if (typeof r.bondMinGameVerifySats !== 'bigint' || typeof r.bondMinSettlementSats !== 'bigint') throw new Error('a round names each role\'s bond floor in BigInt sats');
    w.u8(RULES_MARKER);
    for (const k of ['equivocation', 'noQuorum', 'finality', 'slashing']) w.bytes32(r[k]);
    w.u8(r.disconnect); w.u16(r.claimWindowDays); w.u64(r.bondMinGameVerifySats); w.u64(r.bondMinSettlementSats);
  }
  // THE CREATOR'S KEY (§6 `creator_pubkey`2026.0.3): the x-only key whose BIP-340 signature over the round id rides
  // beside the contract (creator.js), as the id does. Last, after its own marker, and only when named: 33 bytes, so a tail of
  // 33/37/69/73 bytes is never one of the 0/4/36/40 above, and every contract that names none keeps its bytes and its id.
  if (c.creatorPubkey !== undefined && c.creatorPubkey !== null) {
    if (!(c.creatorPubkey instanceof Uint8Array) || c.creatorPubkey.length !== 32 || c.creatorPubkey.every((b) => b === 0))
      throw new Error('a round names its creator by a 32-byte x-only key');
    if (!(version >= CREATOR_VERSION)) throw new Error(`a round names its creator from protocol version ${CREATOR_VERSION} on`);
    w.u8(CREATOR_MARKER);
    w.bytes32(c.creatorPubkey);
  }
  // THE ROUND A MARKET ON A GAME IS ON (feature 6; 2026.0.6): on a round of a game market (manifest.js `gameSource`)
  // the id of the one round of the source game whose signed result decides it. After the creator's key and before a question,
  // only when named, and only from version 6: so every contract below 6, and every one that names none, keeps its bytes and its
  // id. 34 bytes - its marker, the id, its marker again - so with it a contract's tail is one of the 16 lengths above plus 34,
  // none of which is one of those 16 (the decoder tells them apart by length alone, and only on a version-6 contract). Not on a
  // round of a series (its id H(series_id || i) would not hash the source, so the source would not be the round's), and not
  // beside a question: a market on a game asks its manifest's question, a round asking its own is a template's.
  if (c.sourceRoundId !== undefined && c.sourceRoundId !== null) {
    if (!(version >= GAME_MARKET_VERSION)) throw new Error(`a round names a source round from protocol version ${GAME_MARKET_VERSION} on`);
    if (!(c.sourceRoundId instanceof Uint8Array) || c.sourceRoundId.length !== 32 || c.sourceRoundId.every((b) => b === 0))
      throw new Error('a market on a game names its source round by a 32-byte round id');
    if (c.seriesId !== undefined && c.seriesId !== null) throw new Error('a market on a game is no round of a series: a series round\'s id H(series_id || i) does not hash its source round');
    if (c.event !== undefined && c.event !== null) throw new Error('a market on a game asks its manifest\'s question: a round that names a source round asks none of its own');
    w.u8(SOURCE_ROUND_MARKER);
    w.bytes32(c.sourceRoundId);
    w.u8(SOURCE_ROUND_MARKER);
  }
  // THE ROUND'S OWN QUESTION (feature 5): on a round of an event-market template (manifest.js `template`) the
  // question, its 2 to 16 outcome labels and its resolution time - the market's terms a round, not its manifest, names, so
  // anyone opens a question by publishing one round of the template. LAST OF ALL, after its own marker, and only when named,
  // so every contract without it keeps its bytes and its id. Its length is variable, so it also ENDS with its own length
  // and marker (contractEventTail reads it from the end); whether a template's round must carry it and a non-template's must
  // not is the manifest's to say (manifest.js roundFitsManifest), which a seat asks of every round it opens.
  if (c.event !== undefined && c.event !== null) {
    if (!(version >= EVENT_VERSION)) throw new Error(`a round asks its own question from protocol version ${EVENT_VERSION} on`);
    if (c.seriesId !== undefined && c.seriesId !== null) throw new Error('a round that asks its own question is no round of a series: a series round\'s id H(series_id || i) does not hash its question');
    const f = contractEventFits(c.event);
    if (!f.ok) throw new Error(f.why);
    const start = w.len;
    w.u8(EVENT_MARKER);
    w.str(c.event.question);
    w.vec(c.event.outcomes, (o, ww) => ww.str(o));
    w.u64(c.event.resolveAtMs);
    // A ROUND OF A SCALAR TEMPLATE NAMES ITS OWN BOUNDS (2026.0.8): two i64 after its resolution time, inside the tail - so its
    // length and closing marker cover them and every question without them keeps its bytes
    if (c.event.scalar !== undefined && c.event.scalar !== null) {
      if (!(version >= SCALAR_TEMPLATE_VERSION)) throw new Error(`a round names its own scalar bounds from protocol version ${SCALAR_TEMPLATE_VERSION} on`);
      w.i64(c.event.scalar.low); w.i64(c.event.scalar.high);
    }
    w.u16(w.len - start + 3);
    w.u8(EVENT_MARKER);
    return w.finish();
  }
  // A CONTRACT THAT ASKS NO QUESTION NEVER READS AS ONE: its last bytes (a creator key is any 32) could end like a question's
  // tail by chance, and its decoding would then be another round than the one written - refused here, never misread there
  const out = w.finish();
  if (out[out.length - 1] === EVENT_MARKER && contractEventTail(out, out.length - contractTailStart(out))) throw new Error('these contract bytes would read back as a round that asks its own question: name another creator key');
  return out;
}

/**
 * A ROUND'S OWN QUESTION (feature 5): the byte before it and after it, its limits, and the version it is read
 * from - 2026.0.4, the first version whose builds read it (a template requires it: manifest.js TEMPLATE_MIN_PROTOCOL_VERSION, so
 * only seats that read it are seated for its rounds).
 * A question of 1 to 280 UTF-8 bytes (a tweet), 2 to 16 outcome labels of 1 to 64 UTF-8 bytes each, each named once, and
 * a resolution time in ms. How many outcomes a round may name and when it may resolve is its template's (manifest.js
 * eventFitsTemplate).
 */
export const EVENT_MARKER = 0xc3;
export const EVENT_VERSION = 4;
export const EVENT_QUESTION_MAX_BYTES = 280;
export const EVENT_LABEL_MAX_BYTES = 64;
export const EVENT_OUTCOMES_MAX = 16;
// marker, the question (2 + 1), the outcome count (2), two labels (2 + 1 each), the time (8), the length (2), the marker
const EVENT_MIN_BYTES = 1 + 3 + 2 + 6 + 8 + 2 + 1;
export function contractEventFits(ev) {
  if (!ev || typeof ev !== 'object') return { ok: false, why: 'a round\'s question is an object { question, outcomes, resolveAtMs }' };
  const bytesOf = (x) => { try { return utf8Encode(x).length; } catch { return -1; } };
  if (typeof ev.question !== 'string' || bytesOf(ev.question) < 1 || bytesOf(ev.question) > EVENT_QUESTION_MAX_BYTES)
    return { ok: false, why: `a round asks its question in 1 to ${EVENT_QUESTION_MAX_BYTES} bytes of UTF-8` };
  if (!Array.isArray(ev.outcomes) || ev.outcomes.length < 2 || ev.outcomes.length > EVENT_OUTCOMES_MAX)
    return { ok: false, why: `a round's question names 2 to ${EVENT_OUTCOMES_MAX} outcomes` };
  for (const o of ev.outcomes)
    if (typeof o !== 'string' || bytesOf(o) < 1 || bytesOf(o) > EVENT_LABEL_MAX_BYTES)
      return { ok: false, why: `a round's outcome is labelled in 1 to ${EVENT_LABEL_MAX_BYTES} bytes of UTF-8` };
  if (new Set(ev.outcomes).size !== ev.outcomes.length) return { ok: false, why: 'a round names each of its outcomes once' };
  if (typeof ev.resolveAtMs !== 'bigint' || ev.resolveAtMs < 0n || ev.resolveAtMs > 0xffffffffffffffffn)
    return { ok: false, why: 'a round names its resolution time as BigInt ms' };
  if (ev.scalar !== undefined && ev.scalar !== null) {
    const sc = ev.scalar, I64 = 0x7fffffffffffffffn;
    if (typeof sc.low !== 'bigint' || typeof sc.high !== 'bigint' || sc.low < -I64 - 1n || sc.high > I64)
      return { ok: false, why: 'a round names its scalar bounds low and high as signed 64-bit BigInt whole numbers' };
    if (sc.low >= sc.high) return { ok: false, why: `a round's low bound is below its high bound; this one names low ${sc.low} and high ${sc.high}` };
    if (ev.outcomes.length !== 2) return { ok: false, why: 'a round with scalar bounds names its two sides, long then short' };
  }
  return { ok: true };
}
// Where a contract's trailing fields begin: after its node list (its last field read the same way by every version).
function contractTailStart(bytes) {
  const r = new Reader(bytes);
  r.u8(); r.u16();
  for (let i = 0; i < 4; i++) r.bytes32();                               // network, game, config, core
  r.u64(); r.u64(); r.u64(); r.u8(); r.bytes32(); r.u32(); r.u32(); r.u8(); r.bytes32(); r.u32(); r.u32(); r.bytes32(); r.u64();
  r.str(); r.vec((rr) => rr.str()); r.u8(); r.u8(); r.u64(); r.u64(); r.u16();
  for (let i = 0; i < 6; i++) r.u32();
  r.u8(); r.u8(); r.vec((rr) => rr.bytes32());
  return r.at;
}
// The tail lengths a contract may end with before its question: the deadline (4), the series (36), both (40), the rules (148)
// and the creator key (33) - 16 lengths, each unique, which decodeRoundContract reads apart.
const contractTailFits = (n) => [0, 4, 36, 40].some((b) => n === b || n === b + RULES_BYTES || n === b + 33 || n === b + RULES_BYTES + 33);
/**
 * THE QUESTION AT THE END OF A CONTRACT'S `left` TRAILING BYTES, or null: its closing marker last, its length before that
 * pointing at its opening marker, its body read whole, and what stands before it one of the tails a contract without a
 * question may end with. Anything else is no question - and the decoder then reads the tail as before (and refuses what does
 * not fit). Never throws.
 */
export function contractEventTail(bytes, left) {
  const end = bytes.length;
  if (left < EVENT_MIN_BYTES || bytes[end - 1] !== EVENT_MARKER) return null;
  const size = (bytes[end - 3] << 8) | bytes[end - 2];
  if (size < EVENT_MIN_BYTES || size > left || bytes[end - size] !== EVENT_MARKER) return null;
  if (!contractTailFits(left - size)) return null;
  try {
    const r = new Reader(bytes.subarray(end - size + 1, end - 3));
    const ev = { question: r.str(), outcomes: r.vec((rr) => rr.str()), resolveAtMs: r.u64() };
    // a scalar template's round (2026.0.8): its bounds, two i64, are what is left - the decoder holds the version to them
    if (r.b.length - r.at === 16) ev.scalar = { low: r.i64(), high: r.i64() };
    r.end();
    if (!contractEventFits(ev).ok) return null;
    return { event: ev, size };
  } catch { return null; }
}

/**
 * THE BYTE AROUND A MARKET ROUND'S SOURCE ROUND (feature 6): marker, 32-byte round id, marker - 34 bytes, after the
 * creator's key. Read from protocol version 2026.0.6 (constants.js GAME_MARKET_VERSION) on, and only there.
 */
export const SOURCE_ROUND_MARKER = 0xc4;
const SOURCE_ROUND_BYTES = 34;
/** The byte before a round's named rules (§6), before the creator's key; their tail is 148 bytes. */
export const RULES_MARKER = 0xc2;
const RULES_BYTES = 148;
/** The byte before a round's creator key (§6), last of the contract. */
export const CREATOR_MARKER = 0xc1;
/** The protocol version a round may name its creator from (2026.0.3). */
export const CREATOR_VERSION = 3;

/**
 * A CUSTODY BYTE THIS NETWORK HAS, OR THE RECORD DOES NOT PARSE (RULED 2026-09-22 22:59).
 *
 * §23.6: "a record from before this ruling that carries the old value is not a round of this network
 * and is neither decoded, replayed, settled, listed nor counted; a node that holds such a record treats
 * it as it treats BYTES THAT DO NOT PARSE. There is no decode-only label and no history exception."
 *
 * So this throws, exactly as a bad length or an unknown type byte throws. It does not return a label,
 * a null, or a flag a caller could choose to ignore - any of which would be the decode-only value the
 * ruling refuses. Every byte but FEDERATION's throws the same sentence, byte 0 as byte 2: a message
 * that named what byte 0 once was would be that label.
 */
function custodyOrRefuse(byte) {
  const name = custodyName(byte);
  if (name === null)
    throw new Error(`custody byte ${byte} is not a custody of this network: the one value is FEDERATION`);
  return name;
}

export function decodeRoundContract(bytes) {
  const r = new Reader(bytes);
  const type = r.u8();
  if (type !== TYPE_ROUND_CONTRACT) throw new Error('not a RoundContract: type ' + type);
  const version = r.u16();
  if (!speaksVersion(version))
    throw new Error('protocol version ' + version + ', this build speaks ' + PROTOCOL_VERSION);

  const c = {
    // ON THE WIRE SINCE VERSION ONE AND DISCARDED BY THIS DECODER UNTIL NOW.
    // 5d wants a node's selectability decided against the round's version, and
    // the census could not read it off a contract that did not carry it back.
    protocolVersion: version,
    networkId: r.bytes32(),
    gameId: r.bytes32(),
    configHash: r.bytes32(),
    simCoreHash: r.bytes32(),
    startTimeMs: r.u64(),
    entryCloseMs: r.u64(),
    objectionWindowMs: r.u64(),
    custody: custodyOrRefuse(r.u8()),
    federationId: r.bytes32(),
    stakeExpiryBlocks: r.u32(),
    slashMinimumServed: r.u32(),
    slashRemainder: slashRemainderOf(r.u8()),
    donationSetId: r.bytes32(),
    censusHeight: r.u32(),
    censusConfirmations: r.u32(),
    censusRoot: r.bytes32(),
    committeeTimeMs: r.u64(),
    randomnessRule: r.str(),
    publicationRelays: r.vec((rr) => rr.str()),
    gameVerifySlots: r.u8(),
    settlementSlots: r.u8(),
    stakeMsat: r.u64(),
    bondMinSats: r.u64(),
    blockTicks: r.u16(),
    exposureReference: r.u32(),
    corridorHalfWidth: r.u32(),
    spawnFreeRadius: r.u32(),
    timeFloor: r.u32(),
    timeCeil: r.u32(),
    minScore: r.u32(),
    rankNumerator: r.u8(),
    rankDenominator: r.u8(),
    nodes: r.vec((rr) => rr.bytes32()),
  };
  // The start deadline, present only when the round named one that is not the
  // default. Written as the default it would be a second encoding of one round. And after it the series and the
  // index, only on a round of a series: 4 bytes left is the deadline, 36 the series, 40 both.
  let left = r.b.length - r.at;
  // THE ROUND'S OWN QUESTION, last of all when named (feature 5): read from the end by its closing marker and length
  const asked = contractEventTail(r.b, left);
  const tailEnd = asked ? r.b.length - asked.size : r.b.length;
  if (asked) left -= asked.size;
  // THE SOURCE ROUND OF A MARKET ON A GAME (feature 6), before the question: 34 bytes between two markers, looked for
  // ONLY on a contract of version 6 or later - a contract below 6 is read exactly as before - and only when what stands before
  // it is one of the tails a contract may end with (no tail of those 16 lengths is another one plus 34)
  const sourceAt = c.protocolVersion >= GAME_MARKET_VERSION && left >= SOURCE_ROUND_BYTES && contractTailFits(left - SOURCE_ROUND_BYTES)
    && r.b[tailEnd - 1] === SOURCE_ROUND_MARKER && r.b[tailEnd - SOURCE_ROUND_BYTES] === SOURCE_ROUND_MARKER ? tailEnd - SOURCE_ROUND_BYTES : -1;
  if (sourceAt >= 0) left -= SOURCE_ROUND_BYTES;
  const beforeSource = sourceAt >= 0 ? sourceAt : tailEnd;
  // THE CREATOR'S KEY, last when named: 33 more bytes, its marker first; and before it the rules, 148
  const base = [0, 4, 36, 40];
  const creatorAt = base.some((b) => left === b + 33 || left === b + RULES_BYTES + 33) ? beforeSource - 33 : -1;
  if (creatorAt >= 0) {
    if (r.b[creatorAt] !== CREATOR_MARKER) throw new Error(`a round contract with ${left} trailing bytes`);
    left -= 33;
  }
  const rulesAt = base.some((b) => left === b + RULES_BYTES) ? r.at + left - RULES_BYTES : -1;
  if (rulesAt >= 0) {
    if (r.b[rulesAt] !== RULES_MARKER) throw new Error(`a round contract with ${left} trailing bytes`);
    left -= RULES_BYTES;
  }
  if (left !== 0 && left !== 4 && left !== 36 && left !== 40) throw new Error(`a round contract with ${left} trailing bytes`);
  if (left === 4 || left === 40) {
    const d = r.u32();
    if (d === START_DEADLINE_TICKS) throw new Error('a start deadline equal to the default is written by omitting it');
    if (d < 1 || d >= c.blockTicks) throw new Error(`a start deadline of ${d} ticks is outside 1 to below the round's ${c.blockTicks}`);
    c.startDeadlineTicks = d;
  }
  if (left === 36 || left === 40) {
    c.seriesId = r.bytes32();
    c.roundIndex = r.u32();
  }
  if (rulesAt >= 0) {
    r.u8();
    const rules = {};
    for (const k of ['equivocation', 'noQuorum', 'finality', 'slashing']) rules[k] = r.bytes32();
    rules.disconnect = r.u8(); rules.claimWindowDays = r.u16(); rules.bondMinGameVerifySats = r.u64(); rules.bondMinSettlementSats = r.u64();
    c.rules = rules;
    if (!(c.protocolVersion >= CREATOR_VERSION)) throw new Error(`a round names its rules from protocol version ${CREATOR_VERSION} on`);
  }
  if (creatorAt >= 0) {
    r.u8();
    c.creatorPubkey = r.bytes32();
    if (c.creatorPubkey.every((b) => b === 0)) throw new Error('a round names its creator by a 32-byte x-only key');
    if (!(c.protocolVersion >= CREATOR_VERSION)) throw new Error(`a round names its creator from protocol version ${CREATOR_VERSION} on`);
  }
  if (sourceAt >= 0) {
    r.u8();
    c.sourceRoundId = r.bytes32();
    r.u8();
    if (c.sourceRoundId.every((b) => b === 0)) throw new Error('a market on a game names its source round by a 32-byte round id');
    if (c.seriesId !== undefined) throw new Error('a market on a game is no round of a series');
  }
  if (asked) {
    r.bytes(asked.size);                                      // read whole by contractEventTail
    c.event = asked.event;
    if (!(c.protocolVersion >= EVENT_VERSION)) throw new Error(`a round asks its own question from protocol version ${EVENT_VERSION} on`);
    if (c.event.scalar && !(c.protocolVersion >= SCALAR_TEMPLATE_VERSION)) throw new Error(`a round names its own scalar bounds from protocol version ${SCALAR_TEMPLATE_VERSION} on`);
    if (c.seriesId !== undefined) throw new Error('a round that asks its own question is no round of a series');
  }
  r.end();
  // AND BYTES FROM ANYWHERE ARE HELD TO THE SAME (M3 W7): a paying FEDERATION round naming none is refused.
  const named = federationIsNamed(c);
  if (!named.ok) throw new Error(named.why);
  return c;
}

/**
 * THE ROUND'S ID. A round of a series: H(series_id || i) - the series fixes the round, and a node holds its contract
 * only when it is exactly the one the series derives (series.js seriesRoundCheck). Any other round: its contract's hash.
 */
export const roundId = (c) => {
  if (c && c.seriesId !== undefined && c.seriesId !== null) {
    encodeRoundContract(c);                                   // a contract that does not encode has no id
    return seriesRoundIdOf(c.seriesId, c.roundIndex);
  }
  return taggedHash(TAG.roundContract, encodeRoundContract(idBodyOf(c)));
};
/** Round i of a series' id, H(series_id || i), from the two alone (a seat looking at a series' earlier rounds). */
export function seriesRoundIdOf(seriesIdBytes, index) {
  const i = new Uint8Array(4); new DataView(i.buffer).setUint32(0, index, false);
  const body = new Uint8Array(36); body.set(seriesIdBytes, 0); body.set(i, 32);
  return taggedHash(TAG.seriesRound, body);
}
/**
 * THE BYTES A ROUND'S ID HASHES (2026.0.2): a v2 contract's with `nodes` emptied - the seated nodes are the
 * draw's answer, written in by each seat after it, and never an input to the draw - and a v1 contract's whole, as before.
 */
export const idBodyOf = (c) => (namesNoDraw(c) ? { ...c, nodes: [] } : c);

/**
 * IS THIS CONTRACT FOR THIS BUILD'S NETWORK, AND FOR RULES IT IS RUNNING?
 *
 * 27A.4: "nodes and clients reject contracts that do not match the one they
 * were built for". 27A.9: "The trust anchor is the client's own built-in
 * `network_id`, NEVER A VALUE FROM THE CONTRACT" - so the anchor is handed in
 * and is not read off the thing being judged, the same discipline
 * `censusRootMatchesRound` needed for its entries.
 *
 * AND 27A.7.5, the config half: "A node that has not upgraded simply stops
 * being selectable for rounds naming the new hash... It is not ejected and it
 * is not slashed; it serves nothing." That is why this answers rather than
 * throwing, and why the refusal names which of the two failed: not serving a
 * round is an ordinary outcome, not an error.
 *
 * This build's anchors are testnet4 + the live core config. A contract naming
 * another network is not selectable, not slashed.
 */
export function contractIsForThisBuild(contract, { anchor, config } = {}) {
  if (!contract || !is32(contract.networkId))
    return { ok: false, why: 'that contract names no network' };
  if (!is32(contract.configHash))
    return { ok: false, why: 'that contract names no config' };
  if (!is32(anchor))
    return { ok: false, why: 'this build names no network to check it against' };
  if (!is32(config))
    return { ok: false, why: 'this build names no config to check it against' };

  if (!contract.networkId.every((b, i) => b === anchor[i]))
    return {
      ok: false,
      why: 'that contract is for another network: a fork that changes the '
        + 'donation authority is a different network, not a theft',
    };
  if (!contract.configHash.every((b, i) => b === config[i]))
    return {
      ok: false,
      why: 'that round runs a config this build is not running, so it is not '
        + 'selectable for it - not ejected, not slashed, it serves nothing',
    };
  return { ok: true, why: 'that contract is for this network and this config' };
}

const is32 = (v) => v instanceof Uint8Array && v.length === 32;

export function encodeEntryContract(e) {
  const w = new Writer();
  w.u8(TYPE_ENTRY_CONTRACT);
  w.u16(PROTOCOL_VERSION);
  w.bytes32(e.roundId);
  w.bytes32(e.playerPubkey);
  w.bytes32(e.sessionPubkey);
  w.bytes32(e.stakeCommitment);      // H(P), the hold-invoice preimage commitment
  w.u64(e.stakeMsat);
  w.u64(e.feeMsat);
  w.u64(e.donationMsat);
  w.u32(e.joinTick);
  // 2026-09-08: the world secret is on the entry so a node can replay.
  w.bytes32(e.worldSecret);
  // 23.1's `vss_shares_ref`: the id of the handout this entry's stake preimage
  // was split into. IN THE SIGNED BYTES, because that is the whole of what it
  // buys - a reference a player could change after signing would let a dealer
  // swap the polynomial under a committee that had already checked one.
  //
  // 32 zero bytes is a real value and means "this entry publishes no shares",
  // which is every entry in M2 until a stake exists to protect. It is not a
  // default the encoder supplies: a caller says which it means, because an
  // entry that forgot the field and an entry that has no shares must not be
  // the same bytes by accident.
  w.bytes32(e.vssSharesRef);

  // THE STAKE LOCK'S HALF OF THE ENTRY, section 7 (v4.6.2), §23.1 steps 0-5:
  //
  //   stake_point                P.G - a POINT, so a signer node can check Feldman's
  //                              A0 against it; with only H(P) a loser could
  //                              deal consistent shares of Q != P and escape
  //                              at expiry (F1)
  //   fee_preimage               F in clear: opens the fee lock once FINAL
  //   stake_lock_outpoint,       where the federation holds the two locks -
  //   fee_lock_outpoint          Fedimint's (txid, out_idx)
  //   claim_key_attestation_ref  the >=5 signer node signatures on (round_id, claim_pk)
  //
  // `stakeCommitment` = H(P) stays above them while the hold invoice is the
  // path that ships: its payment hash is that hash. Zeros in every one of these
  // name "no stake lock", which is every entry until the lock is wired - said
  // by the caller, never supplied here.
  w.bytes(e.stakePoint, STAKE_POINT_BYTES);
  w.bytes32(e.feePreimage);
  writeOutpoint(w, e.stakeLockOutpoint, 'stakeLockOutpoint');
  writeOutpoint(w, e.feeLockOutpoint, 'feeLockOutpoint');
  w.bytes32(e.claimKeyAttestationRef);
  // THE DONATION OUTPOINTS (2026-10-03, FEDERATION.md "Donations in the federation"): where the player's lock
  // transaction paid each recipient key of a set of keys its share - in the set's order, one per share above 0 msat
  // (donationOutputsExpected). WRITTEN ONLY WHEN THERE ARE ANY: an entry that pays no key - every entry before this, every
  // LNURL round - keeps exactly its bytes and its id. An empty list is never written, so an entry has one encoding.
  const donations = e.donationOutpoints || [];
  if (!Array.isArray(donations)) throw new Error('donationOutpoints is a list of federation outpoints');
  if (donations.length) w.vec(donations, (o, ww) => writeOutpoint(ww, o, 'a donation outpoint'));
  // THE PICK (§0A.7a): on a round of an attested game the entry backs one outcome by its index, in place of a
  // run. WRITTEN ONLY WHEN THERE IS ONE, after a marker no donation list can start with (its u16 count's first byte is 0
  // below 256 outpoints): every entry before this keeps exactly its bytes and its id.
  if (e.pick !== undefined && e.pick !== null) {
    if (!Number.isInteger(e.pick) || e.pick < 0 || e.pick > 255) throw new Error('a pick is an outcome index, 0 to 255');
    w.u8(PICK_MARKER);
    w.u8(e.pick);
  }
  // A MARKET ORDER (comment 1127): an entry whose pick is bought at a LIMIT PRICE (order-book.js, a fraction of
  // PRICE_SCALE in whole cents) and that stands until its EXPIRY (ms, 0: until it fills or is cancelled). Its stake lock is
  // its budget less its fee, its fee lock the fee - the locks every entry has. WRITTEN ONLY WHEN IT IS ONE, after the pick
  // and its own marker: every other entry keeps exactly its bytes and its id.
  if (e.limitPrice !== undefined && e.limitPrice !== null) {
    if (e.pick === undefined || e.pick === null) throw new Error('an order buys an outcome: it names a pick');
    if (!Number.isInteger(e.limitPrice) || e.limitPrice < 1 || e.limitPrice > 0xffffffff) throw new Error('a limit price is a whole number of the price scale');
    if (typeof (e.orderExpiryMs ?? 0n) !== 'bigint') throw new Error('an order\'s expiry is BigInt ms');
    w.u8(ORDER_MARKER);
    w.u32(e.limitPrice);
    w.u64(e.orderExpiryMs ?? 0n);
  }
  // THE HIDDEN MOVE: on a round of a head-to-head game the entry names H(round_id || session key || move ||
  // salt) (head-to-head.js), revealed after entry close. WRITTEN ONLY WHEN THERE IS ONE, after its own marker: every
  // other entry keeps exactly its bytes and its id. An entry backs a pick or hides a move, never both.
  if (e.commit !== undefined && e.commit !== null) {
    if (e.pick !== undefined && e.pick !== null) throw new Error('an entry backs an outcome or hides a move, not both');
    if (!(e.commit instanceof Uint8Array) || e.commit.length !== 32) throw new Error('a move commitment is 32 bytes');
    w.u8(COMMIT_MARKER);
    w.bytes32(e.commit);
  }
  // THE FEDERATION ITS LOCKS ARE IN (2026.0.3): on a round that takes any federation (takesAnyFederation) the entry
  // names where its stake and fee locks are. WRITTEN ONLY WHEN THERE IS ONE, last, after its own marker: every other entry keeps
  // exactly its bytes and its id.
  if (e.federationId !== undefined && e.federationId !== null) {
    if (!(e.federationId instanceof Uint8Array) || e.federationId.length !== 32 || e.federationId.every((b) => b === 0))
      throw new Error('an entry names its federation in 32 bytes, not zero');
    w.u8(FEDERATION_MARKER);
    w.bytes32(e.federationId);
  }
  // THE OPERATOR THIS PLAYER IS (§7 `operator_id_declaration`, §5A.13): "none" or the operator's key. WRITTEN ONLY
  // WHEN IT NAMES ONE, last, after its own marker: "none" is no bytes, so every other entry keeps exactly its bytes and its id.
  if (e.operatorId !== undefined && e.operatorId !== null) {
    if (!(e.operatorId instanceof Uint8Array) || e.operatorId.length !== 32 || e.operatorId.every((b) => b === 0))
      throw new Error('an entry declares its operator in 32 bytes, not zero ("none" is no declaration)');
    w.u8(OPERATOR_MARKER);
    w.bytes32(e.operatorId);
  }
  // THE WEBSITE THAT BROUGHT THIS ENTRY (2026.0.9): its 33-byte payout key, paid 20% of the nodes' fee on this
  // stake at settlement (fee.js frontendShares). In the signed bytes, so no seat can swap it. WRITTEN ONLY WHEN IT NAMES ONE, last
  // of all, after its own marker: every other entry keeps exactly its bytes and its id.
  if (e.frontendPk !== undefined && e.frontendPk !== null) {
    if (!(e.frontendPk instanceof Uint8Array) || e.frontendPk.length !== 33 || (e.frontendPk[0] !== 2 && e.frontendPk[0] !== 3))
      throw new Error('an entry names the website that brought it by a 33-byte compressed payout key');
    w.u8(FRONTEND_MARKER);
    w.bytes(e.frontendPk, 33);
  }
  // THE ITEMS THIS ENTRY PLAYS WITH (protocol 10): each an item of the round's game by its id, the purchase that made its
  // owner, and the owner's proof - the BIP340 signature, by the key the purchase names (player-key.js itemsSecretFor),
  // over entryItemDigest(round, this entry's player key, purchase): the entry's key is fresh per round, the owner's is not, so the
  // seats check the purchase is kept and that its buyer signed for this entry. WRITTEN ONLY WHEN IT NAMES ANY, last of all, after its
  // own marker: every other entry keeps exactly its bytes and its id. Sorted by item id, each once.
  if (e.items !== undefined && e.items !== null) {
    if (!Array.isArray(e.items) || e.items.length < 1 || e.items.length > ENTRY_ITEMS_MAX) throw new Error(`an entry plays with 1 to ${ENTRY_ITEMS_MAX} items`);
    for (let i = 0; i < e.items.length; i++) {
      const it = e.items[i];
      if (!it || typeof it.itemId !== 'string' || !/^[a-z0-9][a-z0-9-]{0,31}$/.test(it.itemId) || !(it.purchaseId instanceof Uint8Array) || it.purchaseId.length !== 32)
        throw new Error('an entry names an item by its id and the 32-byte id of the purchase that made it the player\'s');
      if (!(it.ownerSig instanceof Uint8Array) || it.ownerSig.length !== 64)
        throw new Error('an entry\'s item carries its owner\'s 64-byte signature (entryItemDigest)');
      if (i > 0 && !(e.items[i - 1].itemId < it.itemId)) throw new Error('an entry\'s items are sorted by id, each once');
    }
    w.u8(ITEMS_ENTRY_MARKER);
    w.vec(e.items, (it, ww) => { ww.str(it.itemId); ww.bytes32(it.purchaseId); ww.bytes(it.ownerSig, 64); });
  }
  // THE RESERVE LOCK (protocol 11, §27A.9.2): where the entry's lock transaction locked the round's 2 % to the
  // federation's reserve key. WRITTEN ONLY WHEN THERE IS ONE, last of all, after its own marker: every other entry keeps exactly
  // its bytes and its id.
  if (e.reserveOutpoint !== undefined && e.reserveOutpoint !== null) {
    w.u8(RESERVE_ENTRY_MARKER);
    writeOutpoint(w, e.reserveOutpoint, 'reserveOutpoint');
  }
  // A BOT'S ENTRY (kanban #581, 2026-10-22: "The bots are also marked as bots, so they are excluded from the leaderboard. There is
  // a flag in the API and protocol to mark them as bots"): the market maker bots sign it in their own entry, so no seat can add or take it
  // away; the leaderboard leaves such entries out. WRITTEN ONLY FOR A BOT, last of all, its marker alone: every other entry keeps exactly
  // its bytes and its id.
  if (e.bot !== undefined && e.bot !== null && e.bot !== false) {
    if (e.bot !== true) throw new Error('an entry is a bot\'s (true) or not');
    w.u8(BOT_MARKER);
  }
  return w.finish();
}

/**
 * WHAT AN ITEM'S OWNER SIGNS FOR AN ENTRY: taggedHash("ARENA/v1/EntryItem", round id || the entry's player key ||
 * purchase id). Bound to the round and to this entry's key, so the proof is no good on any other entry.
 */
export function entryItemDigest({ roundId, playerPubkey, purchaseId }) {
  for (const [n, b] of [['round id', roundId], ['player key', playerPubkey], ['purchase id', purchaseId]])
    if (!(b instanceof Uint8Array) || b.length !== 32) throw new Error(`an entry item's proof names its ${n} in 32 bytes`);
  const m = new Uint8Array(96); m.set(roundId, 0); m.set(playerPubkey, 32); m.set(purchaseId, 64);
  return taggedHash(TAG.entryItem, m);
}

/** The byte before the items an entry plays with (protocol 10), last of all. */
export const ITEMS_ENTRY_MARKER = 0xad;
/** An entry's reserve lock outpoint follows (protocol 11). */
export const RESERVE_ENTRY_MARKER = 0xae;
/** The byte that says the entry is a bot's (kanban #581), last of all - no payload. */
export const BOT_MARKER = 0xaf;
export const ENTRY_ITEMS_MAX = 8;

/** The byte before an entry's pick: never the first byte of a donation list (its count < 256 starts with 0). */
export const PICK_MARKER = 0xa7;
/** The byte before an entry's move commitment (head-to-head), likewise never a donation list's first byte. */
export const COMMIT_MARKER = 0xa8;
/** The byte before a market order's limit price and expiry, after its pick. */
export const ORDER_MARKER = 0xa9;
/** The byte before the federation an entry's locks are in (2026.0.3), last. */
export const FEDERATION_MARKER = 0xaa;
/** The byte before the payout key of the website that brought the entry (2026.0.9), last of all. */
export const FRONTEND_MARKER = 0xac;
/** The byte before the operator an entry's player declares it is (§7, §5A.13), before the website's key. */
export const OPERATOR_MARKER = 0xab;

/** The same compressed point as a Feldman commitment (`handout.js`). */
export const STAKE_POINT_BYTES = 33;

function writeOutpoint(w, o, name) {
  if (!o || typeof o !== 'object') throw new Error(`${name} is a federation outpoint { txid, outIdx }`);
  w.bytes32(o.txid);
  w.u64(o.outIdx);
}

const readOutpoint = (r) => ({ txid: r.bytes32(), outIdx: r.u64() });

export function decodeEntryContract(bytes) {
  const r = new Reader(bytes);
  if (r.u8() !== TYPE_ENTRY_CONTRACT) throw new Error('not an EntryContract');
  const version = r.u16();
  if (!speaksVersion(version)) throw new Error('protocol version ' + version);
  const e = {
    roundId: r.bytes32(),
    playerPubkey: r.bytes32(),
    sessionPubkey: r.bytes32(),
    stakeCommitment: r.bytes32(),
    stakeMsat: r.u64(),
    feeMsat: r.u64(),
    donationMsat: r.u64(),
    joinTick: r.u32(),
    worldSecret: r.bytes32(),
    vssSharesRef: r.bytes32(),
    stakePoint: r.bytes(STAKE_POINT_BYTES),
    feePreimage: r.bytes32(),
    stakeLockOutpoint: readOutpoint(r),
    feeLockOutpoint: readOutpoint(r),
    claimKeyAttestationRef: r.bytes32(),
  };
  // the tail markers after the pick/move section: the federation, then the operator - either may stand alone
  // the bot mark ends an entry too (kanban #581: a bot's entry with no donation outputs, or a pick and no order, read the mark as a list)
  const tail = (b) => b === FEDERATION_MARKER || b === OPERATOR_MARKER || b === FRONTEND_MARKER || b === ITEMS_ENTRY_MARKER || b === RESERVE_ENTRY_MARKER || b === BOT_MARKER;
  if (r.at < bytes.length && bytes[r.at] !== PICK_MARKER && bytes[r.at] !== COMMIT_MARKER && !tail(bytes[r.at])) {
    e.donationOutpoints = r.vec(readOutpoint);
    if (!e.donationOutpoints.length) throw new Error('an empty list of donation outpoints is not written: these bytes are not an entry\'s one encoding');
  }
  if (r.at < bytes.length && !tail(bytes[r.at])) {
    const marker = r.u8();
    if (marker === PICK_MARKER) e.pick = r.u8();
    else if (marker === COMMIT_MARKER) e.commit = r.bytes32();
    else throw new Error('these bytes carry something after the entry that is neither a pick nor a move commitment');
    if (marker === PICK_MARKER && r.at < bytes.length && !tail(bytes[r.at])) {
      if (r.u8() !== ORDER_MARKER) throw new Error('these bytes carry something after the pick that is not an order');
      e.limitPrice = r.u32();
      e.orderExpiryMs = r.u64();
    }
  }
  if (r.at < bytes.length && bytes[r.at] === FEDERATION_MARKER) {
    r.u8();
    e.federationId = r.bytes32();
    if (e.federationId.every((b) => b === 0)) throw new Error('an entry names its federation in 32 bytes, not zero');
  }
  if (r.at < bytes.length && bytes[r.at] === OPERATOR_MARKER) {
    r.u8();
    e.operatorId = r.bytes32();
    if (e.operatorId.every((b) => b === 0)) throw new Error('an entry declares its operator in 32 bytes, not zero');
  }
  if (r.at < bytes.length && bytes[r.at] === FRONTEND_MARKER) {
    r.u8();
    e.frontendPk = r.bytes(33);
    if (e.frontendPk[0] !== 2 && e.frontendPk[0] !== 3) throw new Error('an entry names the website that brought it by a 33-byte compressed payout key');
  }
  if (r.at < bytes.length && bytes[r.at] === ITEMS_ENTRY_MARKER) {
    r.u8();
    e.items = r.vec((rr) => ({ itemId: rr.str(), purchaseId: rr.bytes32(), ownerSig: rr.bytes(64) }));
    if (!e.items.length) throw new Error('an empty list of items is not written: these bytes are not an entry\'s one encoding');
  }
  if (r.at < bytes.length && bytes[r.at] === RESERVE_ENTRY_MARKER) {
    r.u8();
    e.reserveOutpoint = readOutpoint(r);
  }
  if (r.at < bytes.length) {
    if (r.u8() !== BOT_MARKER) throw new Error('these bytes carry something after the entry that is neither its federation, its operator, its website, its items, its reserve lock nor the bot mark');
    e.bot = true;
  }
  r.end();
  return e;
}

export const entryId = (e) => taggedHash(TAG.entryContract, encodeEntryContract(e));

/**
 * DO THE SHARES OPEN TO THE LOCK'S OWN SECRET? §23.1 step 2 (v4.6.2, F1): "Each
 * signer node verifies its share against the commitments AND THAT THE CONSTANT
 * COMMITMENT A0 EQUALS stake_point, and refuses the entry otherwise."
 *
 * Byte equality of two compressed points is point equality. An entry naming no
 * stake point is refused rather than passed: "no point" must never read as "a
 * point that matched".
 */
export function stakePointIsTheHandouts(entry, handout) {
  if (!entry || !(entry.stakePoint instanceof Uint8Array) || entry.stakePoint.length !== STAKE_POINT_BYTES)
    return { ok: false, why: 'that entry names no 33-byte stake point' };
  if (entry.stakePoint.every((b) => b === 0))
    return { ok: false, why: 'that entry names no stake point, so no share can be checked against it' };
  const a0 = handout && Array.isArray(handout.commitments) ? handout.commitments[0] : undefined;
  if (!(a0 instanceof Uint8Array) || a0.length !== STAKE_POINT_BYTES)
    return { ok: false, why: 'that handout publishes no constant commitment A0' };
  for (let i = 0; i < STAKE_POINT_BYTES; i++)
    if (a0[i] !== entry.stakePoint[i])
      return {
        ok: false,
        why: 'the handout\'s A0 is not the entry\'s stake point: these shares open to a '
          + 'different secret than the lock',
      };
  return { ok: true };
}

/**
 * IS THIS ROUND'S RUN LENGTH THE ONE THE SIMULATOR ACTUALLY USES?
 *
 * `blockTicks` is section 6's `player_run_duration` in the unit the core
 * counts in, and the core is where it lives: `rules/gate.js` ends a run
 * `RUN_MISSED` at `BLOCK_TICKS` elapsed ticks, and `genesis.js` writes that
 * same number into the config hash a contract's `network_id` commits to.
 *
 * So the field on the contract is section 6's own words - "echoed for
 * readability; MUST equal genesis_parameters, which network_id commits to. A
 * contract disagreeing with the network it names is invalid" - and this is
 * that check, the same one letter 16 wrote for the committee slot counts.
 *
 * MEASURED BEFORE IT EXISTED: a round naming 9000, one naming 4500 and one
 * naming 1 were all accepted, while the core stopped every run at 9000
 * regardless. The number on the wire meant nothing, and a node bounded batches
 * with it - a second clock disagreeing with the first, which is exactly what
 * letter 21 put the tick in the core to prevent.
 */
//
// AND SINCE M3 R1 R3 (2026-09-15 08:07: several cores at once) "the core" is the ROUND'S core
// under the round's config - handed in as `coreTicks` by whoever resolved it (the signer node's plugins.js) -
// and no longer the truck's BLOCK_TICKS read from its rules: the protocol names no game.
export function runLengthIsTheCores(contract, coreTicks) {
  if (!contract || !Number.isInteger(contract.blockTicks))
    return { ok: false, why: 'that round names no run length' };
  if (!Number.isInteger(coreTicks) || coreTicks < 1)
    return { ok: false, why: 'there is no core run length to check that round against' };
  if (contract.blockTicks !== coreTicks)
    return {
      ok: false,
      why: `that round says a run is ${contract.blockTicks} ticks and this core ends one at `
        + `${coreTicks}: a contract disagreeing with the network it names is invalid, and a `
        + 'second clock is not a shorter round',
    };
  return { ok: true, blockTicks: coreTicks };
}

/**
 * THE LAST TICK A RUN MAY CARRY, for an entry that joined at `joinTick`: THE ROUND'S LAST TICK, for every entry.
 *
 * EVERY RUN OF A ROUND ENDS AT THE ROUND'S 82 s (2026-10-04 14:30: "They always end at the 82/90
 * boundary: the run ends at 82 s, the slot at 90 s. A later join does not extend the round. The late joiner has less
 * time"). Ticks are counted from the round's start; an entry joined at tick J carries ticks J .. blockTicks - 1, and its
 * run is blockTicks - J (runTicksForEntry). Before, the last tick was joinTick + blockTicks - 1 - a whole run from the
 * join - which every entry made so far met with joinTick 0, the same tick as now: old rounds replay as they did.
 */
export function lastTickOfRun(joinTick, blockTicks) {
  // The run length is the round's (its contract's blockTicks, checked against its core) - M3 R1 R3.
  if (!Number.isInteger(blockTicks) || blockTicks < 1)
    throw new Error('a run\'s last tick is counted from the round\'s run length, and none was given');
  if (!Number.isInteger(joinTick) || joinTick < 0 || joinTick >= blockTicks)
    throw new Error(`an entry joins at a tick of the round's run, 0 to ${blockTicks - 1}, not ${joinTick}`);
  return blockTicks - 1;
}

// THE LAST ENTRY OF A LATE-JOIN ROUND (2026-10-04 14:30: "Join closes when 45 s remain. A player who
// would have 45 s or less left must not enter"): remaining is the round clock to its run's end at start + 82 s, so an entry
// is taken only before start + 37 s; at that instant 45 s remain and it is refused. Stricter than the bytes (entry_close
// start + 45 s), which stay as posted: no new series.
export const LATE_JOIN_RUN_MS = 82000n;
export const LATE_JOIN_LEFT_MS = 45000n;
export const LATE_JOIN_LAST_ENTRY_MS = LATE_JOIN_RUN_MS - LATE_JOIN_LEFT_MS;   // 37 000 ms after the start

/** THE RUN AN ENTRY GETS: from its join tick to the round's last tick - blockTicks - joinTick ticks. */
export function runTicksForEntry(joinTick, blockTicks) {
  return lastTickOfRun(joinTick, blockTicks) - joinTick + 1;
}


function compare32(a, b) {
  for (let i = 0; i < 32; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

/**
 * Warnings a client must show before a player stakes anything.
 *
 * Spec 18A.7: a contract whose rank curve is flat, or whose paying ranks cover
 * most of the field, is one whose safe route is positive expected value. The
 * protocol does not forbid it - balance is not protocol - but a player is
 * entitled to know before paying.
 */
/**
 * THE 5A.5 WINDOWS: is there time to enter this round at all?
 *
 *   entry_open_time == committee_time
 *   start_time      >= committee_time + min_entry_window
 *
 * ENTRY OPENS AT COMMITTEE_TIME, and that is not a policy this contract can
 * set differently: 23.1 encrypts the preimage shares TO the settlement
 * committee, so an entry cannot be constructed before the committee exists.
 * There is no separate `entry_open_time` on this contract and there must not
 * be one - a second field could disagree with `committee_time`, and the spec's
 * own line is an equality, not a range. So the equality holds by construction
 * and what is checked here is the half that can be got wrong: the window
 * AFTER it.
 *
 * A round with no window is not a strict round, it is one nobody can join -
 * the committee appears and the round has already begun.
 */
export function roundWindowsAreValid(c) {
  if (!c || typeof c.committeeTimeMs !== 'bigint')
    return { ok: false, why: 'that round names no committee time, so nothing says when entry opens' };
  if (typeof c.startTimeMs !== 'bigint')
    return { ok: false, why: 'that round names no start time' };

  const opensAt = c.committeeTimeMs;
  const earliestStart = opensAt + MIN_ENTRY_WINDOW_MS;
  if (c.startTimeMs < earliestStart)
    return {
      ok: false,
      opensAt,
      why: `that round starts at ${c.startTimeMs} and its committee forms at ${opensAt}, `
        + `leaving ${c.startTimeMs - opensAt}ms to enter where this protocol asks for `
        + `${MIN_ENTRY_WINDOW_MS}`,
    };

  // AND THE LAST LATE JOIN CANNOT BE BEFORE THE FIRST. `entry_close_time` is
  // the end of the same window entry_open_time begins.
  if (typeof c.entryCloseMs === 'bigint' && c.entryCloseMs < opensAt)
    return {
      ok: false,
      opensAt,
      why: `that round closes entry at ${c.entryCloseMs}, before its committee forms at ${opensAt}`,
    };

  // AND ITS OBJECTION WINDOW IS EXACTLY 600 000 ms (§13A, WINDOW-10-SPEC, RULED 2026-10-01 09:40): "A Round
  // Contract whose objection_window_W is not exactly 600000 ms is invalid: a node refuses to open it, list it or take an
  // entry for it." The field was contract-defined with a 10-minute reference and a 6-hour cap; neither stands.
  if (typeof c.objectionWindowMs !== 'bigint')
    return { ok: false, opensAt, why: 'that round names no objection window, so nothing says when a result may become final' };
  if (c.objectionWindowMs !== OBJECTION_WINDOW_MS)
    return {
      ok: false,
      opensAt,
      why: `that round's objection window is ${c.objectionWindowMs}ms: the objection window is exactly ${OBJECTION_WINDOW_MS}ms `
        + '(600 s of wall time from the round\'s end, §13A), so the contract is invalid',
    };

  return { ok: true, opensAt, earliestStart };
}

/**
 * DO THE CUSTODY FIELDS SAY WHAT v4.6.2 RULES?
 *
 * Three things the spec states and a contract can get wrong: the expiry is
 * 144 blocks (ruled 2026-09-11, §23.1) - not a number an author tunes; a round
 * that takes a stake into a FEDERATION names which one (§23.6); and every relay
 * is a URL, each once (§13A). Whether the named federation's guardians are
 * bonded census nodes is the client's check against the census, not this one.
 */
const RELAY_SCHEMES = ['http:', 'https:', 'ws:', 'wss:'];

// `manifest`: the round's game's, where the checker knows it - a market's round names its own lock span (lock-expiry.js,
//), every other round the ruled 144
export function custodyFieldsAreValid(c, { manifest = null } = {}) {
  if (!c) return { ok: false, why: 'no contract' };
  const span = stakeExpiryFits(c, { manifest });
  if (!span.ok) return span;
  if (!is32(c.federationId)) return { ok: false, why: 'that round names no 32-byte federation_id' };
  const named = federationIsNamed(c);
  if (!named.ok) return named;
  return publicationRelaysAreValid(c);
}

/**
 * DOES A ROUND THAT TAKES A STAKE INTO A FEDERATION SAY WHICH ONE? (§23.6, M3 W7). A zero
 * federation_id on a paying FEDERATION round is unsigned custody - nothing says who holds its
 * stake locks - so such a contract is not a contract: encoding and decoding refuse it, for every
 * builder and for bytes from anywhere. A free round moves no money and names no federation; it
 * passes. Whether the named federation's guardians are bonded census nodes is
 * federationIsBonded, parked with "which guardians".
 */
export function federationIsNamed(c) {
  if (!c) return { ok: false, why: 'no contract' };
  if (!(typeof c.stakeMsat === 'bigint' && c.stakeMsat > 0n)) return { ok: true };
  // FROM 2026.0.3 A ZERO federation_id IS "ANY": each entry names the federation its lock is in (takesAnyFederation)
  if (takesAnyFederation(c)) return { ok: true };
  if (!is32(c.federationId) || c.federationId.every((b) => b === 0))
    return {
      ok: false,
      why: 'that round takes a stake into a FEDERATION and names no federation_id, '
        + 'so nothing says who holds its stake locks',
    };
  return { ok: true };
}

/**
 * CAN THIS ROUND'S TRANSCRIPTS BE POSTED ANYWHERE? Every relay a URL, each
 * once (§13A) - and at least one on a round that takes a stake. Since P2 no
 * result is FINAL until the round's settlement signer nodes have posted its
 * transcript to these relays, so a paying round naming none could never settle
 * a stake it took: measured, two daemons opened one, held both players' stakes
 * and were still provisionally final after the window. A free round moves no
 * money and may name none.
 */
/**
 * A ROUND MAY NOT NAME MORE SITTING SEATS THAN ITS OWN POOLS HAVE SLOTS (§22A).
 *
 * 22A pays the node fee to "the round's **sitting seats** - the seats the census seated for this round, its
 * `nodes` - however many there are: two in a 2-of-2, seven in a 5-of-7", and says it again as a warning:
 * "**Not seven census slots when the round is 2-of-2**". A fee lock is sized for the same seats the
 * settlement pays, so a contract that names seven seats on a two-slot round mints a lock divided seven ways
 * and a settlement that pays seven - from a committee of two. The extra shares go to seats that never sat.
 *
 * MEASURED BEFORE THIS EXISTED: `feeLockPays` reads `contract.nodes` and never looks at the slot counts, so a
 * 2-of-2 round naming seven seats answered `pays true, signerNodes 7`. The lock was sized for seven.
 *
 * IT IS AN UPPER BOUND, NOT AN EQUALITY, and that is deliberate. The spec's number is "however many there
 * are", and a slot a census left unfilled is a round with fewer seats than slots - legitimate, and not this
 * rule's business. Only naming MORE seats than the round has slots is the fault 22A warns about, so that is
 * all this refuses.
 */
export function sittingSeatsFitTheSlots(c) {
  if (!c) return { ok: false, why: 'no contract' };
  const seats = Array.isArray(c.nodes) ? c.nodes.length : 0;
  const gv = Number.isInteger(c.gameVerifySlots) ? c.gameVerifySlots : 0;
  const st = Number.isInteger(c.settlementSlots) ? c.settlementSlots : 0;
  const slots = Math.max(gv, st);
  // RESERVE SEATS (§5A.7decision A: the contract names the draw): a round may name its draw - two reserves
  // over the seats, 9 for 7 and 3 for 2 (sortition.js drawnForRole) - and its seating certificate says who sits
  const t = slots === 7 ? 5 : slots === 2 ? 2 : Math.floor(slots / 2) + 1;
  const drawn = slots < 1 ? 0 : Math.min(slots + 2, 2 * t - 1);
  if (seats > drawn)
    return { ok: false, seats, slots,
      why: `that round seats ${seats} signer nodes on ${gv}/${st} slots: 22A pays the seats the census `
        + `seated, and a fee lock sized for more of them pays seats that never sat (a round names at most its draw, ${drawn})` };
  return { ok: true, seats, slots, why: '' };
}

export function publicationRelaysAreValid(c) {
  if (!c) return { ok: false, why: 'no contract' };
  if (!Array.isArray(c.publicationRelays))
    return { ok: false, why: 'that round names no publication relays list' };
  const seen = new Set();
  for (const relay of c.publicationRelays) {
    let url;
    try { url = new URL(relay); } catch { url = null; }
    if (!url || !RELAY_SCHEMES.includes(url.protocol))
      return { ok: false, why: `publication relay ${JSON.stringify(relay)} is not an http(s) or ws(s) URL` };
    if (seen.has(relay)) return { ok: false, why: `publication relay ${relay} is named twice` };
    seen.add(relay);
  }
  if (c.stakeMsat > 0n && !c.publicationRelays.length)
    return {
      ok: false,
      why: 'that round takes a stake and names no publication relay: none of its results can become '
        + 'final (§13A), so no stake in it could ever settle',
    };
  return { ok: true };
}

/**
 * WHAT A CLIENT WARNS ABOUT BEFORE ANYONE STAKES. The engine's own: a flat rank curve (§18A.7) and a min_score that is a
 * danger rule. THE GAME'S FIELDS ARE THE GAME'S TO JUDGE: `gameWarnings` is the round's game's own check of
 * the fields only it reads - nextblock's `roundWarnings` (exposure ignored, a degenerate time factor) - appended here.
 */
export function contractWarnings(c, gameWarnings = null) {
  const out = [];
  // Integer comparison, not a quotient. This is only a client warning and a
  // float here would change nothing - which is exactly why it is worth not
  // writing: a division on a money-shaped number is a habit, and the next one
  // will be somewhere it matters.
  // A ROUND WITH NO RANK CURVE (an attested market, §0A.7a: rank 0 of 0) is not flat - it has none
  if (c.rankDenominator > 0 && Math.imul(c.rankNumerator, 100) >= Math.imul(c.rankDenominator, 95))
    out.push('flat_rank_curve');
  // min_score is in the score's unit, 1e-5 points (constants.js SCORE_SCALE): a floor above 100 points is a danger rule
  if (c.minScore > 0 && c.minScore > 100 * SCORE_SCALE) out.push('minimum_score_is_a_danger_rule');
  if (typeof gameWarnings === 'function') out.push(...gameWarnings(c));
  return out;
}

/**
 * THE FEDERATION AN ENTRY'S LOCKS ARE IN (2026.0.3): on a round that takes any federation (takesAnyFederation) the
 * one the entry names - an entry naming none is refused; on any other round the round's own - an entry naming another is
 * refused. Answers { ok, federationId } or { ok: false, why }. Which federations a seat takes is the seat's (OPEN, bonded).
 */
export function entryFederation(round, entry) {
  if (!round || !entry) return { ok: false, why: 'no round or no entry' };
  const named = entry.federationId instanceof Uint8Array && entry.federationId.length === 32 && !entry.federationId.every((b) => b === 0) ? entry.federationId : null;
  if (takesAnyFederation(round)) {
    if (!named) return { ok: false, why: 'that round takes a lock in any federation, and the entry names none: it says where its locks are (2026.0.3)' };
    return { ok: true, federationId: named };
  }
  if (!is32(round.federationId) || round.federationId.every((b) => b === 0)) return { ok: false, why: 'that round names no federation, so its stake is not a lock' };
  if (named && !named.every((b, i) => b === round.federationId[i]))
    return { ok: false, why: 'that entry names another federation than its round\'s, which takes one federation only' };
  return { ok: true, federationId: round.federationId };
}
