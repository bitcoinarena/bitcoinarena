// THE FUNDING PROPOSALS A SEAT KEEPS (§27A.9.3 stage 1, kanban #397 slice 6): every proposal, comment and signal it was handed - by its
// owner's own node, by a writer, or forwarded by another seat - checked, kept in its store and listed with the signal's state. Signals
// are signed messages the seats keep and pass on (the owner 2026-10-16), never on chain; they weigh one per node and move no money.
//
//   add(kind, hex)   a new object (body || 64-byte BIP340 signature): kept when it stands - a proposal by a bonded node and not dated
//                    ahead of this seat's chain, a comment or signal on a proposal held here; `fresh` when it was new (the server
//                    forwards it once)
//   list()           every proposal with its comments, its signals and its signal's state
//   decide()         each proposal whose signal period is over is decided ONCE, on the nodes active in the 432 blocks before its end
//                    (`activeAt(endHeight)`, from the seats' signed FINALs) - written down, so a seat's answer does not move later
import { readSignedFunding, signalOutcome, FUNDING_SCHEDULES } from '../../arena-protocol/src/funding.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';

export const FUNDING_SQL = `CREATE TABLE IF NOT EXISTS funding_items (id TEXT PRIMARY KEY, kind TEXT NOT NULL, proposal TEXT NOT NULL, hex TEXT NOT NULL, at_ms INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS funding_outcomes (proposal TEXT PRIMARY KEY, outcome TEXT NOT NULL, decided_ms INTEGER NOT NULL)`;

/**
 * `db` a better-sqlite3 handle; `verify(sig, digest, key32)` BIP340; `isBonded(nodeHex)` true / false, or null when this seat cannot
 * tell yet; `tip()` this seat's height (a promise; null when unknown); `activeAt(endHeight)` -> { ok, nodes: [hex] } or { ok: false, why };
 * `schedule` FUNDING_SCHEDULES.spec unless a live proof runs the short one.
 */
export function createFundingBook({ db, verify, isBonded, tip, activeAt, schedule = FUNDING_SCHEDULES.spec, log = () => {}, now = () => Date.now() }) {
  db.exec(FUNDING_SQL);
  const rows = (kind) => db.prepare('SELECT id, proposal, hex FROM funding_items WHERE kind = ? ORDER BY at_ms, id').all(kind);
  const read = (kind, hex) => readSignedFunding(kind, fromHex(hex), verify);
  const outcomeOf = (pid) => { const r = db.prepare('SELECT outcome FROM funding_outcomes WHERE proposal = ?').get(pid); return r ? JSON.parse(r.outcome) : null; };
  const signalsOf = (pid) => db.prepare("SELECT hex FROM funding_items WHERE kind = 'signal' AND proposal = ?").all(pid)
    .map((r) => read('signal', r.hex)).filter((x) => x.ok).map((x) => ({ node: toHex(x.obj.node), atHeight: x.obj.atHeight }));
  return {
    schedule,
    async add(kind, hex) {
      const r = (() => { try { return read(kind, String(hex || '').toLowerCase()); } catch (e) { return { ok: false, why: e.message }; } })();
      if (!r.ok) return { ok: false, status: 400, why: r.why };
      const id = toHex(r.id);
      if (db.prepare('SELECT 1 FROM funding_items WHERE id = ?').get(id)) return { ok: true, fresh: false, id };
      const height = await Promise.resolve(tip()).catch(() => null);
      let proposal;
      if (kind === 'proposal') {
        proposal = id;
        const bonded = isBonded(toHex(r.obj.author));
        if (bonded === null) return { ok: false, status: 503, why: 'this seat cannot read the bonded nodes yet' };
        if (!bonded) return { ok: false, status: 422, why: `${toHex(r.obj.author).slice(0, 16)} is no bonded node: a funding proposal is posted by one` };
        if (Number.isInteger(height) && r.obj.publishedHeight > height + 1) return { ok: false, status: 422, why: `published at ${r.obj.publishedHeight}, and this seat's chain is at ${height}` };
      } else {
        proposal = toHex(r.obj.proposalId);
        if (!db.prepare("SELECT 1 FROM funding_items WHERE kind = 'proposal' AND id = ?").get(proposal)) return { ok: false, status: 404, why: 'this seat holds no such proposal: send the proposal first' };
        if (Number.isInteger(height) && r.obj.atHeight > height + 1) return { ok: false, status: 422, why: `dated ${r.obj.atHeight}, and this seat's chain is at ${height}` };
        if (kind === 'signal') {
          const bonded = isBonded(toHex(r.obj.node));
          if (bonded === false) return { ok: false, status: 422, why: 'a signal is given by a bonded node' };
        }
      }
      db.prepare('INSERT OR IGNORE INTO funding_items (id, kind, proposal, hex, at_ms) VALUES (?, ?, ?, ?, ?)').run(id, kind, proposal, String(hex).toLowerCase(), now());
      return { ok: true, fresh: true, id, proposal };
    },
    list(height = null) {
      return rows('proposal').map((row) => {
        const p = read('proposal', row.hex); if (!p.ok) return null;
        const o = p.obj;
        const comments = db.prepare("SELECT hex FROM funding_items WHERE kind = 'comment' AND proposal = ? ORDER BY at_ms, id").all(row.id)
          .map((c) => read('comment', c.hex)).filter((c) => c.ok)
          .map((c) => ({ id: toHex(c.id), parent: toHex(c.obj.parentId), author: toHex(c.obj.author), atHeight: c.obj.atHeight, text: c.obj.text }));
        const signals = signalsOf(row.id);
        const decided = outcomeOf(row.id);
        const st = decided || signalOutcome({ proposal: o, signals, active: null, tip: height, schedule });
        return { id: row.id, network: toHex(o.networkId), author: toHex(o.author), publishedHeight: o.publishedHeight, amountSats: String(o.amountSats),
          lnurl: o.lnurl, purpose: o.purpose, signal: st, signals, comments, hex: row.hex };
      }).filter(Boolean).sort((a, b) => b.publishedHeight - a.publishedHeight);
    },
    /** The objects of one proposal as hex - what another seat is handed to hold it too. */
    hexOf(pid) { return db.prepare('SELECT kind, hex FROM funding_items WHERE proposal = ? ORDER BY at_ms').all(String(pid).toLowerCase()); },
    async decide() {
      const height = await Promise.resolve(tip()).catch(() => null);
      if (!Number.isInteger(height)) return [];
      const done = [];
      for (const row of rows('proposal')) {
        if (outcomeOf(row.id)) continue;
        const p = read('proposal', row.hex); if (!p.ok) continue;
        const end = p.obj.publishedHeight + schedule.signal;
        if (height < end) continue;
        const a = await activeAt(end).catch((e) => ({ ok: false, why: e.message }));
        if (!a || !a.ok) { log(`[funding] ${row.id.slice(0, 16)}: the signal ended at ${end}, its active nodes not read yet: ${a ? a.why : '?'}`); continue; }
        const out = { ...signalOutcome({ proposal: p.obj, signals: signalsOf(row.id), active: a.nodes, tip: height, schedule }), activeFrom: a.fromHeight ?? null, activeTo: end };
        db.prepare('INSERT OR IGNORE INTO funding_outcomes (proposal, outcome, decided_ms) VALUES (?, ?, ?)').run(row.id, JSON.stringify(out), now());
        log(`[funding] ${row.id.slice(0, 16)}: signal ${out.state} - ${out.supporters} of ${out.active} active nodes (${out.pct} %, ${out.needed} needed)`);
        done.push({ id: row.id, ...out });
      }
      return done;
    },
  };
}
