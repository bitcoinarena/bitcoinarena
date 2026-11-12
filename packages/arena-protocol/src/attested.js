// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// AN ATTESTED OUTCOME AND THE PARI-MUTUEL TABLE (§0A.7a2026-10-07): the result of a round of an
// attested game - a prediction market - is not a replayed run but the outcome its attestors sign. The game's manifest
// names the outcomes, the attestor keys and how many of them must sign (k of n, chosen by the game dev); a round's
// entries each back one outcome (contracts.js `pick`); and the payout is pari-mutuel: the losing picks' net stakes are
// split over the winning picks in proportion to their net stakes. No game code runs anywhere in this.
//
//     OutcomeAttestation {
//       round_id, outcome (index into the manifest's outcomes), observed_at_ms,
//       signatures[] - each { attestor key, signature by it over the body's id }
//     }
//
// The attestors sign the BODY's id (TAG.outcomeAttestation over round_id, outcome, observed_at_ms); signatures are not in
// what they sign. NO CURVE, as everywhere in this package: `verify(signature, digest, key)` is injected - Ed25519, the
// scheme the game's own manifest is signed with.
//
// WHAT VERIFY MEANS WITHOUT A REPLAY: a seat checks the signatures against the manifest's attestor set and the threshold,
// the round, and the outcome's range - nothing else of the world. WHAT AN OBJECTION IS: two attestations for one round,
// each standing on its own, naming different outcomes. That pair is the proof; a round holding it settles on neither.
import { Writer, Reader } from './encode.js';
import { taggedHash, toHex } from './hash.js';
import { PROTOCOL_VERSION, speaksVersion, TYPE_OUTCOME_ATTESTATION, TAG } from './constants.js';
import { isAttested, isTemplate, isGameMarket, isScalar, isDrawnAttest, marketOfRound } from './manifest.js';

export const OUTCOME_SIGNATURE_BYTES = 64;

const attIs32 = (b) => b instanceof Uint8Array && b.length === 32;
const attSame = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

/** The bytes the attestors sign: the round, the outcome, when it was seen. */
export function encodeAttestationBody(a) {
  if (!attIs32(a.roundId)) throw new Error('an attestation names its 32-byte round');
  if (!Number.isInteger(a.outcome) || a.outcome < 0 || a.outcome > 255) throw new Error('an attestation names an outcome by its index, 0 to 255');
  if (typeof a.observedAtMs !== 'bigint' || a.observedAtMs < 0n) throw new Error('observed_at_ms is a BigInt of milliseconds');
  const w = new Writer();
  w.u8(TYPE_OUTCOME_ATTESTATION);
  w.u16(PROTOCOL_VERSION);
  w.bytes32(a.roundId);
  w.u8(a.outcome);
  w.u64(a.observedAtMs);
  return w.finish();
}

/** The digest every attestor signs. */
export const attestationBodyId = (a) => taggedHash(TAG.outcomeAttestation, encodeAttestationBody(a));

/** The attestation on the wire: its body, then its signatures (key, signature), in the order given. */
export function encodeAttestation(a) {
  const w = new Writer();
  w.bytes(encodeAttestationBody(a));
  const sigs = a.signatures || [];
  if (!Array.isArray(sigs)) throw new Error('an attestation carries a list of signatures');
  w.vec(sigs, (s, ww) => {
    if (!attIs32(s.key)) throw new Error('a signature names its 32-byte attestor key');
    if (!(s.signature instanceof Uint8Array) || s.signature.length !== OUTCOME_SIGNATURE_BYTES) throw new Error(`an attestor's signature is ${OUTCOME_SIGNATURE_BYTES} bytes`);
    ww.bytes32(s.key); ww.bytes(s.signature);
  });
  return w.finish();
}

export function decodeAttestation(bytes) {
  const r = new Reader(bytes);
  if (r.u8() !== TYPE_OUTCOME_ATTESTATION) throw new Error('not an outcome attestation');
  const version = r.u16();
  if (!speaksVersion(version)) throw new Error(`protocol version ${version}, this build speaks ${PROTOCOL_VERSION}`);
  const a = { roundId: r.bytes32(), outcome: r.u8(), observedAtMs: r.u64() };
  a.signatures = r.vec((rr) => ({ key: rr.bytes32(), signature: rr.bytes(OUTCOME_SIGNATURE_BYTES) }));
  r.end();
  return a;
}

/**
 * DOES THIS ATTESTATION STAND FOR THIS ROUND (§0A.7a)? Its round is this round; its outcome is one the manifest names; and
 * at least the manifest's threshold of DISTINCT attestors the manifest names signed its body. Each refusal names its
 * reason: another round's, an outcome out of range, a key the manifest does not name, a signature that does not verify,
 * too few signatures. Answers, never throws.
 */
//
// A ROUND OF A TEMPLATE (feature 5) names its own outcomes (contracts.js `event`): its attestors sign an index into
// THOSE, so `round` - the round's contract - is handed in, and the range and the label are the round's (manifest.js
// marketOfRound). A template's attestation with no round to read its outcomes from is refused: the template's own labels
// are not the question its attestors answered.
export function attestationStands(a, { manifest: game, roundIdBytes, verify, round = null, drawn = null, backupOpen = false }) {
  if (!isAttested(game)) return { ok: false, why: 'that round\'s game is not attested: its result is a replayed run, not an attestation' };
  // A MARKET ON A GAME (feature 6) HAS NO ATTESTORS: its threshold is 0, so an attestation would stand with no
  // signature at all - refused by name; its outcome is its source round's signed result (game-market.js gameMarketResolution)
  if (isGameMarket(game))
    return { ok: false, why: `game "${game.gameName}" is a market on a game: its outcome is its source round's signed result, and no attestation decides it` };
  // A SCALAR MARKET (feature 8) IS DECIDED BY A SIGNED VALUE, NEVER AN INDEX: its attestors sign a ValueAttestation
  // (scalar.js valueAttestationStands) - an outcome attestation for it, even one its own attestors signed, is refused by name
  if (isScalar(game))
    return { ok: false, why: `game "${game.gameName}" is a scalar market: its attestors sign the observed value (a value attestation), and an outcome index decides nothing of it` };
  if (isTemplate(game) && !(round && round.event))
    return { ok: false, why: `game "${game.gameName}" is a market template: an attestation is checked against its round's own outcomes, and no round naming them was given` };
  const manifest = marketOfRound(game, round);
  let digest;
  try { digest = attestationBodyId(a); } catch (e) { return { ok: false, why: `that attestation does not encode: ${e.message}` }; }
  if (!attIs32(roundIdBytes) || !attSame(a.roundId, roundIdBytes))
    return { ok: false, why: `that attestation is for round ${toHex(a.roundId).slice(0, 16)}, not this round ${attIs32(roundIdBytes) ? toHex(roundIdBytes).slice(0, 16) : ''}`.trim() };
  if (a.outcome >= manifest.outcomes.length)
    return { ok: false, why: `that attestation names outcome ${a.outcome}, out of range: game "${manifest.gameName}" has ${manifest.outcomes.length} outcomes (0 to ${manifest.outcomes.length - 1})` };
  if (typeof verify !== 'function') return { ok: false, why: 'no verifier to check the attestors\' signatures' };
  // A DRAWN SET (#630): the round's own 7 attestors (sortition.js drawAttestors, node keys, BIP-340 - the caller's `verify`), 5 standing
  const draws = isDrawnAttest(manifest);
  if (draws && !(Array.isArray(drawn) && drawn.length === manifest.attestDraw.count))
    return { ok: false, why: `game "${manifest.gameName}" draws its attestors per round, and the round's ${manifest.attestDraw.count} drawn attestors were not given` };
  // THE BACKUP SET (§0A.7a, kanban #1328): an attestation whose signers are the manifest's backup keys is checked against those, and only once
  // the seat consults them (`backupOpen`: after resolve + deadline/2, the first set silent - backupOpensAtMs); one set's keys never mix with the other's
  const backup = !draws && manifest.backupAttestors && (a.signatures || []).length > 0
    && (a.signatures || []).every((s) => manifest.backupAttestors.attestors.some((k) => toHex(k) === toHex(s.key))
      && !manifest.attestors.some((k) => toHex(k) === toHex(s.key)));
  if (backup && !backupOpen)
    return { ok: false, why: `that attestation is signed by game "${manifest.gameName}"'s backup attestors, who are consulted only after the round's resolution plus half its deadline, while its first set is silent` };
  const keysOf = draws ? drawn.map((k) => (typeof k === 'string' ? k.toLowerCase() : toHex(k))) : (backup ? manifest.backupAttestors.attestors : manifest.attestors).map(toHex);
  const need = draws ? manifest.attestDraw.threshold : backup ? manifest.backupAttestors.threshold : manifest.attestThreshold;
  const named = new Set(keysOf);
  // A LIST LONGER THAN THE ATTESTOR SET (kanban #1546) holds a key twice - each key must be one the set names. Refused before any
  // signature is checked: the wire's u16 vec carries up to 65,535, and one public attestation padded with a repeat of a good
  // signature made POST /outcome run every check on the seat's one thread (65,002 Ed25519: 2.5 s; BIP-340 in JS: ~40 s).
  if ((a.signatures || []).length > named.size)
    return { ok: false, why: `that attestation carries ${(a.signatures || []).length} signatures, more than the ${named.size} attestors ${draws ? 'this round drew' : `game "${manifest.gameName}" names`}` };
  const signed = new Set();
  for (const s of a.signatures || []) {
    const k = toHex(s.key);
    if (!named.has(k)) return { ok: false, why: `that attestation is signed by key ${k.slice(0, 16)}, which ${draws ? 'this round did not draw as an attestor' : `game "${manifest.gameName}" does not name as an attestor`}` };
    let good = false;
    try { good = verify(s.signature, digest, s.key) === true; } catch { good = false; }
    if (!good) return { ok: false, why: `attestor ${k.slice(0, 16)}'s signature on that attestation does not verify` };
    signed.add(k);
  }
  if (signed.size < need)
    return { ok: false, why: `that attestation carries ${signed.size} attestor signature(s), and game "${manifest.gameName}" asks ${need} of its ${named.size}` };
  return { ok: true, outcome: a.outcome, label: manifest.outcomes[a.outcome], signers: signed.size, ...(backup ? { backup: true } : {}),
    why: `outcome ${a.outcome} "${manifest.outcomes[a.outcome]}", signed by ${signed.size} of ${named.size} ${backup ? 'backup ' : ''}attestors (threshold ${need})` };
}

/**
 * THE PARI-MUTUEL TABLE (§0A.7a; 2026-10-07): out of each entry's stake the fee and the donation as for any round
 * (§0A.8, - the entry's own feeMsat and donationMsat, already checked against the contract at the door), and
 * its NET stake into the pool. The losing picks' net stakes are split over the winning picks in proportion to each
 * winner's net stake, floored; the msats the floors leave go one each to the winners in the order of their entry ids.
 * Nobody picked the outcome: every entry's net stake goes back to it. Every millisatoshi of the gross is in the table:
 * fees + donations + payouts = gross. `entries`: [{ entryId (hex or bytes), stakeMsat, feeMsat, donationMsat, pick }].
 */
export function pariMutuelTable({ entries, outcome }) {
  if (!Number.isInteger(outcome) || outcome < 0) throw new Error('the table is built for an attested outcome index');
  const rows = entries.map((e) => {
    const id = typeof e.entryId === 'string' ? e.entryId : toHex(e.entryId);
    const net = e.stakeMsat - e.feeMsat - e.donationMsat;
    if (net < 0n) throw new Error(`entry ${id.slice(0, 16)} pays more in fee and donation than it stakes`);
    if (!Number.isInteger(e.pick)) throw new Error(`entry ${id.slice(0, 16)} backs no outcome`);
    return { entryId: id, stakeMsat: e.stakeMsat, feeMsat: e.feeMsat, donationMsat: e.donationMsat, netMsat: net, pick: e.pick, won: e.pick === outcome };
  }).sort((x, y) => (x.entryId < y.entryId ? -1 : x.entryId > y.entryId ? 1 : 0));
  const sum = (xs) => xs.reduce((t, x) => t + x, 0n);
  const winners = rows.filter((r) => r.won);
  const losers = rows.filter((r) => !r.won);
  const losingPool = sum(losers.map((r) => r.netMsat));
  const winningNet = sum(winners.map((r) => r.netMsat));
  let refunded = false;
  if (!winners.length) {
    // NOBODY BACKED IT: each net stake back to its own entry
    for (const r of rows) r.payoutMsat = r.netMsat;
    refunded = true;
  } else if (winningNet === 0n) {
    // A FREE ROUND (nothing staked): somebody was right, and there is nothing to split - each net (0) is its own. Not a refund:
    // measured live, calling it one told the right pick "nobody picked it".
    for (const r of rows) r.payoutMsat = r.netMsat;
  } else {
    for (const r of losers) r.payoutMsat = 0n;
    let given = 0n;
    for (const r of winners) { r.payoutMsat = r.netMsat + (losingPool * r.netMsat) / winningNet; given += r.payoutMsat - r.netMsat; }
    let left = losingPool - given;
    for (let i = 0; left > 0n; i = (i + 1) % winners.length, left--) winners[i].payoutMsat += 1n;
  }
  const gross = sum(rows.map((r) => r.stakeMsat));
  const fees = sum(rows.map((r) => r.feeMsat));
  const donations = sum(rows.map((r) => r.donationMsat));
  const paid = sum(rows.map((r) => r.payoutMsat));
  if (fees + donations + paid !== gross) throw new Error(`the table does not balance: ${fees} + ${donations} + ${paid} is not the gross ${gross}`);
  return { outcome, refunded, grossMsat: gross, feesMsat: fees, donationsMsat: donations, poolMsat: losingPool + winningNet,
    losingPoolMsat: losingPool, winningNetMsat: winningNet, payoutsMsat: paid, rows };
}

/**
 * THE ROUND'S STANDING ON ITS ATTESTATIONS: none yet (OPEN), one outcome (ATTESTED), or two standing attestations of
 * different outcomes (DISPUTED - the pair is the proof, and the round settles on neither). `held` is every standing
 * attestation a seat keeps for the round, decoded.
 */
//
// A SCALAR MARKET'S STANDING (feature 8): its held attestations are VALUE attestations (scalar.js), each with a BigInt
// `value` and no outcome index - ATTESTED answers that `value`; two standing values that differ are DISPUTED, exactly as two
// outcomes are. A value held beside an index (which no seat can hold for one round: each door refuses the other kind) is a
// contradiction too, never a mixture. A list with no value is read exactly as before.
export function outcomeStanding(held) {
  if (!held.length) return { state: 'OPEN' };
  if (held.some((a) => typeof a.value === 'bigint')) {
    const said = [...new Set(held.map((a) => (typeof a.value === 'bigint' ? `value ${a.value}` : `outcome ${a.outcome}`)))];
    if (said.length === 1 && typeof held[0].value === 'bigint') return { state: 'ATTESTED', value: held[0].value };
    const values = [...new Set(held.filter((a) => typeof a.value === 'bigint').map((a) => a.value))];
    return { state: 'DISPUTED', values, why: `two standing attestations name ${said.join(' and ')}: the pair is proof the attestors contradicted themselves, and the round settles on neither` };
  }
  const outcomes = [...new Set(held.map((a) => a.outcome))];
  if (outcomes.length === 1) return { state: 'ATTESTED', outcome: outcomes[0] };
  return { state: 'DISPUTED', outcomes, why: `two standing attestations name outcomes ${outcomes.join(' and ')}: the pair is proof the attestors contradicted themselves, and the round settles on neither` };
}

/**
 * THE OUTCOME IS FINAL (§0A.7a2026-10-07): the first standing attestation, held for the
 * round's objection window (600 s, §13A) with no contradiction. `held` is every standing attestation the seat keeps, each
 * with the `receivedMs` it came at on the seat's clock, oldest first. Answers the standing, whether it is final, and when
 * it is (or will be). A contradiction inside the window makes the round DISPUTED and nothing settles; one after it is
 * still held as proof (`outcomeStanding` says DISPUTED), and a settlement already made is not undone.
 */
export function outcomeFinality(held, { windowMs, nowMs }) {
  const standing = outcomeStanding(held);
  if (standing.state !== 'ATTESTED') return { ...standing, final: false };
  const firstMs = Math.min(...held.map((a) => Number(a.receivedMs)));
  const finalAtMs = firstMs + Number(windowMs);
  return { ...standing, final: Number(nowMs) >= finalAtMs, firstMs, finalAtMs };
}

/**
 * MAY AN ATTESTATION COME IN YET (§0A.7a slice 2): only once the round's entries have closed on the seat's clock, and only
 * for an outcome seen after that close - an outcome known while a pick could still be made is a pick to be copied.
 */
export function attestationTimely(a, { entryCloseMs, nowMs, terms = null }) {
  // A MARKET WITH TERMS DECIDES AT ITS RESOLUTION TIME, and not before it: an outcome observed earlier is not
  // the outcome the market asked for (the price at 18:00 is not the price at 17:59)
  if (terms) {
    const t = marketTimes({ entryCloseMs, terms });
    if (BigInt(a.observedAtMs) < t.resolveAtMs)
      return { ok: false, why: `that attestation says it was observed at ${new Date(Number(a.observedAtMs)).toISOString()}, before the market's resolution time ${new Date(Number(t.resolveAtMs)).toISOString()}` };
    // AND NOT AFTER ITS DEADLINE (kanban #1151): at the deadline a market with no outcome is VOID and its stakes go back at
    // once; an attestation withheld until then and handed in late would turn it ATTESTED over locks already returned
    if (BigInt(nowMs) >= t.deadlineMs)
      return { ok: false, why: `that market's deadline was ${new Date(Number(t.deadlineMs)).toISOString()}: no outcome is taken after it (a market with none by then is VOID, every stake back)` };
  }
  if (BigInt(nowMs) < BigInt(entryCloseMs))
    return { ok: false, why: `that round's entries are still open (they close at ${new Date(Number(entryCloseMs)).toISOString()}): no outcome is taken before the last pick` };
  if (BigInt(a.observedAtMs) < BigInt(entryCloseMs))
    return { ok: false, why: `that attestation says it was observed at ${new Date(Number(a.observedAtMs)).toISOString()}, before the round's entries closed at ${new Date(Number(entryCloseMs)).toISOString()}` };
  return { ok: true };
}

/**
 * A MARKET ROUND'S TIMES: its resolution time - `resolveAfterCloseMs` after its entry close - and the deadline
 * its attestors have, `deadlineAfterResolveMs` after that. A round of a template (feature 5) names its own
 * resolution time: its terms are `roundTermsOf(manifest, contract)`, whose `resolveAfterCloseMs` is the round's.
 */
/** When the seats consult a market's backup attestors (§0A.7a, kanban #1328): resolve_at + deadline/2. */
export function backupOpensAtMs({ entryCloseMs, terms }) {
  const { resolveAtMs } = marketTimes({ entryCloseMs, terms });
  return resolveAtMs + BigInt(terms.deadlineAfterResolveMs) / 2n;
}
export function marketTimes({ entryCloseMs, terms }) {
  const resolveAtMs = BigInt(entryCloseMs) + BigInt(terms.resolveAfterCloseMs);
  return { resolveAtMs, deadlineMs: resolveAtMs + BigInt(terms.deadlineAfterResolveMs) };
}

/**
 * THE MARKET TERMS A ROUND IS HELD TO (feature 5): its manifest's, with a template round's own question and
 * resolution time in them (manifest.js marketOfRound); null for a market that names none. What attestationTimely, marketVoided
 * and the lock span (lock-expiry.js) take as `terms`.
 */
export const roundTermsOf = (manifest, contract) => {
  const m = marketOfRound(manifest, contract);
  return (m && m.marketTerms) || null;
};

/**
 * REFUND AT THE DEADLINE (2026-10-09): a market round with no standing outcome at its deadline, or whose
 * attestors contradicted themselves, is not settled on any outcome - it is VOID, and every stake goes back, its fee too.
 * Answers { voided, why } on the seat's clock; a round inside its deadline with no outcome yet is not decided here.
 */
export function marketVoided(held, { entryCloseMs, terms, nowMs }) {
  // A CONTRADICTION VOIDS ANY MARKET, with terms or without (the ruling: "or a contradiction, makes the round VOID")
  const standing = outcomeStanding(held);
  if (standing.state === 'DISPUTED') return { voided: true, why: `the attestors contradicted themselves: ${standing.why}` };
  if (!terms) return { voided: false };
  const { deadlineMs } = marketTimes({ entryCloseMs, terms });
  if (standing.state === 'OPEN' && BigInt(nowMs) >= deadlineMs)
    return { voided: true, why: `no outcome was attested by the market's deadline ${new Date(Number(deadlineMs)).toISOString()}: every stake goes back` };
  return { voided: false };
}

/**
 * A MARKET ROUND'S STATE (kanban #1151): one enum, one transition function. OPEN (nothing held) -> ATTESTED (one standing
 * outcome, inside its objection window) -> FINAL; OPEN -> VOID (no outcome by the deadline, or a market on a game's held VOID);
 * ATTESTED -> VOID (a contradiction, or a held VOID, inside the window). FINAL and VOID are TERMINAL: a seat persists them
 * (store.js market_states, compare-and-set) and never changes them, so nothing that comes later - a withheld attestation handed
 * in after the deadline, a contradiction after the window, a game VOID after an outcome stood - turns a round whose stakes went
 * back into one that claims them, or one that settled into one that returns them. What comes later is kept as evidence only.
 */
export const MARKET_STATE = Object.freeze({ OPEN: 'OPEN', ATTESTED: 'ATTESTED', FINAL: 'FINAL', VOID: 'VOID' });
export const marketTerminal = (state) => state === MARKET_STATE.FINAL || state === MARKET_STATE.VOID;
const sameStanding = (a, s) => (typeof s.value === 'bigint' ? typeof a.value === 'bigint' && a.value === s.value : typeof a.value !== 'bigint' && a.outcome === s.outcome);
const saidOf = (a) => (typeof a.value === 'bigint' ? `value ${a.value}` : `outcome ${a.outcome}`);

/**
 * THE ONE TRANSITION: from `prev` (a persisted state, or null for OPEN) and the evidence a seat holds - `held` every standing
 * outcome in an attestation's shape with its `receivedMs` (game-market.js heldOutcomes), `voids` a market on a game's held
 * VOIDs [{ receivedMs, why }] - to the state on the seat's clock `nowMs`. Pure; the caller persists what it answers.
 *  - A terminal `prev` is answered as it is.
 *  - Only evidence RECEIVED BEFORE THE DEADLINE counts (`deadlineMs`, null for a market with no terms: none); evidence received at
 *    or after the window's end (`firstMs + windowMs`) of a standing outcome counts neither: both are kept as evidence only.
 *  - Evidence is read in the order it came (a VOID before an outcome received in the same millisecond).
 * Answers { state, outcome?, value?, observedAtMs?, firstMs?, finalAtMs?, atMs?, reason?, why?, said? } - `reason` of a VOID:
 * 'deadline', 'dispute' or 'game'.
 */
export function marketTransition(prev, held, { deadlineMs = null, windowMs, nowMs, voids = [] }) {
  if (prev && marketTerminal(prev.state)) return prev;
  const D = deadlineMs === null || deadlineMs === undefined ? Infinity : Number(deadlineMs);
  const W = Number(windowMs), now = Number(nowMs);
  const events = [...voids.map((v) => ({ at: Number(v.receivedMs), void: v })), ...held.map((h) => ({ at: Number(h.receivedMs), h }))]
    .filter((e) => e.at < D).sort((x, y) => x.at - y.at || (x.void ? -1 : 0) - (y.void ? -1 : 0));
  let s = prev && prev.state === MARKET_STATE.ATTESTED ? { ...prev } : { state: MARKET_STATE.OPEN };
  for (const e of events) {
    if (s.state === MARKET_STATE.OPEN) {
      if (e.void) return { state: MARKET_STATE.VOID, atMs: e.at, reason: 'game', why: e.void.why || 'its source round\'s result refunds this market: every stake goes back' };
      s = { state: MARKET_STATE.ATTESTED, ...(typeof e.h.value === 'bigint' ? { value: e.h.value } : { outcome: e.h.outcome }),
        observedAtMs: e.h.observedAtMs !== undefined ? BigInt(e.h.observedAtMs) : undefined, firstMs: e.at, finalAtMs: e.at + W };
      continue;
    }
    if (e.at >= s.finalAtMs) break;                          // after the window: evidence only, and so is all that follows
    if (e.void) return { state: MARKET_STATE.VOID, atMs: e.at, reason: 'game', said: [saidOf(s), 'a refund'],
      why: `the source round's committee contradicted itself: ${saidOf(s)} and a refund (${e.void.why || 'VOID'}) - the round settles on neither, every stake goes back` };
    if (!sameStanding(e.h, s)) {
      const said = [saidOf(s), saidOf(e.h)];
      return { state: MARKET_STATE.VOID, atMs: e.at, reason: 'dispute', said,
        why: `the attestors contradicted themselves: two standing attestations name ${said.join(' and ')}: the pair is proof the attestors contradicted themselves, and the round settles on neither` };
    }
  }
  if (s.state === MARKET_STATE.ATTESTED && now >= s.finalAtMs) return { ...s, state: MARKET_STATE.FINAL, atMs: s.finalAtMs };
  if (s.state === MARKET_STATE.OPEN && now >= D)
    return { state: MARKET_STATE.VOID, atMs: D, reason: 'deadline', why: `no outcome was attested by the market's deadline ${new Date(D).toISOString()}: every stake goes back` };
  return s;
}

/**
 * A MARKET'S OWN CLOCK (2026-10-09: "Period is 15 minutes on the market's own clock, not the games' 90 s
 * grid"): a market whose manifest names a period (`roundPeriodMs`, e.g. 900 000 for BTC Up or Down 15m) runs one round per
 * period on the UTC grid - each round's entries close at the end of its period, and its WINDOW is the period before that
 * close. A seat refuses a round of it that closes off the grid. A market naming no period (0) has no grid.
 */
export function marketWindowOf(contract, manifest) {
  const period = manifest && typeof manifest.roundPeriodMs === 'bigint' ? manifest.roundPeriodMs : 0n;
  if (period <= 0n) return { ok: true, window: null };
  if (contract.entryCloseMs % period !== 0n)
    return { ok: false, why: `game "${manifest.gameName}" runs one round per ${period} ms on the UTC grid, and that round's entries close at ${contract.entryCloseMs}, off it` };
  return { ok: true, window: { startMs: contract.entryCloseMs - period, endMs: contract.entryCloseMs, periodMs: period } };
}
