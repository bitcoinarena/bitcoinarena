// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A SIGNER NODE VERIFIES THE PLAYER'S STAKE LOCK (v4.6.2 §23.1 step 5).
//
// "STAKE_COMMITTED is recorded once >=5 settlement nodes have VERIFIED the
// locks: the contract id at stake_lock_outpoint (and the fee lock's) equals
// the hash of a contract whose payment_image is the entry's stake_point,
// whose amount is the entry's net stake, whose claim_pk is the attested key,
// whose refund_pk is player_pubkey, and whose expiration is >= lock_height
// + stake_expiry_blocks", lock_height no more than 12 blocks below the height the
// seat verifies at. Seeing the lock is not enough: the player built it. (RULED
// 2026-09-24, option (a): lock_height is the federation-held expiration less 144 -
// the one checked below against blockCount + blocksLeft - and blockCount is the
// verify height handed to lockMatchesEntry.)
//
// This is one signer node's half. The player hands the signer node the contract it locked;
// the signer node asks the federation what it holds at the entry's outpoint (the
// stored contract id and the blocks left to its expiry), hashes the handed
// contract with the stock client's own rule, and requires the two to be one
// contract; then protocol stake-lock.js `lockMatchesEntry` checks every field
// against the entry. Only then is the stake seen - the same record the play
// gate reads, so a verified lock and a held HTLC open play the same way.
//
// THE FEDERATION IS A PORT, as Lightning is: `status(outpoint)` answers
// `{ blockCount, stored: { contractId, blocksLeft } | null }` and
// `contractId(fields)` the stock hash (arena-stake-lock, over the Rust client
// crates). The fee lock is not checked here: its claim hash and the §22A node
// slots wait on a ruling (PRIORITIES).
import { decodeEntryContract, decodeRoundContract, entryFederation } from '../../arena-protocol/src/contracts.js';
import { lockMatchesEntry, lockFieldsFromJson, lockFieldsToJson } from '../../arena-protocol/src/stake-lock.js';
import { feeLockPays } from '../../arena-protocol/src/lock-settlement.js';
import { donationOutputsExpected } from '../../arena-protocol/src/donation.js';
import { reservesEntryExpected, paysReserves, giftsInFeeLock, entryGiftsInFee, giftsFeeBps, ROUND_SPLIT_BPS } from '../../arena-protocol/src/reserves.js';
import { namedClaims, namedClaimKeys, arenaLockContractId, arenaLockMatchesEntry, lockStallBlocks } from '../../arena-protocol/src/arena-lock.js';
import { networkOf } from '../../arena-protocol/src/constants.js';
import { toHex as hexOf } from '../../arena-protocol/src/hash.js';
import { claimReadInput } from '../../arena-protocol/src/named-claim-proof.js';
import { roundSplitBps } from '../../arena-protocol/src/fee-proposal.js';
import { pluginForRound } from './plugins.js';

/**
 * WHETHER THIS ROUND'S GATE MINTS FEE LOCKS (Pick b), by the federation's own fee rule
 * - the same arithmetic the page runs before it locks. Where it mints, a signer node takes no
 * entry without a fee lock and counts no stake whose fee lock it has not verified
 * (2026-09-14, pick (a): refuse at the door - measured before, one entry with no
 * fee lock made the round's one settlement refuse everybody: "an entry's fee lock was
 * never verified, so the fee cannot be claimed").
 */
// `split`: a protocol-27 round's split in force at its census height (kanban #1486)
export async function roundMintsFees({ contract, port, feeBps = undefined, split = undefined }) {
  if (!port || typeof port.fees !== 'function') return { mints: false, why: 'this signer node reads no federation fee rule' };
  const gate = feeLockPays({ contract, fees: await port.fees(), feeBps, split });
  return { mints: gate.pays, why: gate.why };
}

/**
 * A FEDERATION THAT CHARGES A BASE FEE TAKES MONEY THE OPERATOR DID NOT EARN.
 *
 * FEDERATION.md item 4, and 2026-09-15 07:44: "Fedimint base fee is 0 - run the federation with
 * `disable_base_fees`." §22A says it in the spec's own words: "The 2% stays. Fedimint's own base fees are 0:
 * the federation runs with `disable_base_fees`. Lightning `min_htlc` / routing is not a federation fee."
 *
 * A base fee comes out of EVERY input and output of the round's locks - the players' own pool - so it is not
 * a cost of the round, it is a deduction from the stake somebody already committed. The 2% node fee is
 * inclusive and goes to the round's sitting seats for work they did; a base fee goes to the federation for
 * nothing the round asked for, and the operator must not profit from it.
 *
 * `page-lock.js` already refuses to LOCK against such a federation. This is the same refusal on the node, so
 * a signer node does not sit a round whose stakes would be shaved on the way in and out.
 *
 * AN UNKNOWN RULE IS NOT A BASE FEE. A port that answers nothing is the "no fee rule known: no lock" case the
 * client already has - the round simply mints no fee lock - and is not turned into a refusal here.
 */
export function federationTakesNoBaseFee({ fees }) {
  if (!fees || typeof fees.baseMsat !== 'bigint')
    return { ok: true, why: 'no federation fee rule is known, so no base fee is claimed' };
  if (fees.baseMsat > 0n)
    return { ok: false, baseMsat: fees.baseMsat,
      why: `that round's federation charges a base fee of ${fees.baseMsat} msat on every input and output - `
        + 'a federation for BLWP runs with disable_base_fees (FEDERATION.md), and that fee would come out of '
        + 'the players\' own pool' };
  return { ok: true, why: 'that federation charges no base fee' };
}

const zero = (b) => !(b instanceof Uint8Array) || b.every((x) => x === 0);

// The contract a player hands over, as JSON - one encoding, in protocol, which
// the page's bundle writes with.
export { lockFieldsFromJson, lockFieldsToJson };

/**
 * A DONATION OUTPUT AS THE PLAYER'S LOCK TRANSACTION MAKES IT (2026-10-03, FEDERATION.md): a payout contract -
 * the zero hash image, expired from the start, claim and refund key both the recipient's - so only that key can spend
 * it, with `Refund`, at any time. The same shape the settlement pays a winner with (stake-lock main.rs settle).
 */
// THE SENDER ON THE CONTRACT (2026-10-05): `image` is the entry's 32-byte x-only player key, which a
// page from 0.0.2751 writes; zeros as before when none. Nobody holds a preimage of either, so the claim path stays dead and
// the recipient's Refund is the only spend (measured on a regtest federation: kept, redeemed at once).
export const donationContractFields = ({ recipientPk, amountMsat, image = new Uint8Array(32) }) => ({
  paymentImage: { kind: 'hash', bytes: image }, amountMsat, claimPk: recipientPk, refundPk: recipientPk, expiration: 0,
});

/**
 * THE ENTRY'S DONATION OUTPUTS, CHECKED WITH THE FEDERATION (2026-10-03): for a round whose set pays keys, every
 * output `donationOutputsExpected` pairs - the federation holds, at that outpoint, the payout contract to that key for
 * exactly that share - and none already pays for another entry. Answers the rows to keep, or why the entry's donation
 * is not what its set says. An LNURL round answers none (and refuses outputs it does not name).
 */
export async function verifyDonationOutputs({ round, port, entry, entryIdBytes, recipients, federationId }) {
  if (!recipients) {
    if ((entry.donationOutpoints || []).length) return { ok: false, why: 'this signer node holds no donation set for that round, so it cannot check its donation outputs' };
    return { ok: true, rows: [] };
  }
  const want = donationOutputsExpected(entry, recipients);
  if (!want.ok) return { ok: false, why: `donation: ${want.why}` };
  if (!want.outputs.length) return { ok: true, rows: [] };
  if (!port) return { ok: false, why: 'this node reaches no federation, so it cannot verify a donation output' };
  const rows = [];
  for (const o of want.outputs) {
    const taken = round.donationOutputAt ? round.donationOutputAt(o.outpoint) : null;
    if (taken && !Buffer.from(taken.entryId).equals(Buffer.from(entryIdBytes)))
      return { ok: false, why: 'that donation output already pays for another entry: one output is one entry\'s' };
    // EITHER THE ENTRY'S OWN PLAYER KEY AS THE IMAGE, OR ZEROS (pages already out); any other image is not this entry's
    const sender = entry.playerPubkey instanceof Uint8Array && entry.playerPubkey.length === 32 ? entry.playerPubkey : null;
    const [st, zeroId, keyedId] = await Promise.all([port.status(o.outpoint), port.contractId(donationContractFields(o)),
      sender ? port.contractId(donationContractFields({ ...o, image: sender })) : Promise.resolve(null)]);
    const at = `${Buffer.from(o.outpoint.txid).toString('hex').slice(0, 16)}…:${o.outpoint.outIdx}`;
    if (!st || !st.stored) return { ok: false, why: `donation: the federation holds nothing at ${at}` };
    const stored = String(st.stored.contractId);
    const senderOnContract = keyedId !== null && String(keyedId) === stored;
    if (!senderOnContract && String(zeroId) !== stored)
      return { ok: false, why: `donation: the output at ${at} is not ${o.amountMsat} msat to key ${Buffer.from(o.recipientPk).toString('hex').slice(0, 16)}…` };
    rows.push({ outpoint: o.outpoint, entryId: entryIdBytes, roundId: entry.roundId, federationId, recipientPk: o.recipientPk,
      amountMsat: o.amountMsat, contractId: stored, senderOnContract });
  }
  return { ok: true, rows };
}

/**
 * WHAT AN ENTRY GIVES BESIDE ITS STAKE, CHECKED WITH THE FEDERATION: its donation outputs - and ON PROTOCOL 11 (§27A.9.2, kanban
 *) the developers' 4 % as any donation plus the reserves' 2 %, one output to the entry's federation's reserve key, checked
 * the same way (a payout contract to that key for exactly that amount) and kept beside them as a row for that key.
 */
// `split`: the round's split in force at its census height; unset, today's
export async function verifyEntryGifts({ round, port, entry, contract, entryIdBytes, recipients, reserveKey = null, federationId, split = undefined }) {
  if (!(paysReserves(contract) && entry.reserveOutpoint !== undefined))
    return verifyDonationOutputs({ round, port, entry, entryIdBytes, recipients, federationId });
  const want = reservesEntryExpected({ entry, recipients, reserveKey, ...(split ? { split } : {}) });
  if (!want.ok) return { ok: false, why: `reserves: ${want.why}` };
  const devs = await verifyDonationOutputs({ round, port, entry: { ...entry, donationMsat: entry.donationMsat - want.reserve.amountMsat },
    entryIdBytes, recipients, federationId });
  if (!devs.ok) return devs;
  const res = await verifyDonationOutputs({ round, port, entry: { ...entry, donationMsat: want.reserve.amountMsat, donationOutpoints: [want.reserve.outpoint] },
    entryIdBytes, recipients: [{ recipientPk: reserveKey, shareBps: 10000, label: 'protocol reserves' }], federationId });
  if (!res.ok) return { ok: false, why: res.why.replace(/^donation:/, 'reserves:') };
  return { ok: true, rows: [...devs.rows, ...res.rows.map((r) => ({ ...r, reserve: true }))] };
}

/**
 * §23.1 STEP 5 FOR A PROTOCOL-27 ROUND (kanban #1044 B1): its locks are Arena locks. The federation must run the variant (`gate(contract, federation
 * hex)` -> null or why: a threshold of its guardians at LNv2 >= 1.100), hold at the outpoint exactly the contract handed over (its id, its expiration),
 * and the contract must name this round, its settlement seats in seat order and its threshold, beside every stock field. A stock contract handed
 * for such a round, or an Arena lock for an older one, is refused by name. Answers { ok, contractId, height } or { ok: false, why }.
 */
export async function arenaLockStands({ contract, entry, kind, fields, outpoint, port, gate = null, federationId }) {
  const named = namedClaims(contract);
  if (!named) return fields.arena ? { ok: false, why: `this round locks to the stock contract (protocol ${contract.protocolVersion}): that ${kind} lock is an Arena lock` } : null;
  if (!fields.arena) return { ok: false, why: `this round locks to an Arena lock (protocol 27): that ${kind} lock is a stock contract to one claim key` };
  if (gate) { const g = await gate(contract, hexOf(federationId)); if (g) return { ok: false, why: g }; }
  if (!port.arenaStatus) return { ok: false, why: 'this node\'s federation tool reads no Arena lock' };
  const st = await port.arenaStatus(outpoint);
  if (!st || !st.stored) return { ok: false, why: `the federation holds no Arena lock at the entry's ${kind}_lock_outpoint` };
  const id = hexOf(arenaLockContractId(fields));
  if (id !== String(st.stored.contractId)) return { ok: false, why: `the lock at that outpoint is not the ${kind} contract handed over: its id is another` };
  if (fields.expiration !== st.stored.expiration) return { ok: false, why: `that ${kind} contract's expiration is not the one the federation holds` };
  const { seatKeys, threshold } = namedClaimKeys(contract);
  if (fields.fallbackAfter !== st.stored.fallbackAfter) return { ok: false, why: `that ${kind} contract's fallback height is not the one the federation holds` };
  // its fallback height: the lock's block count plus the round's network's stall_blocks (spec §23.2, kanban #1281)
  let stallBlocks = null; try { stallBlocks = lockStallBlocks(networkOf(contract.networkId)); } catch { stallBlocks = null; }
  const m = arenaLockMatchesEntry({ lock: fields, entry, kind, roundId: entry.roundId, seatKeys, threshold, height: st.blockCount, expiryBlocks: contract.stakeExpiryBlocks, stallBlocks });
  return m.ok ? { ok: true, contractId: id, height: st.blockCount } : m;
}

/**
 * THE FILER'S LOWER BOUND: THE LOCK'S OWN FUNDING SESSION, FOUND WHEN THE LOCK IS VERIFIED (kanban #1044 B1, rulings #1138 1 (i), #1139 B). When this seat
 * verifies an Arena lock (§23.1 step 5) the lock's funding was accepted before, so it sits in a session no later than the one running now (the session
 * count c0); once a later session finished (the count above c0) this seat reads the federation's signed sessions back - the newest FUNDING_RECENT_SESSIONS,
 * then doubling (16, 32, ...) - until the stake-lock tool's offline reader names the lock's funding, and keeps THAT session as the bound for (round,
 * federation): the lower of what is stored and it, across restarts. The filer starts at the bound and never searches. A funding not found within
 * FUNDING_SEARCH_SESSIONS leaves the lock unread - no filing on it, nothing held against a seat - and is logged; so is a federation whose running session
 * does not finish within `maxWaitMs` (asked every `waitMs`). A failed read never fails the lock; the search runs beside the verification, not in its way.
 * `outpoint` the lock's. Answers the session kept, or null.
 */
export const FUNDING_SEARCH_SESSIONS = 1024;
export const FUNDING_RECENT_SESSIONS = 8;
const searching = new Map();
// ONCE PER LOCK, ONE READ AT A TIME (measured 2026-11-05 on the #1044 devnet: a lock is verified again and again - at entry, at every refresh of its
// standing - and each verification started its own read-back, 9-17 session exports at once and a MacBook load of 150). A lock searched in this process is
// not searched again; the exports of every search run one after another through `lane`, the waits for a session to finish beside it
const searched = new Set();
let lane = Promise.resolve();
// ONE SESSION COUNT PER FEDERATION AT A TIME, KEPT `COUNT_KEEP_MS` (measured the same day: every lock's wait asked its own count every 20 s, seven seats x four
// locks of a round - 28 tool runs a 20 s, each a second of CPU)
const COUNT_KEEP_MS = 15000;
// ONE EXPORT OF A RANGE SERVES EVERY LOCK SEARCHING IT (the same day: the four locks of a round at seven seats each exported the same 8, 16, ... sessions):
// the fundings a read named, by (federation, from, count), the last few kept
const rangesRead = new Map();
const counts = new Map();
const countOf = (port, fid, now, keepMs = COUNT_KEEP_MS) => {
  const kept = counts.get(fid);
  if (kept && (kept.pending || now() - kept.at < keepMs)) return kept.value;
  const value = Promise.resolve().then(() => port.sessionCount()).then((c) => Number(c));
  const entry = { at: now(), value, pending: true };
  counts.set(fid, entry);
  value.then(() => { entry.pending = false; entry.at = now(); }, () => { counts.delete(fid); });
  return value;
};
/** ONE SESSION READ AT A TIME IN THIS SEAT: the funding searches and the filer's reads (settlement.js) queue on the same lane. */
export function inSessionLane(fn) { const turn = lane.then(fn); lane = turn.catch(() => {}); return turn; }
/** For tests: forget which locks were searched. */
export function forgetLockSearches() { searched.clear(); searching.clear(); counts.clear(); rangesRead.clear(); }
export function keepLockSessionFloor({ round, port, roundId, federationId, outpoint, waitMs = 20000, maxWaitMs = 3600000, countKeepMs = COUNT_KEEP_MS, now = () => Date.now(), log = (l) => console.log(l), sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  if (!round.keepFundingSessionFloor || !round.fundingSessionFloor || !port || typeof port.sessionCount !== 'function'
    || typeof port.sessionExport !== 'function' || typeof port.arenaClaimRead !== 'function' || !outpoint || !(outpoint.txid instanceof Uint8Array)) return Promise.resolve(null);
  const fid = hexOf(federationId);
  const want = `${hexOf(outpoint.txid)}:${String(outpoint.outIdx)}`;
  const key = `${hexOf(roundId)}:${fid}:${hexOf(outpoint.txid)}`;
  if (searching.has(key)) return searching.get(key);
  if (searched.has(key)) return Promise.resolve(null);
  searched.add(key);
  const foundIn = async (from, count) => {
    const rangeKey = `${fid}:${from}:${count}`;
    let fundings = rangesRead.get(rangeKey);
    if (!fundings) {
      const ex = await port.sessionExport({ from });
      const read = await port.arenaClaimRead(claimReadInput({ config: ex.config, firstSession: ex.firstSession, sessions: ex.sessions }));
      fundings = new Map(((read && read.fundings) || []).map((x) => [String(x.outpoint).toLowerCase(), Number(x.session)]));
      rangesRead.set(rangeKey, fundings);
      if (rangesRead.size > 64) rangesRead.delete(rangesRead.keys().next().value);
    }
    return fundings.has(want) ? fundings.get(want) : null;
  };
  const run = (async () => {
    try {
      const count0 = Number(await countOf(port, fid, now, countKeepMs));
      if (!Number.isInteger(count0)) return null;
      // THE SESSION THE FUNDING SITS IN FINISHES FIRST (measured on the #1044 devnet 2026-11-05: sessions of ~4 min, and a search that gave up after 2 min
      // logged every lock of the round "not within 1024 sessions")
      let count = count0;
      for (const until = now() + maxWaitMs; count <= count0;) {
        if (now() > until) { log(`[slash] ${hexOf(roundId).slice(0, 16)}: no session of federation ${fid.slice(0, 16)} finished after ${count0} within ${Math.round(maxWaitMs / 60000)} min: the funding of lock ${want.slice(0, 20)} is not read, nothing is filed on it`); return null; }
        await sleep(waitMs);
        const c = Number(await countOf(port, fid, now, countKeepMs));
        if (Number.isInteger(c)) count = c;
      }
      const readBack = async () => {
        let found = null;
        for (let step = FUNDING_RECENT_SESSIONS; found === null && step <= FUNDING_SEARCH_SESSIONS; step *= 2) {
          found = await foundIn(Math.max(0, count - step), count);
          if (count - step <= 0) break;
        }
        return found;
      };
      const at = await inSessionLane(readBack);
      if (at === null) { log(`[slash] ${hexOf(roundId).slice(0, 16)}: the funding of lock ${want.slice(0, 20)} is not within ${FUNDING_SEARCH_SESSIONS} sessions of federation ${fid.slice(0, 16)}: that lock is unread, nothing is filed on it`); return null; }
      round.keepFundingSessionFloor(roundId, fid, at);
      return at;
    } catch { return null; }
  })();
  searching.set(key, run);
  run.finally(() => searching.delete(key));
  return run;
}

// (NO "HEAD-TO-HEAD FULL" REFUSAL AT /lock, kanban #1588: it refused the lock that would seat one player more HERE, and two seats that saw two
// locks in different orders seated different players and then waited forever for the lock each refused. A valid lock is kept; who is seated is
// round.js seatedEntriesOf's rule - the game's players among the lock-backed entries, in the order the entries were taken, not their locks - so
// crossing locks seat the same players at every seat. The /entry door still refuses a new entry once the round seats its players, kanban #1437.)

/** Another entry of the same player key in this round holding a verified lock of `kind` ('stake' | 'fee') here (kanban #1215). */
function otherStakedUnderKey(round, entry, entryIdBytes, kind) {
  if (typeof round.entriesOf !== 'function') return false;
  const lockOf = kind === 'fee' ? round.feeLock : round.stakeLock;
  if (typeof lockOf !== 'function') return false;
  const me = Buffer.from(entryIdBytes), key = Buffer.from(entry.playerPubkey);
  return round.entriesOf(entry.roundId).some((x) => !Buffer.from(x.entryId).equals(me) && Buffer.from(x.entry.playerPubkey).equals(key) && !!lockOf.call(round, x.entryId));
}

// THE LOCK BELONGS TO THE ENTRY THAT NAMED IT FIRST (kanban #1489, attack audit): an entry carries no player signature and a lock is not bound to its
// entry id, so anyone who saw a player's entry posted a copy under a session key of his own and handed the player's own lock fields (all public or
// derivable) for the copy before the player's /lock landed: the player's stake and fee backed an entry the copier plays and names the payout address
// of, and the player's own lock was refused. A lock is now verified only for the entry of the round that named its outpoint first at this seat; a
// later entry naming the same outpoint (a copy, or a reload's second entry) is refused, as a second hand-over of one lock was before.
function namedFirstByAnother(round, entry, entryIdBytes, kind, outpoint) {
  if (typeof round.firstEntryNamingLock !== 'function') return false;
  const first = round.firstEntryNamingLock(entry.roundId, kind, outpoint);
  return !!first && !Buffer.from(first).equals(Buffer.from(entryIdBytes));
}

// A LOCK THIS SEAT SIGNED BACK, OR KEPT TO SIGN BACK, STAKES NOTHING (kanban #1639, state audit 2026-11-12): a round this seat refused flips back to
// offered by itself (a paused market, the refuse-rounds file, a config not live), and the page posts the same entry with the lock it handed to
// POST /refused-lock again. That lock was kept as refused here and its forfeit may be signed (fate RETURNING, the player holding a Cancel): taken
// as a stake it played on a lock its player could take back at any moment, and every seat that signed the forfeit refused to claim it, so the
// round's settlement never formed. Kept as refused or fated RETURNING here: refused - it comes back by its forfeit while refused, or at its expiry.
function returnedHere(round, outpoint) {
  const op = `${Buffer.from(outpoint.txid).toString('hex')}:${outpoint.outIdx}`;
  if (typeof round.refusedLockAt === 'function' && round.refusedLockAt(op)) return 'that lock was kept at this signer node as the lock of a round it refused, for its return to the player: it stakes no entry (kanban #1639)';
  const fate = typeof round.lockFate === 'function' ? round.lockFate(op) : null;
  if (fate && fate.state === 'RETURNING') return 'this signer node signed a forfeit of that lock back to its player: it stakes no entry (kanban #1639)';
  return null;
}

// `timing` (kanban #605): an object the caller reads afterwards - ms spent asking the federation, checking gifts and reading the fee gate
export async function verifyStakeLock({ round, port, entryIdBytes, fields, claimPk, donationRecipients = null, reserveKey = null, split = undefined, timing = {}, namedGate = null }) {
  const stored = round.entry(entryIdBytes);
  if (!stored) return { ok: false, why: 'this node holds no such entry' };
  const entry = decodeEntryContract(stored);
  if (entry.stakeMsat === 0n) return { ok: false, why: 'that entry takes no stake, so there is no lock to verify' };
  const row = round.get(entry.roundId);
  if (!row) return { ok: false, why: 'this node holds no such round' };
  const contract = decodeRoundContract(new Uint8Array(row.contract));
  // THE ENTRY'S FEDERATION (2026.0.3): the one it names on a round that takes any, else the round's (entryFederation)
  const fed = entryFederation(contract, entry);
  if (!fed.ok) return { ok: false, why: fed.why.replace('its stake is not a lock', 'its stake is not a lock') };
  if (!port) return { ok: false, why: 'this node reaches no federation, so it cannot verify a stake lock' };
  const outpoint = entry.stakeLockOutpoint;
  if (!outpoint || zero(outpoint.txid)) return { ok: false, why: 'that entry names no stake lock outpoint' };
  // ONE LOCK IS ONE ENTRY. A lock this signer node already counted for another entry
  // cannot stake a second: two signer nodes on one stake is one signer node played free.
  const taken = round.stakeLockAt ? round.stakeLockAt(outpoint) : null;
  if (taken && !Buffer.from(taken.entryId).equals(Buffer.from(entryIdBytes)))
    return { ok: false, why: 'that stake lock already stakes another entry in this round: one lock is one entry' };
  if (namedFirstByAnother(round, entry, entryIdBytes, 'stake', outpoint))
    return { ok: false, why: 'that stake lock outpoint was named first by another entry in this round: a lock stakes the entry that named it first (kanban #1489)' };
  // ONE STAKED ENTRY PER PLAYER KEY IN A ROUND (kanban #1215, audit 3 #1210 MONEY-1): the settlement keys every lock by its entry's player
  // key, so a second staked entry under one key took the first one's place in the plan - a loser could make his own lock unclaimable,
  // void the round's settlement and take a lost stake back, or have one lock claimed twice
  if (otherStakedUnderKey(round, entry, entryIdBytes, 'stake'))
    return { ok: false, why: 'another entry of that player key is already staked in this round: one player key stakes one entry' };
  { const back = returnedHere(round, outpoint); if (back) return { ok: false, why: back }; }

  let t = Date.now();
  // PROTOCOL 27: AN ARENA LOCK, checked as arenaLockStands says; null for a round on the stock contract
  const arena = await arenaLockStands({ contract, entry, kind: 'stake', fields, outpoint, port, gate: namedGate, federationId: fed.federationId });
  let st, id;
  if (arena) {
    if (!arena.ok) return arena;
    timing.statusMs = Date.now() - t;
    id = arena.contractId; st = { blockCount: arena.height };
    keepLockSessionFloor({ round, port, roundId: entry.roundId, federationId: fed.federationId, outpoint });
  } else {
  // THE FEDERATION'S WORD AND THE CONTRACT'S ID ASKED TOGETHER (2026-10-02: "stake/fee verification of 5 of 7
  // confirmations must also be much faster"): two stock-client runs, one after the other before.
  [st, id] = await Promise.all([port.status(outpoint), port.contractId(fields)]);
  timing.statusMs = Date.now() - t;
  if (!st || !st.stored) return { ok: false, why: 'the federation holds no lock at the entry\'s stake_lock_outpoint' };
  if (String(id) !== String(st.stored.contractId))
    return { ok: false, why: 'the lock at that outpoint is not the contract handed over: its id is another' };
  if (fields.expiration !== st.blockCount + st.stored.blocksLeft)
    return { ok: false, why: 'that contract\'s expiration is not the one the federation holds' };
  if (!(claimPk instanceof Uint8Array)) return { ok: false, why: 'this signer node holds no claim key for that round' };

  const matches = lockMatchesEntry({ lock: fields, entry, kind: 'stake', claimPk, height: st.blockCount, expiryBlocks: contract.stakeExpiryBlocks });
  if (!matches.ok) return matches;
  }

  // AND ITS DONATION, IN THE SAME TRANSACTION (2026-10-03): a stake whose donation outputs are wrong or missing is
  // not counted - nothing is kept for it, and the lock may be handed over again.
  t = Date.now();
  const donated = await verifyEntryGifts({ round, port, entry, contract, entryIdBytes, recipients: donationRecipients, reserveKey, federationId: fed.federationId, split });
  timing.giftsMs = Date.now() - t;
  if (!donated.ok) return donated;
  if (donated.rows.length && round.putDonationOutputs) round.putDonationOutputs(donated.rows);

  // ONE LOCK IS ONE ENTRY, AGAIN AT THE WRITE (kanban #1214, audit 3 #1210 CONC-1): the check above was read before the federation was
  // asked, and two hand-overs of one lock for two entries at the same moment both passed it - one lock staked two entries. Read again
  // here, with no await between this read and the write below.
  { const now = round.stakeLockAt ? round.stakeLockAt(outpoint) : null;
    if (now && !Buffer.from(now.entryId).equals(Buffer.from(entryIdBytes)))
      return { ok: false, why: 'that stake lock already stakes another entry in this round: one lock is one entry' };
    if (otherStakedUnderKey(round, entry, entryIdBytes, 'stake'))
      return { ok: false, why: 'another entry of that player key is already staked in this round: one player key stakes one entry' };
    const back = returnedHere(round, outpoint);
    if (back) return { ok: false, why: back }; }
  round.putStakeLock({ entryId: entryIdBytes, roundId: entry.roundId, outpoint, fields: lockFieldsToJson(fields), contractId: String(id) });
  // IN A ROUND WHOSE GATE MINTS, THE STAKE COUNTS ONLY WITH ITS FEE LOCK (pick a): kept,
  // verified, and not seen - no play, no place in the settlement - until the fee lock is.
  t = Date.now();
  // A PROTOCOL-27 GAME ROUND'S FEE LOCK HOLDS THE WHOLE 10 % (kanban #1486): the gate is sized on it, as the door's and the page's are
  const gifted = giftsInFeeLock(contract) && entryGiftsInFee(contract, (() => { const g = round.plugins ? pluginForRound(contract, round.plugins) : null; return g && g.ok ? g.plugin.manifest : null; })());
  // at the split in force at its census height (round.feesFor, the fee set GET /fees?height= serves), as the door and the settlement read it
  const giftSplit = gifted ? (typeof round.feesFor === 'function' && round.feesFor(contract) ? roundSplitBps(round.feesFor(contract)) : ROUND_SPLIT_BPS) : undefined;
  const gate = await roundMintsFees({ contract, port, ...(gifted ? { feeBps: giftsFeeBps(giftSplit), split: giftSplit } : {}) });
  timing.gateMs = Date.now() - t;
  if (gate.mints && !(round.feeLock && round.feeLock(entryIdBytes)))
    return { ok: true, contractId: String(id), paidMsat: fields.amountMsat, height: st.blockCount, waitsForFeeLock: true };
  round.putStakeSeen({ entryId: entryIdBytes, paidMsat: fields.amountMsat });
  return { ok: true, contractId: String(id), paidMsat: fields.amountMsat, height: st.blockCount };
}

/**
 * A SIGNER NODE VERIFIES THE PLAYER'S FEE LOCK (Pick A, 2026-09-14; §23.1 step 5
 * "and the fee lock's"; F5): the entry's 2% node fee, locked to H(F) with F in
 * the entry, the round's claim key and the player's refund key - checked field
 * by field against the entry as the stake lock is. It is claimed for the round's
 * sitting signer nodes in the one settlement, whatever the result.
 */
export async function verifyFeeLock({ round, port, entryIdBytes, fields, claimPk, namedGate = null }) {
  const stored = round.entry(entryIdBytes);
  if (!stored) return { ok: false, why: 'this node holds no such entry' };
  const entry = decodeEntryContract(stored);
  if (entry.feeMsat === 0n) return { ok: false, why: 'that entry owes no fee, so there is no fee lock to verify' };
  const row = round.get(entry.roundId);
  if (!row) return { ok: false, why: 'this node holds no such round' };
  const contract = decodeRoundContract(new Uint8Array(row.contract));
  // THE ENTRY'S FEDERATION (2026.0.3): the one it names on a round that takes any, else the round's (entryFederation)
  const fed = entryFederation(contract, entry);
  if (!fed.ok) return { ok: false, why: fed.why.replace('its stake is not a lock', 'its fee is not a lock') };
  if (!port) return { ok: false, why: 'this node reaches no federation, so it cannot verify a fee lock' };
  const outpoint = entry.feeLockOutpoint;
  if (!outpoint || zero(outpoint.txid)) return { ok: false, why: 'that entry names no fee lock outpoint' };
  if (zero(entry.feePreimage)) return { ok: false, why: 'that entry hands over no F, so its fee lock could never be claimed' };
  // ONE FEE LOCK IS ONE ENTRY TOO (kanban #1214): no fee lock was checked against another entry at all
  const feeTaken = () => { const t = round.feeLockAt ? round.feeLockAt(outpoint) : null; return t && !Buffer.from(t.entryId).equals(Buffer.from(entryIdBytes)); };
  if (feeTaken()) return { ok: false, why: 'that fee lock already pays the fee of another entry in this round: one lock is one entry' };
  if (namedFirstByAnother(round, entry, entryIdBytes, 'fee', outpoint))
    return { ok: false, why: 'that fee lock outpoint was named first by another entry in this round: a lock pays for the entry that named it first (kanban #1489)' };
  if (otherStakedUnderKey(round, entry, entryIdBytes, 'fee'))
    return { ok: false, why: 'another entry of that player key already has a fee lock in this round: one player key, one fee lock (kanban #1215)' };
  { const back = returnedHere(round, outpoint); if (back) return { ok: false, why: back }; }
  const arena = await arenaLockStands({ contract, entry, kind: 'fee', fields, outpoint, port, gate: namedGate, federationId: fed.federationId });
  let st, id;
  if (arena) {
    if (!arena.ok) return arena;
    id = arena.contractId; st = { blockCount: arena.height };
    keepLockSessionFloor({ round, port, roundId: entry.roundId, federationId: fed.federationId, outpoint });
  } else {
  [st, id] = await Promise.all([port.status(outpoint), port.contractId(fields)]);
  if (!st || !st.stored) return { ok: false, why: 'the federation holds no lock at the entry\'s fee_lock_outpoint' };

  if (String(id) !== String(st.stored.contractId))
    return { ok: false, why: 'the lock at that outpoint is not the fee contract handed over: its id is another' };
  if (fields.expiration !== st.blockCount + st.stored.blocksLeft)
    return { ok: false, why: 'that fee contract\'s expiration is not the one the federation holds' };
  if (!(claimPk instanceof Uint8Array)) return { ok: false, why: 'this signer node holds no claim key for that round' };
  const matches = lockMatchesEntry({ lock: fields, entry, kind: 'fee', claimPk, height: st.blockCount, expiryBlocks: contract.stakeExpiryBlocks });
  if (!matches.ok) return matches;
  }
  if (feeTaken()) return { ok: false, why: 'that fee lock already pays the fee of another entry in this round: one lock is one entry' };
  if (otherStakedUnderKey(round, entry, entryIdBytes, 'fee'))
    return { ok: false, why: 'another entry of that player key already has a fee lock in this round: one player key, one fee lock (kanban #1215)' };
  { const back = returnedHere(round, outpoint); if (back) return { ok: false, why: back }; }
  round.putFeeLock({ entryId: entryIdBytes, roundId: entry.roundId, outpoint, fields: lockFieldsToJson(fields), contractId: String(id) });
  // AND A STAKE LOCK ALREADY VERIFIED AND WAITING FOR THIS ONE IS COUNTED NOW (pick a).
  const staked = round.stakeLock ? round.stakeLock(entryIdBytes) : null;
  if (staked && !round.stakeSeen(entryIdBytes)) round.putStakeSeen({ entryId: entryIdBytes, paidMsat: lockFieldsFromJson(staked.fields).amountMsat });
  return { ok: true, contractId: String(id), feeMsat: fields.amountMsat, height: st.blockCount };
}
