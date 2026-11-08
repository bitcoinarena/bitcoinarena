// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A SEAT'S OWN WORD ON A PROOF (spec 5A.3B, RULED 2026-11-03, kanban #1065). A holder signs a start, and a node leaves a hold or stays, on this and on nothing a filer says. The arbiter's judges are the
// checks; this reads the complete proof, holds it to this seat's own census and chain, and answers three ways. `true` it holds. `false` it does not: the bytes are all there is to read, so a start on
// them really was false. `undefined` this seat cannot say yet, because it has no census there, no core or no beacon: a holder signs nothing and a node stays in its hold and waits.
//
// A replay costs a seat seconds and anyone can hand it bytes, so one proof is judged at a time, a verdict is kept by the hash, and a queue past `waiting` answers undefined.
import { namedClaims } from '../../arena-protocol/src/arena-lock.js';
import { decodeFraudProof, fraudProofHash, readEvidence } from '../../arena-protocol/src/slash.js';
import { decodeAbandonedProof, isAbandonedProof } from '../../arena-protocol/src/abandoned-slash.js';
import { decodeTheftProof, isTheftProof } from '../../arena-protocol/src/theft-slash.js';
import { decodeBoundProof, isBoundProof } from '../../arena-protocol/src/bound-slash.js';
import { splitSignedRecord } from '../../arena-protocol/src/federation-record.js';
import { decodeEntryContract, decodeRoundContract, entryId as entryIdOf, roundId as roundIdOf } from '../../arena-protocol/src/contracts.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { judgeAuditProof, judgeDoubleProof, judgeNamedClaimProof, judgeProof, judgeReleaseProof, judgeRerunProof, judgeTableProof } from './arbiter.js';
import { NAMED_ROW_OFF_TABLE, NAMED_ROW_PAYEE, NAMED_ROW_FORFEIT } from '../../arena-protocol/src/named-claim-proof.js';
import { decodeSettlementTable } from '../../arena-protocol/src/settlement-ack.js';
import { takesAnyFederation } from '../../arena-protocol/src/constants.js';

/**
 * `committeeOf(contract, rid)` -> { ok, committee[] of keys } or { ok: false, why }, its signer nodes; `censusOf(contract, rid)` -> { ok, entries } or { ok: false, why }; `coreOf(contract, rid)` the round's core, or
 * null where this seat does not host it; `beaconOf(contract, rid, entry, eid)` -> { ok, hash } or { ok: false, why }; `replayRunOf(rid, eid, core)` this seat's replay in its worker pool; `auditSetOf(contract, rid)` { eligible, total } who could audit the round, or null; `vrf` the secp256k1 ECVRF; `manifestOf(contract)` the round's game's manifest, or null; `clientOf(fid hex)` -> { fees(), txid(build) } this seat's own client of a federation, or null; `panelsOf(contract, rid)` -> { ok, panelA, panelB } of keys or { ok: false, why }; `holdBlocksOf(contract)`; `abandoned(bytes, beforeHeight)` -> { verdict, why } this seat's word on an abandonment's proof (federation-records.js abandonedVerdict); `theft(bytes, beforeHeight)` the same on a theft's proof (theftVerdict, kanban #1093 part 2); `claimRead(input)` the stake-lock tool's arena-claim-read over a named claim's sessions (offline), or null where none runs here (kanban #1044 B1); `lostForfeitOf(contract, rid, eid)` -> { allowed: true | false | null, why } whether a forfeit of that entry is one the protocol allows, by this seat's own record (forfeit.js lostForfeitAllowed, kanban #1044 row (b)); `bodyOf(input, build)` its arena-body, a level-1 proof (a)'s correct body rebuilt offline from the same sessions (stake-lock-port.js readBody), or null where none runs here; `payeesOf(contract, rid)` -> { nodeKeys, donationKeys, reserveKeys } who the round may pay (named-claim-payees.js), or null; `entriesOf(rid)` the round's Entry Contracts this seat holds, or null.
 * Answers `judge(bytes)` -> { verdict, why }, and `judge.read(bytes)`, the cheap part, with no replay: { ok, kind, bond: { txid, vout }, roundId, contract, floorHeight, nodePubkey } or { ok: false, why }.
 */
export function createProofJudge({ committeeOf, censusOf, coreOf, coreFetch = async () => null, manifestFetch = async () => null, recordClientOf = async () => null, beaconOf, replayRunOf, auditSetOf = () => null, vrf = null, manifestOf = () => null, clientOf = async () => null, panelsOf = () => ({ ok: false, why: 'no panels here' }), holdBlocksOf = () => null, abandoned = async () => ({ verdict: undefined, why: 'this seat reads no federation records' }), theft = async () => ({ verdict: undefined, why: 'this seat audits no federation' }), bound = async () => ({ verdict: undefined, why: 'this seat reads no federation records' }), claimRead = async () => null, bodyOf = async () => null, lostForfeitOf = () => ({ allowed: null, why: 'this seat reads no forfeit record' }), payeesOf = async () => null, entriesOf = () => null, waiting = 32, kept = 256 }) {
  /** Everything that needs no chain: the bytes read as a proof, and the contract in them is the round the proof names. */
  function read(bytes) {
    if (isAbandonedProof(bytes)) {
      try { const p = decodeAbandonedProof(bytes); return { ok: true, kind: 'abandoned', roundId: null, contract: null, federationId: p.federationId, nodePubkey: p.nodePubkey, bond: { txid: p.txid, vout: p.vout }, floorHeight: splitSignedRecord(p.record).record.height }; }
      catch (e) { return { ok: false, why: `those bytes are no proof: ${e.message}` }; }
    }
    // A COPY ABOVE THE HALT'S BOUND (kanban #1269): no round either; the guardian's bond output, the record's height the floor
    if (isBoundProof(bytes)) {
      try { const p = decodeBoundProof(bytes); return { ok: true, kind: 'bound', roundId: null, contract: null, nodePubkey: p.nodePubkey, bond: { txid: p.txid, vout: p.vout }, floorHeight: splitSignedRecord(p.record).record.height }; }
      catch (e) { return { ok: false, why: `those bytes are no proof: ${e.message}` }; }
    }
    // A THEFT (kanban #1093 part 2): no round either; the guardian's bond output, and the record's height is the floor a start's slash height stands on
    if (isTheftProof(bytes)) {
      try { const p = decodeTheftProof(bytes); return { ok: true, kind: 'theft', roundId: null, contract: null, nodePubkey: p.nodePubkey, bond: { txid: p.txid, vout: p.vout }, floorHeight: splitSignedRecord(p.record).record.height, federationId: p.federationId, mark: p.mark }; }
      catch (e) { return { ok: false, why: `those bytes are no proof: ${e.message}` }; }
    }
    let complete, got, contract;
    try { complete = decodeFraudProof(bytes); got = readEvidence(complete.evidence); } catch (e) { return { ok: false, why: `those bytes are no proof: ${e.message}` }; }
    try { contract = decodeRoundContract(complete.contract); } catch (e) { return { ok: false, why: `the proof holds no contract: ${e.message}` }; }
    if (toHex(roundIdOf(contract)) !== toHex(got.proof.roundId)) return { ok: false, why: 'the contract in that proof is not the round it names' };
    return { ok: true, kind: got.kind, complete, got, contract, roundId: got.proof.roundId, nodePubkey: got.proof.nodePubkey, bond: { txid: got.proof.bondTxid, vout: got.proof.bondVout }, floorHeight: contract.censusHeight };
  }

  /** A replay's or an AUDIT's: the entry in the proof, and the core and the beacon it runs under. */
  // A HOLDER JUDGES WHETHER OR NOT IT HOSTS THE GAME (§5A.3B RULED 2026-11-07, kanban #1303/#1326): the core by the proof's sim_wasm_hash, fetched
  // from a seat that hosts it and checked (`coreFetch`), and a read-only federation client from the public FederationRecord (`recordClientOf`);
  // "does not host the game" is no reason to sign nothing
  async function replayInputs(r) {
    let entry;
    try { entry = decodeEntryContract(r.complete.entry); } catch (e) { return { verdict: false, why: `the proof holds no entry: ${e.message}` }; }
    const eid = entryIdOf(entry);
    let core = coreOf(r.contract, r.roundId);
    if (!core) { try { core = await coreFetch(r.contract, r.roundId); } catch { core = null; } }
    if (!core) return { verdict: undefined, why: 'this seat could not fetch that round\'s core by its sim_wasm_hash from any seat that hosts it' };
    const beacon = beaconOf(r.contract, r.roundId, entry, eid);
    if (!beacon.ok) return { verdict: undefined, why: `no beacon to replay under: ${beacon.why}` };
    return { entry, eid, core, roundRandomness: beacon.hash, replayRun: replayRunOf(r.roundId, eid, core) };
  }

  const manifestFor = async (contract) => { const m = manifestOf(contract); if (m) return m; try { return (await manifestFetch(contract)) || null; } catch { return null; } };
  const clientFor = async (fid) => { const c = await clientOf(fid); if (c) return c; try { return (await recordClientOf(fid)) || null; } catch { return null; } };
  async function fresh(bytes, depth = 0) {
    const r = read(bytes);
    if (!r.ok) return { verdict: false, why: r.why };
    const seats = committeeOf(r.contract, r.roundId);
    if (!seats.ok) return { verdict: undefined, why: `that round's committee cannot be read yet: ${seats.why}` };
    const census = censusOf(r.contract, r.roundId);
    if (!census.ok) return { verdict: undefined, why: `that round's census cannot be read yet: ${census.why}` };
    const e = census.entries.find((x) => toHex(x.pubkey) === toHex(r.nodePubkey) && toHex(x.txid) === toHex(r.bond.txid) && x.vout === r.bond.vout) || null;
    // the advert with its bond as the census holds it: a bond transaction's own advert names its txid as zeros ("this transaction"), kanban #972
    const on = { committee: seats.committee, advert: e ? { ...e.advert, nodePubkey: e.pubkey, bondTxid: e.txid, bondVout: e.vout } : null, bondOutpoint: e ? { txid: e.txid, vout: e.vout } : null };
    const { evidence, bundle } = r.complete;
    let held;
    if (r.kind === 'double') held = judgeDoubleProof({ evidence, roundIdBytes: r.roundId, ...on });
    else if (r.kind === 'result' || r.kind === 'rerun') {
      const inputs = await replayInputs(r);
      if (inputs.verdict !== undefined || !inputs.entry) return inputs;
      const given = { evidence, bundle, entry: inputs.entry, entryId: inputs.eid, contract: r.contract, core: inputs.core, roundRandomness: inputs.roundRandomness, replayRun: inputs.replayRun, ...on };
      held = await (r.kind === 'rerun' ? judgeRerunProof(given) : judgeProof(given));
    } else if (r.kind === 'audit') {
      const inputs = await replayInputs(r);
      if (inputs.verdict !== undefined || !inputs.entry) return inputs;
      if (toHex(inputs.eid) !== toHex(r.got.proof.entryId)) return { verdict: false, why: 'the entry in that proof is not the one it names' };
      const set = auditSetOf(r.contract, r.roundId);
      if (!set) return { verdict: undefined, why: 'this seat cannot read who could audit that round yet' };
      held = await judgeAuditProof({ evidence, bundle, entry: inputs.entry, contract: r.contract, core: inputs.core, roundRandomness: inputs.roundRandomness, replayRun: inputs.replayRun, eligible: set.eligible, total: set.total, vrf, ...on });
    } else if (r.kind === 'table') {
      // ITS OWN CLIENT, ITS OWN FEE RULE AND ITS OWN HASH: no seat's word enters, and a seat with no client of a federation the table names cannot say
      const manifest = await manifestFor(r.contract);
      if (!manifest) return { verdict: undefined, why: 'this seat could not fetch that round\'s game manifest from any seat that hosts it' };
      let table; try { table = decodeSettlementTable(r.got.table); } catch (e) { return { verdict: false, why: `not a proof of a false table: ${e.message}` }; }
      const any = takesAnyFederation(r.contract);
      const named = any ? [...r.got.entries, ...r.got.finals.map((f) => f.entry)].map((x) => toHex(x.federationId || new Uint8Array(32))) : [toHex(r.contract.federationId)];
      const home = any ? toHex(table.federationId) : toHex(r.contract.federationId), fees = new Map();
      for (const fid of new Set([...named, home])) {
        const client = await clientFor(fid);
        if (!client) return { verdict: undefined, why: `this seat holds no client of federation ${fid.slice(0, 16)} and could not read one from its record` };
        fees.set(fid, await client.fees());
      }
      const hashing = await clientFor(home);
      held = await judgeTableProof({ evidence, roundIdBytes: r.roundId, contract: r.contract, manifest, feesOf: (fid) => fees.get(fid) || null, txidOf: (_t, build) => (namedClaims(r.contract) ? hashing.bodyId(build) : hashing.txid(build)), ...on });
    } else if (r.kind === 'named') {
      // A NAMED CLAIM (§5A.3 rows (a), (b), kanban #1044 B1): the sessions replayed offline by this seat's own tool; row (a)'s correct body rebuilt by the same tool, offline and without signers
      const manifest = await manifestFor(r.contract);
      // ROW (a) AT LEVEL 1 (measured 2026-11-05, round a8e68cb6): a proof exists only once its claim spent the round's locks, so its correct body is not
      // rebuilt through the guardians ("the guardians hold no Arena lock") but offline by `bodyOf`, from the lock contracts the proof's own sessions funded
      if (r.got.row === NAMED_ROW_OFF_TABLE && !manifest) return { verdict: undefined, why: 'this seat could not fetch that round\'s game manifest from any seat that hosts it' };
      let table = null;
      if (r.got.row === NAMED_ROW_OFF_TABLE) { try { table = decodeSettlementTable(r.got.table); } catch (e) { return { verdict: false, why: `not a proof of a named claim: ${e.message}` }; } }
      const fees = new Map();
      if (table) {
        const any = takesAnyFederation(r.contract);
        const named = any ? [...r.got.entries, ...r.got.finals.map((f) => f.entry)].map((x) => toHex(x.federationId || new Uint8Array(32))) : [toHex(r.contract.federationId)];
        const home = table.federationId.some((x) => x) ? toHex(table.federationId) : toHex(r.contract.federationId);
        for (const fid of new Set([...named, home])) {
          const client = await clientOf(fid);
          if (!client) return { verdict: undefined, why: `this seat holds no client of federation ${fid.slice(0, 16)}` };
          fees.set(fid, await client.fees());
        }
      }
      // LEVEL 2 (rulings #1138 2, #1140): who the round may pay, from this seat's own bytes, and the entries it holds of the round
      const level2 = r.got.row === NAMED_ROW_PAYEE ? { payees: await payeesOf(r.contract, r.roundId), ownEntries: entriesOf(r.roundId) } : {};
      // ROW (b): this seat's own reading of whether that forfeit is one the protocol allows (forfeit.js lostForfeitAllowed) - an allowed one is false, never a slash
      if (r.got.row === NAMED_ROW_FORFEIT) { try { level2.forfeitAllowed = lostForfeitOf(r.contract, r.roundId, entryIdOf(r.got.entry)); } catch (e) { return { verdict: false, why: `the entry does not encode: ${e.message}` }; } }
      const named = await judgeNamedClaimProof({ evidence, roundIdBytes: r.roundId, contract: r.contract, manifest, claimRead, feesOf: (fid) => fees.get(fid) || null, ...level2,
        bodyOf, ...on });
      if (named.slashed === undefined) return { verdict: undefined, why: named.why };
      held = named;
    } else if (r.kind === 'release') {
      // THE BYTES IT COMMITTED TO ARE JUDGED AS ANY PROOF, on this seat's own word, and a release on bytes this seat cannot say about slashes nobody yet
      const panels = panelsOf(r.contract, r.roundId);
      if (!panels.ok) return { verdict: undefined, why: `that round's panels cannot be read yet: ${panels.why}` };
      let proofChecks;
      if (r.got.fraudProof.length && !r.got.table.length) {
        if (depth > 0) return { verdict: undefined, why: 'a release on a proof against a release is not read further' };
        const nested = await fresh(r.got.fraudProof, depth + 1);
        if (nested.verdict === undefined) return { verdict: undefined, why: `the proof that release committed to cannot be judged yet: ${nested.why}` };
        proofChecks = nested.verdict;
      }
      held = judgeReleaseProof({ evidence, panels, holdBlocks: holdBlocksOf(r.contract), proofChecks, advert: on.advert, bondOutpoint: on.bondOutpoint });
    } else return { verdict: undefined, why: 'this seat cannot judge that kind of proof yet' };
    // AND WHAT IT HELD: the offence, the player and the runs, which a release's table reads its losses from (slash-release-run.js)
    return { verdict: !!held.slashed, why: held.why, ...(held.slashed ? { held } : {}) };
  }

  const verdicts = new Map();
  // ONE PROOF IS ONE PLACE IN THE QUEUE (kanban #1187): every holder's commit reaches this judge, and the same bytes asked again while their replay runs wait on that replay
  // instead of taking another place, so a filer repeating one request cannot fill the queue and leave an honest start's proof answered undefined
  const judging = new Map();
  let tail = Promise.resolve(), queued = 0;
  async function judge(bytes, { startHeight = null } = {}) {
    // AN ABANDONMENT IS READ OFF THE CHAIN AS IT STANDS: no replay, and its answer moves with the output, so it is kept nowhere
    if (isAbandonedProof(bytes)) return abandoned(bytes, startHeight === null ? null : startHeight - 1);
    // A THEFT LIKEWISE: this seat's own alarm book and its own chain, kept nowhere
    if (isTheftProof(bytes)) return theft(bytes, startHeight === null ? null : startHeight - 1);
    // A COPY ABOVE THE HALT'S BOUND (kanban #1269) likewise: the copy, the halt observations and this seat's census and chain
    if (isBoundProof(bytes)) return bound(bytes, startHeight === null ? null : startHeight - 1);
    const id = toHex(fraudProofHash(bytes)), had = verdicts.get(id);
    if (had) return had;
    if (judging.has(id)) return judging.get(id);
    if (queued >= waiting) return { verdict: undefined, why: 'this seat has too many proofs to judge just now' };
    queued += 1;
    const turn = tail.then(() => verdicts.get(id) || fresh(bytes));
    tail = turn.catch(() => null);
    const answer = (async () => {
      try {
        const got = await turn;
        if (got.verdict !== undefined) { verdicts.set(id, got); if (verdicts.size > kept) verdicts.delete(verdicts.keys().next().value); }
        return got;
      } catch (e) { return { verdict: undefined, why: e.message }; } finally { queued -= 1; judging.delete(id); }
    })();
    judging.set(id, answer);
    return answer;
  }
  judge.queued = () => queued;
  judge.read = read;
  return judge;
}
