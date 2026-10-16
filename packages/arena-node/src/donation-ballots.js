// THE DEVELOPERS' BALLOTS A SEAT KEEPS (§27A.4.1, kanban #382): every DonationProposal and DonationApproval it was handed - by a
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

/** `db` a better-sqlite3 handle; `knownSets()` the admin key's sets this seat holds; `verifySecp256k1(sig, digest, pubkey)`. */
export function createDonationBallots({ db, knownSets, verifySecp256k1, log = () => {} }) {
  db.exec(`CREATE TABLE IF NOT EXISTS donation_ballots (id TEXT PRIMARY KEY, kind TEXT NOT NULL, proposal TEXT NOT NULL, hex TEXT NOT NULL, at_ms INTEGER NOT NULL)`);
  let approvedSets = [];
  let tallies = new Map();   // proposal id -> tally
  const rows = () => db.prepare('SELECT kind, proposal, hex FROM donation_ballots ORDER BY at_ms').all();
  const split = (hex) => { const b = fromHex(hex); if (b.length <= SIG_BYTES) throw new Error('no signature'); return { body: b.slice(0, -SIG_BYTES), signature: b.slice(-SIG_BYTES) }; };
  const ballots = () => {
    const byId = new Map();
    for (const r of rows()) {
      try {
        const { body, signature } = split(r.hex);
        if (r.kind === 'proposal') { const p = { ...decodeDonationProposal(body), signature }; byId.set(r.proposal, { ...(byId.get(r.proposal) || { approvals: [] }), proposal: p, hex: r.hex }); }
        else { const a = { ...decodeDonationApproval(body), signature, hex: r.hex }; const b = byId.get(r.proposal) || { approvals: [] }; b.approvals.push(a); byId.set(r.proposal, b); }
      } catch { /* a row that no longer decodes is not counted */ }
    }
    return byId;
  };
  async function retally() {
    const byId = ballots();
    const known = (knownSets() || []).map((s) => ({ ...s }));
    const withProposal = [...byId.values()].filter((b) => b.proposal);
    const nets = [...new Set(withProposal.map((b) => toHex(b.proposal.networkId)))];
    const sets = [];
    for (const net of nets) {
      const r = await approvedDonationSets({ networkId: fromHex(net), known: known.filter((s) => toHex(s.networkId) === net),
        ballots: withProposal.filter((b) => toHex(b.proposal.networkId) === net), verifySecp256k1 });
      sets.push(...r.sets);
    }
    const t = new Map();
    for (const b of withProposal) {
      const all = [...known, ...sets];
      const parent = all.find((s) => toHex(donationSetId(s.recipients)) === toHex(b.proposal.parentSetId));
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
      if (kind === 'approval' && !ballots().has(digestKey)) return { ok: false, status: 404, why: 'this seat holds no such proposal: send the proposal first' };
      // the signature now, so nothing unsigned is ever kept or forwarded
      const digest = kind === 'proposal' ? donationProposalId(obj) : donationApprovalDigest(obj);
      const signer = kind === 'proposal' ? obj.proposer : obj.signer;
      if (!(await verifySecp256k1(obj.signature, digest, signer))) return { ok: false, status: 400, why: 'the signature does not verify' };
      const id = toHex(digest);
      if (db.prepare('SELECT 1 FROM donation_ballots WHERE id = ?').get(id)) return { ok: true, fresh: false, id };
      db.prepare('INSERT INTO donation_ballots (id, kind, proposal, hex, at_ms) VALUES (?, ?, ?, ?, ?)').run(id, kind, digestKey, String(hex).toLowerCase(), Date.now());
      await retally();
      return { ok: true, fresh: true, id, proposal: digestKey };
    },
    /** Every proposal: its bytes, its approvals' bytes, its tally. */
    list() {
      return [...ballots().entries()].filter(([, b]) => b.proposal).map(([id, b]) => {
        const t = tallies.get(id) || { state: 'open', acceptBps: 0, denyBps: 0, counted: [] };
        const p = b.proposal;
        return { id, serial: String(p.serial), network: toHex(p.networkId), parentSetId: toHex(p.parentSetId), proposer: toHex(p.proposer),
          recipients: p.recipients.map((r) => ({ key: toHex(r.recipientPk), shareBps: r.shareBps, label: r.label })),
          state: t.state, validFrom: t.validFrom ?? null, acceptBps: t.acceptBps, denyBps: t.denyBps, why: t.why || null,
          votes: (t.counted || []).map((c) => ({ key: c.key, accept: c.accept, atHeight: c.atHeight, bps: c.bps })),
          hex: b.hex, approvals: b.approvals.map((a) => a.hex) };
      });
    },
    /** The ballots behind an approved set, newest first, back to the admin key's set: [{ proposal hex, approvals hex[] }]. */
    chainOf(set) {
      const byId = ballots();
      const out = [];
      let cur = set;
      for (let i = 0; i < 64 && cur && cur.approvedBy; i++) {
        const b = byId.get(toHex(cur.approvedBy));
        if (!b || !b.proposal) break;
        out.push({ proposal: b.hex, approvals: b.approvals.map((a) => a.hex) });
        const parentId = toHex(b.proposal.parentSetId);
        cur = approvedSets.find((s) => toHex(donationSetId(s.recipients)) === parentId) || null;
      }
      return out;
    },
  };
}
