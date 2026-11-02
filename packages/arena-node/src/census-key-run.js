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
// A RESHARE (kanban #1048 answer 1), in the same epoch's window and beside its keygen, is a run of the same steps with one before them:
//
//   THE TRIGGER    the chain's: the plan of the epoch names the oldest live key held under 80 % by the census (census-key-chain.js planAt), so every node reads one answer
//   READY          first quarter: each old holder signs ReshareReady { key, run }, the run being the epoch, and those signatures go round the old holders
//   THE LIST       from the quarter's end, the first old holder in duty order with signatures covering the old threshold anchors them, rank k from (k - 1) blocks after it.
//                  The first valid anchor of a run is `present`, and the dealers are fixed from it (reshareDealers). No anchor, no reshare
//   DEALS ON       the rest of the window as a keygen, the old holders dealing their parts to the new census. A dealer that is gone fails the run: each part is a term over exactly that
//                  set. Nothing is lost, the old shares stand, and the next epoch's window starts again
//   THE RECORD     as a keygen's, by the new census. Its 'K' anchor names the same public key, and when it stands the new shares are the key's and the old go
import { schnorr } from '@noble/curves/secp256k1.js';
import { censusHeightOfEpoch, censusKeyAnchor, censusKeyDrawHeight, censusKeyEpochOf, censusKeyRecordId, censusKeyShares, censusKeyWindow, decodeCensusKeyRecord,
  encodeCensusKeyBody, encodeReshareList, reshareAnchor, reshareReadyId, reshareWindow } from '../../arena-protocol/src/census-key.js';
import { censusComplaintHolds, censusDealId, censusRecordAgreed, censusRunId, decodeCensusComplaint, decodeCensusDeal, joinSignedCensusDeal, reshareConstant, reshareDealers, splitSignedCensusDeal
 } from '../../arena-protocol/src/census-dkg.js';
import { dutyOrder } from '../../arena-protocol/src/duty.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { feldmanGroup } from './curve.js';
import { censusKeyInWorker } from './census-key-work.js';

/** From the record's completion, how many blocks each next rank waits (kanban #1041 answer 1). */
export const CENSUS_KEY_POST_STEP = 6;
/** From the end of a reshare's first quarter, how many blocks each next rank waits: a list has only until the midpoint. */
export const RESHARE_POST_STEP = 1;
const safeVerify = (sig, msg, key) => { try { return schnorr.verify(sig, msg, key); } catch { return false; } };
const reach = (u) => String(u || '').replace(/^ws(s?):/, 'http$1:').replace(/\/+$/, '');
const dealersOf = (r) => (r.run.reshare ? r.run.reshare.dealers : r.run.holders);

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
 * `store` CensusKeyStore; `key`, `secret` the node's; `tipHeight()`; `blockHashAt(height)`; `censusEntriesAt(height)`; `standing()` the keys that stand, `scannedTo()` how far they
 * were read, `plan(epoch)`, `reshareList(keyHex, run)` and `generationOf(keyHex)` (census-key-chain.js); `post({ body, output })` sends an anchor from this node's wallet and answers
 * { ok, txid } or { ok: false, why }; `fetchFn`; `work` the worker's jobs. A pass does one step at a time, and a step that fails is tried again on the next.
 */
export function createCensusKeyRun({ store, network, networkId, key, secret, firstHeight, foundingWindow, censusConfirmations, genesis = null, sharesMax = undefined,
  tipHeight, blockHashAt, censusEntriesAt, standing, scannedTo, plan, reshareList, generationOf, post = null, fetchFn = fetch, work = censusKeyInWorker, peersPerPass = 8, pushAtOnce = 8,
  timeoutMs = 20000, log = () => {} }) {
  const me = toHex(key);
  const runs = new Map();               // epoch:hash[:key] -> the run, read once
  const active = new Map();             // run id hex -> the runs doors answer for: this epoch's keygen and its reshare
  let ready = null;                     // the reshare whose ReshareReady is going round: { target, window, id, peers, order }
  let running = false;
  let lastWhy = null;
  const retiredShares = new Set();

  const setState = (r, change) => { r.state = { ...r.state, ...change }; store.putRunState(r.run.runId, r.run.epoch, r.state); };

  /** The census of an epoch and its shares, from the chain alone, or null while it is not readable. */
  async function censusOf(epoch) {
    const hash = await blockHashAt(censusKeyDrawHeight(epoch, network));
    if (!hash) return null;
    const censusHeight = censusHeightOfEpoch(epoch, network, censusConfirmations);
    if (censusHeight === null) return null;
    const entries = await censusEntriesAt(censusHeight);
    if (!entries) return null;
    const shares = censusKeyShares({ entries, network, genesis, blockHash: fromHex(String(hash)), ...(sharesMax ? { sharesMax } : {}) });
    const endpoints = new Map();
    for (const e of entries) if (e.advert && e.advert.endpoint) endpoints.set(toHex(e.pubkey), reach(e.advert.endpoint));
    return { hash: String(hash), censusHeight, shares, endpoints };
  }

  /** The keygen of an epoch, or null while it is not readable or none is due. */
  async function runOf(epoch) {
    const census = await censusOf(epoch);
    if (!census) return null;
    const memo = `${epoch}:${census.hash}`;
    if (runs.has(memo)) return runs.get(memo);
    const { censusHeight, endpoints, shares: { holders, total, threshold } } = census;
    if (holders.length < 2) { lastWhy = `the census at ${censusHeight} has ${holders.length} holder(s)`; return null; }
    const runId = censusRunId({ networkId, epoch, censusHeight, holders, threshold });
    const run = { runId, networkId, epoch, censusHeight, holders, total, threshold, needed: threshold };
    const r = { run, peers: run.holders.map((h) => endpoints.get(h.key)).filter((u, i) => u && run.holders[i].key !== me), order: censusKeyPostOrder({ networkId, epoch, holders }),
      window: null, state: store.runState(runId), heard: new Set(), holder: holders.some((h) => h.key === me), dealer: holders.some((h) => h.key === me), part: null };
    runs.set(memo, r);
    return r;
  }

  /** A reshare's run once its list stands: the old holders it names deal to the new census, each to the x of its epoch's shares. Null where that census cannot make one. */
  async function reshareRunOf(epoch, target, list, window) {
    const census = await censusOf(epoch);
    if (!census) return null;
    const memo = `${epoch}:${census.hash}:${target.key}`;
    if (runs.has(memo)) return runs.get(memo);
    const { censusHeight, endpoints, shares: { holders, total, threshold } } = census;
    const dealing = reshareDealers({ holders: target.holders, threshold: target.threshold, present: list.present });
    if (!dealing.ok || holders.length < 2) { lastWhy = dealing.why || `the census at ${censusHeight} has ${holders.length} holder(s)`; return null; }
    const held = store.held(target.publicKey, target.generation.epoch);
    const dealer = dealing.dealers.some((h) => h.key === me);
    if (dealer && !held) { lastWhy = `this node is a dealer of the reshare of ${target.key.slice(0, 16)} and holds no shares of it`; return null; }
    const runId = censusRunId({ networkId, epoch, censusHeight, holders, threshold, reshareOf: target.publicKey, dealers: dealing.dealers.map((h) => h.key) });
    const run = { runId, networkId, epoch, censusHeight, holders, total, threshold, needed: threshold, reshare: { dealers: dealing.dealers, xs: dealing.xs, oldThreshold: target.threshold,
      oldCommitments: held ? held.commitments : null, groupPublicKey: Uint8Array.from([0x02, ...target.publicKey]) } };
    const r = { run, peers: run.holders.map((h) => endpoints.get(h.key)).filter((u, i) => u && run.holders[i].key !== me), order: censusKeyPostOrder({ networkId, epoch, holders }),
      window, state: store.runState(runId), heard: new Set(), holder: holders.some((h) => h.key === me), dealer, part: dealer ? reshareConstant({ xs: dealing.xs, shares: held.shares }) : null, target };
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
  const named = (runIdHex) => active.get(runIdHex) || null;
  const NOT_IN_A_RUN = 'this node is not in a census key run';

  function keepSignedDeal(r, wire) {
    let parts, deal;
    try { parts = splitSignedCensusDeal(wire); deal = decodeCensusDeal(parts.bytes); } catch (e) { return { ok: false, why: e.message }; }
    if (toHex(deal.runId) !== toHex(r.run.runId)) return { ok: false, why: 'that deal belongs to another run' };
    if (!dealersOf(r).some((h) => h.key === toHex(deal.from))) return { ok: false, why: 'that deal is by a node that is not a dealer of this run' };
    if (!safeVerify(parts.signature, censusDealId(deal), deal.from)) return { ok: false, why: 'that deal is not signed by its dealer' };
    return { ok: true, fresh: store.keepDeal(r.run.runId, deal.from, wire) };
  }

  /** POST /census-dkg/deal. The deal set closes at the midpoint, by this node's own tip. */
  async function takeDeal(wire) {
    if (!active.size) return { ok: false, status: 409, why: NOT_IN_A_RUN };
    let id; try { id = toHex(decodeCensusDeal(splitSignedCensusDeal(wire).bytes).runId); } catch (e) { return { ok: false, status: 409, why: e.message }; }
    const r = active.get(id);
    if (!r) return { ok: false, status: 409, why: 'that deal belongs to another run' };
    const tip = Number(await tipHeight());
    if (tip >= r.window.midpoint) return { ok: false, status: 409, why: `the deals of this run closed at ${r.window.midpoint}` };
    const kept = keepSignedDeal(r, wire);
    return kept.ok ? kept : { ...kept, status: 409 };
  }

  /** POST /census-dkg/complaint: it proves itself, against the deal this node holds. */
  async function takeComplaint(bytes) {
    if (!active.size) return { ok: false, status: 409, why: NOT_IN_A_RUN };
    let c; try { c = decodeCensusComplaint(bytes); } catch (e) { return { ok: false, status: 400, why: e.message }; }
    const r = active.get(toHex(c.runId));
    if (!r) return { ok: false, status: 409, why: 'that complaint belongs to another run' };
    const wire = store.dealOf(r.run.runId, c.dealer);
    if (!wire) return { ok: false, status: 409, why: 'this node holds no such deal' };
    const proven = await censusComplaintHolds({ complaint: c, deal: decodeCensusDeal(splitSignedCensusDeal(wire).bytes), holders: r.run.holders, curve: feldmanGroup });
    if (!proven.ok) return { ok: false, status: 409, why: proven.why };
    store.keepComplaint(r.run.runId, c.dealer, c.node, bytes);
    return { ok: true };
  }

  /** POST /census-dkg/ready: { key, run, node, signature } in hex, one old holder's ReshareReady for the run going round now. */
  function takeReady(body) {
    if (!ready || !body || String(body.key) !== ready.target.key || Number(body.run) !== ready.epoch) return { ok: false, status: 409, why: 'that is not the reshare this node is reading' };
    let s; try { s = { node: fromHex(String(body.node)), signature: fromHex(String(body.signature)) }; } catch (e) { return { ok: false, status: 400, why: e.message }; }
    if (s.node.length !== 32 || s.signature.length !== 64) return { ok: false, status: 400, why: 'that is not a ReshareReady' };
    if (!ready.target.holders.some((h) => h.key === toHex(s.node))) return { ok: false, status: 409, why: 'that node holds no share of that key' };
    if (!safeVerify(s.signature, ready.id, s.node)) return { ok: false, status: 409, why: 'that ReshareReady is not signed by its node' };
    store.keepStatement(ready.id, { ...s, recordId: ready.id });
    return { ok: true };
  }

  /** GET /census-dkg/ready?key=&run=: the ReshareReady signatures this node holds. */
  const readyHeld = (keyHex, run) => (ready && ready.target.key === keyHex && ready.epoch === Number(run)
    ? { key: keyHex, run: ready.epoch, signatures: store.statements(ready.id).map((s) => ({ node: toHex(s.node), signature: toHex(s.signature) })) } : null);

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

  const job = (r, kind, extra = {}) => work({ kind, key, secret, run: r.run, part: r.part, ...extra });
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
    setState(r, { checked: true, bad: seen.bad, ...(seen.why ? { why: seen.why } : {}) });
    log(`[census-key] epoch ${r.run.epoch}: checked ${store.dealers(r.run.runId).length} deals, ${seen.bad.length} bad`);
    for (const c of seen.complaints) {
      const decoded = decodeCensusComplaint(c);
      store.keepComplaint(r.run.runId, decoded.dealer, decoded.node, c);
      await push(r, '/census-dkg/complaint', c);
    }
  }

  async function signOnce(r) {
    const said = await job(r, 'sign', { deals: plainDeals(r) });
    if (!said.ok) { setState(r, { signed: true, why: said.why }); log(`[census-key] epoch ${r.run.epoch}: nothing signed: ${said.why}`); return; }
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
    const sent = await post({ body: encodeCensusKeyBody({ record, signatures }), output: censusKeyAnchor(record) });
    if (!sent.ok) { lastWhy = `the anchor of epoch ${r.run.epoch} is not posted by this node: ${sent.why}`; log(`[census-key] ${lastWhy}`); return; }
    setState(r, { anchored: sent.txid });
    log(`[census-key] epoch ${r.run.epoch}: anchor ${sent.txid} posted at rank ${rank}, ${signatures.length} signers, ${sent.vsize} vB`);
  }

  /** The epoch's run is over: failed if it made no key, and its deals go. Older runs' data with it. */
  function closeRuns(epoch) {
    for (const id of store.runsBefore(epoch)) store.dropRunData(id);
    for (const m of runs.keys()) if (Number(m.split(':')[0]) < epoch) runs.delete(m);
  }

  /** One run's steps, a keygen's or a reshare's: deals to the midpoint, the check there, the statement a block later, the record and its anchor. */
  async function step(r, tip) {
    const w = r.window;
    if (tip < w.midpoint) {
      if (r.dealer && !r.state.dealt) await dealOnce(r);
      if (r.holder) await gather(r, { deals: true });
      return 'deals';
    }
    if (!r.holder) return 'dealt';
    if (tip < w.end && !r.state.checked) await checkOnce(r);
    await gather(r, { deals: false });
    if (tip < w.end && tip >= w.midpoint + 1 && !r.state.signed) await signOnce(r);
    if (!r.state.complete) await finishOnce(r, tip);
    if (r.state.complete) await anchorIfDue(r, tip);
    else if (tip >= w.end && !r.state.failed) {
      setState(r, { failed: true });
      log(`[census-key] epoch ${r.run.epoch}: no record reached the threshold by ${w.end}. ${r.target ? 'The old shares stand and the next epoch\'s window starts again' : 'The newest key stands and the next epoch tries again'}`);
    }
    return r.state.complete ? 'complete' : r.state.failed ? 'failed' : 'statements';
  }

  /** The first quarter and the list: what comes before a reshare has its dealers. */
  async function readyPass(t, tip) {
    const held = store.held(t.publicKey, t.generation.epoch);
    if (!held || !t.holders.some((h) => h.key === me)) return;           // only an old holder has a part to offer
    const { id, window: w } = ready;
    if (!store.statements(id).some((s) => toHex(s.node) === me) && tip < w.ready) {
      const signature = schnorr.sign(id, secret);
      store.keepStatement(id, { node: key, recordId: id, signature });
      log(`[census-key] epoch ${ready.epoch}: ready to reshare ${t.key.slice(0, 16)}`);
      const body = JSON.stringify({ key: t.key, run: ready.epoch, node: me, signature: toHex(signature) });
      await Promise.all(ready.peers.map((u) => fetchFn(`${u}/census-dkg/ready`, { method: 'POST', body, signal: AbortSignal.timeout(timeoutMs) }).catch(() => null)));
    }
    await Promise.all(pickPeers(ready).map(async (u) => {
      let held2; try { held2 = await peerJson(`${u}/census-dkg/ready?key=${t.key}&run=${ready.epoch}`); } catch { return; }
      for (const s of held2.signatures || []) if (!ready.heard.has(s.node)) { ready.heard.add(s.node); takeReady({ key: t.key, run: ready.epoch, ...s }); }
    }));
    const due = w.ready + ready.order.indexOf(me) * RESHARE_POST_STEP;
    if (tip < due || tip >= w.midpoint || !post || ready.triedAt === tip || ready.posted) return;
    ready.triedAt = tip;
    const signatures = censusKeySigners({ holders: t.holders, threshold: t.threshold, statements: store.statements(id), recordId: id });
    if (!signatures) { lastWhy = `the ReshareReady signatures of ${t.key.slice(0, 16)} do not cover its threshold of ${t.threshold} at ${tip}`; return; }
    const body = encodeReshareList({ networkId, key: t.publicKey, run: ready.epoch, signatures });
    const sent = await post({ body, output: reshareAnchor(body) });
    if (!sent.ok) { lastWhy = `the list of ${t.key.slice(0, 16)} is not posted by this node: ${sent.why}`; log(`[census-key] ${lastWhy}`); return; }
    ready.posted = sent.txid;
    log(`[census-key] epoch ${ready.epoch}: list ${sent.txid} posted, ${signatures.length} signers, ${sent.vsize} vB`);
  }

  /** The epoch's reshare, if its plan names one. */
  async function resharePass(epoch, tip, t) {
    const window = reshareWindow(epoch, network, foundingWindow);
    if (!ready || ready.epoch !== epoch || ready.target.key !== t.key) {
      const old = await censusEntriesAt(t.generation.censusHeight);
      const now = await censusOf(epoch);
      if (!old || !now) return { phase: 'waits for its census' };
      const endpoints = new Map();
      for (const e of old) if (e.advert && e.advert.endpoint) endpoints.set(toHex(e.pubkey), reach(e.advert.endpoint));
      for (const [k, u] of now.endpoints) endpoints.set(k, u);
      ready = { epoch, target: t, window, id: reshareReadyId({ networkId, key: t.publicKey, run: epoch }), heard: new Set(), order: dutyOrder({ networkId, slot: epoch, nodeKeys: t.holders.map((h) => fromHex(h.key)) }).map(toHex),
        peers: t.holders.map((h) => endpoints.get(h.key)).filter((u, i) => u && t.holders[i].key !== me) };
      if (!store.runState(ready.id).ready) store.putRunState(ready.id, epoch, { ready: true });   // its statements close with the epoch's runs
    }
    const list = reshareList(t.key, epoch);
    if (!list) {
      await readyPass(t, tip);
      return { phase: tip >= window.midpoint ? 'no anchor, no reshare' : 'ready', key: t.key };
    }
    const r = await reshareRunOf(epoch, t, list, window);
    if (!r) return { phase: 'no run', key: t.key };
    if (r.holder || r.dealer) active.set(toHex(r.run.runId), r);
    else return { phase: 'not in it', key: t.key };
    const generation = generationOf(t.key);
    if (r.state.complete && !r.state.anchored && generation && generation.epoch === epoch) setState(r, { anchored: 'by another' });
    return { phase: await step(r, tip), key: t.key };
  }

  /** The shares a reshare replaced go once its record stands, not before: only the chain says the run held. */
  function dropReplacedShares() {
    for (const k of standing()) {
      const hex = toHex(k.publicKey);
      const g = generationOf(hex);
      if (!g || retiredShares.has(`${hex}:${g.epoch}`)) continue;
      retiredShares.add(`${hex}:${g.epoch}`);
      if (store.dropHeldBefore(k.publicKey, g.epoch)) log(`[census-key] the old shares of ${hex.slice(0, 16)} are gone: the record of epoch ${g.epoch} stands`);
    }
  }

  async function pass() {
    if (running || firstHeight === null || firstHeight === undefined) return { skipped: true };
    running = true;
    try {
      const tip = Number(await tipHeight());
      const epoch = censusKeyEpochOf(tip, network);
      closeRuns(epoch);
      const window = censusKeyWindow(epoch, network, foundingWindow);
      if (window.start < firstHeight) { active.clear(); return { idle: 'before the first key height' }; }
      const read = scannedTo();
      if (read === null || read < window.start) return { idle: 'the chain scan has not reached this epoch' };
      dropReplacedShares();
      const r = await runOf(epoch);
      if (!r) return { idle: lastWhy || 'no run for this epoch' };
      r.window = window;
      const planned = await plan(epoch);
      active.clear();
      const out = {};
      if (!planned.newKey && !r.state.dealt) out.idle = 'the newest key has not been named by a bond';
      else if (!r.holder) out.idle = 'this node holds no share of this run';
      else {
        active.set(toHex(r.run.runId), r);
        if (standing().some((k) => k.epoch === epoch) && r.state.complete && !r.state.anchored) setState(r, { anchored: 'by another' });
        out.phase = await step(r, tip);
        out.epoch = epoch;
      }
      if (planned.reshare) out.reshare = await resharePass(epoch, tip, planned.reshare);
      else ready = null;
      return out;
    } finally { running = false; }
  }

  const runStatus = (r) => ({ epoch: r.run.epoch, runId: toHex(r.run.runId), censusHeight: r.run.censusHeight, total: r.run.total, threshold: r.run.threshold, holders: r.run.holders.length,
    window: r.window, deals: store.dealers(r.run.runId).length, statements: store.statements(r.run.runId).length, state: { ...r.state, record: undefined, set: undefined } });
  const inRun = () => [...active.values()];

  return {
    pass, takeDeal, takeComplaint, takeStatement, takeReady, readyHeld, heldOf, dealWire,
    status: () => {
      const keygen = inRun().find((r) => !r.run.reshare), reshare = inRun().find((r) => r.run.reshare);
      return { run: keygen ? runStatus(keygen) : null,
        reshare: ready ? { key: ready.target.key, run: ready.epoch, window: ready.window, signed: store.statements(ready.id).length, list: reshareList(ready.target.key, ready.epoch), posted: ready.posted || null,
          ...(reshare ? { dealers: reshare.run.reshare.dealers.length, ...runStatus(reshare) } : {}) } : null,
        recent: store.runsNewestFirst(4).map((x) => ({ epoch: x.epoch, complete: x.complete ?? null, failed: !!x.failed, anchored: x.anchored ?? null })), lastWhy };
    },
  };
}
