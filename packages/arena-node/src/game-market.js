// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A MARKET ON A GAME AT A SEAT (feature 6; protocol 2026.0.6): THE NODE SIDE. A market round of a game market
// (manifest.js `gameSource`) is decided by its source round's own signed result, never by an attestation (attested.js refuses
// one for it). This is where a seat checks such a result, holds it, and settles the market on it:
//
//   CHECKED. The market round and its source round as THIS seat holds them - or, for a source it does not hold, the source's
//         contract fetched from other seats and checked against its id here (resolve / fetchSource) - the source's settlement
//         committee as THIS seat's roster draws it from the census and the beacon (never the contract's `nodes`, which a round id
//         does not hash from version 2), and the protocol's verification (game-market.js gameMarketResolution): the same count
//         of the same signatures a page makes for the source round itself (arena-client round-verdict.js).
//   HELD. A result that stands is kept where an attested round's attestation is kept for the same purpose (store.js
//         game_outcomes, beside outcome_attestations): the source's RoundResult bytes, the committee's signatures that made it
//         stand, and the source contract - the evidence any seat re-verifies the settlement from. `heldOutcomes` hands it to
//         every reader of an attested round's outcome (settlement.js, forfeit.js, stake-secret.js, server.js GET /outcome) in an
//         attestation's shape, so a market on a game settles exactly as an attested market does: final 600 s (the round's
//         objection window) after it is held, pari-mutuel (attested.js pariMutuelTable), and DISPUTED - settled on neither -
//         should two standing results of different outcomes ever be held.
//   VOID AT ONCE. A source result the market refunds (Tick Tock FLAT -> 0xff) and a source round that can never fit the market
//         (another game, entries closing after it starts, ending after the resolution time) are held as a VOID (outcome 255):
//         `marketVoidOf` answers VOID from then on, not only at the deadline - nothing is claimed, every stake comes back by the
//         return door at once.
//   ON ITS OWN. `gameMarketSweep`: a seat holding a market round on a game asks the source round's committee for its signed
//         result itself once the source has ended, and holds it - POST /game-outcome stays a way for anybody to hand it one.
//
// NOTHING IS TAKEN ON A SEAT'S WORD: a fetched source contract counts only if it hashes to the id the market names (a series
// round only as a series this seat holds derives it); a fetched result only by the signatures of the committee drawn here.
import { decodeRoundContract } from '../../arena-protocol/src/contracts.js';
import { isGameMarket, isScalar, marketOfRound, GAME_MARKET_REFUND } from '../../arena-protocol/src/manifest.js';
import { gameMarketResolution, gameMarketVoided, gameMarketFitsSource } from '../../arena-protocol/src/game-market.js';
import { decodeAttestation, marketVoided, marketTimes, roundTermsOf, pariMutuelTable } from '../../arena-protocol/src/attested.js';
import { decodeValueAttestation, isValueAttestationBytes, scalarPayoutTable } from '../../arena-protocol/src/scalar.js';
import { encodeRoundResult, roundResultId, decodeRoundResult, frontOf, frontName } from '../../arena-protocol/src/round-result.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { pluginForRound } from './plugins.js';
import { endpointsOf } from './roster.js';

const refuse = (why, status = 409) => ({ ok: false, status, why });
/** The outcome column of a held VALUE attestation (feature 8): no index - its value is in its bytes (heldOutcomes). */
export const VALUE_HELD_OUTCOME = -1;
/** A VOID held with no source result (a source that can never fit the market): its result id is 32 zero bytes. */
export const NO_RESULT_ID = new Uint8Array(32);
const SOURCES_KEPT = 4096;

/**
 * EVERY STANDING OUTCOME A SEAT HOLDS FOR A ROUND, in an attestation's shape, oldest first: the attestations (decoded, with
 * `receivedMs` and their `bytes`) and a market on a game's held source results that pay an outcome (`signatures` empty, the
 * evidence in `game`). A VOID (outcome 255) is not an outcome: `marketVoidOf` answers it. What attested.js outcomeFinality,
 * outcomeStanding and marketVoided read, wherever a seat reads an attested round's outcome.
 *
 * A SCALAR MARKET'S VALUE ATTESTATIONS (feature 8) are held in the same table and read back by their own type byte:
 * decoded as a value attestation, with its BigInt `value` and no outcome index - outcomeStanding answers the value they agree on.
 */
export function heldOutcomes(round, roundIdBytes) {
  const held = (round.outcomeAttestations ? round.outcomeAttestations(roundIdBytes) : [])
    .map((r) => {
      const bytes = new Uint8Array(r.bytes);
      return { ...(isValueAttestationBytes(bytes) ? decodeValueAttestation(bytes) : decodeAttestation(bytes)), receivedMs: Number(r.received_ms), bytes };
    });
  const games = (round.gameOutcomes ? round.gameOutcomes(roundIdBytes) : []).filter((g) => g.outcome !== GAME_MARKET_REFUND);
  if (!games.length) return held;
  for (const g of games) held.push({ roundId: roundIdBytes, outcome: g.outcome, observedAtMs: BigInt(g.observedMs), signatures: [], receivedMs: g.receivedMs, game: g });
  return held.sort((a, b) => a.receivedMs - b.receivedMs);
}

/**
 * THE TABLE OF AN ATTESTED ROUND WHOSE OUTCOME STANDS, by its game's rule: a scalar market's (feature 8) by the value
 * its attestors signed - scalar.js scalarPayoutTable over its manifest's bounds - and every other market's pari-mutuel over the
 * outcome, as before. `standing` is outcomeStanding's or outcomeFinality's answer. One answer for the settlement, the stake-share
 * handout and GET /outcome, so the three never read a round by two rules. Throws as the tables do.
 */
export function attestedTable(manifest, entries, standing, contract = null) {
  // a scalar template's round is paid between its own bounds (manifest.js marketOfRound, 2026.0.8)
  if (isScalar(manifest)) return scalarPayoutTable({ entries, value: standing.value, bounds: marketOfRound(manifest, contract).scalar });
  return pariMutuelTable({ entries, outcome: standing.outcome });
}

/** The VOID a seat holds for a market round on a game - a refunding source result or a source that never fits - or null. */
export function gameVoidOf(round, roundIdBytes) {
  return (round.gameOutcomes ? round.gameOutcomes(roundIdBytes) : []).find((g) => g.outcome === GAME_MARKET_REFUND) || null;
}

/**
 * IS A MARKET ROUND VOID ON THIS SEAT'S RECORD (attested.js marketVoided), with a market on a game's early VOID
 * (feature 6): a held VOID - its source ended on a value the market refunds, or can never fit it - voids the round
 * AT ONCE; otherwise as any market: a contradiction, or no standing outcome by its deadline. Answers { voided, why, early? }.
 */
export function marketVoidOf(round, roundIdBytes, { contract, manifest, held = null, nowMs }) {
  const v = gameVoidOf(round, roundIdBytes);
  if (v) return { voided: true, early: true, why: v.why || 'its source round\'s result refunds this market: every stake goes back' };
  return marketVoided(held || heldOutcomes(round, roundIdBytes), { entryCloseMs: contract.entryCloseMs, terms: roundTermsOf(manifest, contract), nowMs });
}

/** What a page or a seat re-verifies a held game outcome from (GET /outcome): the RoundResult, its signatures, the source. */
export function gameEvidenceOf(g) {
  const out = { source: toHex(g.sourceRoundId), sourceContract: toHex(g.source), outcome: g.outcome === GAME_MARKET_REFUND ? null : g.outcome,
    void: g.outcome === GAME_MARKET_REFUND, ...(g.why ? { why: g.why } : {}) };
  if (g.result.length) {
    try { const x = decodeRoundResult(g.result); Object.assign(out, { openCents: x.openCents, closeCents: x.closeCents, front: frontName(x.front) }); } catch { /* kept as bytes */ }
    Object.assign(out, { result: toHex(g.result), sigs: g.sigs });
  }
  return out;
}

/**
 * THE SEAT'S MARKETS ON GAMES. `round` the store (get, gameOutcomes, putGameOutcome), `plugins` the games it hosts
 * (pluginForRound's map), `committeeFor(id, role, { posted })` the roster's draw ({ ok, committee: [{ pubkey, advert }] }) - for
 * a source this seat does not hold, drawn on the fetched contract (`posted`), `verify` BIP-340, `now()` the seat's clock,
 * `seriesHeld()` the series templates the seat holds (a fetched series round is taken only as one of them derives it),
 * `sourcePeers(marketRoundId)` where to ask for a source contract it does not hold (the market round's census seats),
 * `ownResult(sourceHex)` this seat's own signed result where it sits on the source's committee (price-feed.js result),
 * `self` this seat's node key (never its own peer), `fetcher` the seat's routed fetch.
 */
export function gameMarkets({ round, plugins, committeeFor, verify, now = () => Date.now(), seriesHeld = () => [], sourcePeers = () => [],
  ownResult = null, self = null, fetcher = (u, o) => fetch(u, o), timeoutMs = 5000, peersMax = 16, endpointOf = null }) {
  // SOURCE CONTRACTS FETCHED AND CHECKED AGAINST THEIR IDS, by source id - fetched once, not on every ask (bounded)
  const fetched = new Map();

  const marketOf = (marketRoundIdBytes) => {
    const row = round.get(marketRoundIdBytes);
    if (!row) return refuse('this seat holds no such round', 404);
    const market = decodeRoundContract(new Uint8Array(row.contract));
    const found = pluginForRound(market, plugins);
    if (!found.ok) return refuse(found.why);
    const manifest = found.plugin.manifest;
    if (!isGameMarket(manifest)) return refuse(`game "${manifest.gameName}" is no market on a game: its outcome is not a source round's result`);
    return { ok: true, market, manifest };
  };

  // THE SOURCE CONTRACT: this seat's own copy (a series round is held only as its series derives it - POST /round's series
  // refusal - so its times are the series' though its id H(series_id || i) does not hash them), or one fetched and checked
  const sourceOf = (market) => {
    const row = round.get(market.sourceRoundId);
    if (row) { const bytes = new Uint8Array(row.contract); return { ok: true, held: true, bytes, source: decodeRoundContract(bytes) }; }
    const had = fetched.get(toHex(market.sourceRoundId));
    return had ? { ok: true, held: false, ...had } : null;
  };

  const sourceCommittee = (sid, src) => {
    const picked = committeeFor(sid, 'settlement', src.held ? undefined : { posted: src.source });
    if (!picked || !picked.ok) return refuse(`no settlement committee of source round ${toHex(sid).slice(0, 16)} is drawn here: ${(picked && picked.why) || 'no roster'}`);
    return { ok: true, picked, keys: picked.committee.map((e) => toHex(e.pubkey)) };
  };

  /**
   * THE SOURCE CONTRACT FROM OTHER SEATS (a market's seats are another draw than its source's, so a seat may hold the market and
   * not the source): GET /round?id= of each of `sourcePeers` in turn, each answer decoded and checked HERE - it must be the
   * round the market names (its id; a series round as a series this seat holds derives it). A seat answering another contract,
   * or bytes that do not decode, is passed over by name. The first that checks is kept.
   */
  async function fetchSource(marketRoundIdBytes, { market, manifest }) {
    const sid = market.sourceRoundId, hex = toHex(sid);
    const had = sourceOf(market);
    if (had) return had;
    const passed = [];
    for (const base of (sourcePeers(marketRoundIdBytes) || []).slice(0, peersMax)) {
      let bytes, source;
      try {
        const r = await fetcher(`${String(base).replace(/\/+$/, '')}/round?id=${hex}`, { signal: AbortSignal.timeout(timeoutMs) });
        if (!r.ok) { passed.push(`${base}: ${r.status}`); continue; }
        bytes = new Uint8Array(await r.arrayBuffer());
        source = decodeRoundContract(bytes);
      } catch (e) { passed.push(`${base}: ${e.message}`); continue; }
      // THE PROTOCOL'S OWN CHECK: another contract than the named round, or a series round no held series derives, is refused
      // without `void` (it says nothing of the market); a misfit of the named round itself (`void`) is a fact about the right bytes
      const fits = gameMarketFitsSource({ market, manifest, source, sourceSeries: seriesHeld() || [] });
      if (!fits.ok && !fits.void) { passed.push(`${base}: ${fits.why}`); continue; }
      const kept = { bytes, source, from: base };
      fetched.set(hex, kept);
      if (fetched.size > SOURCES_KEPT) fetched.delete(fetched.keys().next().value);
      return { ok: true, held: false, ...kept, passed };
    }
    return refuse(`no seat answered source round ${hex.slice(0, 16)} as the round this market names${passed.length ? `: ${passed.slice(0, 4).join('; ')}` : ' (none asked)'}`, 404);
  }

  /**
   * THE PROTOCOL'S RESOLUTION of a market round from a source RoundResult { openCents, closeCents, front?, sigs } (the shape
   * GET /round-result answers, one { key, signature } per seat), with `voided` on this seat's clock and the source's id - or a
   * refusal by name with an HTTP status. Synchronous: the source must be held here or fetched already.
   */
  function resolve(marketRoundIdBytes, { openCents, closeCents, front, sigs } = {}) {
    const m = marketOf(marketRoundIdBytes);
    if (!m.ok) return m;
    const sourceHex = toHex(m.market.sourceRoundId);
    const src = sourceOf(m.market);
    if (!src) return refuse(`this seat holds no source round ${sourceHex.slice(0, 16)}, and none was fetched: it checks a market on a game only against a source round whose contract it checked itself`, 404);
    return resolveWith(m, src, { openCents, closeCents, front, sigs });
  }

  function resolveWith({ market, manifest }, src, { openCents, closeCents, front, sigs }) {
    const sourceHex = toHex(market.sourceRoundId);
    // A SOURCE THAT CAN NEVER FIT is VOID before any committee is drawn for it
    const fits = gameMarketFitsSource({ market, manifest, source: src.source, sourceHeld: src.held, sourceSeries: seriesHeld() || [] });
    if (!fits.ok) return { ...fits, source: sourceHex, voided: !!fits.void, ...(fits.void ? { voidWhy: `its source does not fit it: ${fits.why}` } : {}) };
    const c = sourceCommittee(market.sourceRoundId, src);
    if (!c.ok) return c;
    const resolution = gameMarketResolution({ market, manifest, source: src.source, committee: c.keys, verify, sourceHeld: src.held, sourceSeries: seriesHeld() || [],
      result: { roundId: market.sourceRoundId, openCents, closeCents, ...(front !== undefined ? { front } : {}) }, sigs });
    const voided = gameMarketVoided(resolution, { market, manifest, nowMs: now() });
    return { ...resolution, source: sourceHex, committee: c.keys, sourceEndMs: Number(fits.sourceEndMs), voided: voided.voided, ...(voided.voided ? { voidWhy: voided.why } : {}) };
  }

  // ONLY THE SIGNATURES THAT COUNT ARE KEPT: one per key of the drawn committee, each verifying over the result's id - what any
  // seat recounts. A body handed in with a thousand signatures is not stored as one.
  const standingSigs = (resultIdBytes, sigs, keys) => {
    const out = [], seen = new Set(), members = new Set(keys);
    for (const s of Array.isArray(sigs) ? sigs : []) {
      const key = typeof s.key === 'string' ? s.key.toLowerCase() : s.key instanceof Uint8Array ? toHex(s.key) : '';
      if (!members.has(key) || seen.has(key)) continue;
      let sig;
      try { sig = typeof s.signature === 'string' ? fromHex(s.signature) : s.signature; } catch { continue; }
      let good = false;
      try { good = verify(sig, resultIdBytes, fromHex(key)) === true; } catch { good = false; }
      if (good) { seen.add(key); out.push({ key, signature: toHex(sig) }); }
    }
    return out;
  };

  /**
   * HOLD A MARKET ROUND'S OUTCOME: the resolution as `resolve` makes it - fetching the source contract first where this seat does
   * not hold it - and, when it decides the round, kept (store.js game_outcomes): an outcome, a refund (VOID) or a source that can
   * never fit (VOID; `result` may be null for that). A source result is taken only once the source round has ENDED on this
   * seat's clock - its committee cannot have signed its close before. Answers the resolution with { held, fresh } or a refusal.
   */
  async function hold(marketRoundIdBytes, result = null) {
    const m = marketOf(marketRoundIdBytes);
    if (!m.ok) return m;
    const src = sourceOf(m.market) || await fetchSource(marketRoundIdBytes, m);
    if (!src.ok) return src;
    const fits = gameMarketFitsSource({ market: m.market, manifest: m.manifest, source: src.source, sourceHeld: src.held, sourceSeries: seriesHeld() || [] });
    if (!fits.ok && !fits.void) return refuse(fits.why);
    const sid = m.market.sourceRoundId;
    if (!fits.ok) {
      const fresh = round.putGameOutcome({ roundId: marketRoundIdBytes, resultId: NO_RESULT_ID, sourceRoundId: sid, outcome: GAME_MARKET_REFUND,
        why: `its source does not fit it: ${fits.why}`, result: new Uint8Array(0), sigs: [], source: src.bytes, observedMs: now(), receivedMs: now() });
      return { ok: false, void: true, why: fits.why, source: toHex(sid), voided: true, voidWhy: `its source does not fit it: ${fits.why}`, held: true, fresh };
    }
    if (!result) return refuse('no source round result to hold: { openCents, closeCents, front?, sigs }', 400);
    if (BigInt(now()) < fits.sourceEndMs)
      return refuse(`source round ${toHex(sid).slice(0, 16)} runs until ${new Date(Number(fits.sourceEndMs)).toISOString()}: no result of it is taken before its end`);
    const got = resolveWith(m, src, result);
    if (!got.ok) return got.status ? got : { ...got, status: 409 };
    let resultBytes, rid;
    try {
      const x = { roundId: sid, openCents: result.openCents, closeCents: result.closeCents, front: frontOf(result.openCents, result.closeCents) };
      resultBytes = encodeRoundResult(x); rid = roundResultId(x);
    } catch (e) { return refuse(`that result names no prices: ${e.message}`, 400); }
    const fresh = round.putGameOutcome({ roundId: marketRoundIdBytes, resultId: rid, sourceRoundId: sid, outcome: got.refund ? GAME_MARKET_REFUND : got.outcome,
      why: got.refund ? got.why : null, result: resultBytes, sigs: standingSigs(rid, result.sigs, got.committee), source: src.bytes,
      observedMs: Number(fits.sourceEndMs), receivedMs: now() });
    const { committee, ...answer } = got;
    return { ...answer, held: true, fresh, ...(got.refund ? { voided: true, voidWhy: got.why } : {}) };
  }

  /**
   * THE SOURCE'S SIGNED RESULT FROM ITS COMMITTEE (§13 GET /round-result): this seat's own where it sits on it, and each other
   * seat's - grouped by the result they signed, the most signed first. A seat answering another open or close signs another
   * result: its signature counts only towards that one, and a lie stands only if the threshold of the committee told it.
   */
  async function collect(sid, src) {
    const c = sourceCommittee(sid, src);
    if (!c.ok) return c;
    const hex = toHex(sid);
    const answers = [];
    if (ownResult) { try { const o = await ownResult(hex); if (o && o.ok) answers.push(o); } catch { /* none of its own */ } }
    for (const base of endpointsOf(c.picked.committee, self, endpointOf)) {
      try {
        const r = await fetcher(`${base}/round-result?round=${hex}`, { signal: AbortSignal.timeout(timeoutMs) });
        if (r.ok) answers.push(await r.json());
      } catch { /* the next seat */ }
    }
    const groups = new Map();
    for (const a of answers) {
      if (!a || !Number.isInteger(a.openCents) || !Number.isInteger(a.closeCents) || typeof a.key !== 'string' || typeof a.signature !== 'string') continue;
      const k = `${a.openCents}:${a.closeCents}`;
      if (!groups.has(k)) groups.set(k, { openCents: a.openCents, closeCents: a.closeCents, sigs: [] });
      groups.get(k).sigs.push({ key: a.key, signature: a.signature });
    }
    return { ok: true, asked: answers.length, groups: [...groups.values()].sort((x, y) => y.sigs.length - x.sigs.length) };
  }

  /**
   * ONE MARKET ROUND, RESOLVED BY THE SEAT ITSELF (the sweep's step): its source contract (held or fetched), a misfit held as VOID,
   * and once the source has ended its committee's signed result, held if it stands. Answers { done, why, retryAtMs? }: done once
   * an outcome or a VOID is held (by this or by anybody's POST /game-outcome).
   */
  async function resolveOnce(marketRoundIdBytes) {
    if (round.gameOutcomes && round.gameOutcomes(marketRoundIdBytes).length) return { done: true, why: 'held already' };
    const m = marketOf(marketRoundIdBytes);
    if (!m.ok) return { done: true, why: m.why };
    const src = sourceOf(m.market) || await fetchSource(marketRoundIdBytes, m);
    if (!src.ok) return { done: false, why: src.why };
    const fits = gameMarketFitsSource({ market: m.market, manifest: m.manifest, source: src.source, sourceHeld: src.held, sourceSeries: seriesHeld() || [] });
    if (!fits.ok) {
      if (!fits.void) return { done: false, why: fits.why };
      const got = await hold(marketRoundIdBytes, null);
      return { done: !!got.held, why: got.why, held: got };
    }
    if (BigInt(now()) < fits.sourceEndMs) return { done: false, why: 'its source round has not ended', retryAtMs: Number(fits.sourceEndMs) + 2000 };
    const c = await collect(m.market.sourceRoundId, src);
    if (!c.ok) return { done: false, why: c.why };
    let last = `none of the ${c.asked} answer(s) of its committee stands`;
    for (const g of c.groups) {
      const got = await hold(marketRoundIdBytes, g);
      if (got.held) return { done: true, why: got.why, held: got };
      last = got.why;
    }
    return { done: false, why: last };
  }

  return { resolve, hold, fetchSource, collect, resolveOnce, sourceOf };
}

/**
 * THE HOOK AS POST /game-outcome FIRST ANSWERED IT (kept for its callers): `resolveGameMarket(marketRoundIdBytes, result)`, the
 * protocol's resolution against a source this seat holds - nothing held.
 */
export function gameMarketHook(opts) { return gameMarkets(opts).resolve; }

/**
 * RESOLVE WITHOUT BEING ASKED (feature 6), bounded and sliced - and NEVER THE SAME ROUNDS AGAIN EVERY PASS (the
 * series writer's lesson, measured 2026-10-15: a pass asking ~900 rounds a stored read each outran its 150 ms slice and ran
 * again at once, seven seats at a core each). Each round of the store is looked at ONCE, in rowid order behind a cursor
 * (`roundsAfter(cursor, n)` -> [{ rowid, round_id, contract }]); only a market round on a game this seat hosts, with no outcome
 * held, is remembered as pending - and each pending round is tried only when it is due: from its entry close, from its source
 * round's end, then every `retryMs`, at most `perPass` a pass. A pending round leaves for good once an outcome or a VOID is held
 * (by the sweep or a POST), once it is past its deadline (VOID by marketVoided then, with nothing to hold), or once it is gone
 * from the store. `onHeld(marketRoundIdBytes, answer)` hears each fresh hold (server.js starts the attested settlement sweep).
 */
export function gameMarketSweep({ markets, round, plugins, roundsAfter, now = () => Date.now(), clock = () => Date.now(), sliceMs = 150, perPass = 4,
  retryMs = 30000, onHeld = () => {}, log = () => {} }) {
  let cursor = 0;
  let running = false;
  const pending = new Map();                 // market round hex -> { rid, nextMs, deadlineMs, why }
  const classify = (r) => {
    let c;
    try { c = decodeRoundContract(new Uint8Array(r.contract)); } catch { return; }
    if (!(c.sourceRoundId instanceof Uint8Array)) return;
    const f = pluginForRound(c, plugins);
    if (!f.ok || !isGameMarket(f.plugin.manifest)) return;
    const rid = new Uint8Array(r.round_id);
    if (round.gameOutcomes && round.gameOutcomes(rid).length) return;
    const terms = roundTermsOf(f.plugin.manifest, c);
    const deadlineMs = terms ? Number(marketTimes({ entryCloseMs: c.entryCloseMs, terms }).deadlineMs) : Infinity;
    // a round past its deadline already (a restarted seat's old markets) is VOID by marketVoided: nothing to fetch or hold
    if (Number(now()) >= deadlineMs) return;
    pending.set(toHex(rid), { rid, nextMs: Number(c.entryCloseMs), deadlineMs, why: 'new' });
  };
  async function pass() {
    if (running) return { skipped: true };
    running = true;
    const t0 = clock();
    let scanned = 0, tried = 0, held = 0;
    try {
      // NEW ROUNDS, EACH LOOKED AT ONCE, until the slice is spent; the cursor goes on from there next pass
      for (;;) {
        if (clock() - t0 >= sliceMs) break;
        const rows = roundsAfter(cursor, 200) || [];
        if (!rows.length) break;
        for (const r of rows) { cursor = Math.max(cursor, Number(r.rowid)); classify(r); scanned++; }
      }
      // THE PENDING ROUNDS THAT ARE DUE, soonest first, a few a pass
      const nowMs = Number(now());
      const due = [...pending.entries()].filter(([, p]) => p.nextMs <= nowMs).sort((a, b) => a[1].nextMs - b[1].nextMs);
      for (const [hex, p] of due) {
        if (tried >= perPass || clock() - t0 >= sliceMs * 4) break;
        if (nowMs >= p.deadlineMs) { pending.delete(hex); log(`[game-market] ${hex.slice(0, 16)}: past its deadline with no source result held - VOID, every stake back`); continue; }
        if (!round.get(p.rid)) { pending.delete(hex); continue; }
        tried++;
        const got = await markets.resolveOnce(p.rid).catch((e) => ({ done: false, why: e.message }));
        if (got.done) {
          pending.delete(hex);
          if (got.held && got.held.fresh) { held++; log(`[game-market] ${hex.slice(0, 16)}: ${got.held.voided ? `VOID - ${got.held.voidWhy}` : got.why}`); onHeld(p.rid, got.held); }
          continue;
        }
        p.nextMs = got.retryAtMs && got.retryAtMs > nowMs ? got.retryAtMs : nowMs + retryMs;
        if (p.why !== got.why) { p.why = got.why; log(`[game-market] ${hex.slice(0, 16)} not resolved yet: ${got.why}`); }
      }
    } finally { running = false; }
    return { scanned, tried, held, pending: pending.size, cursor };
  }
  return { pass, pending: () => pending.size, cursor: () => cursor };
}
