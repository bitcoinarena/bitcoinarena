// A FOUNDING CEREMONY, AS A SEAT RUNS IT (spec §23A.2, kanban #320): the draw is guardian-founding.js (arena-protocol); this is
// what the drawn nodes do with it. Every seat computes the same draw from the census and the beacon after trigger_height, so no
// message decides who sits - the messages only carry what the guardians need to find each other:
//
//   SETUP CODE  a seated node starts its guardian in setup mode, takes its setup code (fedimint's set-local-params: the seat at
//               position 0 leads and names the federation and its size) and posts it signed with its node key:
//               (founding id, node key, code). A code from a node neither drawn nor an alternate, from a no-show, or not signed
//               by its node, is refused; an alternate's code is kept before it is seated and counts once it is.
//   NO-SHOW     founding_window blocks after the window opened, a seated node with no code is a no-show: it is replaced by the
//               next alternate in order, in its position (replaceNoShows), and a new window opens for the replacement.
//   DKG         once every seated node's code is held, each seated node adds the others' codes to its guardian and starts the
//               key generation; its guardian then names the federation (invite) like any other.
//
// `setup` is injected - { localParams({ leader, name, size }), addPeer(code), startDkg(), invite() } - so a test runs it in memory
// and a rehearsal against real fedimintd (tools/rehearsal-20.mjs). Nothing here moves money.
import { drawGuardians, replaceNoShows } from '../../arena-protocol/src/guardian-founding.js';
import { Writer } from '../../arena-protocol/src/encode.js';
import { taggedHash, toHex, fromHex } from '../../arena-protocol/src/hash.js';

/** The founding's id: H('BLWP/v1/FOUNDING', seed || trigger_height) - one per beacon and trigger. */
export function foundingId(seed, triggerHeight) {
  const w = new Writer(); w.bytes32(seed); w.u32(triggerHeight);
  return taggedHash('BLWP/v1/FOUNDING', w.finish());
}
/** What a setup code's signature covers: H('BLWP/v1/FOUNDING_SETUP', id || node || code). */
export function setupDigest(id, node, code) {
  const c = new TextEncoder().encode(String(code));
  const w = new Writer(); w.bytes32(id); w.bytes32(node); w.u32(c.length);
  return taggedHash('BLWP/v1/FOUNDING_SETUP', Uint8Array.from([...w.finish(), ...c]));
}

export function createFounding({ seed, triggerHeight, entries, nominal, bondMinGuardian, guardingOpen = new Set(), foundingWindow,
  ownKey, sign, verify, setup = null, post = async () => {}, name = 'arena', say = () => {} }) {
  const draw = drawGuardians({ entries, seed, nominal, bondMinGuardian, guardingOpen });
  const id = foundingId(seed, triggerHeight);
  const own = toHex(ownKey);
  const codes = new Map();                   // node hex -> { code, signature }
  const noShows = new Set();
  let seated = draw.ok ? draw.drawn.slice() : [];
  let windowFrom = triggerHeight;            // the window of the seated set now: from the trigger, then from each replacement
  let posted = false, started = false, failed = null, invite = null;
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
    if (!verify(sig, setupDigest(id, fromHex(node), m.code), fromHex(node))) return { ok: false, status: 409, why: 'the code is not signed by its node' };
    if (codes.has(node)) return { ok: true, status: 200, kept: false };
    codes.set(node, { code: String(m.code), signature: String(m.signature) });
    return { ok: true, status: 201, kept: true };
  }

  /** One step at chain height `tip`: post this node's code, replace no-shows past the window, run the DKG once all codes are in. */
  async function step(tip) {
    if (!draw.ok) return state();
    if (failed || started) return state();
    // NO-SHOWS: founding_window after the window opened, the seated without a code
    if (tip >= windowFrom + foundingWindow) {
      const missing = seated.filter((e) => !codes.has(toHex(e.pubkey))).map((e) => toHex(e.pubkey));
      if (missing.length) {
        for (const k of missing) noShows.add(k);
        const r = replaceNoShows({ drawn: draw.drawn, alternates: draw.alternates, noShows: [...noShows] });
        if (!r.ok) { failed = r.why; say({ founding: toHex(id).slice(0, 16), failed }); return state(); }
        seated = r.seated; windowFrom = tip;
        say({ founding: toHex(id).slice(0, 16), noShows: missing.map((k) => k.slice(0, 8)), seated: seated.map((e) => toHex(e.pubkey).slice(0, 8)), windowFrom });
      }
    }
    // THIS NODE'S CODE, once it is seated (position 0 leads: it names the federation and its size)
    if (setup && isSeated(own) && !posted) {
      const code = await setup.localParams({ leader: position(own) === 0, name, size: nominal });
      const signature = toHex(sign(setupDigest(id, ownKey, code)));
      const m = { id: toHex(id), node: own, code, signature };
      take(m); posted = true;
      try { await post(m); } catch { /* the others read GET /founding too */ }
    }
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
    return { id: toHex(id), ok: draw.ok, why: draw.ok ? null : draw.why, eligible: draw.eligible, windowFrom, foundingWindow,
      seated: seated.map((e, i) => ({ position: i, node: toHex(e.pubkey), code: codes.has(toHex(e.pubkey)) })),
      alternates: (draw.alternates || []).map((e) => toHex(e.pubkey)), noShows: [...noShows], started, failed, invite,
      codes: [...codes.entries()].map(([node, c]) => ({ node, code: c.code, signature: c.signature })) };
  }
  // a code to take again from a peer's GET /founding (the codes list, as state() shows it)
  const takeAll = (list) => (list || []).map((c) => take({ id: toHex(id), ...c }));
  return { id: toHex(id), take, takeAll, step, state };
}
