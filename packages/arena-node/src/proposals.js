// THE PROPOSALS A SEAT KEEPS AND SERVES (spec §27A.7.2-3, kanban #329): a vote carries only proposal_id[0:8] (ballot.js), so a voter
// needs the full proposal from somewhere - the seats. A proposal is taken only when it stands on its face (proposalStands: signed by
// its proposer, activation after cooldown, deposit within the cap) and its deposit is on this seat's chain (depositOf, RULED option
// A): the proposer names the block its deposit_txid confirmed in, and the seat reads the transaction from that block itself.
//
//   POST /proposal   { proposal: hex of body || signature, blockHash: hex }   -> 201 { id, publishedAt, votingFrom, ... } or 422 why
//   GET  /proposals                                                            -> { proposals: [...] }, newest publication first
//
// A REPEAL (§27A.7.6) is read against the history live AT THE PROPOSAL'S PUBLICATION HEIGHT (`historyFor(net, height)`, the
// tally's - ballot-tally.js): the same answer at every seat, whenever it is asked. Until this seat has decided every proposal
// that activates at or before that height, it cannot know that history, and says so (503) rather than guess a schedule.
// A proposal's outcome is written into its record once (`decide`), and never tallied again.
import { decodeConfigProposalBody, proposalId, proposalStands, SCHEDULES, REPEAL_SCHEDULES } from '../../arena-protocol/src/ballot.js';
import { depositOf } from '../../arena-protocol/src/ballot-chain.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';

/**
 * `confirmedTx(txidHex, blockHashHex)` -> { raw: Uint8Array, height } or null: the transaction from that block of this seat's
 * chain, and the block's height (main.js: getrawtransaction with the block hash, which needs no txindex). `recipientsFor(networkIdHex,
 * height)` -> the network's donation set in force at that height (its recipients), or null; `lowestBondMinSatsFor(networkIdHex)` -> BigInt; `verify(sig, msg, pubkey)`; `store`:
 * { read() -> [], write(list) }. `scheduleFor(net)` / `repealScheduleFor(net)`: the network's schedules (regtest's short ones);
 * `historyFor(net, height)` -> the live history at that height ([{ config }], liveConfig's), or null while it cannot be known yet;
 * none given: no proposal is read as a repeal (the first slice's behaviour).
 */
export function createProposals({ confirmedTx, recipientsFor, lowestBondMinSatsFor, verify, store, schedule = SCHEDULES.mainnet, scheduleFor = null,
  repealSchedule = REPEAL_SCHEDULES.mainnet, repealScheduleFor = null, historyFor = null }) {
  const held = new Map((store && store.read ? store.read() || [] : []).map((x) => [x.id, x]));
  const save = () => { if (store && store.write) store.write([...held.values()]); };
  return {
    async add({ proposal: hex, blockHash }) {
      if (!/^[0-9a-f]+$/i.test(String(hex || '')) || String(hex).length < 130) return { ok: false, status: 400, why: 'a proposal is the hex of its body and its 64-byte signature' };
      if (!/^[0-9a-f]{64}$/i.test(String(blockHash || ''))) return { ok: false, status: 400, why: 'name the block its deposit confirmed in (blockHash, 64 hex)' };
      const bytes = fromHex(String(hex).toLowerCase());
      let p;
      try { p = { ...decodeConfigProposalBody(bytes.subarray(0, bytes.length - 64)), signature: bytes.slice(bytes.length - 64) }; }
      catch (e) { return { ok: false, status: 400, why: `that is no config proposal: ${e.message}` }; }
      const id = toHex(proposalId(p));
      if (held.has(id)) return { ok: true, status: 200, ...held.get(id), already: true };
      const net = toHex(p.networkId);
      const tx = await confirmedTx(toHex(Uint8Array.from(p.depositTxid).reverse()), String(blockHash).toLowerCase());
      if (!tx) return { ok: false, status: 422, why: 'that block of this seat\'s chain does not hold the deposit the proposal names' };
      // the network's donation set IN FORCE AT THE DEPOSIT'S HEIGHT (27A.4): the set the deposit had to pay
      const recipients = recipientsFor(net, tx.height);
      if (!recipients) return { ok: false, status: 422, why: `this seat knows no donation set in force for that network at height ${tx.height}` };
      const dep = depositOf({ raw: tx.raw, height: tx.height, proposal: p, recipients });
      if (!dep.ok) return { ok: false, status: 422, why: dep.why };
      // THE HISTORY A REPEAL IS READ AGAINST: the configs live before, at the height it was published at (27A.7.6)
      const history = historyFor ? historyFor(net, dep.publishedAt) : null;
      if (historyFor && !history)
        return { ok: false, status: 503, why: `this seat has not yet decided every proposal that activates by height ${dep.publishedAt}, so it cannot yet say whether this one is a repeal: ask again shortly` };
      const stands = proposalStands(p, { publishedAt: dep.publishedAt, depositSats: dep.depositSats, lowestBondMinSats: lowestBondMinSatsFor(net),
        schedule: (scheduleFor && scheduleFor(net)) || schedule, repealSchedule: (repealScheduleFor && repealScheduleFor(net)) || repealSchedule, verify, history });
      if (!stands.ok) return { ok: false, status: 422, why: stands.why };
      const kept = { id, proposal: toHex(bytes), networkId: net, parent: toHex(p.parent), configHash: toHex(p.configHash), class: stands.class,
        proposer: toHex(p.proposer), publishedAt: dep.publishedAt, depositSats: String(dep.depositSats), votingFrom: stands.votingFrom,
        votingUntil: stands.votingUntil, activationHeight: stands.activationHeight, repeal: stands.repeal };
      held.set(id, kept); save();
      return { ok: true, status: 201, ...kept };
    },
    list: () => [...held.values()].sort((a, b) => b.publishedAt - a.publishedAt),
    /** THE OUTCOME, WRITTEN ONCE (ballot-tally.js): a decided proposal is never tallied again, across restarts too. */
    decide(id, outcome) {
      const had = held.get(id);
      if (!had || had.decided) return false;
      held.set(id, { ...had, decided: outcome }); save();
      return true;
    },
  };
}
