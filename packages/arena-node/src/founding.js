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
//               founding_window with no federation running (the seated guardian's consensus, `setup.done()`, or a peer that says
//               so), the founding is void - and so is one whose alternates ran out.
//   SEATED FIRST a succession (§23A.6 step 1) seats the old federation's seated, non-departing guardians first, in
//               the order given (`seatedFirst`, census entries), and draws only the missing seats (drawGuardians). A seated-first
//               node is held to the same window and fifth as a drawn one: no code a fifth after the beacon, and the next alternate
//               takes its position.
//   DKG         once every seated node's code is held, each seated node adds the others' codes to its guardian and starts the
//               key generation; its guardian then names the federation (invite) like any other.
//
// `setup` is injected - { localParams({ leader, name, size }), addPeer(code), startDkg(), invite(), done() } - so a test runs it in memory
// and a rehearsal against real fedimintd (tools/rehearsal-20.mjs). Nothing here moves money.
import { drawGuardians, replaceNoShows } from '../../arena-protocol/src/guardian-founding.js';
import { Writer } from '../../arena-protocol/src/encode.js';
import { taggedHash, toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { tagAt, tagsAccepted, TAG_PAIRS } from '../../arena-protocol/src/tag-switch.js';

/** The founding's id: H(founding tag, seed || trigger_height) - one per beacon and trigger; the tag by the trigger height (kanban #525). */
export function foundingId(seed, triggerHeight) {
  const w = new Writer(); w.bytes32(seed); w.u32(triggerHeight);
  return taggedHash(tagAt('founding', { height: triggerHeight }), w.finish());
}
/** What a setup code's signature covers: H(setup tag, id || node || code) - under the tag of the founding's trigger height, or `tag`. */
export function setupDigest(id, node, code, tag = TAG_PAIRS.foundingSetup[0]) {
  const c = new TextEncoder().encode(String(code));
  const w = new Writer(); w.bytes32(id); w.bytes32(node); w.u32(c.length);
  return taggedHash(tag, Uint8Array.from([...w.finish(), ...c]));
}

export function createFounding({ seed, triggerHeight, entries, nominal, bondMinGuardian, guardingOpen = new Set(), seatedFirst = [], foundingWindow,
  ownKey, sign, verify, setup = null, post = async () => {}, name = 'arena', say = () => {} }) {
  const draw = drawGuardians({ entries, seed, height: triggerHeight, nominal, bondMinGuardian, guardingOpen, seatedFirst });
  const id = foundingId(seed, triggerHeight);
  const own = toHex(ownKey);
  const codes = new Map();                   // node hex -> { code, signature }
  const noShows = new Set();
  let seated = draw.ok ? draw.drawn.slice() : [];
  const beacon = triggerHeight + 1;          // the block whose hash is the seed: the window opens here, once
  const windowEnd = beacon + foundingWindow; // ... and closes here, replacements or not
  const fifth = Math.max(1, Math.ceil(foundingWindow / 5));
  const seatedSince = new Map(seated.map((e) => [toHex(e.pubkey), beacon]));   // node hex -> the height it was seated at
  let posted = false, started = false, failed = null, invite = null, federation = false, voided = null;
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

  /** A peer says the federation runs (its GET /founding `federation`): no void here for a federation that exists. */
  const federationSeen = () => { federation = true; };
  /**
   * One advance at chain height `tip`: the void at the window's end, no-shows past their fifth, this node's code, the DKG once all
   * codes are in, and whether the federation now runs.
   */
  async function postOwn() {
    if (started || !setup || !isSeated(own) || posted) return;
    try {
      const code = await setup.localParams({ leader: position(own) === 0, name, size: nominal });
      const signature = toHex(sign(setupDigest(id, ownKey, code, tagAt('foundingSetup', { height: triggerHeight }))));
      const m = { id: toHex(id), node: own, code, signature };
      take(m); posted = true;
      try { await post(m); } catch { /* the others read GET /founding too */ }
    } catch (e) { say({ founding: toHex(id).slice(0, 16), ownCode: `not made yet: ${e.message}` }); }
  }
  async function advance(tip) {
    if (!draw.ok || failed || federation) return state();
    // THE FEDERATION RUNS: this node's guardian, seated and past its DKG, is in consensus
    if (started && setup && typeof setup.done === 'function') {
      try { if (await setup.done()) { federation = true; say({ founding: toHex(id).slice(0, 16), federation: 'running', at: tip }); return state(); } } catch { /* asked again next advance */ }
    }
    // VOID: the window passed without a federation (§23A.2) - the next trigger draws again
    if (tip >= windowEnd) {
      failed = voided = `the founding window (${foundingWindow} blocks from the beacon ${beacon}) passed at ${windowEnd} without a federation: void, the next trigger draws again`;
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
      const missing = seated.filter((e) => !codes.has(toHex(e.pubkey)) && tip >= seatedSince.get(toHex(e.pubkey)) + fifth).map((e) => toHex(e.pubkey));
      if (missing.length) {
        for (const k of missing) noShows.add(k);
        const r = replaceNoShows({ drawn: draw.drawn, alternates: draw.alternates, noShows: [...noShows] });
        if (!r.ok) { failed = voided = `${r.why}: void`; say({ founding: toHex(id).slice(0, 16), failed }); return state(); }
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
      for (const e of seated) { const k = toHex(e.pubkey); if (k !== own) await setup.addPeer(codes.get(k).code); }
      await setup.startDkg();
      started = true;
      try { invite = await setup.invite(); } catch { invite = null; }
      say({ founding: toHex(id).slice(0, 16), dkg: 'started', seated: seated.length, invite: invite ? String(invite).slice(0, 24) : null });
    }
    return state();
  }

  function state() {
    return { id: toHex(id), ok: draw.ok, why: draw.ok ? null : draw.why, eligible: draw.eligible, seatedFirst: draw.seatedFirst || 0, beacon, windowEnd, fifth, foundingWindow,
      seated: seated.map((e, i) => ({ position: i, node: toHex(e.pubkey), code: codes.has(toHex(e.pubkey)), since: seatedSince.get(toHex(e.pubkey)) })),
      alternates: (draw.alternates || []).map((e) => toHex(e.pubkey)), noShows: [...noShows], started, federation, void: !!voided, failed, invite,
      codes: [...codes.entries()].map(([node, c]) => ({ node, code: c.code, signature: c.signature })) };
  }
  // a code to take again from a peer's GET /founding (the codes list, as state() shows it)
  const takeAll = (list) => (list || []).map((c) => take({ id: toHex(id), ...c }));
  return { id: toHex(id), take, takeAll, advance, state, federationSeen };
}
