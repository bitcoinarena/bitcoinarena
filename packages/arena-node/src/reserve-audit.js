// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE FEDERATION'S OWN SIGNED HISTORY, READ BY A SEAT (kanban #1093 part 2, ruling #1106, 2026-11-03). "A Fedimint federation's sessions are
// threshold-signed. In them, every e-cash issue (mint outputs), every redemption (mint inputs) and every peg-out (wallet module) is an item.
// Theft by a threshold leaves one of two marks, both objective: inflation - in the signed history, the e-cash redeemed so far exceeds the
// e-cash issued so far; unbacked spend - a reserve UTXO spent on the chain, 6 deep, by no peg-out in the signed history."
//
// This is the inflation half, run by the seat that holds a client of the federation: the stake-lock tool's session-audit mode (packages/arena-node
// tools/stake-lock) fetches each signed session from a guardian, verifies it against the federation's broadcast keys and sums mint issues and
// redemptions; the seat keeps the running totals per federation and asks again from where it stopped, `perPass` sessions at a time, carrying
// the totals in. A session that fails verification is not counted and is asked again next pass. The first session where the cumulative
// redemptions pass the cumulative issues is a mark: it is raised in the seat's alarm book (reserve-alarms.js), and deposits stop.
//
// The unbacked-spend half needs the federation's reserve outputs on the chain beside the peg-outs the history names (pegOutTxids, kept here
// for it); it is a later step.

/**
 * `federations()` -> [{ federation (hex), dataDir }]: the federations this seat holds a client of. `run(args)` -> the tool's final JSON line
 * (parsed) for `--mode session-audit --data-dir ... --from ... --max-sessions ... --carry-issued-msat ... --carry-redeemed-msat ...`.
 * `load(fid)` / `save(fid, row)`: the kept totals { lastSession, issuedMsat, redeemedMsat, pegOutTxids, checkedAtMs }. `alarms`: reserve-alarms.js.
 * `height()`: the chain tip, named in an alarm.
 */
export function createReserveAudit({ federations, run, load, save, alarms, height = async () => 0, perPass = 200, nowMs = () => Date.now(), say = () => {} }) {
  const passing = new Set();
  async function auditOne({ federation, dataDir }) {
    const fid = String(federation).toLowerCase();
    if (passing.has(fid)) return { federation: fid, skipped: 'a pass runs' };
    passing.add(fid);
    try {
      const kept = load(fid) || { lastSession: -1, issuedMsat: '0', redeemedMsat: '0', pegOutTxids: [] };
      const from = Number(kept.lastSession) + 1;
      let got;
      try {
        got = await run(['--mode', 'session-audit', '--data-dir', dataDir, '--from', String(from), '--max-sessions', String(perPass),
          '--carry-issued-msat', String(kept.issuedMsat), '--carry-redeemed-msat', String(kept.redeemedMsat)]);
      } catch (e) { return { federation: fid, why: `the audit did not run: ${e.message}` }; }
      if (!got || typeof got !== 'object' || got.mode !== 'session-audit') return { federation: fid, why: 'the audit answered no session-audit line' };
      // A SESSION THAT DID NOT VERIFY is never counted: the totals stop before the first one, and it is asked again
      const unverified = (got.unverified || []).map(Number).filter(Number.isInteger).sort((a, b) => a - b);
      if (unverified.length) return { federation: fid, why: `session ${unverified[0]} does not verify against the federation's keys: asked again next pass`, unverified };
      const last = Number(got.lastSession);
      if (!Number.isInteger(last) || last < from - 1) return { federation: fid, why: 'the audit named no last session' };
      const row = { lastSession: last, issuedMsat: String(got.cumulativeIssuedMsat ?? kept.issuedMsat), redeemedMsat: String(got.cumulativeRedeemedMsat ?? kept.redeemedMsat),
        pegOutTxids: [...new Set([...(kept.pegOutTxids || []), ...(got.pegOutTxids || []).map((t) => String(t).toLowerCase())])], checkedAtMs: nowMs() };
      save(fid, row);
      const marked = got.firstInflationSession !== null && got.firstInflationSession !== undefined && Number.isInteger(Number(got.firstInflationSession))
        ? Number(got.firstInflationSession) : (BigInt(row.redeemedMsat) > BigInt(row.issuedMsat) ? last : null);
      if (marked !== null) {
        const r = alarms.raise({ federation: fid, kind: 'inflation', height: Number(await height()), session: marked, issuedMsat: row.issuedMsat, redeemedMsat: row.redeemedMsat });
        say({ federation: fid.slice(0, 16), inflation: marked, issued: row.issuedMsat, redeemed: row.redeemedMsat, kept: r.kept });
        return { federation: fid, alarm: true, session: marked, ...row };
      }
      return { federation: fid, sessions: Number(got.sessions || 0), ...row };
    } finally { passing.delete(fid); }
  }
  /** One pass over every federation this seat holds a client of. */
  async function pass() {
    const out = [];
    for (const f of (await federations()) || []) out.push(await auditOne(f));
    return out;
  }
  return { pass, auditOne };
}
