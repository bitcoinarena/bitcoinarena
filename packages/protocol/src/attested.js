// AN ATTESTED OUTCOME AND THE PARI-MUTUEL TABLE (§0A.7a, kanban #206, the owner 2026-10-07): the result of a round of an
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
import { PROTOCOL_VERSION, TYPE_OUTCOME_ATTESTATION, TAG } from './constants.js';
import { isAttested } from './manifest.js';

export const ATTESTATION_SIGNATURE_BYTES = 64;

const is32 = (b) => b instanceof Uint8Array && b.length === 32;
const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

/** The bytes the attestors sign: the round, the outcome, when it was seen. */
export function encodeAttestationBody(a) {
  if (!is32(a.roundId)) throw new Error('an attestation names its 32-byte round');
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
    if (!is32(s.key)) throw new Error('a signature names its 32-byte attestor key');
    if (!(s.signature instanceof Uint8Array) || s.signature.length !== ATTESTATION_SIGNATURE_BYTES) throw new Error(`an attestor's signature is ${ATTESTATION_SIGNATURE_BYTES} bytes`);
    ww.bytes32(s.key); ww.bytes(s.signature);
  });
  return w.finish();
}

export function decodeAttestation(bytes) {
  const r = new Reader(bytes);
  if (r.u8() !== TYPE_OUTCOME_ATTESTATION) throw new Error('not an outcome attestation');
  const version = r.u16();
  if (version !== PROTOCOL_VERSION) throw new Error(`protocol version ${version}, this build speaks ${PROTOCOL_VERSION}`);
  const a = { roundId: r.bytes32(), outcome: r.u8(), observedAtMs: r.u64() };
  a.signatures = r.vec((rr) => ({ key: rr.bytes32(), signature: rr.bytes(ATTESTATION_SIGNATURE_BYTES) }));
  r.end();
  return a;
}

/**
 * DOES THIS ATTESTATION STAND FOR THIS ROUND (§0A.7a)? Its round is this round; its outcome is one the manifest names; and
 * at least the manifest's threshold of DISTINCT attestors the manifest names signed its body. Each refusal names its
 * reason: another round's, an outcome out of range, a key the manifest does not name, a signature that does not verify,
 * too few signatures. Answers, never throws.
 */
export function attestationStands(a, { manifest, roundIdBytes, verify }) {
  if (!isAttested(manifest)) return { ok: false, why: 'that round\'s game is not attested: its result is a replayed run, not an attestation' };
  let digest;
  try { digest = attestationBodyId(a); } catch (e) { return { ok: false, why: `that attestation does not encode: ${e.message}` }; }
  if (!is32(roundIdBytes) || !same(a.roundId, roundIdBytes))
    return { ok: false, why: `that attestation is for round ${toHex(a.roundId).slice(0, 16)}, not this round ${is32(roundIdBytes) ? toHex(roundIdBytes).slice(0, 16) : ''}`.trim() };
  if (a.outcome >= manifest.outcomes.length)
    return { ok: false, why: `that attestation names outcome ${a.outcome}, out of range: game "${manifest.gameName}" has ${manifest.outcomes.length} outcomes (0 to ${manifest.outcomes.length - 1})` };
  if (typeof verify !== 'function') return { ok: false, why: 'no verifier to check the attestors\' signatures' };
  const named = new Set(manifest.attestors.map(toHex));
  const signed = new Set();
  for (const s of a.signatures || []) {
    const k = toHex(s.key);
    if (!named.has(k)) return { ok: false, why: `that attestation is signed by key ${k.slice(0, 16)}, which game "${manifest.gameName}" does not name as an attestor` };
    let good = false;
    try { good = verify(s.signature, digest, s.key) === true; } catch { good = false; }
    if (!good) return { ok: false, why: `attestor ${k.slice(0, 16)}'s signature on that attestation does not verify` };
    signed.add(k);
  }
  if (signed.size < manifest.attestThreshold)
    return { ok: false, why: `that attestation carries ${signed.size} attestor signature(s), and game "${manifest.gameName}" asks ${manifest.attestThreshold} of its ${manifest.attestors.length}` };
  return { ok: true, outcome: a.outcome, label: manifest.outcomes[a.outcome], signers: signed.size,
    why: `outcome ${a.outcome} "${manifest.outcomes[a.outcome]}", signed by ${signed.size} of ${manifest.attestors.length} attestors (threshold ${manifest.attestThreshold})` };
}

/**
 * THE PARI-MUTUEL TABLE (§0A.7a; the owner 2026-10-07): out of each entry's stake the fee and the donation as for any round
 * (§0A.8, kanban #205 - the entry's own feeMsat and donationMsat, already checked against the contract at the door), and
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
  if (!winners.length || winningNet === 0n) {
    // NOBODY BACKED IT: each net stake back to its own entry
    for (const r of rows) r.payoutMsat = r.netMsat;
    refunded = true;
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
export function outcomeStanding(held) {
  if (!held.length) return { state: 'OPEN' };
  const outcomes = [...new Set(held.map((a) => a.outcome))];
  if (outcomes.length === 1) return { state: 'ATTESTED', outcome: outcomes[0] };
  return { state: 'DISPUTED', outcomes, why: `two standing attestations name outcomes ${outcomes.join(' and ')}: the pair is proof the attestors contradicted themselves, and the round settles on neither` };
}
