// THE RULES A ROUND IS SETTLED UNDER, NAMED IN ITS CONTRACT (§6 equivocation_rule_hash, no_quorum_rule_hash, finality_rule,
// slashing_rules_hash, disconnect_rule, claim_window_days, bond_min per role; kanban #314; 2026.0.3). Until now these were bound only
// implicitly - through the code a seat runs and the config_hash. A v3 contract may name them: each rule a fixed text whose tagged hash
// the contract carries, so a seat running other rules refuses the round by name (as a config it does not run), and a player's client
// shows which rules it stakes under. The texts are the rules as built; changing one is a new hash, i.e. a new rule.
import { taggedHash } from './hash.js';
import { TAG } from './constants.js';

const te = new TextEncoder();
export const RULE_TEXTS = Object.freeze({
  equivocation: 'ARENA rule equivocation v1 (§10, kanban #25, RULED 2026-10-05 (b)): two checkpoints of one entry, each signed by its session key, '
    + 'with different ids and the same tick or the same parent, forfeit the entry (FORFEIT, its stake to the loser pool); a pair from one later '
    + 'parent forfeits only when both marks were receipted by a seat. The pair is the proof; no replay.',
  noQuorum: 'ARENA rule no-quorum v1 (§5A.7, §5A.13, §16): a round with fewer than its threshold of drawn nodes present never opens for entries; '
    + 'signer nodes unavailable at a run\'s start make it ENTRY_VOID (refund); conflicts that leave a committee under its threshold make its '
    + 'entries ENTRY_VOID.',
  finality: 'ARENA rule finality v1 (§13A, WINDOW-10-SPEC 2026-10-01): a result is PROVISIONAL until its objection window of exactly 600000 ms '
    + 'closes without a standing objection, then FINAL; a standing objection is decided by deterministic re-run, SUSPENDED meanwhile.',
  slashing: 'ARENA rule slashing v1 (§5A.3, §5A.3B): the offences of §5A.3 (double result, signing a result the re-run contradicts, signing for a '
    + 'round its operator played, a false operator declaration), each with its one-artifact proof, slash the bond; 75 % evenly to the active '
    + 'census nodes, 25 % to the donation set.',
});
/** A rule's hash: its text under the rule tag. */
export const ruleHash = (text) => taggedHash(TAG.contractRule, te.encode(text));
export const RULE_HASHES = Object.freeze(Object.fromEntries(Object.entries(RULE_TEXTS).map(([k, t]) => [k, ruleHash(t)])));
/** disconnect_rule: what a player who stops sending inputs gets - 1, the run ends at its last receipted checkpoint (§15). */
export const DISCONNECT_LAST_MARK = 1;
export const DISCONNECT_RULES = Object.freeze([DISCONNECT_LAST_MARK]);

/** The rules this build settles under, as a contract names them (with the round's own claim window and floors). */
export function buildRules({ claimWindowDays = 1, bondMinGameVerifySats, bondMinSettlementSats } = {}) {
  return { equivocation: RULE_HASHES.equivocation, noQuorum: RULE_HASHES.noQuorum, finality: RULE_HASHES.finality, slashing: RULE_HASHES.slashing,
    disconnect: DISCONNECT_LAST_MARK, claimWindowDays, bondMinGameVerifySats, bondMinSettlementSats };
}

/**
 * DOES THIS BUILD SETTLE UNDER THE RULES A CONTRACT NAMES? { ok, why }. A contract naming none is bound only implicitly, as before;
 * one naming them must name this build's four hashes and a disconnect rule it runs, a claim window of 1 day or more, and a floor per
 * role no lower than the round's bond_min.
 */
export function rulesStand(contract) {
  const r = contract && contract.rules;
  if (!r) return { ok: true, why: 'that round names no rules: bound by its config only' };
  const eq = (a, b) => a instanceof Uint8Array && b instanceof Uint8Array && a.length === b.length && a.every((x, i) => x === b[i]);
  for (const k of ['equivocation', 'noQuorum', 'finality', 'slashing'])
    if (!eq(r[k], RULE_HASHES[k])) return { ok: false, why: `that round names a ${k} rule this build does not run: it is not selectable here, not slashed` };
  if (!DISCONNECT_RULES.includes(r.disconnect)) return { ok: false, why: `that round names disconnect rule ${r.disconnect}, which this build does not run` };
  if (!Number.isInteger(r.claimWindowDays) || r.claimWindowDays < 1) return { ok: false, why: 'a claim window is 1 day or more' };
  for (const k of ['bondMinGameVerifySats', 'bondMinSettlementSats'])
    if (typeof r[k] !== 'bigint' || r[k] < contract.bondMinSats) return { ok: false, why: `that round's ${k} is under its bond_min: a role's floor is the round's or above` };
  return { ok: true, why: 'that round names the rules this build settles under' };
}

/** The bond floor of a role: the contract's own for that role when it names its rules, its bond_min otherwise. */
export function roleFloorSats(contract, role) {
  const r = contract && contract.rules;
  if (!r) return contract.bondMinSats;
  return role === 'game' || role === 'game-verify' ? r.bondMinGameVerifySats : role === 'settlement' ? r.bondMinSettlementSats : contract.bondMinSats;
}
