// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A SEAT'S OWN WORD ON A PROOF (spec 5A.3B, RULED 2026-11-03, kanban #1065). A holder signs a start, and a node leaves a hold or stays, on this and on nothing a filer says. The arbiter's judges are the
// checks; this reads the complete proof, holds it to this seat's own census and chain, and answers three ways. `true` it holds. `false` it does not: the bytes are all there is to read, so a start on
// them really was false. `undefined` this seat cannot say yet, because it has no census there, no core or no beacon: a holder signs nothing and a node stays in its hold and waits.
//
// A replay costs a seat seconds and anyone can hand it bytes, so one proof is judged at a time, a verdict is kept by the hash, and a queue past `waiting` answers undefined.
import { decodeFraudProof, fraudProofHash, readEvidence } from '../../arena-protocol/src/slash.js';
import { decodeEntryContract, decodeRoundContract, entryId as entryIdOf, roundId as roundIdOf } from '../../arena-protocol/src/contracts.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { judgeDoubleProof, judgeProof, judgeRerunProof } from './arbiter.js';

/**
 * `committeeOf(contract, rid)` -> { ok, committee[] of keys } or { ok: false, why }, its signer nodes; `censusOf(contract, rid)` -> { ok, entries } or { ok: false, why }; `coreOf(contract, rid)` the round's core, or
 * null where this seat does not host it; `beaconOf(contract, rid, entry, eid)` -> { ok, hash } or { ok: false, why }; `replayRunOf(rid, eid, core)` this seat's replay in its worker pool.
 * Answers `judge(bytes)` -> { verdict, why }, and `judge.read(bytes)`, the cheap part, with no replay: { ok, kind, bond: { txid, vout }, roundId, contract, floorHeight, nodePubkey } or { ok: false, why }.
 */
export function createProofJudge({ committeeOf, censusOf, coreOf, beaconOf, replayRunOf, waiting = 32, kept = 256 }) {
  /** Everything that needs no chain: the bytes read as a proof, and the contract in them is the round the proof names. */
  function read(bytes) {
    let complete, got, contract;
    try { complete = decodeFraudProof(bytes); got = readEvidence(complete.evidence); } catch (e) { return { ok: false, why: `those bytes are no proof: ${e.message}` }; }
    try { contract = decodeRoundContract(complete.contract); } catch (e) { return { ok: false, why: `the proof holds no contract: ${e.message}` }; }
    if (toHex(roundIdOf(contract)) !== toHex(got.proof.roundId)) return { ok: false, why: 'the contract in that proof is not the round it names' };
    return { ok: true, kind: got.kind, complete, got, contract, roundId: got.proof.roundId, nodePubkey: got.proof.nodePubkey, bond: { txid: got.proof.bondTxid, vout: got.proof.bondVout }, floorHeight: contract.censusHeight };
  }

  /** A replay's or an AUDIT's: the entry in the proof, and the core and the beacon it runs under. */
  function replayInputs(r) {
    let entry;
    try { entry = decodeEntryContract(r.complete.entry); } catch (e) { return { verdict: false, why: `the proof holds no entry: ${e.message}` }; }
    const eid = entryIdOf(entry), core = coreOf(r.contract, r.roundId);
    if (!core) return { verdict: undefined, why: 'this seat does not host that round\'s game' };
    const beacon = beaconOf(r.contract, r.roundId, entry, eid);
    if (!beacon.ok) return { verdict: undefined, why: `no beacon to replay under: ${beacon.why}` };
    return { entry, eid, core, roundRandomness: beacon.hash, replayRun: replayRunOf(r.roundId, eid, core) };
  }

  async function fresh(bytes) {
    const r = read(bytes);
    if (!r.ok) return { verdict: false, why: r.why };
    const seats = committeeOf(r.contract, r.roundId);
    if (!seats.ok) return { verdict: undefined, why: `that round's committee cannot be read yet: ${seats.why}` };
    const census = censusOf(r.contract, r.roundId);
    if (!census.ok) return { verdict: undefined, why: `that round's census cannot be read yet: ${census.why}` };
    const e = census.entries.find((x) => toHex(x.pubkey) === toHex(r.nodePubkey) && toHex(x.txid) === toHex(r.bond.txid) && x.vout === r.bond.vout) || null;
    const on = { committee: seats.committee, advert: e ? { ...e.advert, nodePubkey: e.pubkey } : null, bondOutpoint: e ? { txid: e.txid, vout: e.vout } : null };
    const { evidence, bundle } = r.complete;
    let held;
    if (r.kind === 'double') held = judgeDoubleProof({ evidence, roundIdBytes: r.roundId, ...on });
    else if (r.kind === 'result' || r.kind === 'rerun') {
      const inputs = replayInputs(r);
      if (inputs.verdict !== undefined || !inputs.entry) return inputs;
      const given = { evidence, bundle, entry: inputs.entry, entryId: inputs.eid, contract: r.contract, core: inputs.core, roundRandomness: inputs.roundRandomness, replayRun: inputs.replayRun, ...on };
      held = await (r.kind === 'rerun' ? judgeRerunProof(given) : judgeProof(given));
    } else return { verdict: undefined, why: 'this seat cannot judge that kind of proof yet' };
    return { verdict: !!held.slashed, why: held.why };
  }

  const verdicts = new Map();
  let tail = Promise.resolve(), queued = 0;
  async function judge(bytes) {
    const id = toHex(fraudProofHash(bytes)), had = verdicts.get(id);
    if (had) return had;
    if (queued >= waiting) return { verdict: undefined, why: 'this seat has too many proofs to judge just now' };
    queued += 1;
    const turn = tail.then(() => verdicts.get(id) || fresh(bytes));
    tail = turn.catch(() => null);
    try {
      const got = await turn;
      if (got.verdict !== undefined) { verdicts.set(id, got); if (verdicts.size > kept) verdicts.delete(verdicts.keys().next().value); }
      return got;
    } catch (e) { return { verdict: undefined, why: e.message }; } finally { queued -= 1; }
  }
  judge.read = read;
  return judge;
}
