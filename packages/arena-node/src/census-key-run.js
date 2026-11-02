// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// ONE NODE'S SIDE OF MAKING A CENSUS KEY, ON THE CHAIN'S CLOCK (5A.3B, kanban #972, #1034 answer 5, #1041). Every height comes from the chain and the run from the census, so a
// seat needs no one's word to know the run, and nothing here is asked of a coordinator.
//
//   WHEN           founding_window from the epoch's first height e x E, and only if the newest key has been named by a bond (censusKeyPlan). A holder of no share sits it out
//   DEALS          first half: each holder deals once, signed by its node key, to every other holder, and any deal it missed is pulled from a few peers each pass
//   THE MIDPOINT   the deal set is every valid deal held at it. The check runs there, in one batch, and a bad deal's complaint goes to the holders
//   THE STATEMENT  one block later, so complaints heard meanwhile drop their deals everywhere first: a node signs the CensusKeyRecord of what it still holds, once for the run
//   THE RECORD     holders of the threshold on one hash make the key. Nodes that differ sign different hashes, no hash gets there, the key fails and the newest stands.
//                  A node that signed another hash, or none, takes the agreed deal set from a peer that signed the agreed one, and keeps its shares
//   THE ANCHOR     any holder, from its own wallet, in duty order: rank k posts from (k - 1) x 6 blocks after the record is complete. One that cannot pay says so and the next
//                  takes it. Nobody is paid and nobody is punished (kanban #1041 answer 1)
//
// A reshare is not run from here: CensusDkg holds it, but no rule says yet how the nodes agree which old holders are present when one starts.
import { schnorr } from '@noble/curves/secp256k1.js';
import { censusHeightOfEpoch, censusKeyDrawHeight, censusKeyEpochOf, censusKeyPlan, censusKeyRecordId, censusKeyShares, censusKeyWindow, decodeCensusKeyRecord,
  encodeCensusKeyBody } from '../../arena-protocol/src/census-key.js';
import { censusComplaintHolds, censusDealId, censusRecordAgreed, censusRunId, decodeCensusComplaint, decodeCensusDeal, joinSignedCensusDeal, splitSignedCensusDeal
 } from '../../arena-protocol/src/census-dkg.js';
import { dutyOrder } from '../../arena-protocol/src/duty.js';
import { BOND_TEMPLATE_V3 } from '../../arena-protocol/src/bond-script.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { feldmanGroup } from './curve.js';
import { censusKeyInWorker } from './census-key-work.js';

/** From the record's completion, how many blocks each next rank waits (kanban #1041 answer 1). */
export const CENSUS_KEY_POST_STEP = 6;
const safeVerify = (sig, msg, key) => { try { return schnorr.verify(sig, msg, key); } catch { return false; } };
const reach = (u) => String(u || '').replace(/^ws(s?):/, 'http$1:').replace(/\/+$/, '');

/** The holders in duty order for an epoch: the slot of duty.js's rule is the epoch. */
export const censusKeyPostOrder = ({ networkId, epoch, holders }) => dutyOrder({ networkId, slot: epoch, nodeKeys: holders.map((h) => fromHex(h.key)) }).map(toHex);

/** The fewest signers reaching the threshold, the largest first, so the anchor is as small as it can be. Their signatures on `recordId`, ascending key. */
export function censusKeySigners({ holders, threshold, statements, recordId }) {
  const said = new Map(statements.filter((s) => toHex(s.recordId) === toHex(recordId)).map((s) => [toHex(s.node), s.signature]));
  const out = [];
  let have = 0;
  for (const h of [...holders].sort((a, b) => b.shares - a.shares || (a.key < b.key ? -1 : 1))) {
    if (have >= threshold) break;
    if (!said.has(h.key)) continue;
    out.push({ key: fromHex(h.key), signature: said.get(h.key) }); have += h.shares;
  }
  return have < threshold ? null : out.sort((a, b) => (toHex(a.key) < toHex(b.key) ? -1 : 1));
}

/**
 * `store` CensusKeyStore; `key`, `secret` the node's; `tipHeight()`; `blockHashAt(height)`; `censusEntriesAt(height)`; `standing()` the keys that stand and `scannedTo()` how far they
 * were read (census-key-chain.js); `post({ body, record })` sends the anchor from this node's wallet and answers { ok, txid } or { ok: false, why };
 * `fetchFn`; `work` the worker's jobs. A pass does one step at a time, and a step that fails is tried again on the next.
 */
export function createCensusKeyRun({ store, network, networkId, key, secret, firstHeight, foundingWindow, censusConfirmations, genesis = null, sharesMax = undefined,
  tipHeight, blockHashAt, censusEntriesAt, standing, scannedTo, post = null, fetchFn = fetch, work = censusKeyInWorker, peersPerPass = 8, pushAtOnce = 8, timeoutMs = 20000, log = () => {} }) {
  const me = toHex(key);
  const runs = new Map();               // epoch:hash -> the run, read once
  let current = null;                   // the run a door answers for
  let running = false;
  let lastWhy = null;

  const setState = (r, change) => { r.state = { ...r.state, ...change }; store.putRunState(r.run.runId, r.run.epoch, r.state); };

  /** The run of an epoch, from the chain alone, or null while it is not readable or none is due. */
  async function runOf(epoch) {
    const drawHeight = censusKeyDrawHeight(epoch, network);
    const hash = await blockHashAt(drawHeight);
    if (!hash) return null;
    const memo = `${epoch}:${hash}`;
    if (runs.has(memo)) return runs.get(memo);
    const censusHeight = censusHeightOfEpoch(epoch, network, censusConfirmations);
    if (censusHeight === null) return null;
    const entries = await censusEntriesAt(censusHeight);
    if (!entries) return null;
    const shares = censusKeyShares({ entries, network, genesis, blockHash: fromHex(String(hash)), ...(sharesMax ? { sharesMax } : {}) });
    const { holders, total, threshold } = shares;
    if (holders.length < 2) { lastWhy = `the census at ${censusHeight} has ${holders.length} holder(s)`; return null; }
    const runId = censusRunId({ networkId, epoch, censusHeight, holders, threshold });
    const run = { runId, networkId, epoch, censusHeight, holders, total, threshold, needed: threshold };
    const peers = new Map();
    for (const e of entries) if (e.advert && e.advert.endpoint) peers.set(toHex(e.pubkey), reach(e.advert.endpoint));
    const named = (k) => entries.filter((e) => e.advert && e.advert.bondScriptTemplateVersion === BOND_TEMPLATE_V3 && e.advert.censusKey && toHex(e.advert.censusKey) === toHex(k.publicKey)).length;
    const r = { run, peers: run.holders.map((h) => peers.get(h.key)).filter((u, i) => u && run.holders[i].key !== me), named, order: censusKeyPostOrder({ networkId, epoch, holders }),
      window: null, state: store.runState(runId), heard: new Set() };
    runs.set(memo, r);
    return r;
  }

  const peerJson = async (url) => { const r = await fetchFn(url, { signal: AbortSignal.timeout(timeoutMs) }); if (!r.ok) throw new Error(`${url}: ${r.status}`); return r.json(); };
  const pickPeers = (r) => [...r.peers].sort(() => Math.random() - 0.5).slice(0, peersPerPass);

  /** To every other holder, a few at a time. One that does not take it pulls it later. */
  async function push(r, path, body) {
    const list = [...r.peers];
    const one = async () => {
      for (let u = list.shift(); u; u = list.shift()) {
        try { await fetchFn(`${u}${path}`, { method: 'POST', body, signal: AbortSignal.timeout(timeoutMs) }); } catch { /* it pulls */ }
      }
    };
    await Promise.all(Array.from({ length: pushAtOnce }, one));
  }

  // THE DOORS' HALF: cheap checks only, on the seat's thread. A deal's polynomial is the check's, at the midpoint.
  const named = (runIdHex) => (current && toHex(current.run.runId) === runIdHex ? current : null);

  function keepSignedDeal(r, wire) {
    let parts, deal;
    try { parts = splitSignedCensusDeal(wire); deal = decodeCensusDeal(parts.bytes); } catch (e) { return { ok: false, why: e.message }; }
    if (toHex(deal.runId) !== toHex(r.run.runId)) return { ok: false, why: 'that deal belongs to another run' };
    if (!r.run.holders.some((h) => h.key === toHex(deal.from))) return { ok: false, why: 'that deal is by a node that is not a dealer of this run' };
    if (!safeVerify(parts.signature, censusDealId(deal), deal.from)) return { ok: false, why: 'that deal is not signed by its dealer' };
    return { ok: true, fresh: store.keepDeal(r.run.runId, deal.from, wire) };
  }

  /** POST /census-dkg/deal. The deal set closes at the midpoint, by this node's own tip. */
  async function takeDeal(wire) {
    const r = current;
    if (!r) return { ok: false, status: 409, why: 'this node is not in a census key run' };
    const tip = Number(await tipHeight());
    if (tip >= r.window.midpoint) return { ok: false, status: 409, why: `the deals of this run closed at ${r.window.midpoint}` };
    const kept = keepSignedDeal(r, wire);
    return kept.ok ? kept : { ...kept, status: 409 };
  }

  /** POST /census-dkg/complaint: it proves itself, against the deal this node holds. */
  async function takeComplaint(bytes) {
    const r = current;
    if (!r) return { ok: false, status: 409, why: 'this node is not in a census key run' };
    let c; try { c = decodeCensusComplaint(bytes); } catch (e) { return { ok: false, status: 400, why: e.message }; }
    if (toHex(c.runId) !== toHex(r.run.runId)) return { ok: false, status: 409, why: 'that complaint belongs to another run' };
    const wire = store.dealOf(r.run.runId, c.dealer);
    if (!wire) return { ok: false, status: 409, why: 'this node holds no such deal' };
    const proven = await censusComplaintHolds({ complaint: c, deal: decodeCensusDeal(splitSignedCensusDeal(wire).bytes), holders: r.run.holders, curve: feldmanGroup });
    if (!proven.ok) return { ok: false, status: 409, why: proven.why };
    store.keepComplaint(r.run.runId, c.dealer, c.node, bytes);
    return { ok: true };
  }

  /** POST /census-dkg/statement: { run, node, recordId, signature } in hex. */
  function takeStatement(body) {
    const r = body && named(String(body.run));
    if (!r) return { ok: false, status: 409, why: 'that is not this node\'s census key run' };
    let s; try { s = { node: fromHex(String(body.node)), recordId: fromHex(String(body.recordId)), signature: fromHex(String(body.signature)) }; }
    catch (e) { return { ok: false, status: 400, why: e.message }; }
    if (s.node.length !== 32 || s.recordId.length !== 32 || s.signature.length !== 64) return { ok: false, status: 400, why: 'that is not a statement' };
    if (!r.run.holders.some((h) => h.key === toHex(s.node))) return { ok: false, status: 409, why: 'that node holds no share of this run' };
    if (!safeVerify(s.signature, s.recordId, s.node)) return { ok: false, status: 409, why: 'that statement is not signed by its node' };
    store.keepStatement(r.run.runId, s);
    return { ok: true };
  }

  /** GET /census-dkg?run=: what this node holds, public all of it. */
  function heldOf(runIdHex) {
    const r = named(runIdHex);
    if (!r) return null;
    const id = r.run.runId;
    return { run: runIdHex, epoch: r.run.epoch, dealers: store.dealers(id), set: r.state.set || null, recordId: r.state.recordId || null,
      statements: store.statements(id).map((s) => ({ node: toHex(s.node), recordId: toHex(s.recordId), signature: toHex(s.signature) })),
      complaints: store.complaints(id).map((c) => toHex(c.bytes)) };
  }

  /** GET /census-dkg/deal?run=&dealer=: the signed bytes, so a holder that missed a deal asks a peer and not the dealer. */
  const dealWire = (runIdHex, dealerHex) => { const r = named(runIdHex); return r && /^[0-9a-f]{64}$/.test(dealerHex) ? store.dealOf(r.run.runId, fromHex(dealerHex)) : null; };

  // THE PASS

  /** What a few peers hold that this node does not: deals until the midpoint, statements and complaints always. */
  async function gather(r, { deals }) {
    const id = toHex(r.run.runId);
    await Promise.all(pickPeers(r).map(async (u) => {
      let held; try { held = await peerJson(`${u}/census-dkg?run=${id}`); } catch { return; }
      // each statement and complaint is checked once: every peer lists all of them on every pass
      for (const s of held.statements || []) {
        const name = `${s.node}:${s.recordId}`;
        if (!r.heard.has(name)) { r.heard.add(name); takeStatement({ run: id, ...s }); }
      }
      for (const c of held.complaints || []) {
        if (r.heard.has(c)) continue;
        r.heard.add(c);
        try { await takeComplaint(fromHex(c)); } catch { /* it proves nothing */ }
      }
      if (deals) await pullDeals(r, u, held.dealers || []);
    }));
  }

  async function pullDeals(r, url, dealers) {
    const id = toHex(r.run.runId);
    const have = new Set(store.dealers(r.run.runId));
    for (const d of dealers) {
      if (have.has(d)) continue;
      try { const got = await fetchFn(`${url}/census-dkg/deal?run=${id}&dealer=${d}`, { signal: AbortSignal.timeout(timeoutMs) });
        if (got.ok) keepSignedDeal(r, new Uint8Array(await got.arrayBuffer())); } catch { /* the next peer has it */ }
    }
  }

  const job = (r, kind, extra = {}) => work({ kind, key, secret, run: r.run, ...extra });
  const plainDeals = (r, only = null) => {
    const dropped = new Set([...(r.state.bad || []), ...store.complaints(r.run.runId).map((c) => c.dealer)]);
    return store.deals(r.run.runId).filter((d) => (only ? only.includes(d.dealer) : !dropped.has(d.dealer))).map((d) => new Uint8Array(splitSignedCensusDeal(d.wire).bytes));
  };

  async function dealOnce(r) {
    const made = await job(r, 'deal');
    if (!made.ok) throw new Error(made.why);
    const wire = joinSignedCensusDeal(made.bytes, schnorr.sign(censusDealId(decodeCensusDeal(made.bytes)), secret));
    store.keepDeal(r.run.runId, key, wire);        // written before it leaves: a node deals once, and a restart never deals again
    setState(r, { dealt: true });
    log(`[census-key] epoch ${r.run.epoch}: dealt, ${wire.length} bytes, to ${r.peers.length} holders`);
    await push(r, '/census-dkg/deal', wire);
  }

  async function checkOnce(r) {
    const seen = await job(r, 'check', { deals: plainDeals(r) });
    setState(r, { checked: true, bad: seen.bad });
    log(`[census-key] epoch ${r.run.epoch}: checked ${store.dealers(r.run.runId).length} deals, ${seen.bad.length} bad`);
    for (const c of seen.complaints) {
      const decoded = decodeCensusComplaint(c);
      store.keepComplaint(r.run.runId, decoded.dealer, decoded.node, c);
      await push(r, '/census-dkg/complaint', c);
    }
  }

  async function signOnce(r) {
    const said = await job(r, 'sign', { deals: plainDeals(r) });
    if (!said.ok) { setState(r, { signed: true, why: said.why }); return; }
    const recordId = toHex(said.recordId);
    setState(r, { signed: true, recordId, set: said.set, record: toHex(said.record) });
    store.keepStatement(r.run.runId, said);
    log(`[census-key] epoch ${r.run.epoch}: signed record ${recordId.slice(0, 16)} over ${said.set.length} deals`);
    await push(r, '/census-dkg/statement', JSON.stringify({ run: toHex(r.run.runId), node: me, recordId, signature: toHex(said.signature) }));
  }

  /** Holders of the threshold on one record: keep this node's shares of it. */
  async function finishOnce(r, tip) {
    const statements = store.statements(r.run.runId);
    const agreed = censusRecordAgreed({ holders: r.run.holders, threshold: r.run.threshold, statements, verify: () => true });
    if (!agreed.ok) return;
    const recordId = toHex(agreed.recordId);
    let only = null;
    if (recordId !== r.state.recordId) {
      // ANOTHER SET WON: its deals, from a peer that signed it
      for (const u of pickPeers(r)) {
        let held; try { held = await peerJson(`${u}/census-dkg?run=${toHex(r.run.runId)}`); } catch { continue; }
        if (held.recordId !== recordId || !held.set) continue;
        await pullDeals(r, u, held.set);
        only = held.set; break;
      }
      if (!only) return;
    }
    const done = await job(r, 'finish', { deals: plainDeals(r, only), statements });
    if (!done.ok) { lastWhy = done.why; return; }
    store.keepHeld({ publicKey: done.publicKey, epoch: r.run.epoch, runId: r.run.runId, record: done.record, negated: done.negated, shares: done.shares, commitments: done.commitments });
    setState(r, { complete: tip, agreed: recordId, record: toHex(done.record), publicKey: toHex(done.publicKey) });
    log(`[census-key] epoch ${r.run.epoch}: key ${toHex(done.publicKey).slice(0, 16)}, holders of ${agreed.have} of ${r.run.total} shares signed; this node keeps ${done.shares.size}`);
  }

  async function anchorIfDue(r, tip) {
    const rank = r.order.indexOf(me) + 1;
    const due = r.state.complete + (rank - 1) * CENSUS_KEY_POST_STEP;
    // ONE TRY PER BLOCK: a funded carrier whose reveal failed costs its fee, and a try every pass would spend that every 10 s
    if (tip < due || r.state.anchored || !post || r.triedAt === tip) return;
    r.triedAt = tip;
    const record = decodeCensusKeyRecord(fromHex(r.state.record));
    const signatures = censusKeySigners({ holders: r.run.holders, threshold: r.run.threshold, statements: store.statements(r.run.runId), recordId: censusKeyRecordId(record) });
    if (!signatures) return;
    const sent = await post({ body: encodeCensusKeyBody({ record, signatures }), record });
    if (!sent.ok) { lastWhy = `the anchor of epoch ${r.run.epoch} is not posted by this node: ${sent.why}`; log(`[census-key] ${lastWhy}`); return; }
    setState(r, { anchored: sent.txid });
    log(`[census-key] epoch ${r.run.epoch}: anchor ${sent.txid} posted at rank ${rank}, ${signatures.length} signers, ${sent.vsize} vB`);
  }

  /** The epoch's run is over: failed if it made no key, and its deals go. Older runs' data with it. */
  function closeRuns(epoch) {
    for (const id of store.runsBefore(epoch)) store.dropRunData(id);
    for (const m of runs.keys()) if (Number(m.split(':')[0]) < epoch) runs.delete(m);
  }

  async function pass() {
    if (running || firstHeight === null || firstHeight === undefined) return { skipped: true };
    running = true;
    try {
      const tip = Number(await tipHeight());
      const epoch = censusKeyEpochOf(tip, network);
      closeRuns(epoch);
      const window = censusKeyWindow(epoch, network, foundingWindow);
      if (window.start < firstHeight) { current = null; return { idle: 'before the first key height' }; }
      const read = scannedTo();
      if (read === null || read < window.start) return { idle: 'the chain scan has not reached this epoch' };
      const r = await runOf(epoch);
      if (!r) return { idle: lastWhy || 'no run for this epoch' };
      r.window = window;
      const known = standing().filter((k) => k.height <= window.start);
      const due = censusKeyPlan({ keys: known.map((k) => ({ ...k, named: r.named(k), threshold: 0, heldNow: 0, totalShares: 0 })), epochStart: true }).newKey;
      if (!due && !r.state.dealt) { current = null; return { idle: 'the newest key has not been named by a bond' }; }
      if (!r.run.holders.some((h) => h.key === me)) { current = null; return { idle: 'this node holds no share of this run' }; }
      current = r;
      if (standing().some((k) => k.epoch === epoch)) { if (r.state.complete && !r.state.anchored) setState(r, { anchored: 'by another' }); }
      if (tip < window.midpoint) {
        if (!r.state.dealt) await dealOnce(r);
        await gather(r, { deals: true });
        return { phase: 'deals', epoch };
      }
      if (tip < window.end && !r.state.checked) await checkOnce(r);
      await gather(r, { deals: false });
      if (tip < window.end && tip >= window.midpoint + 1 && !r.state.signed) await signOnce(r);
      if (!r.state.complete) await finishOnce(r, tip);
      if (r.state.complete) await anchorIfDue(r, tip);
      else if (tip >= window.end && !r.state.failed) {
        setState(r, { failed: true });
        log(`[census-key] epoch ${epoch}: no record reached the threshold by ${window.end}. The newest key stands and the next epoch tries again`);
      }
      return { phase: r.state.complete ? 'complete' : r.state.failed ? 'failed' : 'statements', epoch };
    } finally { running = false; }
  }

  return {
    pass, takeDeal, takeComplaint, takeStatement, heldOf, dealWire,
    status: () => {
      const r = current;
      return { run: r ? { epoch: r.run.epoch, runId: toHex(r.run.runId), censusHeight: r.run.censusHeight, total: r.run.total, threshold: r.run.threshold, holders: r.run.holders.length,
        window: r.window, deals: store.dealers(r.run.runId).length, statements: store.statements(r.run.runId).length, state: { ...r.state, record: undefined, set: undefined } } : null,
      recent: store.runsNewestFirst(4).map((x) => ({ epoch: x.epoch, complete: x.complete ?? null, failed: !!x.failed, anchored: x.anchored ?? null })), lastWhy };
    },
  };
}
