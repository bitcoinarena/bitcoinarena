// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A CONTRADICTED AUDIT, FILED FOR SLASHING THROUGH THE SEAT (spec §13A.1, kanban #724, #725). The auditor's round of auditor-round.test.js
// (a protocol-22 paid round on one seat of seven, and a second daemon that is no seat of it and the one node that may audit it) and the
// re-run of slash-filing.test.js: five seats sign a rewritten score, and the auditor - lying, or never having replayed - signs an AUDIT over
// the agreed runs anyway, which the seat takes. An objection then holds, the committee re-runs, the run is FINAL on the re-run, and the seat
// files the first result's five signers AND the AUDIT: one AUDIT_CONTRADICTED proof (the AUDIT, its signature, its rows), listed for the
// arbitration set (GET /slashes `auditSlashes`), served (GET /audit-slash-proofs), kept by the round's relay under its id - and the
// arbiter's own judgement, the objection replayed again under the round's core, slashes it and builds path B on the auditor's bond.
// MEASURED BEFORE (ac313991): the AUDIT was marked contradicted and paid nothing; no proof against it was filed, none listed, none servable.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js';
import { sevenSignerNodes, object, opts, wait, b32, WINDOW_MS } from './window-fixture.js';
import { testNow, skipTo } from './test-clock.js';
import { CLOCK } from './block-clock.js';
import { assumeAssigned } from './assignment.js';
import { HOSTED } from './plugins/hosted.js';
import { AUDITOR_VERSION } from '../../arena-protocol/src/constants.js';
import { windowsOf } from '../../arena-protocol/src/window.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { beaconFromChain } from '../../arena-protocol/src/beacon.js';
import { makeVrf, SUITE_SECP256K1_TAI } from '../../arena-protocol/src/vrf.js';
import { vrfSecretFor, auditAlpha, encodeAudit, auditId } from '../../arena-protocol/src/auditor.js';
import { splitAuditSlashEvidence, cutAuditSlashEvidence, auditSlashProofId, slashHoldsOnAudit, AUDIT_CONTRADICTED } from '../../arena-protocol/src/slash.js';
import { decodeRoundContract } from '../../arena-protocol/src/contracts.js';
import { bondOutputKey, bondInternalKey } from '../../arena-protocol/src/bond-script.js';
import { resultFinality } from '../src/finality.js';
import { agreedRunsOf } from '../src/audit-seat.js';
import { arbitrationMembers, judgeAuditProof, buildSlash, memberSign, assemble, coreForRound } from '../src/arbiter.js';
import { tweakPoint, combine } from '../src/curve.js';
import { openStore } from '../src/store.js';
import { serve } from '../src/server.js';

const vrf = makeVrf({ Point: secp256k1.Point, suite: SUITE_SECP256K1_TAI });
const verify = (sig, m, k) => { try { return schnorr.verify(sig, m, k); } catch { return false; } };
const set = arbitrationMembers('regtest');

test('a contradicted AUDIT is filed by the seat as AUDIT_CONTRADICTED, listed, served, relayed, and the arbiter\'s replay slashes the auditor\'s bond', { timeout: 170000 }, async () => {
  const box = { key: null };
  const audit = { everyMs: 0, setFor: () => (box.key ? { eligible: new Map([[box.key, 1n]]), total: 1n } : null) };
  const w = await sevenSignerNodes(WINDOW_MS, undefined, { endMs: testNow() + 4000, storedBeforeTheRule: true, round: { protocolVersion: AUDITOR_VERSION },
    finality: { everyMs: 100, rerunMs: 30000 }, serveOpts: { audit } });
  const auditor = await serve(openStore(':memory:'), { plugins: HOSTED, port: 0, ...opts, stakeLocks: w.slot.port, chainFor: w.slot.chainFor,
    randomnessFor: w.slot.randomnessFor, claimKeyFor: () => new Uint8Array(33).fill(2), audit });
  try {
    auditor.round.chainView = CLOCK.chainView();
    box.key = toHex(auditor.round.pubkey);
    auditor.round.open(w.contract);
    assumeAssigned(auditor.round, w.rid, w.contract.nodes);
    // THE AUDITOR'S OWN ADVERTISEMENT, AS THE CENSUS GIVES IT: the bond a slash of it spends
    const advert = { nodePubkey: auditor.round.pubkey, bondTxid: b32(0xa7), bondVout: 7 };
    w.adverts.set(box.key, advert);

    w.sign('agrees', () => ({}));
    w.sign('dissents', (r) => ({ score: r.score + 1 }));          // five keys sign a run nobody played
    const eid = w.runs.dissents.eid;
    skipTo(Number(windowsOf(w.contract).openMs) + 1000);

    // THE LYING AUDIT: over the agreed runs - the false one included - signed by the auditor's own key, its VRF good, in time
    const committee = w.holder.round.signerNodes(w.rid);
    const entries = w.holder.round.entriesOf(w.rid).map((e) => ({ entryId: e.entryId, results: w.holder.round.results(w.rid, e.entryId).map((r) => r.bytes) }));
    const runs = agreedRunsOf({ contract: w.contract, committee, entries });
    assert.equal(runs.ok, true, runs.why);
    const a = { roundId: w.rid, resultsHash: runs.resultsHash, nodePubkey: auditor.round.pubkey, atMs: BigInt(w.holder.round.now()),
      vrfProof: vrf.prove(vrfSecretFor(auditor.round.identity.secret, secp256k1.Point), auditAlpha(w.rid)) };
    const posted = await fetch(`http://127.0.0.1:${w.holder.port}/audit`, { method: 'POST',
      body: new Uint8Array([...encodeAudit(a), ...schnorr.sign(auditId(a), auditor.round.identity.secret)]) });
    assert.equal(posted.status, 201, await posted.text());

    // THE OBJECTION HOLDS, THE COMMITTEE RE-RUNS, THE RUN IS FINAL ON THE RE-RUN
    assert.equal((await object(w, eid)).status, 201);
    let stop = Date.now() + 8000;
    while (Date.now() < stop && !w.holder.round.reruns(w.rid, eid).some((r) => toHex(r.signerNodePubkey) === toHex(w.holder.round.pubkey))) await wait(50);
    w.rerunBy('dissents', 4);
    const f = await w.finalNow('dissents');
    assert.equal(f.state, 'FINAL', f.why);
    stop = Date.now() + 10000;
    while (Date.now() < stop && !w.holder.round.auditSlashProofs(w.rid).length) await wait(100);

    // WHAT THE SEAT FILED
    const filed = w.holder.round.auditSlashProofs(w.rid);
    const got = filed.length ? splitAuditSlashEvidence(filed[0].bytes) : null;
    const standing = resultFinality(w.holder.round, w.rid, eid);
    const base = `http://127.0.0.1:${w.holder.port}`;
    const list = await (await fetch(`${base}/slashes`)).json();
    const served = new Uint8Array(await (await fetch(`${base}/audit-slash-proofs?round=${toHex(w.rid)}`)).arrayBuffer());
    const id = got ? toHex(auditSlashProofId(got.proof)) : '';
    const relayed = got ? await fetch(`${base}/slash/${id}`) : null;
    const relayedBytes = relayed && relayed.status === 200 ? new Uint8Array(await relayed.arrayBuffer()) : new Uint8Array(0);
    const audits = (await (await fetch(`${base}/audits?round=${toHex(w.rid)}`)).json()).audits;
    // A STRANGER'S OWN CHECK OF IT, from the round's public facts: the eligible set, the canonical transcript, the objected run
    const check = got && slashHoldsOnAudit({ proof: got.proof, audit: got.audit, signature: got.signature, rows: got.rows,
      entry: w.holder.round.entriesOf(w.rid).find((e) => toHex(e.entryId) === toHex(eid)).entry, advert, eligible: new Map([[box.key, 1n]]), total: 1n,
      vrf, verify, windowCloseMs: windowsOf(w.contract).closeMs, canonicalTranscriptHash: w.holder.round.canonicalTranscript(w.rid, eid).hash,
      objectedRunId: fromHex(standing.contradictedRunId), replayDiffers: true });
    const facts = {
      state: standing.state,
      auditMarked: audits.length === 1 && /agreed re-run/.test(String(audits[0].contradicted)),
      firstResultProofs: w.holder.round.slashProofs(w.rid, eid).length,
      auditProofs: filed.length,
      accused: got ? toHex(got.proof.nodePubkey) === box.key : false,
      namesTheEntryAndItsRun: got ? toHex(got.proof.entryId) === toHex(eid) && toHex(got.proof.contradictedRunId) === standing.contradictedRunId : false,
      carriesTheAudit: got ? toHex(got.audit) === toHex(encodeAudit(a)) : false,
      bondIsItsOwn: got ? toHex(got.proof.bondTxid) === toHex(advert.bondTxid) && got.proof.bondVout === 7 : false,
      slashes: !!(check && check.slashed && check.offence === AUDIT_CONTRADICTED),
      listed: (list.auditSlashes || []).map((s) => [s.node, s.entry, s.proof, s.objection]),
      oldListUnchanged: list.slashes.length === 5,
      served: cutAuditSlashEvidence(served).length === 1 && toHex(served) === toHex(filed[0] ? filed[0].bytes : []),
      relayKeeps: relayedBytes.length > 0 && toHex(relayedBytes) === toHex(filed[0].bytes),
    };
    console.log('  FACTS (contradicted AUDIT filed):', JSON.stringify({ ...facts, listed: facts.listed.length }));
    assert.deepEqual(facts, {
      state: 'FINAL', auditMarked: true, firstResultProofs: 5, auditProofs: 1, accused: true, namesTheEntryAndItsRun: true, carriesTheAudit: true,
      bondIsItsOwn: true, slashes: true, listed: [[box.key, toHex(eid), id, true]], oldListUnchanged: true, served: true, relayKeeps: true,
    });

    // FILED ONCE: the same contradiction again files nothing new
    assert.equal(w.holder.round.auditSlashProofs(w.rid).length, 1);

    // THE ARBITRATION SET'S JUDGEMENT, FROM THE SEAT'S DOORS: the objection replayed again under the round's core and beacon
    const bundle = new Uint8Array(await (await fetch(`${base}/objection-bundle?round=${toHex(w.rid)}&entry=${toHex(eid)}`)).arrayBuffer());
    const contract = decodeRoundContract(new Uint8Array(w.holder.round.get(w.rid).contract));
    const view = w.holder.roster.chainFor({ contract, roundIdBytes: w.rid });
    const beacon = beaconFromChain(contract, { headers: view.blocks.map((b) => b.header), firstHeight: view.firstHeight });
    assert.equal(beacon.ok, true, beacon.why);
    const entry = w.holder.round.entriesOf(w.rid).find((e) => toHex(e.entryId) === toHex(eid)).entry;
    const judged = (over = {}) => judgeAuditProof({ evidence: filed[0].bytes, bundle, entry, contract, committee, advert,
      bondOutpoint: { txid: advert.bondTxid, vout: advert.bondVout }, core: coreForRound(contract, w.rid, HOSTED), roundRandomness: beacon.hash,
      eligible: new Map([[box.key, 1n]]), total: 1n, vrf, ...over });
    const verdict = await judged();
    assert.equal(verdict.slashed, true, verdict.why);
    assert.equal(verdict.offence, AUDIT_CONTRADICTED);
    assert.equal(toHex(verdict.proofId), id);
    // AND REFUSED: the objection of another entry (the honest one has none: an empty bundle), a node outside the eligible set
    assert.match((await judged({ bundle: new Uint8Array(0) })).why, /no objection bundle/);
    assert.match((await judged({ eligible: new Map() })).why, /may not audit this round/);

    // PATH B ON THE AUDITOR'S BOND, SPLIT AS EVERY SLASH: the players' escrow (the contradicted entry's player), the nodes', the developers'
    const internalKey = bondInternalKey({ nodeKey: advert.nodePubkey, arbitrationKeys: set.keys }, { combine }).internalKey;
    const k = bondOutputKey({ nodeKey: advert.nodePubkey, arbitrationKeys: set.keys, arbitrationK: set.k, bondMaturity: 100, internalKey }, { tweakPoint, combine });
    const bond = { txid: advert.bondTxid, vout: advert.bondVout, value: 2_000_000n, script: Uint8Array.from([0x51, 0x20, ...k.outputKey]) };
    const censusNodes = [...[...w.adverts.values()].map((x) => x.nodePubkey), ...[1, 2, 3].map((i) => schnorr.getPublicKey(new Uint8Array(32).fill(0x40 + i)))];
    const slash = buildSlash({ verdict, bond, advert: { ...advert, bondScriptTemplateVersion: 1 }, contract, roundId: w.rid,
      slashHeight: contract.censusHeight + 10, tipHeight: contract.censusHeight + 12, censusNodes, seats: committee, set });
    assert.equal(slash.ok, true, slash.why);
    assert.deepEqual(slash.built.tx.outputs.slice(1).map((o) => o.pays), ['players\' escrow', 'nodes\'', 'developers\'']);
    assert.deepEqual([...slash.distribution.playerShares.keys()], [toHex(entry.playerPubkey)], 'the contradicted entry\'s player');
    const five = assemble({ slash, signatures: set.members.slice(0, 5).map((m) => ({ key: m.key, sig: memberSign(m, slash.sighash) })), set });
    assert.equal(five.ok, true, five.why);
  } finally { await auditor.close(); await w.close(); }
});
