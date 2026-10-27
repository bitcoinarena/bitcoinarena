// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// ONE GRID, BUILT AND PUBLISHED - the part of tools/round-2of2.mjs openGrid that a node posting its own duty needs too (kanban #702,
// 2026-10-26: "The round runners must be an integrated part of the node"). Pure where it can be: the tables' templates, their series ids,
// the signed lines and the outputs are worked out from a contract and the census root (buildGrid); the coins, the fee and the broadcast are
// the wallet's (publishGridTx); the announcement goes to the seats (announceGrid). openGrid and the node's duty poster (duty-poster.js)
// both call these, so a grid is built one way only.
import { schnorr } from '@noble/curves/secp256k1.js';
import { seriesId, seriesRound, seriesLeadIsValid, seriesPublicationOutput } from '../../arena-protocol/src/series.js';
import { seriesCreatorMessage } from '../../arena-protocol/src/creator.js';
import { buildRules } from '../../arena-protocol/src/rules.js';
import { encodeRoundContract, decodeRoundContract } from '../../arena-protocol/src/contracts.js';
import { meetsCensusMinimum } from '../../arena-protocol/src/census.js';
import { MIN_ENTRY_WINDOW_MS } from '../../arena-protocol/src/constants.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { seriesLineOf, parseSeriesLine } from './series-line.js';
import { fundAtRate } from './fund-at-rate.js';

const le = (n, bytes) => { const b = Buffer.alloc(bytes); if (bytes === 8) b.writeBigUInt64LE(BigInt(n)); else b.writeUIntLE(n, 0, bytes); return b; };
const outputBytes = (o) => Buffer.concat([le(o.value || 0, 8), Buffer.from([o.script.length]), Buffer.from(o.script)]);

/**
 * THE GRID'S TABLES, IDS, LINES AND OUTPUTS. `contract` the round template every table starts from; `kind` as openGrid takes it
 * (fields, tableFields, stakeMsat, custody, stakeExpiryFor, mustDraw, rules, creatorSecret); `censusRootFor(template)` derives the census
 * root as the seats do and `censusEntries()` answers the census that root was derived from (for mustDraw); `blockTicksAt(startMs)` the run
 * length a contract names at a start. Throws, by name, on a grid no seat would take - nothing is spent before this returns.
 */
export function buildGrid({ contract, kind = {}, slots = 225, tables = 2, windowMs = 8000n, entryAfterStartMs = 80000n, firstCloseMs, committeeTimeMs,
  censusRootFor, censusEntries = () => [], blockTicksAt = null, extraOutputs = [] }) {
  if (firstCloseMs === undefined || committeeTimeMs === undefined) throw new Error('a grid names its first close and its committee time');
  if (Array.isArray(kind.tableFields) && kind.tableFields.length) tables = kind.tableFields.length;
  const committee = BigInt(committeeTimeMs), first = BigInt(firstCloseMs);
  if (first - BigInt(entryAfterStartMs) - committee < MIN_ENTRY_WINDOW_MS) throw new Error('the grid starts before its committee time plus the minimum entry window');
  const start = first - BigInt(entryAfterStartMs);
  const templates = [];
  for (let k = 0; k < tables; k++) {
    const t = { ...contract,
      ...(kind.stakeMsat !== undefined ? { stakeMsat: BigInt(kind.stakeMsat) } : {}),
      ...(kind.custody ? { custody: kind.custody } : {}),
      committeeTimeMs: committee - BigInt(k), startTimeMs: start, entryCloseMs: first,
      ...(blockTicksAt ? { blockTicks: blockTicksAt(start) } : {}),
      ...(kind.fields || {}),
      // A TABLE'S OWN FIELDS (2026-10-14: "Each game may only have one round posting per day"): one transaction carries every
      // federation's tables of a game, each table naming its federation here
      ...((kind.tableFields || [])[k] || {}) };
    // a lock span sized from the round's times is the LAST round's, so it holds for every round of the table
    if (typeof kind.stakeExpiryFor === 'function') {
      const lastStart = start + BigInt(slots - 1) * BigInt(windowMs);
      t.stakeExpiryBlocks = kind.stakeExpiryFor({ ...t, startTimeMs: lastStart, entryCloseMs: lastStart + BigInt(entryAfterStartMs) });
    }
    Object.assign(t, { seriesGrid: true, seriesPeriodMs: BigInt(windowMs), seriesCount: slots });
    const valid = seriesLeadIsValid(t);
    if (!valid.ok) throw new Error(`the grid is no grid series: ${valid.why}`);
    templates.push(t);
  }
  // ONE CENSUS FOR THE GRID: every round names the same census height, game and slots, so the root is derived once - and checked again on
  // the last round, which must agree
  // THE ROOT ON EVERY TEMPLATE BEFORE THE LAST ROUND IS DERIVED (kanban #702, measured 2026-10-27 08:33Z, the seats posting for the first time:
  // seriesRound encodes the template for its series id, and a template the node built itself names no root yet - "expected 32 bytes, got
  // nothing" for every grid; the runners' templates carried their held round's root, so they never met it)
  const root = censusRootFor(templates[0]);
  for (const t of templates) t.censusRoot = root;
  if (toHex(censusRootFor(seriesRound(templates[tables - 1], slots - 1))) !== toHex(root)) throw new Error('the grid first and last rounds derive different census roots');
  // A GRID NO COMMITTEE CAN SERVE IS NOT PUBLISHED (kanban #689): enough game nodes hosting each table's game, and enough settlement nodes
  if (kind.mustDraw) for (const t of templates) for (const role of ['game', 'settlement']) {
    const m = meetsCensusMinimum(censusEntries(), decodeRoundContract(encodeRoundContract(t)), role);
    if (!m.ok) throw new Error(`no committee can be drawn for this grid at census ${t.censusHeight}: ${m.why}`);
  }
  // THE RULES IT IS SETTLED UNDER (§6): a v3 grid names this build's four rule hashes, unless `kind.rules` is false
  for (const t of templates) if (Number(t.protocolVersion) >= 3 && kind.rules !== false && !t.rules)
    t.rules = buildRules({ claimWindowDays: 1, bondMinGameVerifySats: BigInt(t.bondMinSats), bondMinSettlementSats: BigInt(t.bondMinSats) });
  // THE CREATOR: `kind.creatorSecret` names this publisher in every template (2026.0.3) and signs each series id
  if (kind.creatorSecret) for (const t of templates) t.creatorPubkey = schnorr.getPublicKey(kind.creatorSecret);
  // FRESH OBJECTS BEFORE THE IDS (measured 2026-10-20: seriesId() keeps one id per template object, kanban #468)
  for (let k = 0; k < templates.length; k++) templates[k] = { ...templates[k] };
  const ids = templates.map((t) => seriesId(t));
  if (kind.creatorSecret) templates.forEach((t, k) => { t.creatorSignature = schnorr.sign(seriesCreatorMessage(ids[k]), kind.creatorSecret); });
  const lastClose = templates[0].entryCloseMs + BigInt(slots - 1) * BigInt(windowMs);
  // THE TRANSACTION'S OUTPUTS: one zero-value OP_RETURN "ARN" SERIES series_id per table, then any other the caller names (the duty marker)
  const outs = [...ids.map((id) => outputBytes(seriesPublicationOutput(id))), ...extraOutputs.map(outputBytes)];
  const lines = templates.map((t) => seriesLineOf(t, encodeRoundContract));
  // AND NOTHING IS PUBLISHED THAT A SEAT WOULD READ AS ANOTHER SERIES: each line, read back as a seat reads it, must name the id published
  lines.forEach((line, k) => { const back = toHex(seriesId(parseSeriesLine(line))); if (back !== toHex(ids[k])) throw new Error(`series line ${k} reads back as ${back.slice(0, 16)}, not ${toHex(ids[k]).slice(0, 16)}: nothing published`); });
  return { templates, ids, lines, outs, start, first, committee, slots, tables, rounds: slots * tables, lastCloseMs: lastClose };
}

/**
 * THE GRID'S TRANSACTION, FUNDED AT `feeRate` BY THE WALLET (fund-at-rate.js) AND SENT - or, `dry`, asked of the mempool only
 * (testmempoolaccept). -> { txid, hex, vsize, fee } or { dry: true, accepted, reject, hex, vsize, fee }.
 */
export async function publishGridTx({ outs, rpc, feeRate, dry = false }) {
  const { hex, vsize, fee } = await fundAtRate(rpc, outs, feeRate);
  if (dry) {
    const [acc] = await rpc('testmempoolaccept', [[hex]]);
    return { dry: true, accepted: acc.allowed, reject: acc['reject-reason'], hex, vsize, fee };
  }
  const txid = String(await rpc('sendrawtransaction', [hex]));
  return { txid, hex, vsize, fee };
}

/**
 * AND ANNOUNCED (kanban #560): every seat in `targets` gets each signed line and the publication (POST /expected), checks both and says
 * when the grid's first window comes. -> how many took it, of how many asked.
 */
export async function announceGrid({ lines, tx, targets, fetchFn = fetch, timeoutMs = 20000 }) {
  const said = await Promise.all(lines.flatMap((line) => targets.map(async (u) => {
    try { const r = await fetchFn(`${u}/expected`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ line, tx }), signal: AbortSignal.timeout(timeoutMs) }); return r.ok; } catch { return false; }
  })));
  return { took: said.filter(Boolean).length, of: said.length };
}

/**
 * A SERIES LINE TO EVERY SEAT IN `targets` ([who, url]), asked again 3 s apart while a seat says it is not ready (its view, the
 * publication, the funding) - the seats that took it, and why the others did not.
 */
export async function postSeriesLine(line, targets, { fetchFn = fetch, tries = 30, waitMs = 3000 } = {}) {
  const answers = await Promise.all(targets.map(async ([who, url]) => {
    let ok = false, why = '';
    for (let t = 0; t < tries && !ok; t++) {
      try { const r = await fetchFn(`${url}/series`, { method: 'POST', body: line, signal: AbortSignal.timeout(30000) }); ok = r.ok; if (!ok) why = await r.text(); }
      catch (e) { why = e.message; }
      if (!ok && !/no chain view|view .*pending|fetch failed|unreachable|not confirmed|no publication|nobody has funded/i.test(why)) break;
      if (!ok) await new Promise((res) => setTimeout(res, waitMs));
    }
    return { who: String(who).slice(0, 8), ok, why: ok ? '' : String(why).slice(0, 160) };
  }));
  return { took: answers.filter((x) => x.ok).length, of: answers.length, refused: answers.filter((x) => !x.ok) };
}
