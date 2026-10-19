// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A MARKET IN THE PAGE (§0A.7a; 2026-10-07, decisions A and B of plan 777): the pick sheet's
// model, the pick handed to the seats, the outcome checked by the page itself, and the lines the lobby draws.
//
// - The sheet (#blwp-pick in index.html) is drawn from `pickSheet`: one button per outcome, the stake, the 5% fee line and
//   the 0-5% donation line. Outcome labels and attestor keys come from the page's PINNED known-games list (`marketOf`),
//   never from a node; a market the page does not pin is read from its signed manifest (GET /game-manifest, checked to hash
//   to the round's game id) and staked on only after the second confirmation (§0A.6) - `needsConfirm`.
// - A pick plays no run: the page hands the entry and its locks to the seats itself (`submitPick`), no session opens, and
//   the join ends in state `picked` - Unity does not take it over.
// - The outcome is the seats' GET /outcome, but believed only once its attestation verifies against the attestors the page
//   pinned (`checkAttestation`, Ed25519 through WebCrypto); otherwise it is shown as unverified and nothing is concluded.
import { stakeOf } from './join.js';
import { decodeManifest, gameIdOf, isAttested, isScalar, isGameMarket, RESULT_TYPE } from '../../arena-protocol/src/manifest.js';
import { decodeValueAttestation, isValueAttestationBytes, valueAttestationBodyId, valueAttestationStands } from '../../arena-protocol/src/scalar.js';
import { gameMarketResolution } from '../../arena-protocol/src/game-market.js';
import { seriesId, seriesRoundCheck } from '../../arena-protocol/src/series.js';
import { parseSeriesLine } from '../../arena-protocol/src/series-line.js';
import { decodeRoundContract } from '../../arena-protocol/src/contracts.js';
import { decodeAttestation, attestationStands, attestationBodyId } from '../../arena-protocol/src/attested.js';
import { marketOf, feeOfKnownGame } from '../../arena-protocol/src/known-game.js';
import { entryFeeMsat, feeBpsOf, donationBpsOf } from '../../arena-protocol/src/fee.js';
import { termsOfKnownGame } from '../../arena-protocol/src/known-game.js';
import { encodeEntryContract, entryId, decodeEntryContract } from '../../arena-protocol/src/contracts.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { handLock } from './page-lock.js';
import { cancelId, sellId, PRICE_SCALE } from '../../arena-protocol/src/order-book.js';

const sats = (msat) => (Number(BigInt(msat)) / 1000).toLocaleString('en-US', { maximumFractionDigits: 3 });

/**
 * THE MARKET A ROUND PLAYS, as this page may stake on it: pinned (`known: true`), or - for a game the page does not pin -
 * from the manifest a seat served, only if that manifest IS the round's game (its id) and is attested; `needsConfirm` then.
 * null for a round that is not a market.
 */
export function marketForRound(round, { manifestBytes = null } = {}) {
  if (!round || !(round.gameId instanceof Uint8Array)) return null;
  const pinned = marketOf(round.gameId);
  // ITS FEE: a market's own, from its manifest, or the market default 0.5 % + 0.5 %
  // AND ITS TERMS: resolution delay and void deadline - what its rounds' lock span is checked by (lock-expiry.js)
  if (pinned) return marketAsRoundAsks({ ...pinned, needsConfirm: false, fee: feeOfKnownGame(round.gameId), terms: termsOfKnownGame(round.gameId) }, round);
  if (!manifestBytes) return null;
  let m;
  try { m = decodeManifest(manifestBytes instanceof Uint8Array ? manifestBytes : fromHex(String(manifestBytes))); } catch { return null; }
  if (toHex(gameIdOf(m)) !== toHex(round.gameId) || !isAttested(m)) return null;
  return marketAsRoundAsks({ gameId: toHex(round.gameId), name: m.gameName, known: false, needsConfirm: true, outcomes: [...m.outcomes],
    attestors: m.attestors.map(toHex), threshold: m.attestThreshold, devKey: toHex(m.gameDevPubkey), networks: [],
    fee: { nodeBps: feeBpsOf(m), donationBps: donationBpsOf(m) }, terms: m.marketTerms || null,
    // A SCALAR MARKET'S BOUNDS (protocol 7) and A MARKET ON A GAME'S SOURCE (protocol 6),: what its lines say and
    // what its outcome is checked by - the decoded manifest kept beside them for that check
    ...(isScalar(m) ? { scalar: { low: m.scalar.low, high: m.scalar.high, unit: m.scalar.unit } } : {}),
    ...(isGameMarket(m) ? { gameSource: { sourceGameId: toHex(m.gameSource.sourceGameId), mapping: [...m.gameSource.mapping] } } : {}),
    manifest: m }, round);
}

/**
 * A ROUND OF A MARKET TEMPLATE ASKS ITS OWN QUESTION (feature 5): its labels, its question and its resolution time
 * are the round's signed contract's (`event`), the attestors, threshold and fees the template's - so the pick sheet, the
 * attestation check and the lock span read the round's. Any other round: the market as it is.
 */
function marketAsRoundAsks(market, round) {
  if (!market || !round || !round.event) return market;
  const ev = round.event;
  return { ...market, outcomes: [...ev.outcomes], question: ev.question, resolveAtMs: ev.resolveAtMs,
    terms: market.terms ? { ...market.terms, resolveAfterCloseMs: ev.resolveAtMs - round.entryCloseMs } : market.terms,
    // A ROUND OF A SCALAR TEMPLATE (2026.0.8) is paid between ITS bounds, in the template's unit
    ...(market.scalar && ev.scalar ? { scalar: { low: ev.scalar.low, high: ev.scalar.high, unit: market.scalar.unit } } : {}) };
}

/**
 * THE PICK SHEET: the market's outcomes as buttons, and what a pick costs out of the stake - the fee (5%, §0A.8), the
 * donation (0-5%, the player's own setting) and the net stake that is at risk. An unpinned market carries the second
 * confirmation's words: its developer key and manifest id.
 */
// `contract`: the round's (its stake is read here, so the page names no contract field); `stakeMsat` instead, for a caller with no
// contract at hand.
export function pickSheet({ market, contract = null, stakeMsat = contract ? contract.stakeMsat : 0n }) {
  const stake = BigInt(stakeMsat);
  // THE MARKET'S OWN RATES: its node fee and its donation (0.5 % + 0.5 % by default), DUE WHEN THE PICK FILLS -
  // at entry close (2026-10-09): they sit in the fee lock beside the stake, are paid out when the market resolves from
  // winners and losers alike, and come back whole on a cancel before entry close, a VOID or a market nobody picked right
  const rates = market.fee || { nodeBps: 50, donationBps: 50 };
  const fee = entryFeeMsat(stake, rates.nodeBps + rates.donationBps);
  const pct = (bps) => `${(bps / 100).toFixed(bps % 100 ? (bps % 10 ? 2 : 1) : 0)}%`;
  const net = stake - fee;
  return {
    title: `${market.name} - pick one`,
    outcomes: market.outcomes.map((label, index) => ({ index, label })),
    lines: {
      stake: `stake ${sats(stake)} sats`,
      fee: `fees ${pct(rates.nodeBps + rates.donationBps)}: ${sats(fee)} sats - ${pct(rates.nodeBps)} nodes + ${pct(rates.donationBps)} donation `
        + `(half to the protocol devs, half to ${market.name}'s dev), due once your pick is in at entry close - cancel before that costs nothing; `
        + 'back in full if the market is void or nobody picked right',
      net: `at risk on your pick: ${sats(net)} sats`,
    },
    stakeMsat: stake, feeMsat: fee, donationMsat: 0n, netMsat: net,
    attestors: `outcome by ${market.threshold} of ${market.attestors.length} attestors named by ${market.name}'s dev`,
    confirm: market.needsConfirm
      ? `${market.name} is not on this page's list of known markets. Its developer key is ${market.devKey.slice(0, 16)}… and its manifest ${market.gameId.slice(0, 16)}…; `
        + 'only its attestors decide the outcome. Stake on it anyway?'
      : null,
  };
}

/**
 * HAND A PICK TO THE ROUND'S SEATS (no session, no run): the entry to every seat, then its stake lock and fee lock as the
 * client hands them (`handLock`). Answers each seat's word and the entry id.
 */
// `onEntries` (measured on the paid regtest stack: a paid head-to-head tap was counted only after the guardians
// accepted its lock and the 7 seats had each checked it - 6.5 s median at load 30-47; the seats had taken the entry at ~2.8 s):
// called with { entryId, entries } as soon as the seats answered the entry, while the locks are handed after it
export async function submitPick({ entry, stakeLock, nodes, fetcher = fetch, onEntries = null }) {
  const eid = entryId(entry);
  const bytes = encodeEntryContract(entry);
  const entries = await Promise.all(nodes.map(async (node) => {
    try {
      const r = await fetcher(`${String(node).replace(/\/+$/, '')}/entry`, { method: 'POST', body: bytes });
      return { node, status: r.status, why: r.status === 201 ? null : (await r.text()).trim() };
    } catch (e) { return { node, status: 0, why: e.message }; }
  }));
  const took = entries.filter((x) => x.status === 201).map((x) => x.node);
  if (onEntries) { try { onEntries({ entryId: toHex(eid), entries }); } catch { /* the caller's own fault */ } }
  if (!took.length) return { ok: false, entryId: toHex(eid), entries, why: entries.map((x) => `${x.node}: ${x.why}`).join('; ') };
  if (!stakeLock) return { ok: took.length === nodes.length, entryId: toHex(eid), entries, lock: null, feeLock: null };
  // THE LOCKS ONCE THE GUARDIANS ACCEPTED THEM, AND AGAIN TO A SEAT THAT REFUSED (measured on the regtest market
  // stack): handed once, at once, while the federation was still accepting the lock, every seat that looked first refused it
  // and none was asked again - so the order was tradable nowhere (a batch needs 5 seats holding its locks). The first pass
  // after acceptance is awaited; the seats still refusing are asked again in the background until the round's entry closes
  // (`stakeLock.handUntilMs`) or LOCK_HAND_MS passes - `handing` is that whole.
  if (stakeLock.accepted && typeof stakeLock.accepted.then === 'function') {
    try { await stakeLock.accepted; } catch (e) { return { ok: false, entryId: toHex(eid), entries, why: `the stake lock was not accepted: ${e.message}` }; }
  }
  const kinds = [{ door: 'lock', fields: stakeLock.fields }, ...(stakeLock.feeLock ? [{ door: 'fee-lock', fields: stakeLock.feeLock.fields }] : [])];
  const tookLock = new Map(kinds.map((k) => [k.door, new Set()]));
  const said = {};
  const pass = async () => {
    await Promise.all(kinds.map(async (k) => {
      const left = took.filter((n) => !tookLock.get(k.door).has(n));
      if (!left.length) return;
      const r = await handLock({ entryId: eid, fields: k.fields, nodes: left, needed: 0, fetcher, door: k.door });
      for (const x of r.said) if (x.status === 201) tookLock.get(k.door).add(x.node);
      said[k.door] = { committed: tookLock.get(k.door).size, needed: took.length, said: r.said };
    }));
  };
  await pass();
  const until = Math.max(Date.now() + LOCK_HAND_MS_PICK, Number(stakeLock.handUntilMs || 0));
  const handing = (async () => {
    for (let pause = 1000; Date.now() < until && kinds.some((k) => tookLock.get(k.door).size < took.length); pause = Math.min(pause * 2, 15000)) {
      await new Promise((r) => setTimeout(r, pause));
      await pass();
    }
    return said;
  })();
  return { ok: took.length === nodes.length, entryId: toHex(eid), entries, lock: said.lock || null, feeLock: said['fee-lock'] || null, handing };
}
const LOCK_HAND_MS_PICK = 120000;

/**
 * THE TAB'S RECORD OF A PICK (what the lobby's market lines are made of): its round, entry and pick, its market's game, its
 * stake and entry close as the round's contract says them, and the signer nodes to ask for its outcome.
 */
export function pickRecord({ roundIdHex, entryIdHex, pick, round, nodes, confirmed = false }) {
  return { roundIdHex, entryIdHex, pick, gameId: toHex(round.gameId), stakeMsat: String(stakeOf(round)), entryCloseMs: String(round.entryCloseMs),
    // a market on a game's round names its source round (feature 6): its outcome is that round's signed result
    ...(round.sourceRoundId instanceof Uint8Array ? { sourceRoundIdHex: toHex(round.sourceRoundId) } : {}),
    // a template's round asks its own question - and a scalar template's names its own bounds (2026.0.8): kept with the pick, so its
    // lines say the round's, not the template's
    ...(round.event ? { event: { question: round.event.question, outcomes: [...round.event.outcomes], resolveAtMs: String(round.event.resolveAtMs),
      ...(round.event.scalar ? { scalar: { low: String(round.event.scalar.low), high: String(round.event.scalar.high) } } : {}) } } : {}),
    nodes: [...nodes], confirmed: !!confirmed };
}

/** The round a kept pick names, as marketForRound reads it: its game, its entry close and - for a template's round - its question. */
export function roundOfPick(p) {
  const ev = p && p.event;
  return { gameId: fromHex(String(p.gameId)), entryCloseMs: BigInt(p.entryCloseMs),
    ...(ev ? { event: { question: ev.question, outcomes: [...ev.outcomes], resolveAtMs: BigInt(ev.resolveAtMs),
      ...(ev.scalar ? { scalar: { low: BigInt(ev.scalar.low), high: BigInt(ev.scalar.high) } } : {}) } } : {}) };
}

/** Ed25519 through the browser's WebCrypto; null where the browser cannot (the attestation is then shown unverified). */
export async function webCryptoEd25519(signature, message, key) {
  const subtle = globalThis.crypto && globalThis.crypto.subtle;
  if (!subtle) return null;
  try {
    const k = await subtle.importKey('raw', key, { name: 'Ed25519' }, false, ['verify']);
    return await subtle.verify({ name: 'Ed25519' }, k, signature, message);
  } catch { return null; }
}

/**
 * IS THE SEATS' OUTCOME THE ATTESTORS'? The attestation's own bytes (GET /outcome), checked against the market this page
 * pinned (or confirmed): its round, an outcome in range, the threshold of distinct named attestors, every signature good.
 * `verify(signature, digest, key)` may be async (WebCrypto); a verifier that cannot answer leaves it `unverifiable`.
 */
export async function checkAttestation({ attestationHex, market, roundIdHex, verify = webCryptoEd25519 }) {
  let a;
  try { a = decodeAttestation(fromHex(String(attestationHex))); } catch (e) { return { verified: false, why: `not an attestation: ${e.message}` }; }
  const digest = attestationBodyId(a);
  const said = new Map();
  for (const s of a.signatures) {
    const v = await verify(s.signature, digest, s.key);
    if (v === null) return { verified: false, unverifiable: true, why: 'this browser cannot check Ed25519 signatures: the outcome is shown unverified' };
    said.set(`${toHex(s.key)}:${toHex(s.signature)}`, v === true);
  }
  const manifest = { gameName: market.name, resultType: RESULT_TYPE.ATTESTED, outcomes: market.outcomes,
    attestors: market.attestors.map((k) => fromHex(k)), attestThreshold: market.threshold };
  const stands = attestationStands(a, { manifest, roundIdBytes: fromHex(roundIdHex),
    verify: (sig, _d, key) => said.get(`${toHex(key)}:${toHex(sig)}`) === true });
  return stands.ok ? { verified: true, outcome: stands.outcome, label: stands.label, why: stands.why } : { verified: false, why: stands.why };
}

/**
 * A MARKET OUTCOME, CHECKED BY THIS PAGE (the market lines of protocols 6 and 7), whatever its kind - the seats'
 * GET /outcome answer `o`, the pick's `market` (marketForRound's), its round id:
 * - an outcome attestation: checkAttestation, against the attestors the page pinned or the player confirmed;
 * - a VALUE attestation (a scalar market, type 0x2a): its attestors' signatures (Ed25519, `verify`) and threshold, for this
 *   round, against the manifest's attestors - answers the value, and where it is paid (clamped to the bounds);
 * - a market on a game's source result: the source round's RoundResult, signed by ITS settlement committee - which
 *   `sourceCommittee(sourceRoundIdHex, sourceContract)` derives on this page (clientCommittee), never the seats' list - at its
 *   own threshold, mapped by the manifest. A source round of a SERIES (Tick Tock's are) - whose id does not hash its contract -
 *   is first checked as its series derives it: `sourceSeries(seriesIdHex)` hands the series' template (fetchSeriesTemplate:
 *   from any seat, believed only once it hashes to that id), and the contract must be its round byte for byte.
 * `{ verified, outcome, label, value, refund, why }`; never throws.
 */
export async function checkMarketOutcome({ outcome: o, market, roundIdHex, sourceRoundIdHex = null, entryCloseMs = null,
  sourceCommittee = null, sourceSeries: sourceSeries_ = null, verify = webCryptoEd25519, verifySchnorr = null }) {
  try {
    if (o && o.gameOutcome && market && market.gameSource) {
      const g = o.gameOutcome;
      if (g.void) return { verified: false, why: `the seats hold it VOID: ${g.why || 'its source round refunds it'} (not checked here)` };
      let source;
      try { source = decodeRoundContract(fromHex(String(g.sourceContract))); } catch (e) { return { verified: false, why: `the source contract does not decode: ${e.message}` }; }
      let sourceSeries = null;
      if (source.seriesId !== undefined && source.seriesId !== null) {
        const sid = toHex(source.seriesId);
        const t = typeof sourceSeries_ === 'function' ? await sourceSeries_(sid) : null;
        if (!t || !t.ok) return { verified: false, why: `its source is round ${source.roundIndex} of series ${sid.slice(0, 8)}, and ${t && t.why ? t.why : 'no series template was found to check it'}` };
        const sc = seriesRoundCheck(source, [t.template]);
        if (!sc.ok) return { verified: false, why: `its source round: ${sc.why}` };
        sourceSeries = [t.template];
      }
      if (typeof sourceCommittee !== 'function' || typeof verifySchnorr !== 'function') return { verified: false, why: 'this page cannot derive the source round\'s committee' };
      const committee = await sourceCommittee(String(g.source), source);
      if (!committee || !committee.length) return { verified: false, why: 'this page could not derive the source round\'s committee from the chain' };
      const r = gameMarketResolution({ market: { sourceRoundId: fromHex(String(sourceRoundIdHex || g.source)), entryCloseMs: BigInt(entryCloseMs ?? o.entryCloseMs) },
        manifest: market.manifest, source, result: { roundId: fromHex(String(g.source)), openCents: Number(g.openCents), closeCents: Number(g.closeCents) },
        sigs: g.sigs, committee, verify: verifySchnorr, sourceSeries });
      if (!r.ok) return { verified: false, why: r.why };
      return r.refund ? { verified: true, refund: true, value: r.value, why: r.why }
        : { verified: true, outcome: r.outcome, label: r.label, value: r.value, signers: r.signers, threshold: r.threshold, why: r.why };
    }
    if (o && o.attestation && market && market.scalar && isValueAttestationBytes(fromHex(String(o.attestation)))) {
      let a;
      try { a = decodeValueAttestation(fromHex(String(o.attestation))); } catch (e) { return { verified: false, why: `not a value attestation: ${e.message}` }; }
      const digest = valueAttestationBodyId(a);
      const said = new Map();
      for (const x of a.signatures) {
        const v = await verify(x.signature, digest, x.key);
        if (v === null) return { verified: false, unverifiable: true, why: 'this browser cannot check Ed25519 signatures: the value is shown unverified' };
        said.set(`${toHex(x.key)}:${toHex(x.signature)}`, v === true);
      }
      // clamped to the bounds THIS round is paid between - a scalar template's round names its own (2026.0.8)
      const st = valueAttestationStands(a, { manifest: { ...market.manifest, scalar: market.scalar }, roundIdBytes: fromHex(roundIdHex),
        verify: (sig, _d, key) => said.get(`${toHex(key)}:${toHex(sig)}`) === true });
      return st.ok ? { verified: true, value: st.value, clamped: st.clamped, why: st.why } : { verified: false, why: st.why };
    }
    if (o && o.attestation) return await checkAttestation({ attestationHex: o.attestation, market, roundIdHex, verify });
    return { verified: false, why: 'the seats handed no evidence for it' };
  } catch (e) { return { verified: false, why: e.message }; }
}

/**
 * A SERIES' TEMPLATE FROM THE SEATS: each of `nodes` asked GET /series-template?id= in turn; a line is believed only
 * once the template it carries hashes to `seriesIdHex` (series.js seriesId over the template, its period and its count) - so no
 * seat can hand another series. `{ ok, template, from }` or `{ ok: false, why }`.
 */
export async function fetchSeriesTemplate({ seriesIdHex, nodes = [], fetcher = fetch, timeout = null } = {}) {
  const want = String(seriesIdHex || '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(want)) return { ok: false, why: 'that is not a series id' };
  const refused = [];
  for (const n of nodes) {
    const base = String(n).replace(/\/+$/, '');
    try {
      const r = await fetcher(`${base}/series-template?id=${want}`, timeout ? { signal: timeout(8000) } : {});
      if (!r.ok) { refused.push(`${base}: ${r.status}`); continue; }
      const t = parseSeriesLine(await r.text());
      if (toHex(seriesId(t)) !== want) { refused.push(`${base}: its template is another series`); continue; }
      return { ok: true, template: t, from: base };
    } catch (e) { refused.push(`${base}: ${e.message}`); }
  }
  return { ok: false, why: `no seat handed series ${want.slice(0, 8)}'s template (${refused.slice(0, 3).join('; ') || 'no seat to ask'})` };
}

/** A scalar value in its unit: "8,300,000 USD cents" -> "83,000.00 USD" for cents, else the number and its unit. */
export function scalarValueLine(value, unit) {
  const v = BigInt(value);
  const u = String(unit || '');
  const m = u.match(/^(.*?)\s*cents$/i);
  if (m) {
    const neg = v < 0n, a = neg ? -v : v;
    return `${neg ? '-' : ''}${(a / 100n).toLocaleString('en-US')}.${String(a % 100n).padStart(2, '0')} ${m[1] || ''}`.trim();
  }
  return `${v.toLocaleString('en-US')} ${u}`.trim();
}

/**
 * THE LOBBY'S MARKET LINES (Unity draws them under the round rows, kind 'market'): for each pick this page made, the pick
 * while its round is open, then the outcome as the page checked it, and what it means for this pick.
 * `picks`: [{ roundIdHex, entryIdHex, market, pick, stakeMsat, entryCloseMs }]; `outcomes`: Map roundIdHex -> the seats'
 * GET /outcome answer with `check` (checkAttestation's) added.
 */
export function marketLines({ picks, outcomes = new Map(), nowMs = Date.now() }) {
  const lines = [];
  const left = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };
  for (const p of picks) {
    const label = p.market.outcomes[p.pick];
    const head = `${p.market.name} ${p.roundIdHex.slice(0, 8)}`;
    const o = outcomes.get(p.roundIdHex);
    // EACH LINE ALSO SAID AS DATA (2026-10-17: "This looks pretty bad, make it prettier and more structured"): its
    // round and entry, the pick, the stake, the window's close and a state - a client draws its own row from these; the text stays
    const at = (state, more = {}) => ({ kind: 'market', round: p.roundIdHex, entry: p.entryIdHex || null, pick: p.pick, label, stakeMsat: String(p.stakeMsat),
      entryCloseMs: Number(p.entryCloseMs), state,
      // WHEN THE RESULT IS FINAL (2026-10-17: "show there if it's still pending (10 minute delay)"): the seats'
      // finality of an attested outcome and its time, so a client counts the objection window down on every result, won or lost
      ...(o && o.state === 'ATTESTED' ? { final: !!o.final, finalAtMs: Number(o.finalAtMs) || null } : {}), ...more });
    if (nowMs < Number(p.entryCloseMs)) {
      lines.push({ ...at('open'), text: `${p.market.name}: you picked '${label}' · ${sats(p.stakeMsat)} sats · closes in ${left(Number(p.entryCloseMs) - nowMs)}` });
      continue;
    }
    if (!o || o.state === 'OPEN') {
      // what decides it: a market on a game waits for its source round's signed result, any other for its attestors
      const by = p.market.gameSource ? `source round ${String(p.sourceRoundIdHex || '').slice(0, 8)}'s signed result`
        : `${p.market.threshold} of ${p.market.attestors.length} attestors${p.market.scalar ? ' to sign the value' : ''}`;
      lines.push({ ...at('waiting'), text: `${head}: you picked '${label}' · waiting for ${by}` });
      continue;
    }
    if (o.state === 'VOID') {
      lines.push({ ...at('void'), text: `${head}: VOID - ${o.why || 'its source round refunds it'} · every stake comes back` });
      continue;
    }
    if (o.state === 'DISPUTED') {
      lines.push({ ...at('disputed'), text: `${head}: the attestors contradicted themselves, nothing is paid; your stake comes back at expiry` });
      continue;
    }
    const check = o.check || { verified: false, why: 'not checked yet' };
    if (!check.verified) {
      lines.push({ ...at('unverified'), text: `${head}: the signer nodes say '${o.label}' - UNVERIFIED (${check.why})` });
      continue;
    }
    const row = o.table && o.table.rows ? o.table.rows.find((r) => r.entryId === p.entryIdHex) : null;
    // WHAT WAS SIGNED, as this page checked it: a scalar market's value and where it pays, a market on a game's source result,
    // else the attestors' outcome
    const signed = p.market.scalar ? `value ${scalarValueLine(check.value, p.market.scalar.unit)}${check.clamped !== undefined && check.clamped !== check.value ? ` (paid as ${scalarValueLine(check.clamped, p.market.scalar.unit)})` : ''} between ${scalarValueLine(p.market.scalar.low, p.market.scalar.unit)} and ${scalarValueLine(p.market.scalar.high, p.market.scalar.unit)} (${p.market.threshold} of ${p.market.attestors.length} attestors, verified)`
      : p.market.gameSource ? `'${check.label}' (source round ${String(p.sourceRoundIdHex || '').slice(0, 8)} ended ${check.value}, signed by its committee, verified)`
        : `'${check.label}' (${p.market.threshold} of ${p.market.attestors.length} attestors, verified)`;
    // AN ORDER THAT MATCHED NOBODY (measured 2026-10-17: two 14:00 orders held 0 shares and 0 cost in their round's
    // book on every seat, and the settlement table - filled positions only - had no row for them, so they stayed "waiting"): the page
    // read its position from the book after the close (`unfilled`); its stake comes back whole
    if (!row && p.unfilled) { lines.push({ ...at('refunded', { backMsat: String(p.stakeMsat) }), text: `${head}: ${signed} · your order matched nobody: its ${sats(p.stakeMsat)} sats come back whole` }); continue; }
    if (!row) { lines.push({ ...at('unknown'), text: `${head}: ${signed} · your pick is not in the signer nodes' table` }); continue; }
    const net = BigInt(row.netMsat);
    const pay = BigInt(row.payoutMsat);
    // A FREE ROUND: nothing staked, so the pick was right or wrong and nothing more
    if (BigInt(p.stakeMsat) === 0n) lines.push({ ...at(row.won ? 'right' : 'wrong'), text: `${head}: ${signed} · ${row.won ? 'your pick was right' : 'your pick was wrong'} (free round)` });
    else if (o.table.refunded) lines.push({ ...at('refunded', { backMsat: String(net) }), text: `${head}: ${signed} · nobody picked it: your ${sats(net)} sats come back` });
    // NOBODY ON THE OTHER SIDE (measured live 2026-10-13: the first paid Up/Down window, one order alone, read "you won
    // 0 sats" while the seats claimed nothing - an order nobody took the other side of fills nothing, and its lock comes back whole)
    else if (!p.market.scalar && row.won && BigInt(o.table.losingPoolMsat || 0) === 0n) lines.push({ ...at('refunded', { backMsat: String(row.stakeMsat || p.stakeMsat) }), text: `${head}: ${signed} · nobody took the other side: your ${sats(row.stakeMsat || p.stakeMsat)} sats come back whole when the lock expires` });
    // A SCALAR SIDE IS PAID ITS SHARE, not all or nothing: what came back, and the gain or the loss
    else if (p.market.scalar) lines.push({ ...at('settled', { payoutMsat: String(pay), netMsat: String(net) }), text: `${head}: ${signed} · '${label}' gets ${sats(pay)} of your ${sats(net)} sats · ${pay >= net ? `+${sats(pay - net)}` : `-${sats(net - pay)}`}${o.final ? '' : ' (final after the objection window)'}` });
    else if (row.won) lines.push({ ...at('won', { gainMsat: String(pay - net), payoutMsat: String(pay) }), text: `${head}: ${signed} · you won ${sats(pay - net)} sats${o.final ? '' : ' (final after the objection window)'}` });
    else lines.push({ ...at('lost', { lostMsat: String(net) }), text: `${head}: ${signed} · you lost ${sats(net)} sats` });
  }
  return lines;
}

// AN ORDER'S OWN MESSAGES: what its session key signs to cancel it, or to sell its shares back, before the
// market resolves (protocol order-book.js) - here so the page's bundle carries them (the bundle takes no import aliases)
export function orderCancelId({ roundId, entryId }) { return cancelId({ roundId, entryId }); }
export function orderSellId({ roundId, entryId, outcome, price, sharesMsat, nonce }) { return sellId({ roundId, entryId, outcome, price, sharesMsat, nonce }); }
/** The order book's price scale: a limit price of PRICE_SCALE is certainty (1 sat per share). */
export const ORDER_PRICE_SCALE = Number(PRICE_SCALE);

/**
 * MY ORDERS, FROM THE SEATS (2026-10-17: "When I reload the page my open orders are gone and still no closed
 * orders"; "Have the open orders from the nodes not from local storage"): of a round's entries as its signer seats hold them
 * (`entries`: [{ idHex, bytes }], from GET /book's positions and resting buys, each fetched by GET /entry), the ones whose player key
 * is one this wallet makes for that round - `keys`: Map(player key hex -> order index), playerFor(round, seed, order) - read back
 * as orders: [{ entryIdHex, orderIndex, pick, limitPrice, orderExpiryMs, stakeMsat }]. An entry that does not decode, or is checked
 * under another id than the one it was asked by, is skipped.
 */
export function myOrdersFromEntries({ entries, keys }) {
  const out = [];
  for (const { idHex, bytes } of entries || []) {
    let e;
    try { e = decodeEntryContract(bytes); } catch { continue; }
    if (toHex(entryId(e)) !== String(idHex).toLowerCase()) continue;
    const order = keys.get(toHex(e.playerPubkey));
    if (order === undefined || e.limitPrice === undefined) continue;
    out.push({ entryIdHex: toHex(entryId(e)), orderIndex: order, pick: e.pick, limitPrice: Number(e.limitPrice), orderExpiryMs: String(e.orderExpiryMs || 0n), stakeMsat: String(e.stakeMsat) });
  }
  return out;
}
