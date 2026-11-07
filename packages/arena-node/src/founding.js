// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A FOUNDING CEREMONY, AS A SEAT RUNS IT (spec §23A.2): the draw is guardian-founding.js (arena-protocol); this is
// what the drawn nodes do with it. Every seat computes the same draw from the census and the beacon after trigger_height, so no
// message decides who sits - the messages only carry what the guardians need to find each other:
//
//   SETUP CODE  a seated node starts its guardian in setup mode, takes its setup code (fedimint's set-local-params: the seat at
//               position 0 leads and names the federation and its size) and posts it signed with its node key:
//               (founding id, node key, code). A code from a node neither drawn nor an alternate, from a no-show, or not signed
//               by its node, is refused; an alternate's code is kept before it is seated and counts once it is.
//   THE WINDOW  "within founding_window blocks of the beacon": from the beacon (the block after trigger_height) to beacon +
//               founding_window, ONE window for the founding - a replacement never opens a new one (the gap of
//               comment 2258: it opened at trigger_height and again at each replacement).
//   NO-SHOW     "a drawn node that has not joined the ceremony within a fifth of the window is replaced by the next alternate":
//               a seated node with no code ceil(founding_window / 5) blocks after it was seated (the beacon for the drawn, the
//               replacement's height for an alternate) is a no-show, replaced in its position (replaceNoShows). Not slashed: it
//               held nothing.
//   VOID        "if the window passes without a federation, the founding is void and the next trigger draws again": at beacon +
//               founding_window with no federation running (the seated guardian's consensus, `setup.done()`, or a threshold of the
//               seated nodes that say so, kanban #1161 - never one peer's word), the founding is void - and so is one whose alternates
//               ran out.
//   PHASE       one enum and one transition (kanban #1161): COLLECTING (codes) -> DKG (this node started its key generation) ->
//               RUNNING (its own guardian in consensus, or thresholdOf(seated) seated nodes say so); COLLECTING or DKG -> VOID (the
//               window passed, or the alternates ran out); COLLECTING -> RUNNING for a seat that sits in no guardian. RUNNING and VOID
//               are final.
//   SEATED FIRST a succession (§23A.6 step 1) seats the old federation's seated, non-departing guardians first, in
//               the order given (`seatedFirst`, census entries), and draws only the missing seats (drawGuardians). A seated-first
//               node is held to the same window and fifth as a drawn one: no code a fifth after the beacon, and the next alternate
//               takes its position.
//   PRESSURE    `pressureBond`, B*_net while the network is under capacity pressure, orders the draw (drawGuardians, §23A.3a): every
//               seat of a founding has to pass the same value. The founding's id covers it, so seats that read another one name
//               another founding and cannot meet in one ceremony: it goes void and draws again.
//   TEN ARE ENOUGH (2026-10-22: "we need 10 nodes not 14", "On mainnet we also want 10": as soon as 10 nodes want to found a
//               federation it is allowed): a late seated node that no alternate can replace keeps its seat and may post its code
//               until the window's end - only the no-shows an alternate takes over are dropped, and the founding is void only when
//               the window passes. Measured 3d30afd4: 10 eligible, 0 alternates, and three installers that saw the draw only after a
//               burst of blocks voided it at once.
//   DKG         once every seated node's code is held, each seated node adds the others' codes to its guardian and starts the
//               key generation; its guardian then names the federation (invite) like any other.
//
// `setup` is injected - { localParams({ leader, name, size }), addPeer(code), startDkg(), invite(), done() } - so a test runs it in memory
// and a rehearsal against real fedimintd (tools/rehearsal-20.mjs). Nothing here moves money.
import { drawGuardians, replaceNoShows, foundingId } from '../../arena-protocol/src/guardian-founding.js';
import { Writer } from '../../arena-protocol/src/encode.js';
import { taggedHash, toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { tagAt, tagsAccepted, TAG_PAIRS } from '../../arena-protocol/src/tag-switch.js';
import { thresholdOf } from '../../arena-protocol/src/federation-record.js';

/** A founding's phase (kanban #1161). */
export const PHASE = Object.freeze({ COLLECTING: 'COLLECTING', DKG: 'DKG', RUNNING: 'RUNNING', VOID: 'VOID' });
const NEXT = Object.freeze({ COLLECTING: ['DKG', 'RUNNING', 'VOID'], DKG: ['RUNNING', 'VOID'], RUNNING: [], VOID: [] });
/** The one transition: `to` when it follows `phase`, else `phase` unchanged (a final phase never moves). */
export const foundingStep = (phase, to) => (NEXT[phase] && NEXT[phase].includes(to) ? to : phase);

export { foundingId };
/** What a setup code's signature covers: H(setup tag, id || node || code) - under the tag of the founding's trigger height, or `tag`. */
export function setupDigest(id, node, code, tag = TAG_PAIRS.foundingSetup[0]) {
  const c = new TextEncoder().encode(String(code));
  const w = new Writer(); w.bytes32(id); w.bytes32(node); w.u32(c.length);
  return taggedHash(tag, Uint8Array.from([...w.finish(), ...c]));
}

// `firstSeason` { blocks, from } (#1318): from `from` on, a bond maturing within `blocks` of the trigger height is no candidate
export function createFounding({ seed, triggerHeight, entries, nominal, bondMinGuardian, guardingOpen = new Set(), seatedFirst = [], pressureBond = null, candidateVersion = null, foundingWindow,
  ownKey, sign, verify, setup = null, post = async () => {}, name = 'arena', say = () => {}, firstSeason = null }) {
  const firstSeasonEnds = firstSeason && Number.isInteger(firstSeason.blocks) && Number.isInteger(firstSeason.from) && triggerHeight >= firstSeason.from ? triggerHeight + firstSeason.blocks : null;
  const draw = drawGuardians({ entries, seed, height: triggerHeight, nominal, bondMinGuardian, guardingOpen, seatedFirst, pressureBond, candidateVersion, firstSeasonEnds });
  const id = foundingId(seed, triggerHeight, draw.ok ? pressureBond : null);
  const own = toHex(ownKey);
  const codes = new Map();                   // node hex -> { code, signature }
  const noShows = new Set();
  let seated = draw.ok ? draw.drawn.slice() : [];
  const beacon = triggerHeight + 1;          // the block whose hash is the seed: the window opens here, once
  const windowEnd = beacon + foundingWindow; // ... and closes here, replacements or not
  const fifth = Math.max(1, Math.ceil(foundingWindow / 5));
  const seatedSince = new Map(seated.map((e) => [toHex(e.pubkey), beacon]));   // node hex -> the height it was seated at
  let posted = false, started = false, failed = null, invite = null, phase = PHASE.COLLECTING;
  const seenRunning = new Set();             // seated nodes whose own seat said the federation runs (node hex)
  const step = (to, why = null) => { const was = phase; phase = foundingStep(phase, to); if (phase !== was && phase === PHASE.VOID) failed = why; return phase !== was; };
  const isSeated = (hex) => seated.some((e) => toHex(e.pubkey) === hex);
  const position = (hex) => seated.findIndex((e) => toHex(e.pubkey) === hex);

  // a code is kept from any drawn node or alternate that is not a no-show: an alternate's code can arrive before this seat has
  // seen its window close and replaced the no-show itself (measured in the test: refused, and the DKG never started here)
  const mayPost = (hex) => !noShows.has(hex) && (draw.ok ? [...draw.drawn, ...draw.alternates] : []).some((e) => toHex(e.pubkey) === hex);
  /** POST /founding: a node's signed setup code { id, node, code, signature } (hex fields); kept from a drawn node or alternate. */
  function take(m) {
    if (!m || String(m.id).toLowerCase() !== toHex(id)) return { ok: false, status: 404, why: 'not this founding' };
    const node = String(m.node || '').toLowerCase();
    if (!mayPost(node)) return { ok: false, status: 409, why: 'that node is not drawn in this founding, or is a no-show' };
    let sig; try { sig = fromHex(String(m.signature)); } catch { return { ok: false, status: 400, why: 'a signature in hex' }; }
    if (!tagsAccepted('foundingSetup', { height: triggerHeight }).some((t) => verify(sig, setupDigest(id, fromHex(node), m.code, t), fromHex(node)))) return { ok: false, status: 409, why: 'the code is not signed by its node' };
    if (codes.has(node)) return { ok: true, status: 200, kept: false };
    codes.set(node, { code: String(m.code), signature: String(m.signature) });
    return { ok: true, status: 201, kept: true };
  }

  /**
   * A SEATED NODE'S OWN SEAT SAYS THE FEDERATION RUNS (its GET /founding `federation`, read at that node's census endpoint): counted per
   * node, and the founding RUNS here - no void for a federation that exists - once thresholdOf(seated) seated nodes said so (kanban #1161:
   * one peer's answer froze a succession or genesis until restart). A node not seated, or none named, counts nothing.
   */
  const federationSeen = (node = null) => {
    const k = String(node || '').toLowerCase();
    if (!k || !isSeated(k)) return false;
    seenRunning.add(k);
    const n = seated.filter((e) => seenRunning.has(toHex(e.pubkey))).length;
    if (n >= thresholdOf(seated.length) && step(PHASE.RUNNING)) say({ founding: toHex(id).slice(0, 16), federation: 'running', seenBy: n, of: seated.length });
    return true;
  };
  /**
   * One advance at chain height `tip`: the void at the window's end, no-shows past their fifth, this node's code, the DKG once all
   * codes are in, and whether the federation now runs.
   */
  let refreshed = false;
  // THE PEERS THIS NODE'S GUARDIAN HAS TAKEN, by node key: the DKG step is asked again on every tick until it starts
  const added = new Set();
  async function postOwn() {
    if (started || !setup || !isSeated(own) || posted) return;
    try {
      let code;
      // THE CODE THIS NODE POSTED BEFORE IT WAS STARTED AGAIN (kanban #495, measured 2026-10-21 22:2xZ on 53be35a3: seven seated nodes
      // restarted after their codes were out took new local params - a new TLS key - while their peers kept the first codes, and every
      // DKG connection failed "invalid peer certificate: BadSignature"): the same code again, never new params, never a fresh setup.
      // Its guardian kept the params behind it (guardian.js: a guardian waiting in setup outlives its node).
      const saved = typeof setup.savedCode === 'function' ? setup.savedCode() : null;
      const again = !!saved && saved.id === toHex(id);
      if (again) {
        code = saved.code;
        say({ founding: toHex(id).slice(0, 16), ownCode: 'the code posted before this start, again' });
      } else try { code = await setup.localParams({ leader: position(own) === 0, name, size: nominal }); }
      catch (e) {
        // PARAMS FROM A FOUNDING THAT WENT VOID (kanban #495): the guardian took them for an earlier founding and refuses new ones; it is
        // started again in a fresh setup - once in this founding, only before this node's code is posted - and asked again
        if (!/already been set/i.test(String(e && e.message)) || refreshed || typeof setup.freshSetup !== 'function') throw e;
        refreshed = true;
        const r = await setup.freshSetup();
        say({ founding: toHex(id).slice(0, 16), freshSetup: r.ok ? 'the guardian\'s setup started again (its old setup kept)' : r.why });
        if (!r.ok) throw e;
        code = await setup.localParams({ leader: position(own) === 0, name, size: nominal });
      }
      if (!again && typeof setup.saveCode === 'function') {
        try { setup.saveCode(toHex(id), code); } catch (e) { say({ founding: toHex(id).slice(0, 16), ownCode: `posted, not kept for a restart: ${e.message}` }); }
      }
      const signature = toHex(sign(setupDigest(id, ownKey, code, tagAt('foundingSetup', { height: triggerHeight }))));
      const m = { id: toHex(id), node: own, code, signature };
      take(m); posted = true;
      try { await post(m); } catch { /* the others read GET /founding too */ }
    } catch (e) { say({ founding: toHex(id).slice(0, 16), ownCode: `not made yet: ${e.message}` }); }
  }
  async function advance(tip) {
    if (!draw.ok || phase === PHASE.VOID || phase === PHASE.RUNNING) return state();
    // THE FEDERATION RUNS: this node's guardian, seated and past its DKG, is in consensus
    if (started && setup && typeof setup.done === 'function') {
      try { if (await setup.done()) { step(PHASE.RUNNING); say({ founding: toHex(id).slice(0, 16), federation: 'running', at: tip }); return state(); } } catch { /* asked again next advance */ }
    }
    // VOID: the window passed without a federation (§23A.2) - the next trigger draws again
    if (tip >= windowEnd) {
      step(PHASE.VOID, `the founding window (${foundingWindow} blocks from the beacon ${beacon}) passed at ${windowEnd} without a federation: void, the next trigger draws again`);
      say({ founding: toHex(id).slice(0, 16), void: true, at: tip, windowEnd });
      return state();
    }
    // THIS NODE'S CODE, once it is seated (position 0 leads: it names the federation and its size) - BEFORE the no-shows are counted
    // (kanban #495, measured 2026-10-21 10:22Z: seated nodes restarted after the beacon held no code of their own at their first
    // advance past the fifth, so each counted itself a no-show and the founding e8741283 went void at 4 seats); a seat that cannot
    // reach its guardian's setup yet counts as before
    await postOwn();
    // NO-SHOWS: a seated node with no code a fifth of the window after it was seated - only while the DKG has not started
    if (!started) {
      let missing = seated.filter((e) => !codes.has(toHex(e.pubkey)) && tip >= seatedSince.get(toHex(e.pubkey)) + fifth).map((e) => toHex(e.pubkey));
      // TEN ARE ENOUGH: only as many no-shows as the alternates can replace; the others keep their seats until the window's end
      while (missing.length && !replaceNoShows({ drawn: draw.drawn, alternates: draw.alternates, noShows: [...noShows, ...missing] }).ok) missing = missing.slice(0, -1);
      if (missing.length) {
        for (const k of missing) noShows.add(k);
        const r = replaceNoShows({ drawn: draw.drawn, alternates: draw.alternates, noShows: [...noShows] });
        if (!r.ok) { step(PHASE.VOID, `${r.why}: void`); say({ founding: toHex(id).slice(0, 16), failed }); return state(); }
        seated = r.seated;
        for (const e of seated) if (!seatedSince.has(toHex(e.pubkey))) seatedSince.set(toHex(e.pubkey), tip);
        say({ founding: toHex(id).slice(0, 16), noShows: missing.map((k) => k.slice(0, 8)), at: tip, seated: seated.map((e) => toHex(e.pubkey).slice(0, 8)) });
      }
    }
    if (started) return state();
    // ... and again once the no-shows are counted: an alternate seated just now posts its code in this same advance
    await postOwn();
    // THE KEY GENERATION, once every seated node's code is held
    if (setup && isSeated(own) && posted && seated.every((e) => codes.has(toHex(e.pubkey)))) {
      // EACH PEER ADDED ONCE (kanban #577, measured 2026-10-26 on foundings 3976076b and d8e88fd3: one add-peer that failed - a guardian
      // not up yet - sent the next tick through the whole list again, and the guardian refused the leader's code a second time with
      // "Federation name has already been set to arena" on every tick after, so no seat ever reached start-dkg and both foundings stalled
      // with all ten codes held): a peer taken is not asked again, and a guardian that answers that it already holds it counts as taken
      for (const e of seated) {
        const k = toHex(e.pubkey);
        if (k === own || added.has(k)) continue;
        try { await setup.addPeer(codes.get(k).code); }
        catch (err) { if (!/already been set|already added|already exists|duplicate/i.test(String(err && err.message))) throw err; }
        added.add(k);
      }
      await setup.startDkg();
      started = true; step(PHASE.DKG);
      try { invite = await setup.invite(); } catch { invite = null; }
      say({ founding: toHex(id).slice(0, 16), dkg: 'started', seated: seated.length, invite: invite ? String(invite).slice(0, 24) : null });
    }
    return state();
  }

  function state() {
    return { id: toHex(id), ok: draw.ok, why: draw.ok ? null : draw.why, eligible: draw.eligible, seatedFirst: draw.seatedFirst || 0, beacon, windowEnd, fifth, foundingWindow,
      seated: seated.map((e, i) => ({ position: i, node: toHex(e.pubkey), code: codes.has(toHex(e.pubkey)), since: seatedSince.get(toHex(e.pubkey)) })),
      alternates: (draw.alternates || []).map((e) => toHex(e.pubkey)), noShows: [...noShows], started, phase, federation: phase === PHASE.RUNNING, void: phase === PHASE.VOID, failed, invite,
      codes: [...codes.entries()].map(([node, c]) => ({ node, code: c.code, signature: c.signature })) };
  }
  // a code to take again from a peer's GET /founding (the codes list, as state() shows it)
  const takeAll = (list) => (list || []).map((c) => take({ id: toHex(id), ...c }));
  return { id: toHex(id), take, takeAll, advance, state, federationSeen };
}
