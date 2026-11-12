// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// Everything a second implementation has to agree on before anything else can
// be compared: the version, the type bytes, and the hash tags.
//
// Tags are BIP-340 style and every hash in the protocol carries one, so a
// RoundContract digest can never collide with an Advert digest even if their
// bodies happen to encode identically. Adding a type means adding a tag, not
// reusing a neighbour's.

import { taggedHash } from './hash.js';
import { isOldTestnet4Id } from './old-series.js';
import { utf8Encode } from './utf8.js';
import {
  GENESIS_CONFIG_HASH,
  NETWORK_ID_REGTEST, NETWORK_ID_TESTNET4,
} from './genesis-ids.js';

export const PROTOCOL_VERSION = 1;

/**
 * THE VERSIONS THIS BUILD READS (2026-10-12: "Spiele und Protokolle müssen bestimmte Protokoll
 * Versionen required können. Alte nodes die da nicht updaten fliegen raus."). It writes PROTOCOL_VERSION and reads every
 * version listed here, so a cut-over can run old and new rounds side by side: a build of version N+1 lists N and N+1
 * until the last round of N has settled and refunded, then N leaves the list. A version joins the list only together
 * with its decoding - the layout read is still this build's. Every decoder asks `speaksVersion`, none compares itself.
 */
export const SUPPORTED_PROTOCOL_VERSIONS = Object.freeze([PROTOCOL_VERSION, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 27, 28]);
/** The last BLWP/v1 tags become ARENA/v1 at one point per network (tag-switch.js, kanban #525). */
export const TAG_SWITCH_VERSION = 18;
/** A node's bond outputs count as their sum: the round's floor is applied to it (census.js nodeBonds, kanban #544). */
export const BOND_SUM_VERSION = 19;
/** Under capacity pressure the guardians' custody share is weighted by bond up to B*, squared (§23A.3a part 1, kanban #559/#543). */
export const PRESSURE_WEIGHT_VERSION = 20;
/**
 * 2026.0.27 - NO DEVELOPER OR RESERVE MONEY FOR AN ENTRY THAT IS NOT ACCEPTED (kanban #1486, ruled 2026-11-11: "Er sollte keine fees
 * entgegen nehmen wenn die order nicht angenommen wird"; FEDERATION.md "Amended 2026-11-11"). A paid game round of this version takes the
 * developers' 4 % and the reserves' 2 % in the entry's FEE LOCK, beside the nodes' 4 % (fee 10 %, donation 0, no donation or reserve
 * output), and pays them at settlement for counted entries only - a refused, void or refunded entry gets them back with its stake. 21 is the
 * drawn attestors' label (#630) and 22-26 are taken on the 2.0 branches, so this is 27; versions are cumulative, keep them in step.
 */
export const GIFTS_IN_FEE_LOCK_VERSION = 27;
/**
 * 2026.0.28 - THE CERTIFIED LOCK SET (kanban #2561, spec ruling #2116 (b), 2026-11-12; multiplayer_p2p.md §17A). A paying head-to-head round of
 * this version plays only the entries its committee certified at the entry close: a threshold of the round's seats (5 of 7, 2 of 2) sign
 * LockSet { round_id, entries[] } (lock-set.js), the entries whose stake lock each signer verified before the close. No seat takes or serves a
 * reveal before it holds that certificate; no certificate by the close + LOCK_SET_WINDOW_MS and the round is VOID, every stake back. It
 * replaces the per-seat timing rules of #1598 for these rounds; every round below 28, and every free round, keeps them byte for byte.
 * 22-26 are the 2.0 branches' and 27 the gifts', so this is 28.
 */
export const LOCK_SET_VERSION = 28;
/**
 * 2026.0.2 - A ROUND CONTRACT THAT DOES NOT NAME ITS DRAW (RULED 2026-10-13, path 1: "The contract stops
 * naming the draw. The node list leaves the hashed contract bytes. Seats and the page work out who serves from the census
 * and the beacon ... Thresholds count the 7 seated nodes"). Measured 2026-10-13 00:28Z: with federation B's 7 bonds the
 * testnet4 census held 14 nodes, and no round could name its draw - the draw is seeded by the round id, which hashed the
 * very `nodes` it had to name (a fixed point only while the census is no larger than the draw). From this version:
 *   - the round id (and a series id) hash the contract with `nodes` emptied, so the list is no input to its own draw;
 *   - both roles take ONE draw, the settlement pool's (sortition.js drawRoleOf), so the seated nodes are one set of 7;
 *   - a seat fills `nodes` with that seated set itself, and every threshold counts those seats (5 of 7).
 * Other message types are written at PROTOCOL_VERSION as before: the version names the round's rules.
 */
export const DRAW_FREE_VERSION = 2;
export const namesNoDraw = (c) => !!c && Number.isInteger(c.protocolVersion) && c.protocolVersion >= DRAW_FREE_VERSION;
// EVERY GAME THROUGH EVERY FEDERATION (2026.0.32026-10-13 ~11:45Z: "Es muss möglich sein für alle Spiele über
// alle Federation zu zahlen"): from version 3 a paying round need not name one federation - a zero federation_id takes a stake
// lock in any federation its seats hold OPEN, each entry naming its own (contracts.js FEDERATION_MARKER) - and it settles one
// balanced federation transaction per federation by one payout table.
export const MULTI_FEDERATION_VERSION = 3;
export const takesAnyFederation = (c) => !!c && Number.isInteger(c.protocolVersion) && c.protocolVersion >= MULTI_FEDERATION_VERSION
  && c.federationId instanceof Uint8Array && c.federationId.length === 32 && c.federationId.every((b) => b === 0);
// TOP-N PRIZE SPLITS (2026.0.4, feature 3): from version 4 a replayed game's manifest may pay its rounds by fixed
// shares of the pot over its top places (manifest.js PAYOUT_RULE.TOP_SPLIT, payout.js computePayoutTable) instead of §18A's rank
// curve. Nothing of a round's bytes changes with it - the rule is the manifest's - and a TOP_SPLIT manifest REQUIRES this
// version, so its rounds name 4 or later and the census seats only nodes whose advert lists such a version: a node
// that cannot pay the split is never drawn for it.
export const TOP_SPLIT_VERSION = 4;
// THE MEDIAN OF SIGNED READINGS (2026.0.5RULED 2026-10-14 ~21:50Z: "Build A as protocol 5 ... each seat
// signs the price it read, and the sample is the median of five signed readings. Nobody proposes a price, so nobody chooses
// BULLS, BEARS, or FLAT. That signature change is protocol 5."). A price round of version 5 or later plays prices no seat
// proposed: each committee seat signs ITS OWN reading of each moment (price-sample.js priceReadingId), and a sample is the
// median of at least `threshold` of them (priceSampleStands5); its tape and its RoundResult are made the same way. A round
// below 5 keeps the proposed-and-countersigned sample (priceAttestationStands) exactly as before. The round's own version
// picks the scheme, never the seat's.
export const PRICE_MEDIAN_VERSION = 5;
export const mediansPrices = (c) => !!c && Number.isInteger(c.protocolVersion) && c.protocolVersion >= PRICE_MEDIAN_VERSION;
// MARKETS ON GAMES (2026.0.6, feature 6, docs/PLATFORM-RESEARCH.md item 6: "an attested market whose outcome is a
// game round's signed result ... no external oracle: the committee's 5-of-7 RoundResult resolves it"). From version 6 an ATTESTED
// manifest may name a source game instead of attestors (manifest.js `gameSource`, marker 0x05), and each round of it names the one
// round of that game it is a market on (contracts.js `sourceRoundId`, marker 0xc4). Its outcome is that source round's own
// signed result, verified against the source round's committee and threshold (game-market.js) - no attestor signs anything.
// Both fields are new bytes only a version-6 manifest and round may carry, so nothing below 6 moves; and a game market REQUIRES
// this version, so the census seats its rounds only on nodes whose advert lists 6.
export const GAME_MARKET_VERSION = 6;
// SCALAR MARKETS (2026.0.7, feature 8, docs/PLATFORM-RESEARCH.md item 8: "a numeric outcome (a price, a count) paid
// linearly between bounds. Richer questions than buckets; one market instead of many"). From version 7 an ATTESTED manifest may
// name a scalar (manifest.js `scalar`, marker 0x06): integer bounds low < high in a named unit and the two sides LONG and SHORT.
// Its attestors sign the observed VALUE, not an outcome index - a message of its own type and tag (scalar.js
// ValueAttestation), so neither kind of attestation can ever stand for the other - and the pool is split linearly between the
// sides by where the clamped value lies (scalar.js scalarPayoutTable). No round byte changes: a round of a scalar market is an
// attested round whose picks are 0 (LONG) and 1 (SHORT); the manifest REQUIRES this version, so its rounds name 7 and the
// census seats them only on nodes whose advert lists 7. Nothing below 7 reads or writes any of it.
export const SCALAR_VERSION = 7;
// SCALAR TEMPLATES (2026.0.8docs/PLATFORM-RESEARCH.md items 5 + 8: "Left: scalar templates"). From version 8 a scalar
// market may be a template (manifest.js `template` beside `scalar`): anyone opens a numeric question by publishing one round of it,
// and the round names - inside its own question's tail (contracts.js `event.scalar`) - the bounds it is paid between, low < high,
// within the manifest's bounds, in the manifest's unit. The bounds are in the round's hashed bytes, so they are its id. Only a
// version-8 round may carry them and only a version-8 manifest may be a scalar template: nothing below 8 moves.
export const SCALAR_TEMPLATE_VERSION = 8;
// THE WEBSITE THAT BROUGHT THE ENTRY (2026.0.9, roadmap item 7, RULED 2026-10-15: path (a) - "Take it out of the
// nodes' 5% fee, 20% of that fee, so nodes earn less ... The player's stake is not increased by this fee"). An entry may name the
// payout key of the page that brought it (contracts.js `frontendPk`, marker 0xac); at settlement that key is paid 20% of the nodes'
// fee on the stakes it brought, off the top of the nodes' part (fee.js frontendShares, lock-settlement.js). Only on a round of
// version 9 or later, so its seats are only nodes that pay it; every entry without it keeps its bytes.
export const FRONTEND_FEE_VERSION = 9;
// IN-GAME ITEMS (2026-10-15: "ein Spiel kann ingame items haben zb ein neuer Trick. Der kostet X Satoshi, wobei 25%
// an die protocol devs gehen, 25% an den a game dev und 50% an die nodes die in den letzten 24h an einer Runde beteiligt waren"): a
// manifest's item catalogue (items.js, marker 0x07), a purchase (purchase.js) and an entry's items (contracts.js, marker 0xad) require
// version 10; spoken since the purchase, its money path (paySubmit) and the seats' check of an entry's items were built.
export const ITEMS_VERSION = 10;
/**
 * THE PROTOCOL RESERVES' VERSION (§27A.9): a paid round's 10 % split mandatory as nodes 4 %, developers 4 % (2 + 2),
 * reserves 2 %; items 40 % nodes, 20 % reserves, the developers' share 40/30/20/10/0 %. Spoken since slice 3: an entry locks the
 * reserves' part to its federation's reserve key (reserves.js reservesEntryExpected), and the seats check it.
 */
export const RESERVES_VERSION = 11;
/** 2026.0.12: the leaderboard payout - a proposal that pays the top N of a season from the protocol reserves. */
export const LEADERBOARD_VERSION = 12;
// 2026.0.13 - THE GUARDIAN POOL IS THE FEDERATION'S SEATED GUARDIANS (§22A v4.6.4, gap 1; measured on Tick Tock round 32cfad1c,
// 10-16: test host 7, seated in federation A - no absence, no departure - was out of that day's census and got no guardian share, while
// the six in the census were paid). From this version a round's guardian third goes to the guardians its federation's record seats (not
// gone, §23A.1), whether or not each is in the round's census; below it, the census nodes naming the federation, as before.
export const SEATED_GUARDIAN_VERSION = 13;
/** 2026.0.14 (ruling 3, §23A.2 event 4): the cohort - ten guardian-capable operators guarding no OPEN federation found one. */
export const COHORT_VERSION = 14;
/** 2026.0.15 (§23A.9): a third of the guardian pool goes to the federation's two gateway seats (the record names them). */
export const GATEWAY_SEAT_VERSION = 15;
/** 2026.0.16 (§23A.10): the node fee in four pools of a quarter each - game/verify, settlement, custody, liquidity (the
 * federation's liquidity providers, who open incoming channels to new nodes). */
export const LIQUIDITY_VERSION = 16;
/** The owner's emergency key (§23A.5a): the advert names it, a request it signs takes an offline node out without losing its bond. */
export const EMERGENCY_VERSION = 17;
export const speaksVersion = (v) => SUPPORTED_PROTOCOL_VERSIONS.includes(v);

/**
 * THE FEWEST PLAYERS A ROUND OPENS FOR. The preflight sizes a signer node's Lightning
 * for it, and the fee-lock gate (lock-settlement.js `feeLockPays`) takes it as
 * the worst case: more players only raise each signer node's fee share.
 */
export const MIN_PLAYERS_PER_ROUND = 2;

/**
 * THE ENTRY WINDOW, from 5A.5's own line:
 *
 *   committee_time  >= published_at + min_publication_lead   (reference: 5 min)
 *   entry_open_time == committee_time
 *   start_time      >= committee_time + min_entry_window     (reference: 60 s)
 *
 * Entry opens when the committee exists, because the preimage shares are
 * encrypted TO the settlement committee (23.1) - an entry cannot be built
 * before there is one. So the window between them is the whole time anybody
 * has to enter, and a round that leaves none is a round nobody can join.
 *
 * The number is the spec's reference, not a taste: sixty seconds.
 */
export const MIN_ENTRY_WINDOW_MS = 60000n;

/**
 * THE START DEADLINE A ROUND GETS WHEN IT NAMES NONE (§16), in ticks after a
 * player's join tick. A first mark signed at a tick after join_tick + this is
 * the player's own late start: the entry is FORFEIT, not ENTRY_VOID
 * (first-mark.js; §13C). §16 names no number; this is the page's own window.
 *
 * MEASURED, not chosen: the core runs 65536/1092 = 60.015 ticks a second; the
 * page marks once a second (MarkEvery 60), so its first mark names tick 60 -
 * 60 for both players on the built page (lobby-regtest.sh). A mark waits up to
 * 10 s for its inputs (MARK_INPUT_WAIT_MS) and every mark due meanwhile is
 * skipped, so one timed-out wait puts an honest first mark at tick 720. 900 is
 * that plus three more missed marks: 15 s. The previous default, 120 (2 s),
 * an honest page under load could miss. A round may still name 120, or any line
 * from 1 to below its run, explicitly. It is not the active-play grace period.
 */
export const START_DEADLINE_TICKS = 900;

export const TYPE_ROUND_CONTRACT = 0x01;
export const TYPE_ENTRY_CONTRACT = 0x02;
export const TYPE_ADVERT = 0x03;
export const TYPE_CENSUS_LEAF = 0x04;
export const TYPE_CHECKPOINT = 0x05;
export const TYPE_RESULT = 0x06;
export const TYPE_PAYOUT_TABLE = 0x07;

/**
 * THE WORD A NODE PUTS ON "I HAVE NOT SEEN THIS STAKE HELD YET" (23.1 step 5).
 *
 * A node takes no play for a paying round's entry until its own Lightning shows
 * the stake held, and a wallet takes seconds to pay. That answer is a WAIT, not a
 * disagreement: the client holds the ticks and asks again, where a refusal would
 * resync and end the run. One word, here, so neither side matches on the other's
 * prose.
 */
export const STAKE_NOT_SEEN = 'stake not seen: ';

/**
 * What a player sends while a round is running.
 *
 * The only message a node takes in M2.1 that was not already here, and the
 * next free byte rather than a reuse: a batch digest must not be able to
 * collide with a contract's.
 */
export const TYPE_INPUT_BATCH = 0x08;

/** A whole round's inputs as one object - what a node hands over. */
export const TYPE_TRANSCRIPT = 0x09;

// The receipt a node returns for a checkpoint (section 10). The spec names
// the object but reserves no type for it, so this is the next free number.
export const TYPE_CHECKPOINT_RECEIPT = 0x0a;

/**
 * 13A's objection. The spec reserves neither a type nor a tag for it - it
 * gives the field list and nothing else - so both are new here, the way
 * `CheckpointReceipt` needed both, and both follow the numbering already in
 * use rather than starting a second one.
 */
export const TYPE_OBJECTION = 0x0b;

/**
 * 5A.3B's fraud proof. Same story as the objection: the spec names the
 * artifact - "the two contradicting signatures, or the transcript + receipts
 * + replay, or the payout table + its inputs" - and reserves neither a type
 * nor a tag, so both are the next free number here.
 *
 * It needs its own tag for a reason step 4 makes concrete: the slashing
 * transaction carries `H(fraud_proof)` in an OP_RETURN, so that hash is what
 * a stranger re-derives years later to check a spend was justified. A digest
 * that could collide with some other object's is a slash nobody can audit.
 */
export const TYPE_SLASH_PROOF = 0x0c;

/**
 * The settlement record of 5A.3 row 4: what a settlement node DID to a hold
 * invoice, and the conditions it published for having done it. 23.2's table
 * names the action and the requirements; the spec reserves no type for the
 * record itself, so this is the next free number, like the objection's.
 */
export const TYPE_SETTLEMENT_RECORD = 0x0d;

/**
 * 22A's fee share, as the two objects row 6 of 5A.3 needs: what a node CLAIMS
 * for a round and a role, and the record of what it actually did. The spec
 * gives the arithmetic and the availability rule and reserves no types, so
 * these are the next free numbers, like the objection's and the record's.
 */
export const TYPE_FEE_CLAIM = 0x0e;
export const TYPE_SERVICE_RECORD = 0x0f;

/**
 * 22A's donation set: the recipients and their shares, as bytes.
 *
 * The spec gives the set as JSON and names no type, so this is the next free
 * number like the fee claim's and the record's. It needs one for the reason
 * every other money object here does: without an encoding a set is a local
 * array, two nodes cannot agree WHICH set was published, and a committee has
 * nothing to check. 22A eventually hashes it into the Round Contract; the hash
 * has to exist before anything can carry it.
 */
export const TYPE_DONATION_SET = 0x10;

/**
 * A PICTURE OF SOMEBODY ELSE'S TRUCK, AND NOTHING ELSE.
 *
 * 0.9: "Other trucks are visible ghosts with no collision... Another player
 * must not be able to change my financial odds by ramming me, blocking a road,
 * pushing me, damaging me, drawing my enemies away, pulling enemies toward me,
 * sacrificing themselves for me, or colluding physically."
 *
 * 0.10: "Ghost snapshots are never inputs to this calculation." It has its own
 * type byte because it must never be mistakable for a message that IS an
 * input - an InputBatch and a Ghost differ in their first byte, before a
 * decoder has read anything else.
 */
export const TYPE_GHOST = 0x11;

/**
 * THE SHARES A PLAYER PUBLISHED FOR THEIR STAKE PREIMAGE, and the polynomial
 * they were cut from. 23.1's `vss_shares_ref` points at one of these.
 *
 * IT DECIDES SOMETHING, which is why it is a type of its own rather than a
 * blob beside an entry: a signer node refuses an entry whose handout it cannot check,
 * so this object gates play. A Ghost is the only frame in this protocol that
 * decides nothing, and this is not a Ghost.
 */
export const TYPE_VSS_HANDOUT = 0x12;

/**
 * ONE SIGNER NODE'S CONTRIBUTION TO THE COMMITTEE'S OWN KEY (M3.3 item 14).
 *
 * Its own type byte and its own tag, and NOT a VssHandout with the fields read
 * differently. A handout is a PLAYER splitting their stake preimage to the
 * committee; this is a SIGNER NODE splitting a secret nobody is meant to know to its
 * peers, and the two are only shaped alike. Sharing an encoding would let one
 * be presented as the other under an id somebody had already signed.
 */
export const TYPE_DKG_CONTRIBUTION = 0x13;

/**
 * 27A.4'S DONATION SET, WHICH IS NOT THE RECIPIENT LIST.
 *
 * `TYPE_DONATION_SET` above is 22A's list of payees and shares - the thing a
 * Round Contract's `donationSetId` names. 27A.4 specifies the object that
 * PUBLISHES one:
 *
 *     DonationSet { network_id, serial, entries[], valid_from, signature }
 *
 * and the difference decides money. A list stands or fails on its own shares;
 * this says WHICH list is the network's, FROM WHEN, and WHO SAID SO. Two type
 * bytes and not one, because a signed publication that could be read as a bare
 * list - or the reverse - is a set with two encodings, and the authority's
 * signature over one would carry to the other.
 *
 * `TYPE_AUTHORITY_ROTATION` is the recovery key's only sentence: it names a
 * new authority and can do nothing else. Its own byte for the same reason -
 * a rotation read as a donation set would be the cold key publishing payees.
 */
export const TYPE_SIGNED_DONATION_SET = 0x14;
/**
 * A DONATION SET OF KEYS (2026-10-03, FEDERATION.md "Donations in the federation"): each recipient is a 33-byte
 * secp256k1 key the player's lock transaction pays a payout contract to, in the round's federation - no LNURL. Its own
 * byte, so a set of keys and a set of LNURLs are never the same bytes, and every set already published keeps its id.
 */
export const TYPE_DONATION_SET_KEYS = 0x1b;
export const TYPE_AUTHORITY_ROTATION = 0x15;
// ONE SETTLEMENT SIGNER NODE SAYING "this is the round's claim key" (§23.1 step 0,
// v4.6.2): a client locks a stake to a claim_pk only with the round's
// threshold of these, so no single signer node can serve a key of its own (F3).
export const TYPE_CLAIM_KEY_ATTESTATION = 0x16;
// ONE SIGNER NODE SAYING WHICH DKG CONTRIBUTIONS IT COMBINED, signed. A signer node keeps its
// share only when every signer node of the committee has said the same set - so a
// dealer who sent different contributions to different signer nodes splits nobody.
export const TYPE_DKG_AGREEMENT = 0x17;
// ONE SETTLEMENT SIGNER NODE SAYING IT POSTED A RUN'S CANONICAL TRANSCRIPT to the
// round's publication relays, signed. A result is FINAL only once the round's
// threshold of signer nodes have said so (§13A, v4.6.2 P2).
export const TYPE_TRANSCRIPT_POSTING = 0x18;
// ONE COMMITTEE SIGNER NODE'S RE-RUN OF A SUSPENDED RESULT (§13A), signed: the result
// its replay of the canonical transcript produces, tied to the contradicted run.
// The spec names no wire object for it; this is that object.
export const TYPE_RERUN_RESULT = 0x19;
// A SEAT'S FINAL SIGNATURE (§13A, WINDOW-10-SPEC, 2026-10-01): one settlement seat's word that a run is FINAL,
// signed once its own clock read the window's close + the tolerance and it held no valid objection in time. Five of
// seven (the round's threshold) make the run FINAL.
export const TYPE_FINAL_SIGNATURE = 0x1a;
// A GAME'S MANIFEST (§0A.3): a game is a plugin the engine reads through this, never through its code.
/** EVERY SERIES RUNS ON ONE 90 s GRID (series.js; §5A.5): a round of a series starts every ROUND_PERIOD_MS. */
export const ROUND_PERIOD_MS = 90000n;
export const TYPE_GAME_MANIFEST = 0x1c;
// AN ATTESTED OUTCOME (§0A.7a): the attestors' word on a non-replay round's result - which outcome, when seen.
export const TYPE_OUTCOME_ATTESTATION = 0x1d;
// AN ATTESTED PRICE SAMPLE (§11): the committee's word on the price a run plays against at one tick - and the
// 64 prices before the start, as one tape - so the player never chooses the price.
export const TYPE_PRICE_SAMPLE = 0x1e;
export const TYPE_PRICE_TAPE = 0x1f;
// A FEDERATION'S RECORD (§23A.4): signed by its guardians, it decides whether a client may deposit into it,
// and whether a seat names it in a new round - OPEN, DRAINING, CRITICAL, CLOSED, HALTED.
export const TYPE_FEDERATION_RECORD = 0x20;
// RESERVE SEATS (§5A.7): a drawn node's word that it is present for a round and role, and the seating its
// seated nodes all sign - which nodes serve the round. Two seatings for one round and role are equivocation.
export const TYPE_PRESENT = 0x21;
export const TYPE_SEATING = 0x22;
// A CONFIG PROPOSAL (§27A.7.2): the full named configuration a ballot decides
export const TYPE_CONFIG_PROPOSAL = 0x23;
// A GUARDIAN'S ABSENCE ATTESTATION AND A DEPARTURE NOTICE (§23A.4 / §23A.5); 0x23 is the ballot's
export const TYPE_ABSENCE_ATTESTATION = 0x24;
export const TYPE_DEPARTURE_NOTICE = 0x25;
/** A leave request signed by a node's emergency key, for a node that is offline (§23A.5a). */
export const TYPE_EMERGENCY_DEPARTURE = 0x35;
/**
 * AN INPUT BATCH SIGNED BY ITS ENTRY'S SESSION KEY (kanban #1503, feedback #012): the batch's own bytes, then 64 bytes of
 * ed25519 over its id under the session key the Entry Contract names. The only form a player's batch is taken in on
 * /play - an unsigned batch let anybody who knew a public entry id write ticks and loads into that entry. What a seat
 * stores, hands to another seat and serves in a transcript stays the bare batch (TYPE_INPUT_BATCH): there the signed
 * mark's input chain hash endorses it.
 */
export const TYPE_SIGNED_INPUT_BATCH = 0x36;
/** THE CERTIFIED LOCK SET OF A HEAD-TO-HEAD ROUND (protocol 28, kanban #2561, lock-set.js): the set, and the set with its seats' signatures.
 * 0x50 and 0x51 are used on neither line (1.9 ends at 0x36, 2.0 at 0x4e). */
export const TYPE_LOCK_SET = 0x50;
export const TYPE_LOCK_SET_CERTIFICATE = 0x51;
// A GUARDIAN'S COPY OF A HALTED FEDERATION'S SPENT-NOTE SET (§23A.5 liquidation step 1); 0x23 is the
// ballot's, 0x24 and 0x25 absence and departure
export const TYPE_SPENT_SET = 0x26;
// WHO WON A PRICE ROUND (§13 RoundResult): open and close of the attested tape and the front, signed by the
// settlement committee
export const TYPE_ROUND_RESULT = 0x27;
// A PLAYER RESULT OF A PRICE ROUND, WITH ITS FRONT (§13 front_*): the result's own type, so a stream of results cuts by
// each record's first byte - 168 bytes without the front, 178 with it
export const TYPE_RESULT_FRONT = 0x28;
// A SEAT'S OBSERVATION THAT A FEDERATION HALTED (§23A.5 "How a halt is proven"): no guardian past session S
export const TYPE_HALT_OBSERVATION = 0x29;
// AN ATTESTED VALUE (feature 8, protocol 2026.0.7): a scalar market's attestors' word on the number it asked for - its
// own type, so an outcome attestation's bytes (0x1d) never decode as one, nor the other way round
export const TYPE_VALUE_ATTESTATION = 0x2a;
// THE DEVELOPERS' OWN BALLOT (§27A.4.1): a proposed donation set and a recipient's approval of it
export const TYPE_DONATION_PROPOSAL = 0x2b;
export const TYPE_DONATION_APPROVAL = 0x2c;
// A SET OF KEYS WHOSE ENTRIES MAY VEST (§27A.4.1): a set without vesting keeps TYPE_DONATION_SET_KEYS and its id
export const TYPE_DONATION_SET_KEYS_VESTING = 0x2d;
/** PROJECT FUNDING PROPOSALS (§27A.9.3): a proposal signed by a bonded node, a comment signed by anyone, a node's signal. */
export const TYPE_FUNDING_PROPOSAL = 0x2e;
export const TYPE_FUNDING_COMMENT = 0x2f;
export const TYPE_FUNDING_SIGNAL = 0x30;
// A PLAYER'S NAME, NETWORK-WIDE (PIP, 2026-10-17: "Have custom names in the protocol"): player-name.js
export const TYPE_PLAYER_NAME = 0x31;
// A FEE PROPOSAL AND A PROTOCOL DEVELOPER'S ANSWER TO IT (2026-10-17): fee-proposal.js
export const TYPE_FEE_PROPOSAL = 0x32;
export const TYPE_FEE_APPROVAL = 0x33;
// A LEADERBOARD PAYOUT REQUEST: leaderboard-payout.js
export const TYPE_LEADERBOARD_PAYOUT = 0x34;

// A SEALED SHARE IS A FIXED SIZE, and it is not a choice: 32 bytes of scalar
// under AES-GCM plus the 16-byte tag that makes a wrong key a REFUSAL rather
// than a garbage scalar. The nonce is derived rather than carried, so it is
// not on the wire.
export const VSS_SEALED_BYTES = 48;
export const VSS_NONCE_BYTES = 12;

export const TAG = {
  roundContract: 'ARENA/v1/RoundContract',
  // round_id(i) = H(series_id || i) (multiplayer_p2p.md "Round i of a series is derived, never authored"; ALL-BUT-MIN-1727)
  seriesRound: 'ARENA/v1/SeriesRound',
  // WHAT A ROUND'S CREATOR SIGNS (§6 creator_signature): the round's id, under this tag
  roundCreator: 'ARENA/v1/RoundCreator',
  // a series that names its creator: one signature over the series id for all its rounds
  seriesCreator: 'ARENA/v1/SeriesCreator',
  // A RULE A CONTRACT NAMES (§6 *_rule_hash): the rule's text under this tag
  contractRule: 'ARENA/v1/ContractRule',
  // (A GUARDIAN FOUNDING'S TICKET and WHO IS ON DUTY: their tags switch from BLWP/v1 to ARENA/v1 at one point - tag-switch.js, kanban #525)
  // A SEAT'S SIGNED OBSERVATION OF A HALT (§23A.5)
  haltObservation: 'ARENA/v1/HaltObservation',
  entryContract: 'ARENA/v1/EntryContract',
  advert: 'ARENA/v1/Advert',
  censusLeaf: 'ARENA/v1/CensusLeaf',
  censusBranch: 'ARENA/v1/CensusBranch',
  ticket: 'ARENA/v1/Ticket',
  // 5A.5's committee seed. Its own tag because this repo's H is a tagged hash
  // everywhere else, and a seed that shared a tag with anything could be
  // produced by hashing that other thing.
  committeeSeed: 'ARENA/v1/CommitteeSeed',
  // #630: a round's attestors are drawn on their own seed, H(this tag || committee seed) - never the settlement draw's
  attestorDraw: 'ARENA/v1/AttestorDraw',
  checkpoint: 'ARENA/v1/Checkpoint',
  checkpointReceipt: 'ARENA/v1/CheckpointReceipt',
  result: 'ARENA/v1/Result',
  payoutTable: 'ARENA/v1/PayoutTable',
  inputBatch: 'ARENA/v1/InputBatch',
  transcript: 'ARENA/v1/Transcript',
  objection: 'ARENA/v1/Objection',
  slashProof: 'ARENA/v1/SlashProof',
  // The membership and floor a payout table was computed FROM. Its own tag
  // rather than the table's, because a proof binds to the inputs and a
  // signature binds to the table, and the two must never be interchangeable.
  payoutInputs: 'ARENA/v1/PayoutInputs',
  settlementRecord: 'ARENA/v1/SettlementRecord',
  // One signer node's deal in a committee's key generation, and the id of the epoch
  // those deals belong to. Separate tags: a contribution binds to one epoch,
  // and an epoch is a set of signer nodes - neither may be produced by hashing the
  // other.
  dkgContribution: 'ARENA/v1/DkgContribution',
  dkgEpoch: 'ARENA/v1/DkgEpoch',
  // A FEDERATION'S RESERVE KEY (§27A.9.2): its own epoch, never a round committee's, even over the same seven nodes
  reserveEpoch: 'ARENA/v1/ReserveEpoch',
  feeClaim: 'ARENA/v1/FeeClaim',
  serviceRecord: 'ARENA/v1/ServiceRecord',
  // The record and the minimum a claim is measured against, bound as one hash
  // so an accuser cannot choose either of them after the fact.
  feeInputs: 'ARENA/v1/FeeInputs',
  // The whole 22A table a claim is measured against: the gross, the fee and
  // every signer node's share. A proof names which table, or the accuser picks one.
  feeTable: 'ARENA/v1/FeeTable',
  donationSet: 'ARENA/v1/DonationSet',
  // The signed publication of a set, and the cold key's rotation. Separate
  // tags from `donationSet` and from each other: the authority signs a digest,
  // and a digest that could be produced by hashing a different object is a
  // signature that carries somewhere it was never given.
  signedDonationSet: 'ARENA/v1/SignedDonationSet',
  authorityRotation: 'ARENA/v1/AuthorityRotation',
  // §27A.4.1: what a developer proposes and what each recipient signs
  donationProposal: 'ARENA/v1/DonationProposal',
  donationApproval: 'ARENA/v1/DonationApproval',
  fundingProposal: 'ARENA/v1/FundingProposal',
  fundingComment: 'ARENA/v1/FundingComment',
  fundingSignal: 'ARENA/v1/FundingSignal',
  playerName: 'ARENA/v1/PlayerName',
  feeProposal: 'ARENA/v1/FeeProposal',
  feeApproval: 'ARENA/v1/FeeApproval',
  leaderboardPayout: 'ARENA/v1/LeaderboardPayout',
  // The player's lock client's root, per round, from their seed (W1b). Its own
  // tag: it must never be the player key the same seed makes for the round.
  lockClientSecret: 'ARENA/v1/LockClientSecret',
  // The player wallet's root (§24A.1, v4.6.3): one per seed and FEDERATION - never per round. Its own tag, so it is
  // neither a round's lock client secret nor a player key over the same bytes.
  playerWalletSecret: 'ARENA/v1/PlayerWalletSecret',
  // A picture of another player's truck. Its own tag so a ghost's id can never
  // collide with a checkpoint's or a batch's over the same bytes: 0.10 says a
  // ghost is never an input, and a shared tag would be one way to forget it.
  ghost: 'ARENA/v1/Ghost',
  playerSubSeed: 'ARENA/v1/PlayerSubSeed',
  // The census entries a contract's root is checked against, and the height
  // they were taken at. Its own tag: a proof binds to the INPUTS, and a
  // signature binds to the root, and the two must never be interchangeable.
  censusInputs: 'ARENA/v1/CensusInputs',
  vssShare: 'ARENA/v1/VssShare',
  // The key one signer node's share is sealed under, and the nonce it is sealed with.
  // Two tags and not one: a key and a nonce derived from the same bytes under
  // one tag would BE the same bytes, and a nonce that equals its own key is
  // not a nonce.
  vssShareKey: 'ARENA/v1/VssShareKey',
  vssShareNonce: 'ARENA/v1/VssShareNonce',
  // The id of a whole handout - the polynomial's commitments - which is what
  // an Entry Contract's `vss_shares_ref` names. Its own tag, so a ref can
  // never be produced by hashing a single share.
  vssHandout: 'ARENA/v1/VssHandout',
  remainder: 'ARENA/v1/Remainder',
  // One signer node's attestation of (round_id, claim_pk), and the attested set an
  // entry names as `claim_key_attestation_ref` (§7, §23.1 step 0, v4.6.2).
  claimKeyAttestation: 'ARENA/v1/ClaimKeyAttestation',
  claimKeyAttestationSet: 'ARENA/v1/ClaimKeyAttestationSet',
  // The player's per-round key from their own seed, and the fingerprint of the
  // refund key it makes - what the player compares outside the page (§24, F2).
  playerKey: 'ARENA/v1/PlayerKey',
  refundFingerprint: 'ARENA/v1/RefundFingerprint',
  // WHO A TAB IS IN THE LOBBY (M3.3-34): its identity key, from the same seed
  // as every round's player key but under its own tag, so it is never one.
  lobbyIdentity: 'ARENA/v1/LobbyIdentity',
  //: the key a player buys in-game items with, and its proof on an entry that plays with one (contracts.js)
  itemsKey: 'ARENA/v1/ItemsKey',
  entryItem: 'ARENA/v1/EntryItem',
  // ONE SIGNER NODE'S SIGNED WORD ABOUT A ROUND IN ITS LOBBY (M3.3-34): the page
  // offers Join only when the round's threshold of its own signer nodes signed it.
  lobbyListing: 'ARENA/v1/LobbyListing',
  // A BOND OF THE NETWORK BEFORE THIS ONE, CARRIED BY ITS OPERATOR (§27A.8.3, spec 0A.9): what the bond's
  // node key signs to say "this bond serves network_id too". Its own tag, so a re-affirmation is never a vote or an update.
  reaffirmation: 'ARENA/v1/Reaffirmation',
  // A JOINED PLAYER'S NAME FOR ONE ROUND (lobby-name.js), signed with the
  // round key it is joined under, so a signer node can serve it but not write it.
  lobbyName: 'ARENA/v1/LobbyName',
  // The nonce of a DKG dealer's round-1 proof of knowledge, derived from its
  // own secret so no randomness source can repeat it across two proofs.
  dkgProofNonce: 'ARENA/v1/DkgProofNonce',
  // What a signer node signs to say which contributions it combined for an epoch.
  dkgAgreement: 'ARENA/v1/DkgAgreement',
  // What a settlement signer node signs once it has posted a run's transcript (§13A).
  transcriptPosting: 'ARENA/v1/TranscriptPosting',
  // What a signer node signs when it re-runs a suspended result (§13A).
  rerunResult: 'ARENA/v1/RerunResult',
  // What a settlement seat signs when it signs a run FINAL (§13A, WINDOW-10-SPEC).
  finalSignature: 'ARENA/v1/FinalSignature',
  // A game's manifest (§0A.3): what its developer signs (the body), and its id, game_id = H(body || signature).
  // Two tags: the digest a key signs is never the id of the signed object, or a signature could carry somewhere else.
  gameManifestBody: 'ARENA/v1/GameManifestBody',
  gameManifest: 'ARENA/v1/GameManifest',
  // a federation record's id, the bytes its guardians sign (federation-record.js)
  federationRecord: 'ARENA/v1/FederationRecord',
  //: a game's description and website, signed by its developer key beside its manifest (game-info.js)
  gameInfo: 'ARENA/v1/GameInfo',
  // A head-to-head player's hidden move: H(round_id || entry key || move || salt), revealed after entry close.
  headToHeadCommit: 'ARENA/v1/HeadToHeadCommit',
  // a market order's id, the bytes its player signs (order-book.js)
  marketOrder: 'ARENA/v1/MarketOrder',
  // a player's cancel of a market entry before its entry close
  marketCancel: 'ARENA/v1/MarketCancel',
  // one batch of a market's order book, the set its seats agreed and signed (order-book.js)
  marketBatch: 'ARENA/v1/MarketBatch',
  // a player's sell of shares its market entry holds (comment 1127)
  marketSell: 'ARENA/v1/MarketSell',
  // a seat's word that it did not sign a batch and never will (a batch is void once 5 can no longer be reached)
  marketBatchDecline: 'ARENA/v1/MarketBatchDecline',
  // a round seat's ask that the others answer whether they signed a batch past its signing window, or decline it (kanban #1167)
  marketBatchVoidAsk: 'ARENA/v1/MarketBatchVoidAsk',
  // a player's identity key naming its head-to-head entry, and a seat's signed running score of two identities
  // THE CERTIFIED LOCK SET (protocol 28, kanban #2561): the set's id, a seat's signature over (set id, its time), and a seat's signed view
  // (what it verified) - each its own tag, so a view is never a certificate's signature
  lockSet: 'ARENA/v1/LockSet',
  lockSetSignature: 'ARENA/v1/LockSetSignature',
  lockSetView: 'ARENA/v1/LockSetView',
  matchProof: 'ARENA/v1/MatchProof',
  matchRecord: 'ARENA/v1/MatchRecord',
  presence: 'ARENA/v1/Presence',
  // §5A.7 reserve seats
  seatPresent: 'ARENA/v1/SeatPresent',
  seating: 'ARENA/v1/Seating',
  // §23A.5 a guardian's signed copy of a halted federation's spent-note set
  spentSet: 'ARENA/v1/SpentSet',
  // §13 who won a price round: BULLS / BEARS / FLAT by its attested open and close
  roundResult: 'ARENA/v1/RoundResult',
  // What an attestor signs for a non-replay round (§0A.7a): the outcome attestation's body.
  outcomeAttestation: 'ARENA/v1/OutcomeAttestation',
  // What a scalar market's attestors sign (feature 8): the value attestation's body - another tag than the outcome's,
  // so a signature over one is never a signature over the other, whatever their bytes
  valueAttestation: 'ARENA/v1/ValueAttestation',
  priceSample: 'ARENA/v1/PriceSample',
  priceTape: 'ARENA/v1/PriceTape',
  // protocol 5: ONE seat's own reading of one moment, and of the 64 moments before the start - each signed by that
  // seat alone; nobody signs anyone else's price
  priceReading: 'ARENA/v1/PriceReading',
  priceTapeReading: 'ARENA/v1/PriceTapeReading',
  // THE BALLOT (§27A.7.2-3): a proposal's body the proposer signs, its id, and what a bond key signs to vote
  configProposalBody: 'ARENA/v1/ConfigProposalBody',
  configProposal: 'ARENA/v1/ConfigProposal',
  vote: 'ARENA/v1/Vote',
  // the proposal a deposit commits to (§27A.7.2, ruled 2026-11-12 #2125/#2012): its body without the deposit txid
  configProposalCommit: 'ARENA/v1/ConfigProposalCommit',
  // ABSENCE AND DEPARTURE (§23A.4-5): what a guardian signs, and an abandonment proof's id
  absenceAttestation: 'ARENA/v1/AbsenceAttestation',
  departureNotice: 'ARENA/v1/DepartureNotice',
  emergencyKey: 'ARENA/v1/EmergencyKey',
  emergencySecret: 'ARENA/v1/EmergencySecret',
  emergencyDeparture: 'ARENA/v1/EmergencyDeparture',
  abandonmentProof: 'ARENA/v1/AbandonmentProof',
};

/**
 * WHERE THE OTHER HALF OF A SLASHED BOND GOES, and it is the one thing 5A.3
 * leaves to the contract.
 *
 * "Slashed bonds are distributed: half to the affected players of that round;
 * the other half 75% evenly to the active census nodes at the slashing height
 * minus the round's own seats (the witnesses) and 25% to the donation set of
 * §22A - the developers."
 *
 * BURN AND COMMITTEE ARE BOTH WITHDRAWN (RULED 2026-09-21). "Nothing is
 * ever burned, here or anywhere in this protocol: a slash that destroys value
 * pays nobody for the harm and makes the slashing itself worthless to prove, so
 * every remainder in this document has a recipient." The other half of a round's
 * slash now goes 75% to the active census nodes at the slashing height MINUS the
 * round's own seats - the witnesses - and 25% to the donation set of §22A. That
 * is one rule, so `slashRemainder` has one valid value and a round naming
 * anything else is invalid.
 *
 * THE HALVES ARE NOT A FIELD: the spec states them as numbers, and a contract
 * that could move them would let an operator write itself the whole bond - which
 * is the fault putting anything in the contract is meant to stop, not one to
 * import. Order is protocol: it indexes the byte.
 *
 * SPLIT takes byte 0, which BURN used to hold. A contract stored before this
 * therefore reads as SPLIT rather than as a burn, and that is the safe
 * direction: the money it describes is paid out instead of destroyed. Byte 1,
 * the old COMMITTEE, no longer decodes at all.
 */
export const SLASH_REMAINDERS = ['SPLIT'];
export const slashRemainderByte = (where) => {
  const at = SLASH_REMAINDERS.indexOf(where);
  if (at < 0) throw new Error(`${where} is not one of ${SLASH_REMAINDERS.join(', ')}`);
  return at;
};
export const slashRemainderOf = (byte) => {
  const where = SLASH_REMAINDERS[byte];
  if (!where) throw new Error(`${byte} is not a slash remainder byte`);
  return where;
};

/**
 * Half, in basis points, and a CONSTANT rather than a field for the reason
 * above. 5A.3 says half to the affected players; the contract says where the
 * rest goes, not how much of it there is.
 */
export const SLASH_TO_PLAYERS_BPS = 5000;

/** Roles a bonded node can stand for. Order is protocol: it indexes roleByte. */
export const ROLES = ['game', 'verify', 'settlement', 'relay'];
export const roleByte = (role) => {
  const i = ROLES.indexOf(role);
  if (i < 0) throw new Error('unknown role: ' + role);
  return i;
};

/**
 * THE ONE ADDRESS EVERY BOND PAYS A DUST OUTPUT TO.
 *
 * Section 25.1: "A P2TR output is a 32-byte key and looks like every other
 * one, so a bond cannot be recognised from its output... OP_RETURN does not
 * help either: BIP158 compact filters exclude it." Hence the requirement:
 * "Every bond funding transaction MUST pay a dust output to BOND_MARKER, a
 * single address fixed by this protocol." One address for every bond, so it
 * appears in the compact filters and any light client can find every bond that
 * has ever existed without asking anyone. It costs one dust output, once.
 *
 * 2026-09-08: set for regtest and testnet. Mainnet stays unchosen.
 * Each program is taggedHash(ARENA/v1/BOND_MARKER, network-name) - 32 bytes,
 * not a wallet key. Compact filters match the P2TR script. Changing a value
 * makes every bond posted against the old one unfindable.
 */
const markerProgram = (network) => taggedHash('ARENA/v1/BOND_MARKER', utf8Encode(network));

export const BOND_MARKER_REGTEST = markerProgram('regtest');
export const BOND_MARKER_TESTNET = markerProgram('testnet');
export const BOND_MARKER_MAINNET = null;

/** @deprecated use bondMarker(network). Mainnet is still null. */
export const BOND_MARKER = BOND_MARKER_MAINNET;

export function bondMarker(network) {
  if (network === 'regtest') return BOND_MARKER_REGTEST;
  // BOTH NAMES FOR ONE NETWORK, as `networkAnchor` already takes them. The
  // chain is called `bitcoin-testnet4` in genesis and `testnet` here, and a
  // census that looked up its marker by the id got 'testnet4' back and was
  // told no marker had been chosen - for a network that has one. Two
  // vocabularies for one chain is a translation waiting to be forgotten at a
  // call site, so both are answered here instead.
  if (network === 'testnet' || network === 'testnet4') return BOND_MARKER_TESTNET;
  throw new Error(
    'BOND_MARKER for ' + String(network || 'mainnet') + ' has not been chosen. '
    + 'Regtest and testnet are set; mainnet is fixed once, before the first '
    + 'mainnet bond, and every bond posted without it is unfindable');
}

/**
 * THE NETWORK THIS BUILD IS FOR, AND WHY IT IS ALSO NULL.
 *
 * 27A.4: `network_id = H(genesis_parameters || donation_authority_pubkey ||
 * donation_recovery_pubkey || predecessor || fork_certificate_hash)`. "Round
 * Contracts carry it, nodes and clients reject contracts that do not match the
 * one they were built for."
 *
 * 27A.9 makes it the trust anchor: "The trust anchor is the client's own
 * built-in `network_id`, NEVER A VALUE FROM THE CONTRACT." So it is a build
 * constant, not a field a round can talk this software into.
 *
 * 2026-09-08: regtest and testnet4 are set. Mainnet is not. This build's
 * default anchor is testnet4 (the live LND chain). Recovery keys are test keys
 * on disk, not cold-storage mainnet keys.
 */
export const NETWORK_ID = NETWORK_ID_TESTNET4;

export function networkAnchor(network) {
  if (!network) return NETWORK_ID;
  if (network === 'regtest') return NETWORK_ID_REGTEST;
  if (network === 'testnet4' || network === 'testnet') return NETWORK_ID_TESTNET4;
  throw new Error('NETWORK_ID for ' + network + ' has not been chosen');
}

/**
 * AND THE SAME QUESTION BACKWARDS: which network is this id?
 *
 * A round contract names its network by ID, and the findability rule names it
 * by MARKER - "every bond funding transaction MUST also pay a dust output to
 * BOND_MARKER" (5A.2), one address per network. A census holding the id and
 * checking the marker of some other network is checking a fact about a chain
 * it is not on, and the markers differ, so it would accept a bond posted
 * somewhere else entirely.
 *
 * Null for an id this build does not know: a contract for a network nobody
 * here has genesis for is not a contract whose bonds can be found, and saying
 * so beats guessing regtest.
 */
export function networkOf(networkId) {
  if (!(networkId instanceof Uint8Array) || networkId.length !== 32) return null;
  const same = (a) => a.every((b, i) => b === networkId[i]);
  if (same(NETWORK_ID_REGTEST)) return 'regtest';
  if (same(NETWORK_ID_TESTNET4)) return 'testnet4';
  // PICK B (old-series.js): testnet4 under its id before genesis_series_start, for series 3cfbe516 alone
  if (isOldTestnet4Id(networkId)) return 'testnet4';
  return null;
}

/**
 * THE CONFIG THIS NETWORK STARTED ON, null for the same reason.
 *
 * Live core numbers: exposure 320 m, mouth 34 m, apron 22 m, front span 40 m,
 * T 0.25..1.5, rank 3/4, block 9000 ticks, node fee 2.00%, current heat.
 */
// RE-EXPORTED, NOT RE-DECLARED. `export const GENESIS_CONFIG_HASH = ...` here
// made a SECOND top-level binding of a name `genesis-ids.js` already owns, and
// the client bundler refuses that by design - it flattens the modules into one
// scope, so two top-level declarations of one name is two different values
// under one name for whoever reads it last. The build had been failing since
// the name arrived, which took the client's whole suite with it.
export { GENESIS_CONFIG_HASH } from './genesis-ids.js';

export function genesisConfigHash() {
  return GENESIS_CONFIG_HASH;
}

/**
 * The objection window's reference length: ten minutes, in milliseconds.
 *
 * Section 13A gives "reference: 10 minutes, contract-defined". A REFERENCE is
 * not a default: the number lives in the round contract the player signed, and
 * this is here so a round can be written with the figure the spec suggests
 * rather than one somebody remembered.
 */
export const OBJECTION_WINDOW_REFERENCE_MS = 600000n;

/**
 * THE OBJECTION WINDOW, FIXED (§13A, WINDOW-10-SPEC, RULED 2026-10-01 09:40): exactly 600 seconds of wall time from
 * the round's end as its contract fixes it. Not a contract choice, not blocks, not a range: a Round Contract whose
 * objection_window_W is anything else is invalid. It replaces the six-hour cap (MAX_OBJECTION_WINDOW_MS, withdrawn).
 */
export const OBJECTION_WINDOW_MS = 600_000n;
/**
 * §13A'S ONE EXCEPTION, HEAD-TO-HEAD ROUNDS (RULED 2026-11-10, kanban #1398): a head-to-head round's result is a pure function of two
 * signed commitments and two signed reveals, so its window is 60 s (`objection_window_h2h`), 5 s on a regtest; replayed games keep 600 s.
 * A contract may name one of these; which one its round may name is its game's kind, checked where the game is known (objectionWindowFits).
 */
export const OBJECTION_WINDOW_H2H_MS = 60_000n;
export const OBJECTION_WINDOW_H2H_REGTEST_MS = 5_000n;
/** A window some round may name: 600 s, or a head-to-head round's 60 s (5 s on a regtest). */
export const objectionWindowAllowed = (w) => w === OBJECTION_WINDOW_MS || w === OBJECTION_WINDOW_H2H_MS || w === OBJECTION_WINDOW_H2H_REGTEST_MS;
/**
 * The window a round of this kind may name: a replayed game exactly 600 s; a head-to-head game its short window (60 s, a regtest's 5 s) - or
 * 600 s, as every head-to-head round published before the ruling names. `regtest`: the contract names the regtest network.
 */
export function objectionWindowFits(w, { headToHead = false, regtest = false } = {}) {
  if (w === OBJECTION_WINDOW_MS) return { ok: true };
  if (!headToHead) return { ok: false, why: `that round's objection window is ${w} ms; a replayed game's is exactly ${OBJECTION_WINDOW_MS} ms (§13A)` };
  const short = regtest ? OBJECTION_WINDOW_H2H_REGTEST_MS : OBJECTION_WINDOW_H2H_MS;
  return w === short ? { ok: true } : { ok: false, why: `that round's objection window is ${w} ms; a head-to-head game's is ${short} ms or ${OBJECTION_WINDOW_MS} ms (§13A, kanban #1398)` };
}
/** The clock tolerance (§13A, RULED with WINDOW-10-SPEC): a seat signs FINAL at window close + 5 s, and counts a signed time only within 5 s of its own clock. */
export const FINAL_TOLERANCE_MS = 5_000n;

/**
 * WHICH CUSTODY CONSTRUCTION A ROUND USES. Section 23.6 says "The Round Contract names which construction it
 * uses", and it has one (the other it once named, a threshold-signed Lightning node, is withdrawn - RULED
 * 2026-09-22 22:59, below):
 *
 *   FEDERATION     V1. A Fedimint-class federation with the STAKE LOCK inside
 *                  it - LNv2's OutgoingContract, claimed by preimage and the
 *                  claim key, forfeited by the claim key to the refund key,
 *                  refunded after expiry, all enforced by the guardians'
 *                  consensus. Lightning only at the edges: deposits and
 *                  withdrawals through any of at least two gateways run by
 *                  different operators. No gateway holds a round's money.
 *
 * A round has to SAY which one it ran under: the residual differs by layer
 * (22: the settlement committee over a round's locks, and the guardians over
 * the federation - a halted federation freezes refunds), and a round settled
 * under one cannot be replayed as if it were the other.
 *
 * Naming a construction is not implementing one. The FEDERATION stake lock is
 * rehearsed on stock fedimintd 0.12.0 in arena-node/tools, but this field and
 * its byte do not bring custody into the node or the client.
 */
/**
 * THE ONE 75/25, so two money paths cannot drift apart.
 *
 * §5A.3 for a slashed round bond and §23A.5 for a slashed guardian bond say the
 * same thing in the same words: 75% to the nodes, 25% to the donation set of
 * §22A - the developers. It was written out twice, once in `slash.js` and once
 * in `federation-slash.js`, and two copies of a split are two chances to change
 * one of them.
 *
 * FLOOR THE NODES AND GIVE THE REST TO THE DEVELOPERS, so the two always add
 * back to the amount exactly and no satoshi can fall between them.
 *
 * WHICH SIDE TAKES THE ODD SATOSHI IS A CHOICE MADE HERE, not a number the spec
 * states: §5A.3 and §23A.5 say 75 and 25 and stop. `payout.js` names an order
 * for leftovers WITHIN one set (`remainderOrder`, ascending H(roundId||pubkey))
 * but says nothing about a 75/25, so there was no existing rule to reuse.
 * Flooring the developers instead would be equally compliant; this direction is
 * written down so nobody later reads 12501 as the spec's own figure.
 */
export const NODE_SHARE_PCT = 75n;
export const splitNodesDevelopers = (amount) => {
  const nodes = (amount * NODE_SHARE_PCT) / 100n;
  return { nodes, developers: amount - nodes };
};

/**
 * THE CUSTODY FIELD HAS ONE VALUE (RULED 2026-09-22 22:59, §23.6):
 * "[the threshold-signed Lightning custody] does not exist, past rounds included, no decode-only value ... the custody field has
 * ONE value, FEDERATION, and no other value is defined, reserved, or kept for decoding. A round that
 * names anything else is invalid, PAST ROUNDS INCLUDED: a record from before this ruling that carries
 * the old value is not a round of this network and is neither decoded, replayed, settled, listed nor
 * counted; a node that holds such a record treats it as it treats bytes that do not parse."
 *
 * SO FEDERATION KEEPS BYTE 1, AND BYTE 0 IS NOT A VALUE. This is the whole of the wire design and it
 * follows from the ruling rather than from convenience: if FEDERATION were renumbered to 0 - the tidy
 * reading of "one value" - then every record written under the old byte 0 would DECODE, silently, as
 * FEDERATION. That is the one outcome the ruling forbids by name. Leaving 1 where it is makes the old
 * byte undefined, so those records do not parse, which is exactly what they are owed.
 *
 * `CUSTODY` is therefore sparse: index 0 is a hole, not a label. Nothing may fill it.
 */
export const CUSTODY = Object.freeze([undefined, 'FEDERATION']);
export const CUSTODY_VALUES = Object.freeze(['FEDERATION']);
export const custodyByte = (which) => {
  const at = CUSTODY.indexOf(which);
  if (at < 0 || which === undefined)
    throw new Error(`${which} is not a custody this network has: the one value is ${CUSTODY_VALUES.join(', ')}`);
  return at;
};
/** The name a custody byte carries, or null when the byte is not a value of this network. */
export const custodyName = (byte) => (byte === 1 ? 'FEDERATION' : null);

/**
 * HOW LONG A STAKE LOCK RUNS, in the federation's blocks: 144, one day (§23.1,
 * ruled 2026-09-11). It covers round + objection window + the settlement
 * transaction only - a forfeit stays redeemable after expiry, and after it the
 * player's key alone refunds, so delay is never loss.
 */
export const STAKE_EXPIRY_BLOCKS = 144;

/**
 * HOW FAR BELOW THE VERIFYING HEIGHT A LOCK'S OWN HEIGHT MAY BE, in the federation's blocks: 12
 * (§23.1 step 5, `stake_lock_freshness_blocks`, RULED 2026-09-24). A lock verified within 12
 * blocks of its creation still has at least 132 blocks - 22 hours on mainnet - to cover the round, the
 * objection window and the settlement transaction.
 */
export const STAKE_LOCK_FRESHNESS_BLOCKS = 12;

/**
 * THE SCORE'S UNIT: an integer count of 1e-5 points (2026-09-25: "Their product is the score, so the core's score
 * is that product"). The core's score is 1000 · E · T · C with each factor on a 1e-5 grid (core/src/rules/score.js,
 * SCORE_SCALE there is this number and core/test/score-scale.test.js pins the two together); a PlayerResult's u32 score
 * carries it as-is. A round contract's min_score is compared with it directly - multiplayer_p2p.md §18A.5, "score >=
 * min_score" - so min_score is in the same unit: the spec's reference value of 1 point is 100000.
 */
export const SCORE_SCALE = 100000;
