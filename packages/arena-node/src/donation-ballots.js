// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE DEVELOPERS' BALLOTS A SEAT KEEPS (§27A.4.1): every DonationProposal and DonationApproval it was handed - by a
// developer's node, by the owner page, or forwarded by another seat - kept in its store, checked, and tallied against the sets
// it holds (the admin key's, and those approved before). What it answers:
//   approved()          the sets the developers approved, for donationSetInForce's `approved` (each with `approvedBy`)
//   chainOf(set)        the proposal and approvals behind an approved set, back to the admin key's set it replaces - what a
//                       page checks for itself before it pays a split no admin key signed
//   list()              every proposal with its tally, for the owner page
//   add(kind, hex)      a new object: decoded, checked, kept, the tally run again; `true` when it was new
// A proposal or approval that does not stand is not kept. Forwarding is the server's (it knows the peers).
import { decodeDonationProposal, decodeDonationApproval, donationProposalId, donationApprovalDigest, tallyDonationProposal, approvedDonationSets } from '../../arena-protocol/src/donation-vote.js';
import { donationSetId } from '../../arena-protocol/src/donation.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';

const SIG_BYTES = 64;
// kanban #1528: what one seat keeps is bounded - every row is re-read and re-checked on each tally.
// kanban #1899, #1939: bounded PER SIGNER, never globally - a global row cap (4096) and a per-proposal approval cap (256)
// let one recipient, whatever its share, fill the room the others need (its own proposals, or its own repeat approvals,
// which the tally counts once) and lock the developers' ballot for good. Each limit below only ever stops the key that hit it.
const MAX_OPEN_PER_PROPOSER = 8;      // open proposals (not approved, refused or withdrawn) one recipient has under one parent set
const MAX_KEPT_PER_PROPOSER = 256;    // proposals of any state but approved one recipient has under one parent set
const MAX_ROWS_PER_SIGNER = 8;        // approvals one recipient has stored for one proposal (only its earliest is counted)

/** `db` a better-sqlite3 handle; `knownSets()` the admin key's sets this seat holds; `verifySecp256k1(sig, digest, pubkey)`. */
export function createDonationBallots({ db, knownSets, verifySecp256k1, log = () => {} }) {
  db.exec(`CREATE TABLE IF NOT EXISTS donation_ballots (id TEXT PRIMARY KEY, kind TEXT NOT NULL, proposal TEXT NOT NULL, hex TEXT NOT NULL, at_ms INTEGER NOT NULL)`);
  let approvedSets = [];
  let tallies = new Map();   // proposal id -> tally
  const rows = () => db.prepare('SELECT kind, proposal, hex FROM donation_ballots ORDER BY at_ms').all();
  const split = (hex) => { const b = fromHex(hex); if (b.length <= SIG_BYTES) throw new Error('no signature'); return { body: b.slice(0, -SIG_BYTES), signature: b.slice(-SIG_BYTES) }; };
  // kanban #1528, #1710, #1775: a recipient key of a set (an LNURL entry has none, so it never matches - and never throws)
  const keyIn = (set, keyHex) => !!(set && Array.isArray(set.recipients) && set.recipients.some((r) => r && r.recipientPk instanceof Uint8Array && toHex(r.recipientPk) === keyHex));
  const setIdHex = (s) => { try { return toHex(donationSetId(s.recipients)); } catch { return null; } };
  const findSet = (sets, idHex) => sets.find((s) => setIdHex(s) === idHex) || null;
  // kanban #2062, #2081: a proposal's parent is a held set OF ITS OWN NETWORK (approvedDonationSets reads it so) - found by
  // recipients alone, a proposal naming any made-up network under a held set's recipients was kept and tallied 'approved'
  // on the majority key's own accept, yet never a set anywhere
  const netHex = (s) => { try { return toHex(s.networkId); } catch { return null; } };
  const parentOf = (sets, p) => findSet(sets.filter((s) => netHex(s) !== null && netHex(s) === toHex(p.networkId)), toHex(p.parentSetId));
  // kanban #2062, #2081: and its serial is above the parent's, as approvedDonationSets requires - one at or below it is
  // never a set in force, whatever its tally
  const aboveParent = (p, parent) => { try { return p.serial > parent.serial; } catch { return false; } };
  // Every stored row, decoded - and, given `parents` (the sets this seat holds), only the rows whose signer may sign them:
  // a proposal whose parent set is held and whose proposer is a key recipient of it, an approval of such a proposal whose
  // signer is a key recipient of the same parent. kanban #1710, #1775: the same check add() makes, applied on every read, so a
  // stranger's row a seat kept before #1528 is never listed, re-tallied, chained or counted against a cap (it stays in the
  // table - nothing is deleted - but it is read as if it were not there).
  // kanban #1899, #1939: of one signer's approvals of one proposal only its first vote stands - the earliest atHeight, as
  // tallyDonationProposal counts it, and at the same height the smaller digest, so every seat holding the same rows reads
  // the same one whatever order they came in. The others stay in the table (nothing is deleted) but are read as if not there,
  // so a proposal never holds more read approvals than its parent set has recipients.
  const firstVote = (x, y) => x.atHeight - y.atHeight || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0);
  const firstVotes = (approvals) => {
    const by = new Map();
    for (const a of approvals) { const k = toHex(a.signer); const c = by.get(k); if (!c || firstVote(a, c) < 0) by.set(k, a); }
    return approvals.filter((a) => by.get(toHex(a.signer)) === a);
  };
  const ballots = (parents = null) => {
    const byId = new Map();
    for (const r of rows()) {
      try {
        const { body, signature } = split(r.hex);
        if (r.kind === 'proposal') { const p = { ...decodeDonationProposal(body), signature }; byId.set(r.proposal, { ...(byId.get(r.proposal) || { approvals: [] }), proposal: p, hex: r.hex }); }
        else { const a = { ...decodeDonationApproval(body), signature, hex: r.hex }; a.id = toHex(donationApprovalDigest(a)); const b = byId.get(r.proposal) || { approvals: [] }; b.approvals.push(a); byId.set(r.proposal, b); }
      } catch { /* a row that no longer decodes is not counted */ }
    }
    // ONE ORDER ON EVERY SEAT (kanban #2068, #1524, wf1489 v1 refute-30 s4): the approvals were listed as they reached this seat
    // (at_ms), so honest seats served the same approved set in different bytes and a page grouping their answers found no quorum.
    // Oldest height first, then signer, then the bytes - the order the tally counts them in, the same on every seat that holds them.
    const cmp = (x, y) => (x < y ? -1 : x > y ? 1 : 0);
    for (const b of byId.values()) b.approvals.sort((x, y) => x.atHeight - y.atHeight || cmp(toHex(x.signer), toHex(y.signer)) || cmp(x.hex, y.hex));
    if (!parents) return byId;
    const out = new Map();
    for (const [id, b] of byId) {
      if (!b.proposal) continue;
      // kanban #2062, #2081: rows kept before these checks (another network, a serial not above the parent's) are read as if not there
      const parent = parentOf(parents, b.proposal);
      if (!parent || !aboveParent(b.proposal, parent) || !keyIn(parent, toHex(b.proposal.proposer))) continue;
      out.set(id, { ...b, all: b.approvals, approvals: firstVotes(b.approvals.filter((a) => keyIn(parent, toHex(a.signer)))) });
    }
    return out;
  };
  const heldSets = () => [...(knownSets() || []), ...approvedSets];
  async function retally() {
    const known = (knownSets() || []).map((s) => ({ ...s }));
    // kanban #1710, #1775: only the rows signed by a recipient of a set held - the admin key's, or one these very rows approve
    // (a chain), so the read widens until the approved sets stop growing
    let sets = [];
    let withProposal = [];
    for (let round = 0; round < 65; round++) {
      withProposal = [...ballots([...known, ...sets]).values()];
      const nets = [...new Set(withProposal.map((b) => toHex(b.proposal.networkId)))];
      const next = [];
      for (const net of nets) {
        const r = await approvedDonationSets({ networkId: fromHex(net), known: known.filter((s) => toHex(s.networkId) === net),
          ballots: withProposal.filter((b) => toHex(b.proposal.networkId) === net), verifySecp256k1 });
        next.push(...r.sets);
      }
      const ids = (xs) => xs.map((s) => toHex(s.approvedBy)).sort().join(',');
      const same = ids(next) === ids(sets);
      sets = next;
      if (same) break;
    }
    const t = new Map();
    for (const b of withProposal) {
      const all = [...known, ...sets];
      const parent = parentOf(all, b.proposal);   // kanban #2062, #2081: of the proposal's own network
      t.set(toHex(donationProposalId(b.proposal)), parent ? await tallyDonationProposal({ proposal: b.proposal, approvals: b.approvals, parent: parent.recipients, verifySecp256k1 })
        : { state: 'refused', why: 'its parent set is not one this seat holds', acceptBps: 0, denyBps: 0, counted: [] });
    }
    const before = new Set(approvedSets.map((s) => toHex(s.approvedBy)));
    approvedSets = sets; tallies = t;
    for (const s of sets) if (!before.has(toHex(s.approvedBy))) log(`[donation-ballot] approved: serial ${s.serial}, in force from height ${s.validFrom} (${s.recipients.map((r) => (r.label || toHex(r.recipientPk).slice(0, 8)) + ' ' + r.shareBps).join(', ')})`);
  }
  return {
    approved: () => approvedSets,
    retally,
    /** A new proposal or approval as hex (body || 64-byte signature): kept if it decodes and its signer may sign it. */
    async add(kind, hex) {
      if (kind !== 'proposal' && kind !== 'approval') return { ok: false, status: 400, why: 'a proposal or an approval' };
      let obj;
      try { const { body, signature } = split(String(hex || '').toLowerCase()); obj = kind === 'proposal' ? { ...decodeDonationProposal(body), signature } : { ...decodeDonationApproval(body), signature }; }
      catch (e) { return { ok: false, status: 400, why: `that is no donation ${kind}: ${e.message}` }; }
      const digestKey = kind === 'proposal' ? toHex(donationProposalId(obj)) : toHex(obj.proposalId);
      const held = kind === 'approval' ? ballots(heldSets()).get(digestKey) : null;
      if (kind === 'approval' && !(held && held.proposal)) return { ok: false, status: 404, why: 'this seat holds no such proposal: send the proposal first' };
      // kanban #1528: kept only when signed by a recipient of a parent set this seat holds (the admin key's, or one approved
      // before) - before, any self-signed object from a key minted at will was kept for good, answered fresh and so forwarded
      // to every seat, and re-tallied on every add
      const prop = kind === 'proposal' ? obj : held.proposal;
      const parentId = toHex(prop.parentSetId);
      // kanban #2062, #2081: the parent among the held sets of the proposal's own network, and the serial above the parent's
      const parent = parentOf(heldSets(), prop);
      if (!parent) return { ok: false, status: 403, why: 'its parent set is not one this seat holds on its network' };
      if (!aboveParent(prop, parent)) return { ok: false, status: 403, why: `its serial is not above its parent set's (${parent.serial})` };
      const signerHex = toHex(kind === 'proposal' ? obj.proposer : obj.signer);
      // kanban #1710, #1775: an LNURL entry has no key - compared as no match, never toHex(undefined) and a 500
      if (!keyIn(parent, signerHex)) return { ok: false, status: 403, why: 'its signer is no recipient of the parent set' };
      // the signature now, so nothing unsigned is ever kept or forwarded
      const digest = kind === 'proposal' ? donationProposalId(obj) : donationApprovalDigest(obj);
      const signer = kind === 'proposal' ? obj.proposer : obj.signer;
      if (!(await verifySecp256k1(obj.signature, digest, signer))) return { ok: false, status: 400, why: 'the signature does not verify' };
      const id = toHex(digest);
      // kanban #1899, #1939: a retry of a row already kept is answered as held before any cap, never 429
      if (db.prepare('SELECT 1 FROM donation_ballots WHERE id = ?').get(id)) return { ok: true, fresh: false, id };
      // kanban #1899, #1939: every limit is the signer's own, so no recipient can use up the room another one needs
      if (kind === 'approval') {
        const counted = held.approvals.find((a) => toHex(a.signer) === signerHex);
        const mine = (held.all || []).filter((a) => toHex(a.signer) === signerHex).length;
        if (mine >= MAX_ROWS_PER_SIGNER) {
          // its vote is already counted from an earlier one: this later one changes nothing and is not kept
          if (counted && firstVote(counted, { atHeight: obj.atHeight, id }) <= 0) return { ok: true, fresh: false, id, counted: counted.id };
          return { ok: false, status: 429, why: 'this seat keeps no more approvals of this proposal by this signer' };
        }
        // (never reached: read approvals are one per signer, and the signer is a recipient of the parent)
        if (!counted && held.approvals.length >= parent.recipients.length) return { ok: false, status: 429, why: 'this proposal holds an approval by every recipient' };
      } else {
        // kanban #2062, #2081: left out of the caps only a proposal that IS an approved set in force - a tally of 'approved'
        // alone is no set (another network, a serial not above the parent's) and still counts against its proposer
        const isSet = (pid) => approvedSets.some((s) => s.approvedBy && toHex(s.approvedBy) === pid);
        const mine = [...ballots(heldSets()).entries()].filter(([pid, b]) => b.proposal && toHex(b.proposal.proposer) === signerHex && toHex(b.proposal.parentSetId) === parentId
            && toHex(b.proposal.networkId) === toHex(obj.networkId) && !isSet(pid))
          .map(([pid]) => (tallies.get(pid) || { state: 'open' }).state);
        if (mine.filter((st) => st === 'open').length >= MAX_OPEN_PER_PROPOSER) return { ok: false, status: 429, why: 'this signer has as many open proposals on this parent set as a seat keeps: withdraw one first' };
        if (mine.length >= MAX_KEPT_PER_PROPOSER) return { ok: false, status: 429, why: 'this seat keeps no more proposals by this signer on this parent set' };
      }
      db.prepare('INSERT INTO donation_ballots (id, kind, proposal, hex, at_ms) VALUES (?, ?, ?, ?, ?)').run(id, kind, digestKey, String(hex).toLowerCase(), Date.now());
      await retally();
      return { ok: true, fresh: true, id, proposal: digestKey };
    },
    /** Every proposal: its bytes, its approvals' bytes, its tally. */
    list() {
      return [...ballots(heldSets()).entries()].filter(([, b]) => b.proposal).map(([id, b]) => {
        const t = tallies.get(id) || { state: 'open', acceptBps: 0, denyBps: 0, counted: [] };
        const p = b.proposal;
        return { id, serial: String(p.serial), network: toHex(p.networkId), parentSetId: toHex(p.parentSetId), proposer: toHex(p.proposer),
          recipients: p.recipients.map((r) => ({ key: toHex(r.recipientPk), shareBps: r.shareBps, label: r.label, ...(r.vesting ? { vesting: r.vesting } : {}) })),
          state: t.state, validFrom: t.validFrom ?? null, acceptBps: t.acceptBps, denyBps: t.denyBps, why: t.why || null,
          votes: (t.counted || []).map((c) => ({ key: c.key, accept: c.accept, atHeight: c.atHeight, bps: c.bps })),
          hex: b.hex, approvals: b.approvals.map((a) => a.hex) };
      });
    },
    /** The ballots behind an approved set, newest first, back to the admin key's set: [{ proposal hex, approvals hex[] }]. */
    chainOf(set) {
      const byId = ballots(heldSets());
      const out = [];
      let cur = set;
      for (let i = 0; i < 64 && cur && cur.approvedBy; i++) {
        const b = byId.get(toHex(cur.approvedBy));
        if (!b || !b.proposal) break;
        out.push({ proposal: b.hex, approvals: b.approvals.map((a) => a.hex) });
        const parentId = toHex(b.proposal.parentSetId);
        cur = findSet(approvedSets, parentId);
      }
      return out;
    },
  };
}
