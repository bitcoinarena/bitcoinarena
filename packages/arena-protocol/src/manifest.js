// A GAME IS A MANIFEST (§0A.3, kanban #202, the owner 2026-10-06/07). The engine never imports a game's code: what it needs
// from a game - which cores, which configs, how long a run may be, which of the engine's payout rules and with which
// numbers - it reads from the game's manifest, and from the game's core only through the adapter a node installed.
//
//     GameManifest {
//       game_name, game_dev_pubkey, version, parent_manifest_id, result_type,
//       cores[] (each with its configs[]), run_ticks_max, round_period,
//       payout_rule, payout_params (the rank curve's numerator and denominator), min_score,
//       clients[], game_donation_set,
//       [ATTESTED only] outcomes[], attestors[], attest_threshold,
//       [HEAD_TO_HEAD only] players, move_count, reveal_window,
//       [ATTESTED, optional] market terms: node_fee_bps, donation_bps, question, resolve_after_close, deadline_after_resolve,
//         source_rule (kanban #235),
//       signature by game_dev_pubkey
//     }
//     game_id = H(GameManifest)
//
// The developer signs the BODY's id (TAG.gameManifestBody), not the bytes that carry the signature - an object whose
// bytes held its own signature could not be signed - and game_id is the hash of body and signature together
// (TAG.gameManifest), so two signatures over one body are two manifests, never one id for either.
//
// An update is a new manifest: the same key, the old id as its parent, the next version. A round names the exact
// manifest it plays (contracts.js gameId), so an update never changes a round already written.
//
// WHO SIGNS (the owner 2026-10-07 15:40): the game developer's dev client (arena-donor/src/manifest-sign.js), never a node -
// a node only verifies, through `manifestStands`.
//
// NO CURVE, as everywhere in this package: `verify(signature, digest, key)` is injected (Ed25519, the scheme the
// donation authority signs with), and a manifest with no verifier to check it is not a game.
import { Writer, Reader } from './encode.js';
import { taggedHash, toHex } from './hash.js';
import { PROTOCOL_VERSION, speaksVersion, TYPE_GAME_MANIFEST, TAG, ROUND_PERIOD_MS } from './constants.js';
import { protocolVersionName } from './protocol-version.js';
import { EVENT_VERSION } from './contracts.js';

/**
 * What a game's result is (§0A.7, §0A.7a; kanban #206): a replayed run, or an outcome its attestors sign (a price, an
 * event - a prediction market), with no core and no run.
 */
export const RESULT_TYPE = Object.freeze({ REPLAY: 1, ATTESTED: 2, HEAD_TO_HEAD: 3 });
/**
 * The engine's payout rules a manifest may pick (§0A.5): §18A's rank curve for a replayed run; pari-mutuel for an attested
 * outcome (the owner 2026-10-07, #206: no counterparty - the losing picks' net stakes pay the winning picks).
 */
export const PAYOUT_RULE = Object.freeze({ RANK_CURVE: 1, PARI_MUTUEL: 2 });
/** An attested game names 2 to 16 outcomes and 1 to 16 attestors. */
export const OUTCOMES_MAX = 16;
export const ATTESTORS_MAX = 16;

/**
 * A MARKET'S OWN TERMS (kanban #235, the owner 2026-10-09: the market's fee "per market in manifest"; "refund at deadline"):
 * its fee - the node share and the donation, each in basis points of the stake, within the network's (NODE_FEE_BPS 500,
 * donations up to 500) - its question, when its outcome is decided (`resolveAfterCloseMs` after a round's entry close),
 * the deadline its attestors have after that, and the rule its attestors read the outcome by (sources and aggregation, as
 * text). Optional: an attested manifest without them keeps the network's fee and today's rules, and its bytes.
 */
export const MARKET_TERMS_MARKER = 0x01;

/**
 * THE PROTOCOL VERSION A GAME REQUIRES (kanban #349, the owner 2026-10-12: "Spiele und Protokolle müssen bestimmte Protokoll
 * Versionen required können. Alte nodes die da nicht updaten fliegen raus."): optional, written last after its own marker,
 * so every manifest without it keeps its bytes and its game id. A round of the game names that version or a later one
 * (roundFitsManifest, gameIsKnownGood), and the census seats only nodes whose advert lists the round's version - a node
 * that did not update is not drawn for the game's rounds. A node too old to know the field cannot read the manifest at
 * all (trailing bytes), so it cannot host the game either.
 */
export const REQUIRED_VERSION_MARKER = 0x02;
/**
 * AN EVENT-MARKET TEMPLATE (kanban #362 feature 5, docs/PLATFORM-RESEARCH.md: "a manifest is a template (attestors, terms,
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
 * keeps its bytes and its game id. A template REQUIRES protocol version 3 or later (#349): its rounds carry their question
 * in a contract tail a node of 2026.0.3 reads (contracts.js EVENT_MARKER), and a node too old to know the field cannot read
 * the manifest at all (trailing bytes), so it cannot host the template. A template runs on no grid (round_period 0): each
 * round names its own times.
 */
export const TEMPLATE_MARKER = 0x03;
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
/** Is this manifest an event-market template (kanban #362 feature 5): an attested game whose rounds ask their own question? */
export const isTemplate = (m) => !!m && m.resultType === RESULT_TYPE.ATTESTED && !!m.template;

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
  // AT MOST 10 % IN ALL (the owner 2026-10-09: "fees per market can't be more than ... to prevent malicious markets" - "I mean 10
  // in total"): the node fee and the donation together, each at most 5 % - a market takes no more of a stake than the
  // network's own games can (5 % node fee + up to 5 % donation)
  if (t.nodeFeeBps + t.donationBps > MARKET_TOTAL_FEE_BPS_MAX) return { ok: false, why: `a market's node fee and donation come to at most ${MARKET_TOTAL_FEE_BPS_MAX} bps (10 %) together; these come to ${t.nodeFeeBps + t.donationBps}` };
  if (typeof t.question !== 'string' || t.question.length < 1 || t.question.length > 256) return { ok: false, why: 'a market asks its question in 1 to 256 characters' };
  if (typeof t.resolveAfterCloseMs !== 'bigint' || t.resolveAfterCloseMs < 0n || t.resolveAfterCloseMs > MARKET_RESOLVE_MAX_MS) return { ok: false, why: 'a market resolves 0 to 30 days after its entry close' };
  if (typeof t.deadlineAfterResolveMs !== 'bigint' || t.deadlineAfterResolveMs < MARKET_DEADLINE_MIN_MS || t.deadlineAfterResolveMs > MARKET_DEADLINE_MAX_MS) return { ok: false, why: 'a market gives its attestors 1 minute to 7 days after its resolution time' };
  if (typeof t.sourceRule !== 'string' || t.sourceRule.length < 1 || t.sourceRule.length > 1024) return { ok: false, why: 'a market names the rule its attestors read the outcome by, in 1 to 1024 characters' };
  return { ok: true };
}

/** Is this manifest's result attested - no core, no run, its attestors' signed outcome (§0A.7a)? */
export const isAttested = (m) => !!m && m.resultType === RESULT_TYPE.ATTESTED;
/**
 * IS THIS A HEAD-TO-HEAD GAME (kanban #233, the owner 2026-10-09)? Each player commits a hidden move at entry and reveals
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
    if (!Array.isArray(m.attestors) || m.attestors.length < 1 || m.attestors.length > ATTESTORS_MAX || !m.attestors.every(manIs32))
      throw new Error(`an attested game names 1 to ${ATTESTORS_MAX} attestor keys of 32 bytes`);
    if (!Number.isInteger(m.attestThreshold) || m.attestThreshold < 1 || m.attestThreshold > m.attestors.length)
      throw new Error(`an attested game's threshold is 1 to its ${m.attestors.length} attestor(s)`);
    if (m.marketTerms !== undefined && m.marketTerms !== null) { const f = marketTermsFit(m.marketTerms); if (!f.ok) throw new Error(f.why); }
    if (m.template !== undefined && m.template !== null) { const f = marketTemplateFits(m.template, m); if (!f.ok) throw new Error(f.why); }
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
    if (m.payoutRule !== PAYOUT_RULE.RANK_CURVE) throw new Error(`a replayed game pays by the rank curve; payout rule ${m.payoutRule} is not one of the engine's for it (§0A.5)`);
    if (!Number.isInteger(m.rankNumerator) || !Number.isInteger(m.rankDenominator) || m.rankDenominator < 1
        || m.rankNumerator < 1 || m.rankNumerator >= m.rankDenominator || m.rankDenominator > 255)
      throw new Error('the rank curve is a numerator below its denominator, both 1 to 255');
    if (!Number.isInteger(m.minScore) || m.minScore < 0) throw new Error('min_score is a whole number of score units');
  }
  if (typeof m.roundPeriodMs !== 'bigint') throw new Error('round_period is a BigInt of milliseconds');
  if (!isAttested(m) && m.template !== undefined && m.template !== null) throw new Error('only an attested game is a market template: its rounds ask a question its attestors answer');
  if (!manNameOf(m.payoutRule, PAYOUT_RULE)) throw new Error(`payout rule ${m.payoutRule} is not one of the engine's (§0A.5)`);
  if (!Array.isArray(m.clients) || !m.clients.every(manIs32)) throw new Error('a client is named by its 32-byte hash');
  if (!manIs32(m.gameDonationSetId)) throw new Error('a game names its donation set by its 32-byte id');
  if (m.requiredProtocolVersion !== undefined && m.requiredProtocolVersion !== null
      && (!Number.isInteger(m.requiredProtocolVersion) || m.requiredProtocolVersion < 1 || m.requiredProtocolVersion > 65535))
    throw new Error('a required protocol version is 1 to 65535');

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
    // ITS MARKET TERMS (kanban #235), after a marker and only when it names them: every attested manifest before keeps its bytes
    if (m.marketTerms) {
      const t = m.marketTerms;
      w.u8(MARKET_TERMS_MARKER); w.u16(t.nodeFeeBps); w.u16(t.donationBps); w.str(t.question);
      w.u64(t.resolveAfterCloseMs); w.u64(t.deadlineAfterResolveMs); w.str(t.sourceRule);
    }
    // ITS TEMPLATE (kanban #362 feature 5), after its own marker and only when it is one: every attested manifest before keeps its bytes
    if (m.template) {
      const t = m.template;
      w.u8(TEMPLATE_MARKER); w.str(t.category); w.u8(t.maxOutcomes); w.u64(t.resolveWithinMs);
    }
  }
  // A HEAD-TO-HEAD GAME'S OWN TERMS, likewise after everything else: no other manifest's bytes move
  if (isHeadToHead(m)) {
    w.u8(m.players);
    w.u8(m.moveCount);
    w.u64(m.revealWindowMs);
  }
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
  }
  if (body.resultType === RESULT_TYPE.HEAD_TO_HEAD) {
    body.players = r.u8();
    body.moveCount = r.u8();
    body.revealWindowMs = r.u64();
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
 * MAY THIS ROUND BE PLAYED UNDER THIS MANIFEST (§0A.3, §0A.5; #202): it names the manifest's game, a core the manifest
 * lists, a config the manifest lists for that core, a run no longer than run_ticks_max, the manifest's rank curve, and a
 * min_score no lower than the manifest's (the game's floor; a round may ask more of its runs, never less).
 */
export function roundFitsManifest(contract, m, gameId = gameIdOf(m)) {
  const name = `game "${m.gameName}"`;
  if (!contract || !manIs32(contract.gameId)) return { ok: false, why: 'that round names no 32-byte game' };
  if (!manSame(contract.gameId, gameId)) return { ok: false, why: `that round names game ${toHex(contract.gameId).slice(0, 16)}, not ${name} ${toHex(gameId).slice(0, 16)}` };
  if (m.requiredProtocolVersion && !(Number.isInteger(contract.protocolVersion) && contract.protocolVersion >= m.requiredProtocolVersion))
    return { ok: false, why: `${name} requires protocol version ${protocolVersionName(m.requiredProtocolVersion)}; that round runs ${Number.isInteger(contract.protocolVersion) ? protocolVersionName(contract.protocolVersion) : 'none'}` };
  // A ROUND ASKS ITS OWN QUESTION ONLY UNDER A TEMPLATE (kanban #362 feature 5): every other game's question - and its outcomes,
  // and when it resolves - is its manifest's, and a round naming its own there would show players a market nobody signed
  const asks = contract.event !== undefined && contract.event !== null;
  if (asks && !isTemplate(m)) return { ok: false, why: `${name} is not a market template: its question is its manifest's, and a round of it carries none of its own` };
  // AN ATTESTED ROUND (§0A.7a) NAMES NO CORE AND NO CONFIG: both 32 zero bytes - there is nothing to replay it with
  if (isAttested(m)) {
    if (!manIs32(contract.simCoreHash) || !manIsZero(contract.simCoreHash) || !manIs32(contract.configHash) || !manIsZero(contract.configHash))
      return { ok: false, why: `${name} is attested: its rounds name no core and no config (32 zero bytes each) - nothing of them is replayed` };
    if (isTemplate(m)) {
      const fits = eventFitsTemplate(contract, m);
      if (!fits.ok) return fits;
      return { ok: true, attested: true, template: true };
    }
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
  if (m.payoutRule !== PAYOUT_RULE.RANK_CURVE) return { ok: false, why: `${name} picks payout rule ${m.payoutRule}, which is not the engine's` };
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
 * DOES THIS ROUND'S QUESTION FIT ITS TEMPLATE (kanban #362 feature 5)? A round of a template MUST carry its own question
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
 * THE MARKET A ROUND PLAYS (kanban #362 feature 5): a round of a template reads its outcomes, its question and its resolution
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
    event: ev };
}

/**
 * MAY THIS GAME RUN ON A SERIES OF `periodMs` (§0A.3 round_period; kanban #202)? Every series of this network runs on
 * the one 90 s grid (series.js ROUND_PERIOD_MS), so a game whose manifest names another period has no series here; one
 * naming 0 asks no period and runs on any.
 */
export function seriesPeriodFits(m, periodMs = ROUND_PERIOD_MS) {
  // A MARKET'S SERIES RUNS ON ITS OWN round_period (kanban #236/#237, §0A.7b.4: "Market rounds on their own 15 min period
  // instead of the 90 s grid"), if a day holds a whole number of its rounds; the answer names it. Every other game is on
  // the network's 90 s grid, as before: a round_period of 0 or 90 s.
  if (m.resultType === RESULT_TYPE.ATTESTED && m.roundPeriodMs > 0n) {
    if (86400000n % m.roundPeriodMs !== 0n) return { ok: false, why: `market "${m.gameName}" runs every ${m.roundPeriodMs} ms, and a day does not hold a whole number of those` };
    return { ok: true, periodMs: m.roundPeriodMs };
  }
  if (m.roundPeriodMs === 0n || m.roundPeriodMs === BigInt(periodMs)) return { ok: true, periodMs: BigInt(periodMs) };
  return { ok: false, why: `game "${m.gameName}" runs every ${m.roundPeriodMs} ms, and this network's series run every ${periodMs} ms` };
}
