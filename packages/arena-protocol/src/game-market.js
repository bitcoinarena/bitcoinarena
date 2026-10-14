// MARKETS ON GAMES (kanban #362 feature 6, docs/PLATFORM-RESEARCH.md item 6; protocol 2026.0.6): "an attested market whose
// outcome is a game round's signed result (e.g. BULLS vs BEARS of a Tick Tock round ...). It turns every game into a spectator
// sport with no external oracle: the committee's 5-of-7 RoundResult resolves it."
//
// THE SHAPE. The market's manifest names a source game, the kind of signed result it reads and a mapping of that result's values
// onto its outcomes (manifest.js `gameSource`, marker 0x05); each round of the market names the ONE round of that game it is a
// market on (contracts.js `sourceRoundId`, marker 0xc4). Both are bytes only a version-6 manifest and round carry.
//
// WHAT DECIDES IT: the source round's own signed result, checked here exactly as a client checks it for the source round
// itself (round-result.js roundResultStands, as arena-client round-verdict.js does): for source kind ROUND_RESULT the §13
// RoundResult { round_id, open_cents, close_cents, front } whose id at least the source round's threshold (5 of 7, threshold.js
// receiptsNeeded of its settlement slots) of distinct keys of the source round's settlement committee signed with their node
// keys (BIP-340). Nothing else: no attestor, no seat's word, no price of the market's own.
//
// THE COMMITTEE IS THE CALLER'S DERIVATION, NEVER A CONTRACT'S `nodes`: from version 2 a round's id hashes its contract with
// `nodes` emptied (constants.js DRAW_FREE_VERSION), so a source contract handed in by anyone could carry any keys there. A seat
// passes the committee the census and the beacon draw for the source round (arena-node roster.committeeFor(id, 'settlement')),
// as the page passes the one it derived.
//
// TIMING (the market's picks must be made blind): its entries close no later than its source round STARTS - before the
// source's first price sample exists - and its source round ends no later than its resolution time (entry close + the
// terms' `resolveAfterCloseMs`), so its attestors' deadline (`deadlineAfterResolveMs` after that, attested.js marketTimes) is a
// deadline for the source's result too. A market whose source does not fit is never decided on an outcome: VOID, every stake
// back. So is one whose source result maps to a refund (Tick Tock FLAT), and one with no standing result by its deadline.
//
// NO CURVE, as everywhere in this package: `verify(signature, message, key)` is injected (BIP-340 for node keys).
import { toHex } from './hash.js';
import { isGameMarket, SOURCE_KIND, SOURCE_VALUES, GAME_MARKET_REFUND } from './manifest.js';
import { roundId } from './contracts.js';
import { roundResultStands, frontOf, frontName } from './round-result.js';
import { receiptsNeeded } from './threshold.js';
import { msForTicks } from './tick.js';
import { marketTimes, roundTermsOf } from './attested.js';
import { seriesRoundCheck } from './series.js';

const gmIs32 = (b) => b instanceof Uint8Array && b.length === 32;
const gmSame = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
const at = (ms) => { try { return new Date(Number(ms)).toISOString(); } catch { return String(ms); } };

/**
 * WHEN A SOURCE ROUND ENDS: its start plus its run (blockTicks), rounded UP to the whole millisecond - the RoundResult's close
 * is the last sample at or before its last tick (round-result.js roundResultFrom), so nothing of it is known before this.
 */
export function sourceRoundEndMs(source) {
  const { ms, exact } = msForTicks(BigInt(source.blockTicks));
  return BigInt(source.startTimeMs) + ms + (exact ? 0n : 1n);
}

/**
 * WHICH OUTCOME A SOURCE RESULT PAYS (the market's `gameSource` mapping). `value`: for ROUND_RESULT the front - FRONT 1 BULLS,
 * 2 BEARS, 3 FLAT, or its name. Answers { ok, outcome, value } for an outcome index, { ok, refund: true, value } for a value
 * mapped to GAME_MARKET_REFUND (every stake back), or { ok: false, why }. Pure: it checks no signature - gameMarketResolution
 * calls it only on a result that stands.
 */
export function gameMarketOutcome(value, gameSource) {
  const values = gameSource && SOURCE_VALUES[gameSource.sourceKind];
  if (!values) return { ok: false, why: `source kind ${gameSource && gameSource.sourceKind} is not one this engine reads` };
  const i = typeof value === 'string' ? values.indexOf(value) : Number.isInteger(value) ? value - 1 : -1;
  if (i < 0 || i >= values.length) return { ok: false, why: `${value} is no result of a ${values.join(' / ')} source` };
  const to = gameSource.mapping[i];
  if (to === GAME_MARKET_REFUND) return { ok: true, refund: true, value: values[i], why: `the source round ended ${values[i]}, which this market refunds: every stake goes back` };
  if (!Number.isInteger(to)) return { ok: false, why: `the market maps ${values[i]} to nothing` };
  return { ok: true, outcome: to, value: values[i] };
}

/**
 * DOES THIS SOURCE ROUND FIT THIS MARKET ROUND? `market` the market round's contract, `manifest` its game's (a market on a game),
 * `source` the source round's contract. It is the round the market names (its id - H(contract) or a series' H(series_id || i)
 * - is the market's `sourceRoundId`), a round of the manifest's source game, it STARTS no earlier than the market's entries
 * close, and it ENDS no later than the market's resolution time. Each refusal by name; answers, never throws. A refusal
 * about the round the market names - its game, its times - carries `void: true`: those bytes are that round's id, so it can
 * never come to fit, and the market is VOID; a refusal before that (another contract, none) says nothing of the market.
 *
 * A SOURCE ROUND OF A SERIES (Tick Tock's rounds are): its id H(series_id || i) does not hash its contract, so a contract that
 * names the right series and index could name any times. It is taken only as its series derives it - `sourceSeries` the
 * series templates to check it against (series.js seriesRoundCheck), or `sourceHeld: true` from a caller whose store keeps a
 * series round only after that same check (a seat: POST /round's series refusal). Neither: refused, and not VOID.
 */
export function gameMarketFitsSource({ market, manifest, source, sourceSeries = null, sourceHeld = false }) {
  if (!isGameMarket(manifest)) return { ok: false, why: 'that game is no market on a game: no source round decides it' };
  const name = `market "${manifest.gameName}"`;
  if (!market || !gmIs32(market.sourceRoundId)) return { ok: false, why: `that round of ${name} names no source round` };
  if (!source) return { ok: false, why: `no contract of source round ${toHex(market.sourceRoundId).slice(0, 16)} to check ${name} against` };
  let sid;
  try { sid = roundId(source); } catch (e) { return { ok: false, why: `that source contract does not encode: ${e.message}` }; }
  if (!gmSame(sid, market.sourceRoundId))
    return { ok: false, why: `that contract is round ${toHex(sid).slice(0, 16)}; ${name}'s round is on ${toHex(market.sourceRoundId).slice(0, 16)}` };
  if (source.seriesId !== undefined && source.seriesId !== null && sourceHeld !== true) {
    if (!Array.isArray(sourceSeries))
      return { ok: false, why: `source round ${toHex(sid).slice(0, 16)} is round ${source.roundIndex} of a series: its id does not hash its contract, so it is taken only as its series derives it, and no series was handed in to check it` };
    const sc = seriesRoundCheck(source, sourceSeries);
    if (!sc.ok) return { ok: false, why: `source round ${toHex(sid).slice(0, 16)}: ${sc.why}` };
  }
  if (!gmIs32(source.gameId) || !gmSame(source.gameId, manifest.gameSource.sourceGameId))
    return { ok: false, void: true, why: `source round ${toHex(sid).slice(0, 16)} plays game ${gmIs32(source.gameId) ? toHex(source.gameId).slice(0, 16) : '(none)'}; ${name} is on game ${toHex(manifest.gameSource.sourceGameId).slice(0, 16)}` };
  if (typeof market.entryCloseMs !== 'bigint' || typeof source.startTimeMs !== 'bigint') return { ok: false, why: 'that round names no entry close, or its source no start' };
  // ENTRY CLOSES BEFORE THE SOURCE STARTS: a pick made while the source round runs is a pick made on its first prices
  if (market.entryCloseMs > source.startTimeMs)
    return { ok: false, void: true, why: `${name}'s entries close at ${at(market.entryCloseMs)}, after its source round ${toHex(sid).slice(0, 16)} starts at ${at(source.startTimeMs)}: a pick would be made with the outcome under way` };
  const terms = manifest.marketTerms;
  if (!terms) return { ok: false, void: true, why: `${name} names no market terms: no resolution time to hold its source round's end to` };
  const resolveAtMs = market.entryCloseMs + terms.resolveAfterCloseMs;
  let endMs;
  try { endMs = sourceRoundEndMs(source); } catch (e) { return { ok: false, void: true, why: `that source round names no run: ${e.message}` }; }
  if (endMs > resolveAtMs)
    return { ok: false, void: true, why: `source round ${toHex(sid).slice(0, 16)} ends at ${at(endMs)}, after ${name}'s resolution time ${at(resolveAtMs)} (${terms.resolveAfterCloseMs} ms after its entry close)` };
  return { ok: true, sourceRoundId: sid, sourceEndMs: endMs, resolveAtMs };
}

/**
 * THE OUTCOME OF A MARKET ROUND ON A GAME, FROM ITS SOURCE ROUND'S SIGNED RESULT. `result` the source's RoundResult
 * { roundId, openCents, closeCents } (its front follows from them), `sigs` [{ key, signature }] (hex or bytes) over its id,
 * `committee` the source round's settlement committee as the CALLER derived it (never `source.nodes`), `verify` BIP-340;
 * `sourceSeries` / `sourceHeld` for a source round of a series, as gameMarketFitsSource takes them.
 * The threshold is the source's own: receiptsNeeded(source.settlementSlots) - 5 of 7 - a number its id hashes.
 *
 * Answers one of:
 *   { ok: true, outcome, label, value, signers }   the market pays `outcome`
 *   { ok: true, refund: true, value, signers }      the source's result is one the market refunds (VOID: every stake back)
 *   { ok: false, void: true, why }                  the source does not fit this market round, and never will: VOID
 *   { ok: false, why }                              no standing result yet (too few signatures, a stranger's, another round's)
 * Never throws.
 */
export function gameMarketResolution({ market, manifest, source, result, sigs, committee, verify, sourceSeries = null, sourceHeld = false }) {
  // A SOURCE THAT DOES NOT FIT NEVER WILL (gameMarketFitsSource's `void`): the market is VOID
  const fits = gameMarketFitsSource({ market, manifest, source, sourceSeries, sourceHeld });
  if (!fits.ok) return fits;
  const g = manifest.gameSource;
  if (g.sourceKind !== SOURCE_KIND.ROUND_RESULT) return { ok: false, why: `source kind ${g.sourceKind} is not one this engine reads` };
  if (!result || !gmIs32(result.roundId)) return { ok: false, why: 'no round result to read: { roundId, openCents, closeCents }' };
  if (!gmSame(result.roundId, fits.sourceRoundId))
    return { ok: false, why: `that result is round ${toHex(result.roundId).slice(0, 16)}'s; this market is on ${toHex(fits.sourceRoundId).slice(0, 16)}` };
  let front;
  try { front = frontOf(result.openCents, result.closeCents); } catch (e) { return { ok: false, why: `that result names no prices: ${e.message}` }; }
  if (result.front !== undefined && result.front !== front && result.front !== frontName(front))
    return { ok: false, why: `that result says ${result.front}, and ${result.openCents} -> ${result.closeCents} cents is ${frontName(front)}` };
  let threshold;
  try { threshold = receiptsNeeded(source.settlementSlots); } catch (e) { return { ok: false, why: `the source round's threshold: ${e.message}` }; }
  const keys = (committee || []).map((k) => (typeof k === 'string' ? k.toLowerCase() : gmIs32(k) ? toHex(k) : ''));
  if (!keys.length || keys.some((k) => !/^[0-9a-f]{64}$/.test(k))) return { ok: false, why: 'no source committee of 32-byte keys to count signatures against' };
  if (new Set(keys).size > source.settlementSlots)
    return { ok: false, why: `the source round seats ${source.settlementSlots}; a committee of ${new Set(keys).size} keys is not its committee` };
  const st = roundResultStands({ result: { roundId: result.roundId, openCents: result.openCents, closeCents: result.closeCents, front }, sigs, committee: keys, threshold, verify });
  if (!st.ok) return { ok: false, why: `source round ${toHex(fits.sourceRoundId).slice(0, 16)}'s result ${frontName(front)} does not stand: ${st.why}` };
  const out = gameMarketOutcome(front, g);
  if (!out.ok) return out;
  if (out.refund) return { ok: true, refund: true, value: out.value, signers: st.signed.length, threshold, why: out.why };
  return { ok: true, outcome: out.outcome, label: manifest.outcomes[out.outcome], value: out.value, signers: st.signed.length, threshold,
    why: `source round ${toHex(fits.sourceRoundId).slice(0, 16)} ended ${out.value} (signed by ${st.signed.length} of its committee, ${threshold} needed): outcome ${out.outcome} "${manifest.outcomes[out.outcome]}"` };
}

/**
 * IS A MARKET ROUND ON A GAME VOID (pari-mutuel VOID: every stake back, its fee too - as attested.js marketVoided for a market
 * with attestors)? When its resolution is a refund (the source ended on a value it refunds), when its source does not fit it,
 * or when no result of its source stands by its deadline - entry close + resolveAfterCloseMs + deadlineAfterResolveMs, on the
 * seat's clock (a source round that was VOID itself, or never ran, signs no result). `resolution` is gameMarketResolution's
 * answer, or null for none yet. Answers { voided, why }.
 */
export function gameMarketVoided(resolution, { market, manifest, nowMs }) {
  if (resolution && resolution.ok && resolution.refund) return { voided: true, why: resolution.why };
  if (resolution && !resolution.ok && resolution.void) return { voided: true, why: `its source does not fit it: ${resolution.why}` };
  if (resolution && resolution.ok) return { voided: false };
  const terms = roundTermsOf(manifest, market);
  if (!terms) return { voided: false };
  const { deadlineMs } = marketTimes({ entryCloseMs: market.entryCloseMs, terms });
  if (BigInt(nowMs) >= deadlineMs) return { voided: true, why: `no signed result of its source round stood by the market's deadline ${at(deadlineMs)}: every stake goes back` };
  return { voided: false };
}
