// A SEASON'S ROUNDS AS THIS NODE HOLDS THEM (kanban #362 feature 1): what GET /season hands protocol season.js - one game's
// rounds started inside a window, each entry with the FINAL result and the amount its round's settlement paid it.
//
// EVERY FIGURE IS READ FROM THIS NODE'S OWN STORE, as the dashboard's are (dashboard.js), and nothing is worked out again:
//   - A RESULT counts once it is FINAL here: the round's census committee's threshold of signed results agreeing on one
//     run (verdict.js `verifiedFinal` - every signature verified, a stranger's or a forger's dropped) AND that many
//     committee seats' FINAL signatures on that run held (final_sigs keeps only those that counted when they came:
//     a committee seat, a signature that verifies, signed inside the tolerance - finality.js `takeFinalSig`). A run
//     still in its objection window, suspended or re-run is not on the season yet. A no-quorum decision (§13C) or an
//     entry void (§13C's ENTRY_VOID) this node wrote stands for the result, as it does for the settlement.
//   - AN AMOUNT counts once the round's settlement is ACCEPTED here (settlement-state.js `stateOf`, every federation's
//     for a round that takes any): an entry whose stake lock the settlement claimed was paid 0; one whose lock it did
//     not claim got the lock's amount back (the net stake, its own verified lock's field), plus the share the settlement
//     paid its key (lock_settlement_shares - the signed plan's `stakeShares`). A late loser's own settlement (§13A,
//     C3b-1) counts the same way once it is ACCEPTED, and holds the entry back while it is not. That is how a market's
//     right pick, a qualifier and a loser all come out of the same three rows, with no rank curve and no pari-mutuel
//     table run here: the settlement already ran them, and its signers signed what it paid.
//   - A FREE ROUND pays 0 to everyone and has no settlement: its entries count on their FINAL result alone. A FREE
//     MARKET has neither a result per entry nor a settlement, so nothing of it is on a season.
//
// WHO AN ENTRY COUNTS UNDER: a head-to-head entry's identity (h2h_identities - the identity key's own signature over the
// round, the entry and the key, kanban #280), else the identity the round key's signed lobby record names (POST /name
// verifies that record under the round key), else the round key itself. The round key alone would make every round a new
// player - each tab joins under a fresh one - and the season would be a list of strangers.
import { decodeRoundContract } from '../../arena-protocol/src/contracts.js';
import { decodePlayerResult, splitSignedResult } from '../../arena-protocol/src/result.js';
import { decodeLobbyName } from '../../arena-protocol/src/lobby-name.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { verifiedFinal, runId } from './verdict.js';
import { stateOf } from './settlement-state.js';

const ACCEPTED = 'ACCEPTED';
const hex = (b) => toHex(new Uint8Array(b));

/**
 * The rounds of `games` (a Set of game id hex) this node holds with entries, started in [fromMs, toMs), read into the
 * shape protocol season.js takes. `isMarket(contract)`: whether the round's game is attested (a market) - its entries
 * carry no result, only a pick, and their amounts come from the settlement alone.
 */
export function seasonRounds(round, { games, fromMs, toMs, isMarket = () => false } = {}) {
  const db = round.db;
  // ONLY ROUNDS WITH ENTRIES - a season is of players, and a seat holds thousands of series rounds nobody joined
  const rows = db.prepare('SELECT r.round_id, r.contract FROM rounds r WHERE EXISTS (SELECT 1 FROM entries e WHERE e.round_id = r.round_id)').all();
  const out = [];
  for (const row of rows) {
    let c;
    try { c = decodeRoundContract(new Uint8Array(row.contract)); } catch { continue; }
    if (!(c.gameId instanceof Uint8Array) || !games.has(hex(c.gameId))) continue;
    const startMs = BigInt(c.startTimeMs);
    if (startMs < BigInt(fromMs) || startMs >= BigInt(toMs)) continue;
    const rid = new Uint8Array(row.round_id);
    const paid = c.stakeMsat > 0n;
    const market = !!isMarket(c);
    if (market && !paid) continue;
    out.push({ roundId: hex(rid), gameId: hex(c.gameId), startMs, entries: entriesOf(round, rid, c, { paid, market }) });
  }
  return out;
}

function entriesOf(round, rid, contract, { paid, market }) {
  const committee = round.signerNodes(rid);
  const member = new Set(committee.map(hex));
  // THE SETTLEMENT, read once for the round: whether it went in, which locks it claimed, what it paid each key
  const settled = paid ? stateOf(round, rid) === ACCEPTED : true;
  const moves = paid && settled && typeof round.lockSettlementMoves === 'function' ? round.lockSettlementMoves(rid) : null;
  const claimed = new Set(moves && Array.isArray(moves.claims) ? moves.claims : []);
  const shares = new Map();
  for (const s of (paid && settled && typeof round.lockSettlementShares === 'function' ? round.lockSettlementShares(rid) : null) || [])
    shares.set(hex(s.pubkey), (shares.get(hex(s.pubkey)) || 0n) + BigInt(s.msat));
  // THE ROUND KEYS' SIGNED NAME RECORDS: the identity each names, and the name the player chose
  const named = new Map();
  for (const n of round.lobbyNames(rid)) {
    try { const r = decodeLobbyName(n.record); named.set(hex(r.playerPubkey), { identity: hex(r.identityPubkey), name: r.name || null }); } catch { /* not a record */ }
  }

  return round.entriesOf(rid).map(({ entryId, entry }) => {
    const key = hex(entry.playerPubkey);
    const proven = typeof round.identityOf === 'function' ? round.identityOf(entryId) : null;
    const record = named.get(key) || null;
    const player = proven ? hex(proven.identity) : record ? record.identity : key;
    const base = { player, name: record ? record.name : null, stakeMsat: entry.stakeMsat, outcome: null, score: null, payoutMsat: null };

    // THE RESULT (not for a market pick, whose round has an attested outcome and no run)
    if (!market) {
      const r = resultOf(round, rid, entryId, contract, committee, member);
      if (!r) return base;                                  // not FINAL here: no amount is read for it either
      base.outcome = r.outcome;
      base.score = r.score;
    }

    // THE AMOUNT
    if (!paid) return { ...base, payoutMsat: 0n };
    if (!settled) return base;
    const lock = typeof round.stakeLock === 'function' ? round.stakeLock(entryId) : null;
    if (!lock || !lock.fields || lock.fields.amountMsat === undefined) return base;
    const late = typeof round.lateLockSettlement === 'function' ? round.lateLockSettlement(rid, entryId) : null;
    if (late && late.state !== ACCEPTED) return base;
    const taken = claimed.has(lock.outpoint) || !!late;
    return { ...base, payoutMsat: (taken ? 0n : BigInt(String(lock.fields.amountMsat))) + (shares.get(key) || 0n) };
  });
}

/**
 * THE ENTRY'S FINAL RESULT HERE, or null: §13C's decision when this node wrote one, else the committee's agreed run when
 * its threshold of results and of FINAL signatures is held.
 */
function resultOf(round, rid, entryId, contract, committee, member) {
  const eid = Buffer.from(entryId);
  const voided = typeof round.entryVoid === 'function' ? round.entryVoid(eid) : null;
  if (voided) return { outcome: 'ENTRY_VOID', score: 0 };
  const decided = typeof round.noQuorum === 'function' ? round.noQuorum(eid) : null;
  if (decided) return { outcome: decided.outcome, score: 0 };
  const held = round.results(rid, entryId);
  const seen = verifiedFinal(held.map((r) => r.bytes), { contract, signerNodes: committee });
  if (!seen.ok || !seen.final) return null;
  let agreed = null;
  for (const r of held) {
    try {
      const x = decodePlayerResult(splitSignedResult(r.bytes).body);
      if (member.has(hex(x.nodePubkey)) && hex(runId(x)) === seen.runId) { agreed = x; break; }
    } catch { /* not a result */ }
  }
  if (!agreed) return null;
  const signers = new Set(round.finalSigs(rid, entryId, Buffer.from(seen.runId, 'hex'))
    .map((s) => hex(s.signerPubkey)).filter((k) => member.has(k)));
  if (signers.size < seen.needed) return null;
  return { outcome: agreed.outcome, score: agreed.score };
}
