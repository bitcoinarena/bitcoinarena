// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A GAME IS A MANIFEST (§0A.32026-10-06/07). The engine never imports a game's code: what it needs
// from a game - which cores, which configs, how long a run may be, which of the engine's payout rules and with which
// numbers - it reads from the game's manifest, and from the game's core only through the adapter a node installed.
//
//     GameManifest {
//       game_name, game_dev_pubkey, version, parent_manifest_id, result_type,
//       cores[] (each with its configs[]), run_ticks_max, round_period,
//       payout_rule, payout_params (the rank curve's numerator and denominator), min_score,
//       clients[], game_donation_set,
//       [ATTESTED only] outcomes[], attestors[], attest_threshold,
//         [optional, marker 0x01] market terms: node_fee_bps, donation_bps, question, resolve_after_close,
//           deadline_after_resolve, source_rule,
//         [optional, marker 0x04] template: category, max_outcomes, resolve_within (feature 5: each ROUND
//           asks its own question - contracts.js `event`),
//         [optional, marker 0x05] game source: source_game_id, source_kind, mapping[] (feature 6: a market on a
//           game - each ROUND names the source round whose signed result decides it, contracts.js `sourceRoundId`; no attestors),
//         [optional, marker 0x06] scalar: low, high (i64 each), unit (feature 8: a numeric outcome paid linearly
//           between the bounds to the sides LONG and SHORT - its attestors sign a value, scalar.js),
//       [HEAD_TO_HEAD only] players, move_count, reveal_window,
//       [REPLAY with payout_rule TOP_SPLIT only, marker 0x03] payout_shares[] (feature 3),
//       [optional, marker 0x07] items[]: id, name, price_sat, unlock (a game's in-game items; protocol 10 - items.js),
//       [optional, marker 0x02] required_protocol_version,
//       signature by game_dev_pubkey
//     }
//
// THE TRAILING FIELDS, IN THIS ORDER AND EACH AFTER ITS OWN MARKER: what only one result type writes (an attested game's
// terms, template and game source, a head-to-head game's table, a top split's shares - never two result types' fields in one
// manifest), then the required version, which any manifest may name, last. Each is optional or bound to its rule, so a
// manifest that names none keeps its bytes and its game id; a reader takes each only where its marker stands, and its seven
// markers 0x01-0x07 are distinct, so no field can be read as another. A node too old to know one cannot read the manifest
// (trailing bytes).
//     game_id = H(GameManifest)
//
// The developer signs the BODY's id (TAG.gameManifestBody), not the bytes that carry the signature - an object whose
// bytes held its own signature could not be signed - and game_id is the hash of body and signature together
// (TAG.gameManifest), so two signatures over one body are two manifests, never one id for either.
//
// An update is a new manifest: the same key, the old id as its parent, the next version. A round names the exact
// manifest it plays (contracts.js gameId), so an update never changes a round already written.
//
// WHO SIGNS (2026-10-07 15:40): the game developer's dev client (arena-donor/src/manifest-sign.js), never a node -
// a node only verifies, through `manifestStands`.
//
// NO CURVE, as everywhere in this package: `verify(signature, digest, key)` is injected (Ed25519, the scheme the
// donation authority signs with), and a manifest with no verifier to check it is not a game.
import { Writer, Reader } from './encode.js';
import { taggedHash, toHex } from './hash.js';
import { PROTOCOL_VERSION, speaksVersion, TYPE_GAME_MANIFEST, TAG, ROUND_PERIOD_MS, TOP_SPLIT_VERSION, GAME_MARKET_VERSION, SCALAR_VERSION, SCALAR_TEMPLATE_VERSION } from './constants.js';
import { protocolVersionName } from './protocol-version.js';
import { itemsFit, writeItems, readItems, ITEMS_MARKER } from './items.js';
import { EVENT_VERSION } from './contracts.js';
import { payoutSharesFit } from './payout.js';

/**
 * What a game's result is (§0A.7, §0A.7a): a replayed run, or an outcome its attestors sign (a price, an
 * event - a prediction market), with no core and no run.
 */
export const RESULT_TYPE = Object.freeze({ REPLAY: 1, ATTESTED: 2, HEAD_TO_HEAD: 3 });
/**
 * The engine's payout rules a manifest may pick (§0A.5): §18A's rank curve for a replayed run; pari-mutuel for an attested
 * outcome (2026-10-07,: no counterparty - the losing picks' net stakes pay the winning picks); and, for a
 * replayed run, a TOP-N PRIZE SPLIT (feature 3: "tournament-style games need fixed splits; the rank curve is
 * one shape only") - fixed shares of the pot over the top places, named in the manifest's `payoutShares` (payout.js
 * payoutSharesFit, computePayoutTable).
 */
export const PAYOUT_RULE = Object.freeze({ RANK_CURVE: 1, PARI_MUTUEL: 2, TOP_SPLIT: 3 });
/** An attested game names 2 to 16 outcomes and 1 to 16 attestors. */
export const OUTCOMES_MAX = 16;
export const ATTESTORS_MAX = 16;

/**
 * A MARKET'S OWN TERMS (2026-10-09: the market's fee "per market in manifest"; "refund at deadline"):
 * its fee - the node share and the donation, each in basis points of the stake, within the network's (NODE_FEE_BPS 500,
 * donations up to 500) - its question, when its outcome is decided (`resolveAfterCloseMs` after a round's entry close),
 * the deadline its attestors have after that, and the rule its attestors read the outcome by (sources and aggregation, as
 * text). Optional: an attested manifest without them keeps the network's fee and today's rules, and its bytes.
 */
export const MARKET_TERMS_MARKER = 0x01;

/**
 * THE PROTOCOL VERSION A GAME REQUIRES (2026-10-12: "Spiele und Protokolle müssen bestimmte Protokoll
 * Versionen required können. Alte nodes die da nicht updaten fliegen raus."): optional, written last after its own marker,
 * so every manifest without it keeps its bytes and its game id. A round of the game names that version or a later one
 * (roundFitsManifest, gameIsKnownGood), and the census seats only nodes whose advert lists the round's version - a node
 * that did not update is not drawn for the game's rounds. A node too old to know the field cannot read the manifest at
 * all (trailing bytes), so it cannot host the game either.
 */
export const REQUIRED_VERSION_MARKER = 0x02;
/**
 * AN EVENT-MARKET TEMPLATE (feature 5, docs/PLATFORM-RESEARCH.md: "a manifest is a template (attestors, terms,
 * category); each round carries its own question, outcome labels and resolve time"): without it every new question - "Will X
 * happen by Y?" - needed a newly signed manifest and a game hosted by nodes; with it anyone opens a question by publishing
 * ONE ROUND of the template. The manifest keeps what the market's trust and money are made of - its attestor set and
 * threshold, its fees, its attestors' deadline and source rule (its market terms, which a template must name) - and adds a
 * category (what kind of question its rounds ask), the most outcomes a round may name (2 to 16) and the latest a round may
 * resolve, `resolveWithinMs` after its entry close. Its market terms' `resolveAfterCloseMs` is then the EARLIEST a round
 * may resolve after its entry close, and its question names the template (e.g. "Sports results"). The manifest's own
 * `outcomes` label the template itself (its shape, e.g. YES / NO); a round names its own (contracts.js `event`).
 *
 * After its own marker, behind the market terms and before the required version: optional, so every manifest without it
 * keeps its bytes and its game id. Its marker is 0x04 (0x03 is a top split's shares, feature 3). A template REQUIRES
 * protocol version 2026.0.4 or later, as a top split does: its rounds carry their question in a contract tail the
 * builds of 2026.0.4 read (contracts.js EVENT_MARKER, EVENT_VERSION), the census seats for a round only nodes whose advert
 * lists its version, so a seat without the code is never seated for a template's round - and a node too old to know the
 * field cannot read the manifest at all (trailing bytes), so it cannot host the template. A template runs on no grid
 * (round_period 0): each round names its own times.
 */
export const TEMPLATE_MARKER = 0x04;
export const TEMPLATE_MIN_PROTOCOL_VERSION = EVENT_VERSION;
export const TEMPLATE_CATEGORY_MAX = 32;
export function marketTemplateFits(t, m) {
  if (!t || typeof t !== 'object') return { ok: false, why: 'a market template is an object' };
  if (typeof t.category !== 'string' || t.category.length < 1 || t.category.length > TEMPLATE_CATEGORY_MAX)
    return { ok: false, why: `a market template names its category in 1 to ${TEMPLATE_CATEGORY_MAX} characters` };
  if (!Number.isInteger(t.maxOutcomes) || t.maxOutcomes < 2 || t.maxOutcomes > OUTCOMES_MAX)
    return { ok: false, why: `a market template lets its rounds name at most 2 to ${OUTCOMES_MAX} outcomes` };
  if (typeof t.resolveWithinMs !== 'bigint' || t.resolveWithinMs < 1n || t.resolveWithinMs > MARKET_RESOLVE_MAX_MS)
    return { ok: false, why: 'a market template\'s rounds resolve within 1 ms to 30 days after their entry close' };
  // ITS TRUST AND MONEY ARE THE MANIFEST'S: fees, the attestors' deadline and the source rule are its market terms
  if (!m || !m.marketTerms) return { ok: false, why: 'a market template names its market terms: its fees, its attestors\' deadline and its source rule' };
  if (t.resolveWithinMs < m.marketTerms.resolveAfterCloseMs)
    return { ok: false, why: `a market template's latest resolution (${t.resolveWithinMs} ms after entry close) is before its earliest (${m.marketTerms.resolveAfterCloseMs} ms)` };
  if (!(Number.isInteger(m.requiredProtocolVersion) && m.requiredProtocolVersion >= TEMPLATE_MIN_PROTOCOL_VERSION))
    return { ok: false, why: `a market template requires protocol version ${protocolVersionName(TEMPLATE_MIN_PROTOCOL_VERSION)} or later (#349): its rounds carry their own question` };
  if (m.roundPeriodMs !== 0n) return { ok: false, why: 'a market template runs on no grid (round_period 0): each round names its own times' };
  return { ok: true };
}
/** Is this manifest an event-market template (feature 5): an attested game whose rounds ask their own question? */
export const isTemplate = (m) => !!m && m.resultType === RESULT_TYPE.ATTESTED && !!m.template;

/**
 * A MARKET ON A GAME (feature 6, docs/PLATFORM-RESEARCH.md item 6: "an attested market whose outcome is a game
 * round's signed result (e.g. BULLS vs BEARS of a Tick Tock round, the winner of an RPS table). It turns every game into a
 * spectator sport with no external oracle: the committee's 5-of-7 RoundResult resolves it"). An ATTESTED manifest may name,
 * after its own marker 0x05 (behind the market terms, never beside a template, before the required version):
 *
 *     game_source { source_game_id (32 bytes), source_kind (u8), mapping[] (u8 each) }
 *
 * - `source_game_id`: the manifest id of the game whose rounds its rounds are markets on; each ROUND of it names the one round
 *   of that game it is on (contracts.js `sourceRoundId`), and a source round of any other game is no source of it.
 * - `source_kind`: which signed result of that round decides it. One kind exists, ROUND_RESULT: the §13 RoundResult of a price
 *   round (Tick Tock / nextblock; round-result.js) - { round_id, open_cents, close_cents, front }, its id signed by each seat's
 *   node key (BIP-340), standing when the source round's settlement committee's threshold (5 of 7) signed the same one.
 *   NOT A KIND, AND WHY: a head-to-head round (Rock Paper Scissors) signs no round-level result - each entry's PlayerResult
 *   (result.js) names one player key, WIN/DRAW/LOSS mapped onto DELIVERED/FAILED and a score - and its players are known only
 *   when its entries close, after a market on it must have closed (game-market.js gameMarketFitsSource); a market could name
 *   no seat whose result it pays on before it is too late to pick. Such a kind needs a signed per-table winner first.
 * - `mapping`: one byte per value of that kind's result, in the kind's order (SOURCE_VALUES: BULLS, BEARS, FLAT) - the index
 *   of the market outcome it pays, or GAME_MARKET_REFUND (0xff): every stake back (pari-mutuel VOID). Tick Tock's natural
 *   market is outcomes [BULLS, BEARS] with mapping [0, 1, 0xff]: FLAT refunds. Every outcome is some value's, so no pick is
 *   one that can never win.
 *
 * ITS TRUST IS THE SOURCE ROUND'S: it names no attestors and a threshold of 0 (the fields are written empty) - nobody but the
 * source round's own committee says anything, and an attestation for it is refused (attested.js attestationStands). Its money
 * and times are its market terms, which it must name: its fees, its question, `resolve_after_close_ms` - the latest its source
 * round may END after its entry close (the market resolves once its source's result is signed) - and the deadline after that,
 * when a market with no standing result is VOID. It runs on no grid (round_period 0): each round names its source and its
 * times. It REQUIRES protocol version 2026.0.6 or later: its rounds carry the source in a contract tail only builds of
 * 2026.0.6 read, so a seat without the code is never seated for them, and a node too old to know the field cannot read the
 * manifest at all (trailing bytes). Optional: every manifest without it keeps its bytes and its game id.
 */
export const GAME_SOURCE_MARKER = 0x05;
export const GAME_MARKET_MIN_PROTOCOL_VERSION = GAME_MARKET_VERSION;
export const SOURCE_KIND = Object.freeze({ ROUND_RESULT: 1 });
/** The values each source kind's result takes, in the order a mapping names them (ROUND_RESULT: round-result.js FRONT 1, 2, 3). */
export const SOURCE_VALUES = Object.freeze({ [SOURCE_KIND.ROUND_RESULT]: Object.freeze(['BULLS', 'BEARS', 'FLAT']) });
export const GAME_MARKET_REFUND = 0xff;
export function gameSourceFits(g, m) {
  if (!g || typeof g !== 'object') return { ok: false, why: 'a game source is an object { sourceGameId, sourceKind, mapping }' };
  if (!manIs32(g.sourceGameId) || manIsZero(g.sourceGameId)) return { ok: false, why: 'a market on a game names its source game by its 32-byte manifest id' };
  const values = SOURCE_VALUES[g.sourceKind];
  if (!values) return { ok: false, why: `source kind ${g.sourceKind} is not one this engine reads (ROUND_RESULT ${SOURCE_KIND.ROUND_RESULT}: a price round's §13 RoundResult)` };
  const outcomes = Array.isArray(m && m.outcomes) ? m.outcomes.length : 0;
  if (!Array.isArray(g.mapping) || g.mapping.length !== values.length)
    return { ok: false, why: `a market on a game maps each of its source's ${values.length} results (${values.join(', ')}) to an outcome or a refund: ${values.length} bytes` };
  for (let i = 0; i < values.length; i++) {
    const x = g.mapping[i];
    if (!(Number.isInteger(x) && ((x >= 0 && x < outcomes) || x === GAME_MARKET_REFUND)))
      return { ok: false, why: `a market on a game maps ${values[i]} to ${x}: an outcome index 0 to ${outcomes - 1}, or ${GAME_MARKET_REFUND} for a refund` };
  }
  for (let o = 0; o < outcomes; o++)
    if (!g.mapping.includes(o)) return { ok: false, why: `outcome ${o} "${m.outcomes[o]}" is no source result's: a pick on it could never win` };
  if (!m.marketTerms) return { ok: false, why: 'a market on a game names its market terms: its fees, its question, the latest its source round may end and the deadline after that' };
  if (m.template !== undefined && m.template !== null) return { ok: false, why: 'a market on a game is no template: it asks its manifest\'s question, of the source round each round names' };
  if (!(Number.isInteger(m.requiredProtocolVersion) && m.requiredProtocolVersion >= GAME_MARKET_MIN_PROTOCOL_VERSION))
    return { ok: false, why: `a market on a game requires protocol version ${protocolVersionName(GAME_MARKET_MIN_PROTOCOL_VERSION)} or later (#349): its rounds name their source round` };
  if (m.roundPeriodMs !== 0n) return { ok: false, why: 'a market on a game runs on no grid (round_period 0): each round names its source round and its own times' };
  return { ok: true };
}
/** Is this manifest a market on a game (feature 6): an attested market decided by a source round's signed result? */
export const isGameMarket = (m) => !!m && m.resultType === RESULT_TYPE.ATTESTED && !!m.gameSource;

/**
 * A SCALAR MARKET (feature 8, docs/PLATFORM-RESEARCH.md item 8: "a numeric outcome (a price, a count) paid linearly
 * between bounds. Richer questions than buckets; one market instead of many"). An ATTESTED manifest may name, after its own
 * marker 0x06 (behind the market terms, never beside a template or a game source, before the required version):
 *
 *     scalar { low (i64), high (i64), unit (1 to 16 characters) }
 *
 * - `low` < `high`: whole numbers in the named unit ("cents", "blocks", "tenths of a degree") - the bounds the market pays
 *   between. Signed, so a market may ask for a change or a temperature; 64 bits, so a price in msat fits.
 * - Its outcomes are exactly the two SIDES, in this order: LONG (index 0) and SHORT (1). A round's entries pick a side as any
 *   attested round's entries pick an outcome (contracts.js `pick`), so no round byte changes.
 *
 * ITS TRUST IS ITS ATTESTORS', k of n as for any attested market (1 to 16 keys, a threshold of 1 to their number) - but what they
 * sign is the OBSERVED VALUE V, in a message of its own type and tag (scalar.js ValueAttestation): an outcome attestation is
 * refused for it by name (attested.js attestationStands), and a value attestation for any other market (scalar.js
 * valueAttestationStands). THE PAYOUT: V clamped to [low, high]; the LONG side's share of the whole net pool is
 * (V - low) / (high - low), the SHORT side's the rest, each side's share split pari-mutuel over its own net stakes
 * (scalar.js scalarPayoutTable - integer msat, every remainder named). Its money and times are its market terms, which it must
 * name: its fees, its question, when V is read (`resolve_after_close_ms`) and the deadline after that, when a market with no
 * standing value is VOID - every stake back. It REQUIRES protocol version 2026.0.7 or later: a node that cannot pay it is
 * never seated for its rounds, and a node too old to know the field cannot read the manifest at all (trailing bytes).
 * Optional: every manifest without it keeps its bytes and its game id.
 */
export const SCALAR_MARKER = 0x06;
export const SCALAR_MIN_PROTOCOL_VERSION = SCALAR_VERSION;
export const SCALAR_SIDES = Object.freeze(['LONG', 'SHORT']);
export const SCALAR_LONG = 0;
export const SCALAR_SHORT = 1;
export const SCALAR_UNIT_MAX = 16;
export const SCALAR_I64_MIN = -0x8000000000000000n;
export const SCALAR_I64_MAX = 0x7fffffffffffffffn;
export function scalarFits(sc, m) {
  if (!sc || typeof sc !== 'object') return { ok: false, why: 'a scalar is an object { low, high, unit }' };
  if (typeof sc.low !== 'bigint' || typeof sc.high !== 'bigint') return { ok: false, why: 'a scalar market names its bounds low and high as BigInt whole numbers' };
  if (sc.low < SCALAR_I64_MIN || sc.low > SCALAR_I64_MAX || sc.high < SCALAR_I64_MIN || sc.high > SCALAR_I64_MAX)
    return { ok: false, why: 'a scalar market\'s bounds are signed 64-bit whole numbers' };
  // LOW BELOW HIGH, BY NAME: equal bounds would divide by zero, and reversed ones would pay LONG for a falling value
  if (sc.low >= sc.high) return { ok: false, why: `a scalar market's low bound is below its high bound; this one names low ${sc.low} and high ${sc.high}` };
  if (typeof sc.unit !== 'string' || sc.unit.length < 1 || sc.unit.length > SCALAR_UNIT_MAX)
    return { ok: false, why: `a scalar market names the unit of its bounds and its value in 1 to ${SCALAR_UNIT_MAX} characters` };
  const outcomes = m && Array.isArray(m.outcomes) ? m.outcomes : [];
  if (outcomes.length !== SCALAR_SIDES.length || outcomes.some((o, i) => o !== SCALAR_SIDES[i]))
    return { ok: false, why: `a scalar market's outcomes are its two sides, ${SCALAR_SIDES.join(' and ')}, in that order` };
  if (!m.marketTerms) return { ok: false, why: 'a scalar market names its market terms: its fees, its question, when its value is read and its attestors\' deadline' };
  // A SCALAR TEMPLATE (2026.0.8): each round names its own question and its own bounds inside the manifest's - which are then the
  // range a round's bounds may take - and its two sides; before 8 a scalar market is no template
  if (m.template !== undefined && m.template !== null) {
    if (!(Number.isInteger(m.requiredProtocolVersion) && m.requiredProtocolVersion >= SCALAR_TEMPLATE_VERSION))
      return { ok: false, why: `a scalar market is a template only under protocol version ${protocolVersionName(SCALAR_TEMPLATE_VERSION)} or later (#349): its rounds name their own bounds` };
    if (m.template.maxOutcomes !== 2) return { ok: false, why: 'a scalar template\'s rounds name its two sides: max_outcomes is 2' };
  }
  if (m.gameSource !== undefined && m.gameSource !== null) return { ok: false, why: 'a scalar market is no market on a game: its attestors sign its value' };
  if (!(Number.isInteger(m.requiredProtocolVersion) && m.requiredProtocolVersion >= SCALAR_MIN_PROTOCOL_VERSION))
    return { ok: false, why: `a scalar market requires protocol version ${protocolVersionName(SCALAR_MIN_PROTOCOL_VERSION)} or later (#349): its attestors sign a value` };
  return { ok: true };
}
/** Is this manifest a scalar market (feature 8): an attested market paid linearly by a signed value between bounds? */
export const isScalar = (m) => !!m && m.resultType === RESULT_TYPE.ATTESTED && !!m.scalar;


/**
 * A TOP SPLIT'S SHARES (feature 3): written only by a manifest whose payout_rule is TOP_SPLIT, after its own
 * marker, right after the game's donation set and before the required version - so every manifest that pays by the curve
 * or pari-mutuel keeps its bytes and its game id. Then a u16 count and each share as a u16 of basis points, places in
 * order (1st first). A TOP_SPLIT manifest must require protocol version TOP_SPLIT_VERSION or later: a node that
 * cannot compute the split does not speak that version, is never seated for the game's rounds, and - too old to know
 * payout rule 3 - cannot even read the manifest to host it.
 */
export const PAYOUT_SHARES_MARKER = 0x03;
/**
 * A MARKET'S PROTOCOL RESERVE (2026-10-17: "Prediction markers brauchen auch eine protocol reserve fee: 0.4%
 * donation (50/50 protocol / market dev), 0.4% node, 0.2% protocol reserve fee"): `marketTerms.reserveBps`, the part of the
 * market's donation rate that goes to the protocol reserves of the federation each lock is in - written after its own marker,
 * after a scalar's, and only when a market names it: every manifest before keeps its bytes and its game id. It is
 * MARKET_RESERVE_BPS exactly (0.2 % of a stake) and inside `donationBps` (0.6 % = 0.4 % to the developers, 50/50 protocol and
 * market dev, + 0.2 % reserve); the whole fee stays `nodeFeeBps + donationBps`. A node too old to read the marker cannot read the
 * manifest, and so never hosts or settles such a market.
 */
export const MARKET_RESERVE_MARKER = 0x08;
export const MARKET_RESERVE_BPS = 20;
export const MARKET_FEE_BPS_MAX = 500;
export const MARKET_DONATION_BPS_MAX = 500;
export const MARKET_TOTAL_FEE_BPS_MAX = 1000;
export const MARKET_RESOLVE_MAX_MS = 30n * 24n * 3600000n;
export const MARKET_DEADLINE_MIN_MS = 60000n;
export const MARKET_DEADLINE_MAX_MS = 7n * 24n * 3600000n;
export function marketTermsFit(t) {
  if (!t || typeof t !== 'object') return { ok: false, why: 'a market\'s terms are an object' };
  if (!Number.isInteger(t.nodeFeeBps) || t.nodeFeeBps < 0 || t.nodeFeeBps > MARKET_FEE_BPS_MAX) return { ok: false, why: `a market's node fee is 0 to ${MARKET_FEE_BPS_MAX} bps` };
  if (!Number.isInteger(t.donationBps) || t.donationBps < 0 || t.donationBps > MARKET_DONATION_BPS_MAX) return { ok: false, why: `a market's donation is 0 to ${MARKET_DONATION_BPS_MAX} bps` };
  // AT MOST 10 % IN ALL (2026-10-09: "fees per market can't be more than ... to prevent malicious markets" - "I mean 10
  // in total"): the node fee and the donation together, each at most 5 % - a market takes no more of a stake than the
  // network's own games can (5 % node fee + up to 5 % donation)
  if (t.nodeFeeBps + t.donationBps > MARKET_TOTAL_FEE_BPS_MAX) return { ok: false, why: `a market's node fee and donation come to at most ${MARKET_TOTAL_FEE_BPS_MAX} bps (10 %) together; these come to ${t.nodeFeeBps + t.donationBps}` };
  if (t.reserveBps !== undefined && t.reserveBps !== null) {
    if (t.reserveBps !== MARKET_RESERVE_BPS) return { ok: false, why: `a market's protocol reserve is ${MARKET_RESERVE_BPS} bps (0.2 %), not ${t.reserveBps}` };
    if (t.donationBps < t.reserveBps) return { ok: false, why: `a market's protocol reserve (${t.reserveBps} bps) is part of its donation (${t.donationBps} bps)` };
  }
  if (typeof t.question !== 'string' || t.question.length < 1 || t.question.length > 256) return { ok: false, why: 'a market asks its question in 1 to 256 characters' };
  if (typeof t.resolveAfterCloseMs !== 'bigint' || t.resolveAfterCloseMs < 0n || t.resolveAfterCloseMs > MARKET_RESOLVE_MAX_MS) return { ok: false, why: 'a market resolves 0 to 30 days after its entry close' };
  if (typeof t.deadlineAfterResolveMs !== 'bigint' || t.deadlineAfterResolveMs < MARKET_DEADLINE_MIN_MS || t.deadlineAfterResolveMs > MARKET_DEADLINE_MAX_MS) return { ok: false, why: 'a market gives its attestors 1 minute to 7 days after its resolution time' };
  if (typeof t.sourceRule !== 'string' || t.sourceRule.length < 1 || t.sourceRule.length > 1024) return { ok: false, why: 'a market names the rule its attestors read the outcome by, in 1 to 1024 characters' };
  return { ok: true };
}

/** Is this manifest's result attested - no core, no run, its attestors' signed outcome (§0A.7a)? */
export const isAttested = (m) => !!m && m.resultType === RESULT_TYPE.ATTESTED;
/**
 * IS THIS A HEAD-TO-HEAD GAME (2026-10-09)? Each player commits a hidden move at entry and reveals
 * it after entry close; the round's nodes decide every entry's result from all the reveals together, with the game's
 * decide adapter - named in cores[] by its hash like a replay core, so a node installs and checks it the same way. No
 * run (run_ticks_max 0); paid by the rank curve with the game's min_score (head-to-head.js maps win/draw/loss onto it).
 */
export const isHeadToHead = (m) => !!m && m.resultType === RESULT_TYPE.HEAD_TO_HEAD;
/** A head-to-head game seats 2 to 16 players, offers 2 to 32 moves, and gives its reveals 10 s to 1 h after entry close. */
export const H2H_PLAYERS_MAX = 16;
export const H2H_MOVES_MAX = 32;
export const H2H_REVEAL_MIN_MS = 10000n;
export const H2H_REVEAL_MAX_MS = 3600000n;
/** What the engine scores a head-to-head win and a draw: a win qualifies (min_score), a draw keeps its stake (§18). */
export const H2H_WIN_SCORE = 2;
export const H2H_DRAW_SCORE = 1;

export const MANIFEST_SIGNATURE_BYTES = 64;
export const NO_PARENT = new Uint8Array(32);

const manIs32 = (b) => b instanceof Uint8Array && b.length === 32;
const manSame = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
const manIsZero = (b) => b.every((x) => x === 0);
const manCompare32 = (a, b) => { for (let i = 0; i < 32; i++) if (a[i] !== b[i]) return a[i] - b[i]; return 0; };
const manNameOf = (v, r) => Object.keys(r).find((k) => r[k] === v);

/**
 * THE BYTES THE DEVELOPER SIGNS. Cores in hash order, each core's configs in hash order, clients in hash order: the
 * encoder asserts the order rather than sorting, so a manifest has one encoding.
 */
export function encodeManifestBody(m) {
  if (typeof m.gameName !== 'string' || m.gameName.length < 1 || m.gameName.length > 64) throw new Error('a game names itself in 1 to 64 characters');
  if (!manIs32(m.gameDevPubkey)) throw new Error('a game names a 32-byte developer key');
  if (!Number.isInteger(m.version) || m.version < 1) throw new Error('a manifest version is 1 or more');
  if (!manIs32(m.parentManifestId)) throw new Error('a manifest names a 32-byte parent (zeros for the first)');
  if (!manNameOf(m.resultType, RESULT_TYPE)) throw new Error(`result type ${m.resultType} is not one this engine has (REPLAY, ATTESTED, HEAD_TO_HEAD)`);
  if (isAttested(m)) {
    // AN ATTESTED GAME HAS NO CORE AND NO RUN (§0A.7a): the replay fields are written empty, so a reader of them finds
    // nothing to replay, and its payout rule is pari-mutuel
    if (!Array.isArray(m.cores) || m.cores.length !== 0) throw new Error('an attested game names no core: nothing of it is replayed');
    if (m.runTicksMax !== 0) throw new Error('an attested game has no run: run_ticks_max is 0');
    if (m.payoutRule !== PAYOUT_RULE.PARI_MUTUEL) throw new Error('an attested game pays by the pari-mutuel rule (§0A.7a)');
    if (m.rankNumerator !== 0 || m.rankDenominator !== 0 || m.minScore !== 0) throw new Error('an attested game has no rank curve and no score: they are 0');
    if (!Array.isArray(m.outcomes) || m.outcomes.length < 2 || m.outcomes.length > OUTCOMES_MAX
        || !m.outcomes.every((o) => typeof o === 'string' && o.length >= 1 && o.length <= 64))
      throw new Error(`an attested game names 2 to ${OUTCOMES_MAX} outcomes, each 1 to 64 characters`);
    if (new Set(m.outcomes).size !== m.outcomes.length) throw new Error('an attested game names each outcome once');
    // A MARKET ON A GAME (feature 6) NAMES NO ATTESTOR: its outcome is its source round's signed result, so the
    // fields are written empty and nothing an attestor signs can decide it; every other attested game names 1 to 16, as before
    const onGame = m.gameSource !== undefined && m.gameSource !== null;
    if (onGame) {
      if (!Array.isArray(m.attestors) || m.attestors.length !== 0 || m.attestThreshold !== 0)
        throw new Error('a market on a game names no attestors and a threshold of 0: its outcome is its source round\'s signed result');
    } else {
      if (!Array.isArray(m.attestors) || m.attestors.length < 1 || m.attestors.length > ATTESTORS_MAX || !m.attestors.every(manIs32))
        throw new Error(`an attested game names 1 to ${ATTESTORS_MAX} attestor keys of 32 bytes`);
      if (!Number.isInteger(m.attestThreshold) || m.attestThreshold < 1 || m.attestThreshold > m.attestors.length)
        throw new Error(`an attested game's threshold is 1 to its ${m.attestors.length} attestor(s)`);
    }
    if (m.marketTerms !== undefined && m.marketTerms !== null) { const f = marketTermsFit(m.marketTerms); if (!f.ok) throw new Error(f.why); }
    if (m.template !== undefined && m.template !== null) { const f = marketTemplateFits(m.template, m); if (!f.ok) throw new Error(f.why); }
    if (onGame) { const f = gameSourceFits(m.gameSource, m); if (!f.ok) throw new Error(f.why); }
    if (m.scalar !== undefined && m.scalar !== null) { const f = scalarFits(m.scalar, m); if (!f.ok) throw new Error(f.why); }
  } else if (isHeadToHead(m)) {
    // A HEAD-TO-HEAD GAME HAS ONE DECIDE ADAPTER AND NO RUN: its core is the adapter, named by hash with its configs
    if (!Array.isArray(m.cores) || m.cores.length !== 1) throw new Error('a head-to-head game names exactly one core: its decide adapter');
    const c = m.cores[0];
    if (!manIs32(c.hash) || !Array.isArray(c.configs) || c.configs.length < 1 || !c.configs.every(manIs32))
      throw new Error('a head-to-head game\'s decide adapter is named by its 32-byte hash with at least one 32-byte config');
    if (m.runTicksMax !== 0) throw new Error('a head-to-head game has no run: run_ticks_max is 0');
    if (m.payoutRule !== PAYOUT_RULE.RANK_CURVE) throw new Error('a head-to-head game pays by the rank curve');
    if (!Number.isInteger(m.rankNumerator) || !Number.isInteger(m.rankDenominator) || m.rankDenominator < 1
        || m.rankNumerator < 1 || m.rankNumerator >= m.rankDenominator || m.rankDenominator > 255)
      throw new Error('the rank curve is a numerator below its denominator, both 1 to 255');
    if (m.minScore !== H2H_WIN_SCORE) throw new Error(`a head-to-head game's min_score is ${H2H_WIN_SCORE}: a win scores ${H2H_WIN_SCORE}, a draw ${H2H_DRAW_SCORE} (head-to-head.js)`);
    if (!Number.isInteger(m.players) || m.players < 2 || m.players > H2H_PLAYERS_MAX) throw new Error(`a head-to-head game seats 2 to ${H2H_PLAYERS_MAX} players`);
    if (!Number.isInteger(m.moveCount) || m.moveCount < 2 || m.moveCount > H2H_MOVES_MAX) throw new Error(`a head-to-head game offers 2 to ${H2H_MOVES_MAX} moves`);
    if (typeof m.revealWindowMs !== 'bigint' || m.revealWindowMs < H2H_REVEAL_MIN_MS || m.revealWindowMs > H2H_REVEAL_MAX_MS)
      throw new Error(`a head-to-head game's reveal window is ${H2H_REVEAL_MIN_MS} to ${H2H_REVEAL_MAX_MS} ms`);
  } else {
    if (!Array.isArray(m.cores) || m.cores.length < 1) throw new Error('a game names at least one core');
    for (const c of m.cores) {
      if (!manIs32(c.hash)) throw new Error('a core is named by its 32-byte hash');
      if (!Array.isArray(c.configs) || c.configs.length < 1 || !c.configs.every(manIs32)) throw new Error(`core ${toHex(c.hash).slice(0, 16)} names no 32-byte config`);
    }
    if (!Number.isInteger(m.runTicksMax) || m.runTicksMax < 1 || m.runTicksMax > 65535) throw new Error('run_ticks_max is 1 to 65535 ticks (a contract\'s blockTicks is a u16)');
    if (m.payoutRule !== PAYOUT_RULE.RANK_CURVE && m.payoutRule !== PAYOUT_RULE.TOP_SPLIT)
      throw new Error(`a replayed game pays by the rank curve or a top split; payout rule ${m.payoutRule} is not one of the engine's for it (§0A.5)`);
    // A TOP SPLIT STILL NAMES A CURVE: the round contract carries numerator and denominator and a round must
    // match its game's (roundFitsManifest), so the fields keep their rule - the table ignores them under a split
    if (!Number.isInteger(m.rankNumerator) || !Number.isInteger(m.rankDenominator) || m.rankDenominator < 1
        || m.rankNumerator < 1 || m.rankNumerator >= m.rankDenominator || m.rankDenominator > 255)
      throw new Error('the rank curve is a numerator below its denominator, both 1 to 255');
    if (!Number.isInteger(m.minScore) || m.minScore < 0) throw new Error('min_score is a whole number of score units');
  }
  if (typeof m.roundPeriodMs !== 'bigint') throw new Error('round_period is a BigInt of milliseconds');
  if (!isAttested(m) && m.template !== undefined && m.template !== null) throw new Error('only an attested game is a market template: its rounds ask a question its attestors answer');
  if (!isAttested(m) && m.gameSource !== undefined && m.gameSource !== null) throw new Error('only an attested game is a market on a game: its outcome is read, not played');
  if (!isAttested(m) && m.scalar !== undefined && m.scalar !== null) throw new Error('only an attested game is a scalar market: its value is attested, not played');
  if (!manNameOf(m.payoutRule, PAYOUT_RULE)) throw new Error(`payout rule ${m.payoutRule} is not one of the engine's (§0A.5)`);
  if (!Array.isArray(m.clients) || !m.clients.every(manIs32)) throw new Error('a client is named by its 32-byte hash');
  if (!manIs32(m.gameDonationSetId)) throw new Error('a game names its donation set by its 32-byte id');
  if (m.requiredProtocolVersion !== undefined && m.requiredProtocolVersion !== null
      && (!Number.isInteger(m.requiredProtocolVersion) || m.requiredProtocolVersion < 1 || m.requiredProtocolVersion > 65535))
    throw new Error('a required protocol version is 1 to 65535');
  // A TOP SPLIT'S SHARES, ITS VERSION, AND NOTHING OF EITHER ON ANY OTHER RULE
  if (m.payoutRule === PAYOUT_RULE.TOP_SPLIT) {
    const fit = payoutSharesFit(m.payoutShares);
    if (!fit.ok) throw new Error(fit.why);
    if (!(Number.isInteger(m.requiredProtocolVersion) && m.requiredProtocolVersion >= TOP_SPLIT_VERSION))
      throw new Error(`a game paid by a top split requires protocol version ${protocolVersionName(TOP_SPLIT_VERSION)} or later (#349), so no node that cannot pay it is seated for it`);
  } else if (m.payoutShares !== undefined && m.payoutShares !== null) {
    throw new Error('only a game paid by a top split (payout rule TOP_SPLIT) names payout shares');
  }
  // ITS ITEMS: any game may sell items, from version 10 - checked, never sorted here (the order is in the hash)
  if (m.items !== undefined && m.items !== null) { const f = itemsFit(m.items, m); if (!f.ok) throw new Error(f.why); }

  const w = new Writer();
  w.u8(TYPE_GAME_MANIFEST);
  w.u16(PROTOCOL_VERSION);
  w.str(m.gameName);
  w.bytes32(m.gameDevPubkey);
  w.u32(m.version);
  w.bytes32(m.parentManifestId);
  w.u8(m.resultType);
  w.vec(m.cores, (c, ww) => { ww.bytes32(c.hash); ww.vec(c.configs, (h, w3) => w3.bytes32(h), { sortedBy: manCompare32 }); },
    { sortedBy: (a, b) => manCompare32(a.hash, b.hash) });
  w.u16(m.runTicksMax);
  w.u64(m.roundPeriodMs);
  w.u8(m.payoutRule);
  w.u8(m.rankNumerator);
  w.u8(m.rankDenominator);
  w.u32(m.minScore);
  w.vec(m.clients, (h, ww) => ww.bytes32(h), { sortedBy: manCompare32 });
  w.bytes32(m.gameDonationSetId);
  // AN ATTESTED GAME'S OWN TERMS, AFTER EVERYTHING A REPLAYED GAME WRITES: every REPLAY manifest keeps its bytes and its id
  if (isAttested(m)) {
    w.vec(m.outcomes, (o, ww) => ww.str(o));
    w.vec(m.attestors, (k, ww) => ww.bytes32(k), { sortedBy: manCompare32 });
    w.u8(m.attestThreshold);
    // ITS MARKET TERMS, after a marker and only when it names them: every attested manifest before keeps its bytes
    if (m.marketTerms) {
      const t = m.marketTerms;
      w.u8(MARKET_TERMS_MARKER); w.u16(t.nodeFeeBps); w.u16(t.donationBps); w.str(t.question);
      w.u64(t.resolveAfterCloseMs); w.u64(t.deadlineAfterResolveMs); w.str(t.sourceRule);
    }
    // ITS TEMPLATE (feature 5), after its own marker and only when it is one: every attested manifest before keeps its bytes
    if (m.template) {
      const t = m.template;
      w.u8(TEMPLATE_MARKER); w.str(t.category); w.u8(t.maxOutcomes); w.u64(t.resolveWithinMs);
    }
    // ITS GAME SOURCE (feature 6), after its own marker and only when it is a market on a game: every attested
    // manifest before keeps its bytes
    if (m.gameSource) {
      const g = m.gameSource;
      w.u8(GAME_SOURCE_MARKER); w.bytes32(g.sourceGameId); w.u8(g.sourceKind); w.vec(g.mapping, (x, ww) => ww.u8(x));
    }
    // ITS SCALAR (feature 8), after its own marker and only when it is one: every attested manifest before keeps its bytes
    if (m.scalar) {
      const sc = m.scalar;
      w.u8(SCALAR_MARKER); w.i64(sc.low); w.i64(sc.high); w.str(sc.unit);
    }
    // ITS PROTOCOL RESERVE, after its own marker and only when its terms name one: every manifest before keeps its bytes
    if (m.marketTerms && m.marketTerms.reserveBps) { w.u8(MARKET_RESERVE_MARKER); w.u16(m.marketTerms.reserveBps); }
  }
  // A HEAD-TO-HEAD GAME'S OWN TERMS, likewise after everything else: no other manifest's bytes move
  if (isHeadToHead(m)) {
    w.u8(m.players);
    w.u8(m.moveCount);
    w.u64(m.revealWindowMs);
  }
  // A TOP SPLIT'S SHARES, after their marker and only under that rule: no manifest before it moves
  if (m.payoutRule === PAYOUT_RULE.TOP_SPLIT) { w.u8(PAYOUT_SHARES_MARKER); w.vec(m.payoutShares, (x, ww) => ww.u16(x)); }
  // ITS ITEMS, after their marker and only when it sells some: no manifest before it moves
  if (m.items) writeItems(w, m.items);
  // THE REQUIRED PROTOCOL VERSION, LAST AND ONLY WHEN NAMED: no manifest before it moves
  if (m.requiredProtocolVersion) { w.u8(REQUIRED_VERSION_MARKER); w.u16(m.requiredProtocolVersion); }
  return w.finish();
}

function readBody(r) {
  if (r.u8() !== TYPE_GAME_MANIFEST) throw new Error('not a game manifest');
  const version = r.u16();
  if (!speaksVersion(version)) throw new Error(`protocol version ${version}, this build speaks ${PROTOCOL_VERSION}`);
  const body = {
    gameName: r.str(),
    gameDevPubkey: r.bytes32(),
    version: r.u32(),
    parentManifestId: r.bytes32(),
    resultType: r.u8(),
    cores: r.vec((rr) => ({ hash: rr.bytes32(), configs: rr.vec((r3) => r3.bytes32()) })),
    runTicksMax: r.u16(),
    roundPeriodMs: r.u64(),
    payoutRule: r.u8(),
    rankNumerator: r.u8(),
    rankDenominator: r.u8(),
    minScore: r.u32(),
    clients: r.vec((rr) => rr.bytes32()),
    gameDonationSetId: r.bytes32(),
  };
  if (body.resultType === RESULT_TYPE.ATTESTED) {
    body.outcomes = r.vec((rr) => rr.str());
    body.attestors = r.vec((rr) => rr.bytes32());
    body.attestThreshold = r.u8();
    if (r.at < r.b.length - MANIFEST_SIGNATURE_BYTES && r.b[r.at] === MARKET_TERMS_MARKER) {
      r.u8();
      body.marketTerms = { nodeFeeBps: r.u16(), donationBps: r.u16(), question: r.str(),
        resolveAfterCloseMs: r.u64(), deadlineAfterResolveMs: r.u64(), sourceRule: r.str() };
    }
    if (r.at < r.b.length - MANIFEST_SIGNATURE_BYTES && r.b[r.at] === TEMPLATE_MARKER) {
      r.u8();
      body.template = { category: r.str(), maxOutcomes: r.u8(), resolveWithinMs: r.u64() };
    }
    if (r.at < r.b.length - MANIFEST_SIGNATURE_BYTES && r.b[r.at] === GAME_SOURCE_MARKER) {
      r.u8();
      body.gameSource = { sourceGameId: r.bytes32(), sourceKind: r.u8(), mapping: r.vec((rr) => rr.u8()) };
    }
    if (r.at < r.b.length - MANIFEST_SIGNATURE_BYTES && r.b[r.at] === SCALAR_MARKER) {
      r.u8();
      body.scalar = { low: r.i64(), high: r.i64(), unit: r.str() };
    }
    if (r.at < r.b.length - MANIFEST_SIGNATURE_BYTES && r.b[r.at] === MARKET_RESERVE_MARKER) {
      r.u8();
      if (!body.marketTerms) throw new Error('a market\'s protocol reserve is part of its terms, and this manifest names none');
      body.marketTerms.reserveBps = r.u16();
    }
  }
  if (body.resultType === RESULT_TYPE.HEAD_TO_HEAD) {
    body.players = r.u8();
    body.moveCount = r.u8();
    body.revealWindowMs = r.u64();
  }
  // a top split's shares: its payout rule says they follow, so their marker is required, not looked for
  if (body.resultType === RESULT_TYPE.REPLAY && body.payoutRule === PAYOUT_RULE.TOP_SPLIT) {
    if (!(r.at < r.b.length - MANIFEST_SIGNATURE_BYTES && r.u8() === PAYOUT_SHARES_MARKER))
      throw new Error('a game paid by a top split carries its shares after their marker');
    body.payoutShares = r.vec((rr) => rr.u16());
  }
  if (r.at < r.b.length - MANIFEST_SIGNATURE_BYTES && r.b[r.at] === ITEMS_MARKER) {
    r.u8();
    body.items = readItems(r);
  }
  if (r.at < r.b.length - MANIFEST_SIGNATURE_BYTES && r.b[r.at] === REQUIRED_VERSION_MARKER) {
    r.u8();
    body.requiredProtocolVersion = r.u16();
  }
  return body;
}

/** The digest the developer's key signs. */
export const manifestBodyId = (m) => taggedHash(TAG.gameManifestBody, encodeManifestBody(m));

/** The manifest on the wire: its body, then the 64-byte signature. */
export function encodeManifest(m) {
  if (!(m.signature instanceof Uint8Array) || m.signature.length !== MANIFEST_SIGNATURE_BYTES)
    throw new Error(`a manifest carries its ${MANIFEST_SIGNATURE_BYTES}-byte signature`);
  const body = encodeManifestBody(m);
  const out = new Uint8Array(body.length + MANIFEST_SIGNATURE_BYTES);
  out.set(body, 0); out.set(m.signature, body.length);
  return out;
}

export function decodeManifest(bytes) {
  const r = new Reader(bytes);
  const m = readBody(r);
  m.signature = r.bytes(MANIFEST_SIGNATURE_BYTES);
  r.end();
  encodeManifestBody(m);                                    // bytes from anywhere are held to the encoder's rules
  return m;
}

/** game_id = H(GameManifest): the body and its signature. */
export const gameIdOf = (m) => taggedHash(TAG.gameManifest, encodeManifest(m));

/**
 * IS THIS A GAME (§0A.3)? Its encoding stands, its developer's key signed its body, and its parent rule holds: the first
 * manifest (version 1) names no parent; an update names one, and that parent is a manifest of the SAME key one version
 * below. `parentOf(id)` hands back a manifest this node holds by id, or nothing - a parent it cannot see is refused,
 * since nothing then says the update is the developer's. Answers, never throws: a manifest that is not a game is an
 * ordinary refusal, by name.
 */
export function manifestStands(m, { verify, parentOf = () => null } = {}) {
  let digest, id;
  try { digest = manifestBodyId(m); id = gameIdOf(m); }
  catch (e) { return { ok: false, why: `that manifest does not encode: ${e.message}` }; }
  const name = `game "${m.gameName}" ${toHex(id).slice(0, 16)}`;
  if (typeof verify !== 'function') return { ok: false, why: `${name}: no verifier to check its developer's signature` };
  let signed = false;
  try { signed = verify(m.signature, digest, m.gameDevPubkey) === true; } catch { signed = false; }
  if (!signed) return { ok: false, why: `${name}: its signature is not its developer key ${toHex(m.gameDevPubkey).slice(0, 16)}'s` };
  // A TOP SPLIT THIS BUILD CANNOT PAY IS NOT A GAME IT HOSTS: the version the game requires is one this
  // build speaks, or none of its rounds could be read here, let alone settled by the split
  if (m.payoutRule === PAYOUT_RULE.TOP_SPLIT && !speaksVersion(m.requiredProtocolVersion))
    return { ok: false, why: `${name}: it pays by a top split under protocol version ${protocolVersionName(m.requiredProtocolVersion)}, which this build does not speak` };
  // AND A TEMPLATE WHOSE ROUNDS THIS BUILD CANNOT READ (feature 5): likewise
  if (isTemplate(m) && !speaksVersion(m.requiredProtocolVersion))
    return { ok: false, why: `${name}: it is a market template under protocol version ${protocolVersionName(m.requiredProtocolVersion)}, which this build does not speak` };
  // AND A MARKET ON A GAME WHOSE ROUNDS THIS BUILD CANNOT READ (feature 6): likewise
  if (isGameMarket(m) && !speaksVersion(m.requiredProtocolVersion))
    return { ok: false, why: `${name}: it is a market on a game under protocol version ${protocolVersionName(m.requiredProtocolVersion)}, which this build does not speak` };
  // AND A SCALAR MARKET WHOSE VALUE THIS BUILD CANNOT PAY (feature 8): likewise
  if (isScalar(m) && !speaksVersion(m.requiredProtocolVersion))
    return { ok: false, why: `${name}: it is a scalar market under protocol version ${protocolVersionName(m.requiredProtocolVersion)}, which this build does not speak` };
  // AND ITEMS THIS BUILD CANNOT SELL OR CHECK: likewise - until version 10 is spoken, no node hosts a game with items
  if (Array.isArray(m.items) && m.items.length && !speaksVersion(m.requiredProtocolVersion))
    return { ok: false, why: `${name}: it sells items under protocol version ${protocolVersionName(m.requiredProtocolVersion)}, which this build does not speak` };
  if (m.version === 1) {
    if (!manIsZero(m.parentManifestId)) return { ok: false, why: `${name}: version 1 names a parent; the first manifest of a game has none` };
    return { ok: true, gameId: id, why: `${name} v1, signed by ${toHex(m.gameDevPubkey).slice(0, 16)}` };
  }
  if (manIsZero(m.parentManifestId)) return { ok: false, why: `${name}: version ${m.version} names no parent; an update names the manifest it replaces` };
  const parent = parentOf(m.parentManifestId);
  if (!parent) return { ok: false, why: `${name}: its parent ${toHex(m.parentManifestId).slice(0, 16)} is not a manifest this node holds` };
  if (!manSame(parent.gameDevPubkey, m.gameDevPubkey))
    return { ok: false, why: `${name}: its parent is a manifest of another developer key - not a game (§0A.3)` };
  if (parent.version + 1 !== m.version)
    return { ok: false, why: `${name}: version ${m.version} after a parent of version ${parent.version}` };
  return { ok: true, gameId: id, why: `${name} v${m.version}, an update of ${toHex(m.parentManifestId).slice(0, 16)} by the same key` };
}

/**
 * MAY THIS ROUND BE PLAYED UNDER THIS MANIFEST (§0A.3, §0A.5): it names the manifest's game, a core the manifest
 * lists, a config the manifest lists for that core, a run no longer than run_ticks_max, the manifest's rank curve, and a
 * min_score no lower than the manifest's (the game's floor; a round may ask more of its runs, never less).
 */
export function roundFitsManifest(contract, m, gameId = gameIdOf(m)) {
  const name = `game "${m.gameName}"`;
  if (!contract || !manIs32(contract.gameId)) return { ok: false, why: 'that round names no 32-byte game' };
  if (!manSame(contract.gameId, gameId)) return { ok: false, why: `that round names game ${toHex(contract.gameId).slice(0, 16)}, not ${name} ${toHex(gameId).slice(0, 16)}` };
  if (m.requiredProtocolVersion && !(Number.isInteger(contract.protocolVersion) && contract.protocolVersion >= m.requiredProtocolVersion))
    return { ok: false, why: `${name} requires protocol version ${protocolVersionName(m.requiredProtocolVersion)}; that round runs ${Number.isInteger(contract.protocolVersion) ? protocolVersionName(contract.protocolVersion) : 'none'}` };
  // A ROUND ASKS ITS OWN QUESTION ONLY UNDER A TEMPLATE (feature 5): every other game's question - and its outcomes,
  // and when it resolves - is its manifest's, and a round naming its own there would show players a market nobody signed
  const asks = contract.event !== undefined && contract.event !== null;
  if (asks && !isTemplate(m)) return { ok: false, why: `${name} is not a market template: its question is its manifest's, and a round of it carries none of its own` };
  // A ROUND NAMES A SOURCE ROUND ONLY UNDER A MARKET ON A GAME (feature 6): on any other game it would be a claim
  // about an outcome nobody reads
  const onRound = contract.sourceRoundId !== undefined && contract.sourceRoundId !== null;
  if (onRound && !isGameMarket(m)) return { ok: false, why: `${name} is no market on a game: a round of it names no source round` };
  // AN ATTESTED ROUND (§0A.7a) NAMES NO CORE AND NO CONFIG: both 32 zero bytes - there is nothing to replay it with
  if (isAttested(m)) {
    if (!manIs32(contract.simCoreHash) || !manIsZero(contract.simCoreHash) || !manIs32(contract.configHash) || !manIsZero(contract.configHash))
      return { ok: false, why: `${name} is attested: its rounds name no core and no config (32 zero bytes each) - nothing of them is replayed` };
    if (isTemplate(m)) {
      const fits = eventFitsTemplate(contract, m);
      if (!fits.ok) return fits;
      return { ok: true, attested: true, template: true };
    }
    // A MARKET ON A GAME'S ROUND NAMES ITS SOURCE ROUND (feature 6), and is no round of a series. Whether that source
    // fits - its game, and its start no earlier than this round's entry close - needs the source's contract: game-market.js
    // gameMarketFitsSource, asked by a seat that holds it and again by every resolution
    if (isGameMarket(m)) {
      if (!onRound) return { ok: false, why: `${name} is a market on a game: each round of it names the source round whose signed result decides it, and this one names none` };
      if (contract.seriesId !== undefined && contract.seriesId !== null)
        return { ok: false, why: `${name}: a market on a game is published on its own, never as a round of a series (a series round's id does not hash its source)` };
      return { ok: true, attested: true, gameMarket: true };
    }
    // A SCALAR MARKET'S ROUND (feature 8) is an attested round like any other: its entries pick a side (LONG 0, SHORT 1)
    // as an index into the manifest's outcomes, and its version is held to the manifest's required one above
    if (isScalar(m)) return { ok: true, attested: true, scalar: true };
    return { ok: true, attested: true };
  }
  if (!manIs32(contract.simCoreHash)) return { ok: false, why: 'that round names no 32-byte core' };
  const core = m.cores.find((c) => manSame(c.hash, contract.simCoreHash));
  if (!core) return { ok: false, why: `${name} lists no core ${toHex(contract.simCoreHash).slice(0, 16)}` };
  if (!manIs32(contract.configHash) || !core.configs.some((h) => manSame(h, contract.configHash)))
    return { ok: false, why: `${name} lists no config ${manIs32(contract.configHash) ? toHex(contract.configHash).slice(0, 16) : '(none)'} for core ${toHex(core.hash).slice(0, 16)}` };
  // A HEAD-TO-HEAD ROUND HAS NO RUN: its blockTicks is left as any u16 says nothing; the curve and min_score still bind
  if (isHeadToHead(m)) {
    if (contract.rankNumerator !== m.rankNumerator || contract.rankDenominator !== m.rankDenominator)
      return { ok: false, why: `that round's rank curve is ${contract.rankNumerator}/${contract.rankDenominator}; ${name} pays ${m.rankNumerator}/${m.rankDenominator}` };
    if (!Number.isInteger(contract.minScore) || contract.minScore < m.minScore)
      return { ok: false, why: `that round's min_score ${contract.minScore} is below ${name}'s ${m.minScore}` };
    return { ok: true, headToHead: true };
  }
  if (!Number.isInteger(contract.blockTicks) || contract.blockTicks < 1 || contract.blockTicks > m.runTicksMax)
    return { ok: false, why: `that round's run is ${contract.blockTicks} ticks; ${name} runs at most ${m.runTicksMax}` };
  if (m.payoutRule !== PAYOUT_RULE.RANK_CURVE && m.payoutRule !== PAYOUT_RULE.TOP_SPLIT)
    return { ok: false, why: `${name} picks payout rule ${m.payoutRule}, which is not the engine's` };
  if (contract.rankNumerator !== m.rankNumerator || contract.rankDenominator !== m.rankDenominator)
    return { ok: false, why: `that round's rank curve is ${contract.rankNumerator}/${contract.rankDenominator}; ${name} pays ${m.rankNumerator}/${m.rankDenominator}` };
  if (!Number.isInteger(contract.minScore) || contract.minScore < m.minScore)
    return { ok: false, why: `that round's min_score ${contract.minScore} is below ${name}'s ${m.minScore}` };
  // A ROUND OF A SERIES runs on the series' grid, and the game's round_period must be that grid (or 0: it asks none)
  if (contract.seriesId !== undefined && contract.seriesId !== null) {
    const period = seriesPeriodFits(m);
    if (!period.ok) return period;
  }
  return { ok: true };
}

/**
 * DOES THIS ROUND'S QUESTION FIT ITS TEMPLATE (feature 5)? A round of a template MUST carry its own question
 * (contracts.js `event`, whose shape the contract's encoding already holds: a question of 1 to 280 UTF-8 bytes, 2 to 16
 * unique labels of 1 to 64 bytes); here, what only the template can say: no more outcomes than its `maxOutcomes`, and a
 * resolution time from its market terms' `resolveAfterCloseMs` to its `resolveWithinMs` after the round's entry close - a
 * question resolved before its last pick would be a pick to be copied, one resolved past the template's limit would hold the
 * stakes longer than the template promised. And no series: a round of a series has the id H(series_id || i) (contracts.js
 * roundId), which would not hash its question - so the question would not be the round's.
 */
export function eventFitsTemplate(contract, m) {
  const name = `template "${m.gameName}"`;
  const ev = contract && contract.event;
  if (!ev) return { ok: false, why: `${name} is a market template: each round of it asks its own question, outcomes and resolution time, and this one names none` };
  // A SCALAR TEMPLATE'S ROUND NAMES ITS BOUNDS, inside the template's; any other template's round names none (2026.0.8)
  if (isScalar(m)) {
    if (!ev.scalar) return { ok: false, why: `${name} is a scalar template: each round names the bounds it is paid between, and this one names none` };
    if (ev.scalar.low < m.scalar.low || ev.scalar.high > m.scalar.high)
      return { ok: false, why: `that round's bounds ${ev.scalar.low}..${ev.scalar.high} ${m.scalar.unit} are outside ${name}'s ${m.scalar.low}..${m.scalar.high}` };
  } else if (ev.scalar) return { ok: false, why: `${name} is no scalar market: its rounds name no bounds` };
  if (contract.seriesId !== undefined && contract.seriesId !== null)
    return { ok: false, why: `${name}: a round that asks its own question is published on its own, never as a round of a series (a series round's id does not hash its question)` };
  if (!Array.isArray(ev.outcomes) || ev.outcomes.length < 2 || ev.outcomes.length > m.template.maxOutcomes)
    return { ok: false, why: `that round names ${Array.isArray(ev.outcomes) ? ev.outcomes.length : 'no'} outcomes; ${name} lets a round name 2 to ${m.template.maxOutcomes}` };
  if (typeof ev.resolveAtMs !== 'bigint' || typeof contract.entryCloseMs !== 'bigint')
    return { ok: false, why: 'that round names no resolution time or no entry close' };
  const earliest = contract.entryCloseMs + m.marketTerms.resolveAfterCloseMs;
  const latest = contract.entryCloseMs + m.template.resolveWithinMs;
  if (ev.resolveAtMs < earliest)
    return { ok: false, why: `that round resolves at ${ev.resolveAtMs}, before ${name}'s earliest ${earliest} (${m.marketTerms.resolveAfterCloseMs} ms after its entry close)` };
  if (ev.resolveAtMs > latest)
    return { ok: false, why: `that round resolves at ${ev.resolveAtMs}, past ${name}'s latest ${latest} (${m.template.resolveWithinMs} ms after its entry close)` };
  return { ok: true };
}

/**
 * THE MARKET A ROUND PLAYS (feature 5): a round of a template reads its outcomes, its question and its resolution
 * time from its own contract (`event`), everything else - attestors, threshold, fees, deadline, source rule - from the
 * template; any other round reads the manifest as before (the manifest itself is answered). What is answered is a VIEW for
 * the market's checks (attestationStands, marketTimes, marketVoided, stakeExpiryFits, the pick's range, the lobby's labels):
 * it is never hashed or encoded - the game's id is its manifest's (gameIdOf(m)), not this.
 */
export function marketOfRound(m, contract) {
  if (!isTemplate(m) || !contract || !contract.event) return m;
  const ev = contract.event;
  return { ...m, outcomes: [...ev.outcomes],
    marketTerms: { ...m.marketTerms, question: ev.question, resolveAfterCloseMs: ev.resolveAtMs - contract.entryCloseMs },
    // a scalar template's round is paid between ITS bounds, in the template's unit (2026.0.8)
    ...(isScalar(m) && ev.scalar ? { scalar: { low: ev.scalar.low, high: ev.scalar.high, unit: m.scalar.unit } } : {}),
    event: ev };
}

/**
 * MAY THIS GAME RUN ON A SERIES OF `periodMs` (§0A.3 round_period)? Every series of this network runs on
 * the one 90 s grid (series.js ROUND_PERIOD_MS), so a game whose manifest names another period has no series here; one
 * naming 0 asks no period and runs on any.
 */
export function seriesPeriodFits(m, periodMs = ROUND_PERIOD_MS) {
  // A MARKET'S SERIES RUNS ON ITS OWN round_period (§0A.7b.4: "Market rounds on their own 15 min period
  // instead of the 90 s grid"), if a day holds a whole number of its rounds; the answer names it. Every other game is on
  // the network's 90 s grid, as before: a round_period of 0 or 90 s.
  if (m.resultType === RESULT_TYPE.ATTESTED && m.roundPeriodMs > 0n) {
    if (86400000n % m.roundPeriodMs !== 0n) return { ok: false, why: `market "${m.gameName}" runs every ${m.roundPeriodMs} ms, and a day does not hold a whole number of those` };
    return { ok: true, periodMs: m.roundPeriodMs };
  }
  if (m.roundPeriodMs === 0n || m.roundPeriodMs === BigInt(periodMs)) return { ok: true, periodMs: BigInt(periodMs) };
  return { ok: false, why: `game "${m.gameName}" runs every ${m.roundPeriodMs} ms, and this network's series run every ${periodMs} ms` };
}

/**
 * THE TOP SPLIT A GAME PAYS BY, as `computePayoutTable`'s `payoutShares`: a copy of its manifest's shares, or
 * null for every other rule (§18A's curve - the table's default).
 */
export const payoutSharesOf = (m) => (m && m.payoutRule === PAYOUT_RULE.TOP_SPLIT && Array.isArray(m.payoutShares) ? [...m.payoutShares] : null);

/**
 * THE PAYOUT RULE A ROUND'S TABLE IS COMPUTED BY, from the manifest of the game it names: one answer for the
 * node's settlement, its standing line, its signed table and a slash proof's recomputation of F, so a TOP_SPLIT round's
 * table is the same everywhere. `manifest`: the game's, as the caller holds it (a node: its hosted plugin) - it must be
 * the game the round names, by id, or nothing is computed. With none: a round from TOP_SPLIT_VERSION on may be a split
 * game's, so nothing says which rule F is - refused rather than guessed at the curve; an older round cannot be one
 * (roundFitsManifest), so it is the curve, as it always was. Answers { ok, payoutShares } or { ok: false, why }.
 */
export function payoutRuleForRound(contract, manifest = null) {
  if (manifest) {
    if (!contract || !manIs32(contract.gameId)) return { ok: false, why: 'that round names no 32-byte game, so no manifest can be its game\'s' };
    let id;
    try { id = gameIdOf(manifest); } catch (e) { return { ok: false, why: `that game's manifest does not encode: ${e.message}` }; }
    if (!manSame(id, contract.gameId))
      return { ok: false, why: `that round plays game ${toHex(contract.gameId).slice(0, 16)}, and the manifest handed in is ${toHex(id).slice(0, 16)}` };
    return { ok: true, payoutShares: payoutSharesOf(manifest) };
  }
  if (contract && Number.isInteger(contract.protocolVersion) && contract.protocolVersion >= TOP_SPLIT_VERSION)
    return { ok: false, why: `a round of protocol version ${protocolVersionName(contract.protocolVersion)} may pay by its game's top split, and no manifest of game ${manIs32(contract.gameId) ? toHex(contract.gameId).slice(0, 16) : '(none)'} is held to say` };
  return { ok: true, payoutShares: null };
}
