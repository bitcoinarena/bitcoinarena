#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE ARBITRATION SET'S SERVICE (spec 5A.3B steps 1-5): unit arena-arbiter-<network>.
//
// Every ARENA_ARBITER_EVERY_MS (60 s) it asks each seat named in ARENA_ARBITER_SEATS for the slash proofs it filed (GET
// /slashes) and, for each one not handled yet:
//   - takes its evidence (GET /slash-proofs), the objection that held (GET /objection-bundle), the round (GET /round) and
//     the entry (GET /entry) - from the seat, believed for nothing;
//   - reads its own chain (its bitcoind): the round's beacon off the headers, the round's census and its committee
//     (deriveCensus + selectCommittee as a seat does, the census checked against the round's census_root), and the
//     accused's bond output itself;
//   - judges the proof (arbiter.js judgeProof: the objection REPLAYED here under the round's core), builds path B at
//     slash_height = the tip, has 5 of its 7 members sign on their own, and posts it only after testmempoolaccept;
//   - pays it (§5A.3, rule v2): the proofs in ascending proof id, each loss once, the rest to the protocol reserves of the
//     federations with room, read from the seats (GET /federations, GET /reserves): what more than half of them say.
// A proof against a contradicted AUDIT (kanban #724, #725; GET /slashes `auditSlashes`, its record at GET /audit-slash-proofs) is judged
// the same way by arbiter.js judgeAuditProof - the objection replayed here, the AUDIT's signature and VRF draw checked against the round's
// census less its drawn nodes and its players (GET /audit-run) - and paid as every slash.
// The members' keys are the test network's derivable ones (genesis-ids.js); mainnet has no set and this refuses it.
// A proof of two results (5A.3 row 1, kanban #986; GET /slashes `doubleSlashes`, its record at GET /double-slash-proofs) is judged by arbiter.js
// judgeDoubleProof: both signatures, one run, the accused's committee seat and bond. Nothing is replayed, so it asks for no objection and no core.
// Its doors (POST /musig/nonce, /musig/partial, GET /status) serve the cooperative key path: it agrees to a release
// only for a node no handled or open proof accuses.
// After each pass it publishes every liquidation and posted slash it keeps as a signed event (kanban #723, arbitration-events.js) to
// every seat of ARENA_ARBITER_SEATS and ARENA_ARBITER_PUBLISH (POST /liquidations/events), for the explorer to read from any seat.
//
//   ARENA_ARBITER_NETWORK=testnet4 ARENA_ARBITER_SEATS=https://seat-a,... ARENA_BITCOIND_URL=... ARENA_BITCOIND_COOKIE=...
//   ARENA_ARBITER_PORT=31290 ARENA_ARBITER_STATE=<file> node tools/arbiter.mjs [--once]
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js';
import { bitcoindRpc, blocksOver, blockCache } from '../src/chain-rpc.js';
import { arbitrationMembers, judgeProof, judgeAuditProof, judgeDoubleProof, buildSlash, settledEntries, memberSign, assemble, post, coreForRound, serveArbiter, payOutSlash, buildEscrowPegin } from '../src/arbiter.js';
import { createLiquidationClaims, payOutLiquidation } from '../src/liquidation-claims.js';
import { liquidationEvent, slashEvent, stampEvent, signEvent, eventKey } from '../src/arbitration-events.js';
import { fedimintNoteValidator } from '../src/note-validate.js';
import { decodeSpentSet, spentNonceSet } from '../../arena-protocol/src/spent-set.js';
import { clocksFor } from '../../arena-protocol/src/federation-slash.js';
import { windowsOf } from '../../arena-protocol/src/window.js';

import { bondSetFor } from '../src/curve.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { decodeRoundContract, decodeEntryContract } from '../../arena-protocol/src/contracts.js';
import { splitSlashEvidence, cutSlashEvidence, splitAuditSlashEvidence, cutAuditSlashEvidence, auditSlashProofId, splitDoubleSlashEvidence, cutDoubleSlashEvidence, slashProofId } from '../../arena-protocol/src/slash.js';
import { auditEligible } from '../../arena-protocol/src/auditor.js';
import { makeVrf, SUITE_SECP256K1_TAI } from '../../arena-protocol/src/vrf.js';
import { decodePlayerResult, splitSignedResult } from '../../arena-protocol/src/result.js';
import { runId } from '../src/verdict.js';
import { payoutRuleOfRound } from '../src/plugins.js';
import { deriveCensus } from '../../arena-protocol/src/census.js';
import { beaconFromChain, committeeSeedFromBeacon } from '../../arena-protocol/src/beacon.js';
import { selectCommittee } from '../../arena-protocol/src/sortition.js';
import { parseTransaction } from '../../arena-protocol/src/tx.js';

const env = process.env;
const network = env.ARENA_ARBITER_NETWORK || 'regtest';
const set = arbitrationMembers(network);
const seats = String(env.ARENA_ARBITER_SEATS || '').split(',').map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean);
const rpc = bitcoindRpc({ url: env.ARENA_BITCOIND_URL, cookiePath: env.ARENA_BITCOIND_COOKIE });
const statePath = env.ARENA_ARBITER_STATE || null;
const state = statePath && existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : { handled: {} };
const keep = () => { if (statePath) writeFileSync(statePath, JSON.stringify(state, null, 1)); };
const say = (o) => console.log(`[arbiter] ${JSON.stringify(o)}`);
const cache = blockCache();
// THE AUDITORS' VRF (§13A.1): a proof against a contradicted AUDIT is judged on the AUDIT's own VRF proof (kanban #724, #725)
const auditVrf = makeVrf({ Point: secp256k1.Point, suite: SUITE_SECP256K1_TAI });
const LOOKBACK = Number(env.ARENA_ARBITER_LOOKBACK || 2100);

const get = async (url, as = 'json') => { const r = await fetch(url, { signal: AbortSignal.timeout(20000) }); if (!r.ok) throw new Error(`${url} answered ${r.status}`); return as === 'json' ? r.json() : new Uint8Array(await r.arrayBuffer()); };

/** The census of a round's contract at `height`, from this arbiter's own blocks, with its entries' adverts. */
async function censusAt(contract, height) {
  const tip = Number(await rpc('getblockcount'));
  const view = await blocksOver(rpc, Math.max(0, height - LOOKBACK), Math.min(tip, height), { cache });
  const byTxid = new Map();
  for (const b of view.blocks) for (const raw of b.transactions || []) { try { byTxid.set(toHex(parseTransaction(raw).txid), raw); } catch { /* */ } }
  const c = deriveCensus(view, { contract: { ...contract, censusHeight: height }, bond: bondSetFor(network),
    resolve: (e) => { const raw = byTxid.get(toHex(e.txid)); return raw ? { transaction: raw } : null; },
    verifyUpdate: (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } } });
  return { ...c, tip, view };
}

async function handle(seat, s) {
  const rid = fromHex(s.round), eid = fromHex(s.entry);
  // A PROOF AGAINST A CONTRADICTED AUDIT (kanban #724, #725): its own record (GET /audit-slash-proofs), judged by judgeAuditProof
  const audit = s.kind === 'audit';
  // A PROOF OF TWO RESULTS (kanban #986): its own record (GET /double-slash-proofs), judged by judgeDoubleProof on the signatures alone
  const double = s.kind === 'double';
  const recs = await get(double ? `${seat}/double-slash-proofs?round=${s.round}` : audit ? `${seat}/audit-slash-proofs?round=${s.round}` : `${seat}/slash-proofs?round=${s.round}&entry=${s.entry}`, 'bytes');
  let evidence = null;
  if (double) {
    for (const r of cutDoubleSlashEvidence(recs)) { let sp; try { sp = splitDoubleSlashEvidence(r); } catch { continue; } if (toHex(sp.proof.nodePubkey) === s.node && toHex(slashProofId(sp.proof)) === s.proof) evidence = r; }
  } else if (audit) {
    for (const r of cutAuditSlashEvidence(recs)) { let sp; try { sp = splitAuditSlashEvidence(r); } catch { continue; } if (toHex(sp.proof.nodePubkey) === s.node && toHex(auditSlashProofId(sp.proof)) === s.proof) evidence = r; }
  } else {
    for (const r of cutSlashEvidence(recs)) { let sp; try { sp = splitSlashEvidence(r); } catch { continue; } if (toHex(sp.proof.nodePubkey) === s.node) evidence = r; }
  }
  if (!evidence) return { done: false, why: 'the seat lists that proof and does not hand it over' };
  const bundle = double ? null : await get(`${seat}/objection-bundle?round=${s.round}&entry=${s.entry}`, 'bytes');
  const contract = decodeRoundContract(await get(`${seat}/round?id=${s.round}`, 'bytes'));
  const entry = decodeEntryContract(await get(`${seat}/entry?id=${s.entry}`, 'bytes'));
  // THE ROUND'S CENSUS AND COMMITTEE, FROM THIS ARBITER'S OWN CHAIN
  const census = await censusAt(contract, contract.censusHeight);
  if (!census.ok) return { done: false, why: `no census: ${census.why}` };
  if (toHex(census.root) !== toHex(contract.censusRoot)) return { done: true, why: 'the round names another census root than the chain gives: not this set\'s to slash on' };
  const headers = { headers: census.view.blocks.map((b) => b.header), firstHeight: census.view.firstHeight };
  const tipView = await blocksOver(rpc, Math.max(0, census.tip - LOOKBACK), census.tip, { cache });
  const beacon = beaconFromChain(contract, { headers: tipView.blocks.map((b) => b.header), firstHeight: tipView.firstHeight });
  if (!beacon.ok) return { done: false, why: `no beacon: ${beacon.why}` };
  const seeded = committeeSeedFromBeacon(contract, { roundId: rid, randomness: beacon.hash, height: beacon.height, timeMs: beacon.timeMs });
  if (!seeded.ok) return { done: false, why: seeded.why };
  const committee = [...new Map([...selectCommittee({ entries: census.entries, contract, role: 'game', committeeSeed: seeded.seed }),
    ...selectCommittee({ entries: census.entries, contract, role: 'settlement', committeeSeed: seeded.seed })].map((e) => [toHex(e.pubkey), e.pubkey])).values()];
  const accused = census.entries.find((e) => toHex(e.pubkey) === s.node);
  if (!accused) return { done: true, why: 'the accused is not in the round\'s census' };
  const core = double ? null : coreForRound(contract, rid, (await import('../src/plugins.js')).hostedPlugins((await loadApps())));
  // THE ROUND'S ENTRIES AND RESULTS, OFF THE SEAT'S GET /audit-run, checked against their own entry ids: a slash pays whoever the
  // false result harmed, and that takes the whole field (kanban #975)
  const run = await get(`${seat}/audit-run?round=${s.round}`);
  // AS THE ROUND SETTLED (§5A.3's real loss): each entry's run off the signatures
  const entries = settledEntries({ run, roundId: rid, contract, committee, finalAfterMs: windowsOf(contract).finalAfterMs });
  const playerKeys = new Set(entries.map((e) => toHex(e.playerPubkey)));
  let verdict;
  if (double) {
    verdict = judgeDoubleProof({ evidence, roundIdBytes: rid, committee, advert: accused.advert, bondOutpoint: { txid: accused.txid, vout: accused.vout } });
  } else if (audit) {
    // WHO COULD AUDIT THE ROUND, FROM THIS ARBITER'S OWN CENSUS (§13A.1): its census less every node drawn for its roles; its players'
    // keys out of the eligible set and still in W, as a seat's door takes them
    const set = auditEligible({ entries: census.entries, bondMinSats: BigInt(contract.bondMinSats || 50000n), drawn: committee.map(toHex) });
    const eligible = new Map([...set.eligible].filter(([key]) => !playerKeys.has(key)));
    verdict = await judgeAuditProof({ evidence, bundle, entry, contract, committee, advert: accused.advert,
      bondOutpoint: { txid: accused.txid, vout: accused.vout }, core, roundRandomness: beacon.hash, eligible, total: set.total, vrf: auditVrf });
  } else {
    verdict = await judgeProof({ evidence, bundle, entry, entryId: eid, contract, committee, advert: accused.advert,
      bondOutpoint: { txid: accused.txid, vout: accused.vout }, core, roundRandomness: beacon.hash });
  }
  if (!verdict.slashed) return { done: true, why: `not slashed: ${verdict.why}` };
  // THE BOND AS THE CHAIN HOLDS IT NOW
  const out = await rpc('gettxout', [toHex([...accused.txid].reverse()), accused.vout, false]);
  if (!out) return { done: true, why: 'the bond is spent already' };
  const bond = { txid: accused.txid, vout: accused.vout, value: BigInt(Math.round(out.value * 1e8)), script: fromHex(out.scriptPubKey.hex) };
  // AN AUDIT'S PROOF NAMES A RUN, NOT A SIGNED RESULT: that run's outcome and score come off the seat's results for the entry
  let signed = verdict.signed;
  if (audit) {
    for (const r of (run.entries || []).find((e) => e.id === s.entry)?.results || []) {
      try { const b = decodePlayerResult(splitSignedResult(fromHex(r)).body); if (toHex(runId(b)) === toHex(verdict.proof.contradictedRunId)) signed = { outcome: b.outcome, score: b.score }; } catch { /* not a result */ }
    }
  }
  // ONE LOSS, ONCE (§5A.3): what the earlier proofs of this round paid and corrected
  const before = Object.values(state.handled).filter((v) => v.round === s.round && v.posted);
  const paid = new Map();
  for (const v of before) for (const p of v.players || []) paid.set(p.key, (paid.get(p.key) || 0n) + BigInt(p.paidMsat ?? p.msat ?? 0));
  const truth = before.flatMap((v) => (v.truth || []).map((t) => ({ pubkey: fromHex(t.key), outcome: t.outcome, score: t.score })));
  const rule = payoutRuleOfRound(contract, (await import('../src/plugins.js')).hostedPlugins(await loadApps()));
  if (!rule.ok) return { done: false, why: rule.why };
  const slash = buildSlash({ verdict, bond, advert: accused.advert, contract, roundId: rid, slashHeight: census.tip, tipHeight: census.tip,
    entries, signed, truth, paid, payoutShares: rule.payoutShares, set, feeSats: PATH_B_FEE_SATS });
  if (!slash.ok) return { done: false, why: slash.why };
  // EACH MEMBER SIGNS ON ITS OWN; k OF THEM ARE ENOUGH, AND THE REST ARE NOT ASKED
  const signatures = set.members.slice(0, set.k).map((m) => ({ key: m.key, sig: memberSign(m, slash.sighash) }));
  const tx = assemble({ slash, signatures, set });
  if (!tx.ok) return { done: false, why: tx.why };
  const sent = await post(rpc, tx.hex);
  // WHAT THE ESCROW OWES, kept with the slash: the step after (payOut) pays it through the federations
  const byKey = new Map(entries.map((e) => [toHex(e.playerPubkey), e]));
  const players = [...slash.distribution.players].map(([key, msat]) => ({ key, msat: String(msat), entry: byKey.get(key).entryId, federation: byKey.get(key).federation }));
  return sent.ok ? { done: true, offence: verdict.offence, posted: sent.txid, slashHeight: census.tip, signers: tx.signers, node: s.node, round: s.round, entry: s.entry,
    bondSats: String(bond.value), escrowSats: String(slash.built.amounts.escrow), players,
    playersMsat: String(slash.distribution.playersMsat), reservesMsat: String(slash.distribution.reservesMsat), shortMsat: String(slash.distribution.shortMsat),
    truth: slash.truth.map((t) => ({ key: toHex(t.pubkey), outcome: t.outcome, score: t.score })) } : { done: false, why: sent.why };
}

// WHERE A SLASH'S RESERVES MAY GO (§27A.9.2), as the seats say it: only what more than half of those that answered name alike, so no single seat can
// name a key of its own. Every OPEN federation with its load and reserve key; loads move with the chain, so a pass where they differ waits for the next.
async function federationView() {
  const votes = new Map();
  let answered = 0;
  await Promise.all(seats.map(async (seat) => {
    try {
      const [feds, res] = await Promise.all([get(`${seat}/federations`), get(`${seat}/reserves`)]);
      const keys = new Map((res.federations || []).map((f) => [f.federationId, f.reserveKey || f.key || null]));
      for (const f of feds.federations || []) {
        const row = { federation: f.federation, status: f.status, reserveSats: String(f.reserveSats || 0), exposureCapSats: String(f.exposureCapSats || 0), reserveKey: keys.get(f.federation) || null };
        const k = JSON.stringify(row);
        votes.set(k, { row, n: (votes.get(k) ? votes.get(k).n : 0) + 1 });
      }
      answered += 1;
    } catch (e) { say({ seat, federations: e.message }); }
  }));
  return [...votes.values()].filter((x) => x.n * 2 > answered).map((x) => x.row);
}

const clientDirs = new Map(String(env.ARENA_ARBITER_CLIENT_DIRS || '').split(',').map((x) => x.trim()).filter(Boolean).map((x) => x.split('=')).filter((x) => x.length === 2).map(([k, d]) => [k.toLowerCase(), d]));
const PATH_B_FEE_SATS = BigInt(env.ARENA_ARBITER_PATH_B_FEE_SATS || 2000);
// AFTER PATH B (§5A.3B step 5): the escrow into the federations, claimed, each loss and each reserve part paid (arbiter.js payOutSlash, through
// ARENA_STAKE_LOCK_BIN on this set's clients: ARENA_ARBITER_CLIENT_DIRS=<federation hex>=<dir>,..., or the one client ARENA_ARBITER_CLIENT_DIR);
// ARENA_ARBITER_RETIRED names the federations a ruling closed to new peg-ins
const payOut = (proof, v) => payOutSlash({ proof, v, set, rpc, keep, say, bin: env.ARENA_STAKE_LOCK_BIN, dirOf: (fid) => clientDirs.get(fid) || env.ARENA_ARBITER_CLIENT_DIR || null,
  federations: federationView, retired: String(env.ARENA_ARBITER_RETIRED || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean),
  feeSats: BigInt(env.ARENA_ARBITER_FEE_SATS || 1000), pegInFeeSats: BigInt(env.ARENA_ARBITER_PEGIN_FEE_SATS || 1000) });

let games = null;
async function loadApps() {
  if (games) return games;
  const list = String(env.ARENA_APPS || '').split(',').filter(Boolean);
  games = [];
  for (const p of list) { const m = await import(p); games.push(m.GAME || Object.values(m).find((v) => v && v.gameId && v.manifest)); }
  return games;
}

// THE TABLE PAID (§23A.5 step 4): once a liquidating federation's claim window has closed, its escrow into the set's
// client of a SAFE federation (ARENA_LIQ_PAY_DIR, through ARENA_STAKE_LOCK_BIN) and each note's payout locked to its key
async function payLiquidations() {
  if (!claims || !env.ARENA_LIQ_PAY_DIR || !env.ARENA_STAKE_LOCK_BIN) return;
  const { execFile } = await import('node:child_process');
  const run = (args) => new Promise((done) => execFile(env.ARENA_STAKE_LOCK_BIN, [...args, '--data-dir', env.ARENA_LIQ_PAY_DIR], { timeout: 900000, maxBuffer: 1 << 24 },
    // the tool's own words when it fails: its last lines (stderr), not the start of the command line, which alone filled the 200 characters
    (err, out, errOut) => { const line = String(out || '').split('\n').find((l) => l.startsWith('{')); done(line ? JSON.parse(line) : { error: String((errOut && String(errOut).trim()) || (err && err.message) || 'no answer').slice(-400) }); }));
  state.liquidations = state.liquidations || {};
  for (const [fid, at] of liqEscrows) {
    const v = state.liquidations[fid] = state.liquidations[fid] || {};
    const [txid, vout] = at.split(':');
    const spendEscrow = async (address) => {
      const o = await rpc('gettxout', [txid, Number(vout), false]);
      if (!o) return { why: 'the escrow output is spent or unknown' };
      const toScript = fromHex((await rpc('validateaddress', [address])).scriptPubKey);
      const spend = buildEscrowPegin({ escrow: { txid: fromHex(txid).reverse(), vout: Number(vout), value: BigInt(Math.round(Number(o.value) * 1e8)) }, set, toScript,
        feeSats: BigInt(env.ARENA_ARBITER_FEE_SATS || 1000) });
      if (!spend.ok) return { why: spend.why };
      const signed = assemble({ slash: spend, signatures: set.members.slice(0, set.k).map((m) => ({ key: m.key, sig: memberSign(m, spend.sighash) })), set });
      if (!signed.ok) return { why: signed.why };
      // with the escrow's amount (kanban #723: the liquidation's event names it), read before it is spent
      return { ...(await post(rpc, signed.hex)), sats: String(BigInt(Math.round(Number(o.value) * 1e8))) };
    };
    // THE REMAINDER GOES TO THE PROTOCOL RESERVES (§5A.3, §23A.5): it is e-cash in the safe federation by now, so that federation's reserve key
    const remainderPayees = async (fidHex, msat) => {
      const into = String(env.ARENA_LIQ_PAY_FEDERATION || '').toLowerCase();
      const f = (await federationView()).find((x) => x.federation === into);
      if (!f || !f.reserveKey) throw new Error(`no reserve key named for federation ${into.slice(0, 16)}: the remainder waits`);
      return [{ key: f.reserveKey, msat, part: 'reserves' }];
    };
    // THE HALT AS THE SEATS LISTED IT, kept once (kanban #723): the liquidation's event says it after the seats forget the federation
    if (!v.halt) { try { const l = await claims.liquidation(fid); if (l) { v.halt = haltOfListing(l); keep(); } } catch { /* next pass */ } }
    let r; try { r = await payOutLiquidation({ fid, v, claims, height: async () => Number(await rpc('getblockcount')), run, spendEscrow, remainderPayees, keep, say }); } catch (e) { r = { why: e.message }; }
    if (r.why) say({ liquidation: fid.slice(0, 16), waits: r.why });
  }
}

const haltOfListing = (l) => ({ height: Number(l.haltHeight), proof: l.haltProof ? { session: l.haltProof.session, observers: l.haltProof.observers,
  abandoned: l.haltProof.abandoned || [], id: l.haltProof.id } : null });

// THE SET'S EVENTS, PUBLISHED (kanban #723, the owner 2026-10-27: liquidations and slashes in the explorer as their own events, with every payout and
// its transaction): after each pass every liquidation and every posted slash this set keeps is said as an event (arbitration-events.js), signed
// by k members, and posted to every seat (POST /liquidations/events) - ARENA_ARBITER_SEATS and ARENA_ARBITER_PUBLISH - when it changed or
// a seat has not taken it within PUBLISH_AGAIN_MS; the seats hand it on to each other and list it at GET /liquidations
const PUBLISH_AGAIN_MS = Number(env.ARENA_ARBITER_PUBLISH_AGAIN_MS || 1800000);
const publishTo = [...new Set([...seats, ...String(env.ARENA_ARBITER_PUBLISH || '').split(',').map((x) => x.trim().replace(/\/+$/, '')).filter(Boolean)])];
const postedTo = new Map();            // seat -> Map(event key -> { hash, at })
function arbiterEvents() {
  const out = [];
  const into = String(env.ARENA_LIQ_PAY_FEDERATION || '').toLowerCase() || null;
  state.events = state.events || {};
  let changed = false;
  for (const [fid, v] of Object.entries(state.liquidations || {})) {
    const body = liquidationEvent({ network, fid, v, claims: claims ? claims.claimed(fid) : [], escrowAt: liqEscrows.get(fid) || null, into });
    const kept = state.events[`liquidation:${fid}`] = state.events[`liquidation:${fid}`] || {};
    const s1 = stampEvent(body, kept); changed = changed || s1.changed; out.push(s1.event);
  }
  for (const [proof, v] of Object.entries(state.handled || {})) {
    if (!v.posted) continue;
    const body = slashEvent({ network, proof, v });
    const kept = state.events[`slash:${proof}`] = state.events[`slash:${proof}`] || {};
    if (!Number.isFinite(kept.firstMs) && Number.isFinite(v.at)) kept.firstMs = v.at;
    const s1 = stampEvent(body, kept); changed = changed || s1.changed; out.push(s1.event);
  }
  if (changed) keep();
  return out;
}
async function publishEvents() {
  const events = arbiterEvents();
  if (!events.length || !publishTo.length) return;
  const signed = events.map((e) => ({ key: eventKey(e), hash: String(e.atMs), said: signEvent(e, set, memberSign) }));
  let sent = 0;
  await Promise.all(publishTo.map(async (seat) => {
    const mine = postedTo.get(seat) || new Map(); postedTo.set(seat, mine);
    for (const x of signed) {
      const had = mine.get(x.key);
      if (had && had.hash === x.hash && Date.now() - had.at < PUBLISH_AGAIN_MS) continue;
      try {
        const r = await fetch(`${seat}/liquidations/events`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(x.said), signal: AbortSignal.timeout(15000) });
        if (r.ok) { mine.set(x.key, { hash: x.hash, at: Date.now() }); sent++; }
      } catch { /* that seat next pass */ }
    }
  }));
  if (sent) say({ eventsPublished: sent, events: signed.length, seats: publishTo.length });
}

async function pass() {
  await payLiquidations().catch((e) => say({ liquidationsError: e.message }));
  // THE PROOFS OF A ROUND IN ASCENDING PROOF ID (§5A.3): the first pays each loss, a later one only what is still owed
  const found = new Map();
  for (const seat of seats) {
    let list; try { list = await get(`${seat}/slashes`); } catch (e) { say({ seat, refused: e.message }); continue; }
    for (const s of [...(list.slashes || []), ...(list.auditSlashes || []).map((x) => ({ ...x, kind: 'audit' })), ...(list.doubleSlashes || []).map((x) => ({ ...x, kind: 'double' }))]) if (!state.handled[s.proof] && !found.has(s.proof)) found.set(s.proof, { seat, s });
  }
  for (const { seat, s } of [...found.values()].sort((a, b) => (a.s.proof < b.s.proof ? -1 : 1))) {
    let r; try { r = await handle(seat, s); } catch (e) { r = { done: false, why: e.message }; }
    say({ seat, proof: s.proof.slice(0, 16), node: s.node.slice(0, 16), ...r });
    // the offence the published event names (kanban #1000, #986): what the judgement found, in `r`, never read off the list a proof came from
    if (r.done) { state.handled[s.proof] = { at: Date.now(), ...r }; keep(); }
  }
  for (const [proof, v] of Object.entries(state.handled)) {
    if (!v.posted || !v.escrowSats || v.settled) continue;
    let r; try { r = await payOut(proof, v); } catch (e) { r = { why: e.message }; }
    if (r.why) say({ proof: proof.slice(0, 16), payouts: r.why });
  }
  await publishEvents().catch((e) => say({ eventsError: e.message }));
}
// THE SLASH'S PAYOUTS (GET /slash-payouts?round=), for a page to collect its player's: each a pre-expired lock at txid:outIdx
const payouts = () => Object.values(state.handled).flatMap((v) => v.payouts || []);

const posted = () => Object.entries(state.handled).filter(([, v]) => v.posted).map(([proof, v]) => ({ proof, txid: v.posted, slashHeight: v.slashHeight }));
// A RELEASE ONLY FOR A NODE NO HANDLED OR OPEN PROOF ACCUSES
const open = new Set();
const allow = ({ nodeKey }) => (open.has(toHex(nodeKey)) || Object.values(state.handled).some((v) => v.node === toHex(nodeKey))
  ? { ok: false, why: 'a slash proof against this node is open or was posted' } : { ok: true });
// A HALTED FEDERATION'S CLAIMS (§23A.5): ARENA_LIQ_CLIENTS=<federation hex>=<fedimint-cli data dir>,... - a client of
// each federation this set joined while it was OPEN, to check presented notes offline; ARENA_LIQ_ESCROWS=<federation hex>=<txid>:<vout>,...
// - the escrow output its slashes paid; the claims kept in ARENA_LIQ_CLAIMS_FILE; the halt and the spent set read from the seats
const pairs = (v) => new Map(String(v || '').split(',').map((x) => x.trim()).filter(Boolean).map((x) => x.split('=')).filter((x) => x.length === 2).map(([k, v2]) => [k.toLowerCase(), v2]));
const liqClients = pairs(env.ARENA_LIQ_CLIENTS); const liqEscrows = pairs(env.ARENA_LIQ_ESCROWS);
let claims = null;
if (liqClients.size) {
  const claimsFile = env.ARENA_LIQ_CLAIMS_FILE || null;
  claims = createLiquidationClaims({
    validate: fedimintNoteValidator({ cli: env.ARENA_FEDIMINT_CLI || 'fedimint-cli', dataDirFor: (fid) => liqClients.get(fid) || null, home: env.ARENA_FEDIMINT_HOME || env.HOME }),
    // THE FIRST SEAT THAT LISTS IT, with the spent set and the record from any seat that has them (kanban #326 rehearsal 17, 2026-10-26:
    // the test host seats list T2 with its record and no spent set, the one T2 seat still up with the spent set; the first answer
    // alone left the remainder with no record to read the guardians from)
    liquidationOf: async (fid) => {
      let first = null, copy = null, record = null;
      for (const s of seats) {
        try {
          const j = await (await fetch(`${s}/liquidations`, { signal: AbortSignal.timeout(15000) })).json();
          const l = (j.liquidations || []).find((x) => x.federation === fid);
          if (!l) continue;
          first = first || l;
          copy = copy || (l.spentSet && l.spentSet.copies && l.spentSet.copies[0]) || null;
          record = record || l.haltRecord || l.record || null;
          if (copy && record) break;
        } catch { /* the next seat */ }
      }
      if (!first) return null;
      return { ...first, record, spentNonces: copy ? spentNonceSet(decodeSpentSet(fromHex(copy.spentSet))) : null };
    },
    height: async () => Number(await rpc('getblockcount')),
    escrowMsatOf: async (fid) => {
      const at = liqEscrows.get(fid); if (!at) return 0n;
      const [txid, vout] = at.split(':');
      const o = await rpc('gettxout', [txid, Number(vout), false]);
      return o ? BigInt(Math.round(Number(o.value) * 1e8)) * 1000n : 0n;
    },
    clocks: clocksFor(network === 'testnet4' ? 'testnet4' : network).clocks,
    load: () => { try { return claimsFile ? JSON.parse(readFileSync(claimsFile, 'utf8')) : []; } catch { return []; } },
    save: (rows) => { if (claimsFile) writeFileSync(claimsFile, JSON.stringify(rows) + '\n'); },
  });
}
// the paid claims' locks, from the state each pass keeps (ARENA_LIQ_PAY_FEDERATION: the safe federation ARENA_LIQ_PAY_DIR is a client of)
const liquidationPayouts = () => Object.entries(state.liquidations || {}).flatMap(([fid, v]) => (v.payouts || []).concat(v.remainderPayouts || [])
  .map((p) => ({ federation: fid, into: String(env.ARENA_LIQ_PAY_FEDERATION || '').toLowerCase(), ...p })));
// EVERY REFUSED NOTE KEPT with its reason (kanban #723: the liquidation's event says the claims accepted and refused), at most 500 a federation
const keepRefused = (body, got) => {
  const fid = String(body && body.federation || '').toLowerCase();
  if (!got || !Array.isArray(got.refused) || !got.refused.length || !/^[0-9a-f]{64}$/.test(fid)) return got;
  state.liquidations = state.liquidations || {};
  const v = state.liquidations[fid] = state.liquidations[fid] || {};
  v.refused = [...(v.refused || []), ...got.refused.map((r) => ({ nonce: r.nonce || r.request || null, why: r.why, height: got.height ?? null }))].slice(-500); keep();
  return got;
};
const claimsDoor = claims ? { ...claims, offer: async (b) => keepRefused(b, await claims.offer(b)), offerPending: async (b) => keepRefused(b, await claims.offerPending(b)) } : null;
const doors = await serveArbiter({ set, allow, port: Number(env.ARENA_ARBITER_PORT || 31290), posted: posted(), payouts, claims: claimsDoor, liquidationPayouts });
say({ up: doors.port, network, seats: seats.length, members: set.members.length, k: set.k });
await pass();
if (process.argv.includes('--once')) { await doors.close(); process.exit(0); }
// ONE PASS AT A TIME (kanban #326 rehearsal 17, measured 2026-10-26 19:12Z on the test host: a pass waits up to 840 s for its peg-in claim,
// the timer started one every 60 s, and 15 `pegin-claim` runs held the same client folder at once - each one failed on the other's lock,
// 2,824 times since 10-24): a pass still running skips the tick
let passing = false;
setInterval(() => {
  if (passing) return;
  passing = true;
  pass().catch((e) => say({ error: e.message })).finally(() => { passing = false; });
}, Number(env.ARENA_ARBITER_EVERY_MS || 60000));
