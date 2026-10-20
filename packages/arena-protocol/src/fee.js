// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// 22A: WHAT EACH NODE IS OWED, AND THE FACT THAT SOMEBODY COMPUTES IT.
//
// The fee was the one number in this protocol nobody recomputed. 5A.3 row 6
// decides WHETHER a node qualifies for a share; until this file, nothing said
// what the share IS - so a qualifying node could claim any amount and no
// predicate contradicted it. That is the shape row 3 had before
// `computePayoutTable` was wired into it.
//
// 22A gives the whole of it and leaves nothing to taste:
//
//   gross_round_volume = sum of stake of every financially activated entry
//   node_fee = 2.00% of gross_round_volume
//   1.00% -> GAME/VERIFY pool (7 slots)
//   1.00% -> SETTLEMENT pool (7 slots)
//   ...unearned shares are redistributed pro rata among the other eligible
//   nodes in the same role pool, keeping the total at 2%.
//   Remainders. Calculate in millisatoshis, floor each base share, and
//   distribute the remaining msat in ascending H(round_id || node_pubkey).
//
// MILLISATOSHI BIGINT THROUGHOUT, like every other money path here. The
// percentages are basis points and integer division; nothing is a float, and
// the remainder a floor leaves behind is handed out rather than kept.
import { Writer } from './encode.js';
// `fromHex` from hash.js and not a private copy. There was one here - the
// same loop without the odd-length check - and two of one decoder is two
// places for it to differ. It also made this file unbundleable beside
// hash.js, which is how it was found.
import { taggedHash, fromHex } from './hash.js';
import { PROTOCOL_VERSION, TYPE_FEE_CLAIM, TAG, GATEWAY_SEAT_VERSION, LIQUIDITY_VERSION, PRESSURE_WEIGHT_VERSION } from './constants.js';
import { roundId } from './contracts.js';
import { DELIVERED, FAILED, FORFEIT, isRefund, remainderOrder, netStakeMsat } from './payout.js';

/**
 * 5.00% (Bitcoin Arena, §0A.8 and §22A, RULED 2026-10-06; BLWP's was 2.00%), mandatory, and what each pool takes
 * of it: three equal pools of 5/3 % when the round's guardians are named, else two halves of 2.50% (* 2026-10-07: the 2% table's 1% + 1%, scaled up - no guardian third is left unallocated).
 */
export const NODE_FEE_BPS = 500;
export const POOL_BPS = 250;

/** The pools 22A pays, and the roles that sit in each. */
export const GAME_VERIFY = 'gameVerify';
export const SETTLEMENT = 'settlement';
// THE GUARDIAN POOL (§22A v4.6.4, RULED 2026-09-21 and 2026-10-01 15:44: "2/3 % to the game/verify pool, 2/3 % to
// the settlement pool ... and 2/3 % to the guardian pool, the seated guardians of the federation the round names"): the
// third pool, divided evenly among those guardians. A round whose guardians are not named keeps the two-pool table.
export const GUARDIAN = 'guardian';
// THE GATEWAY SEATS (2026.0.15, §23A.9): a third of the guardian pool, to the federation's two seated gateways
export const GATEWAY = 'gateway';
// THE LIQUIDITY PROVIDERS (2026.0.16, §23A.10): a quarter of the node fee, to the providers with a channel to one of the federation's
// custody nodes (appended as index 4: every earlier table's id is unchanged)
export const LIQUIDITY = 'liquidity';
export const POOLS = [GAME_VERIFY, SETTLEMENT, GUARDIAN, GATEWAY, LIQUIDITY];

/**
 * WHICH POOL A ROLE IS PAID FROM, and it is not a formality.
 *
 * 22A: "An operator selected for BOTH roles earns BOTH shares, because it
 * performs both services." So the two shares are separate money and a signer node
 * held in each is owed each - a table keyed by pubkey alone merges them, and a
 * claim in one role is then measured against the sum of both, which is an
 * over-claim nobody can see. Measured while writing this: a settlement claim
 * from a node that sat on game/verify was judged against the game/verify
 * share and passed.
 *
 * `relay` is not paid by 22A: the fee is named for the two committees.
 */
export const POOL_OF_ROLE = { game: GAME_VERIFY, verify: GAME_VERIFY, settlement: SETTLEMENT };
export const poolOfRole = (role) => POOL_OF_ROLE[role] || null;

/** Signer nodes are keyed by pool AND key, because the two shares are separate money. */
const signerNodeKey = (pool, pubkey) => `${pool}:${hex(pubkey)}`;

/**
 * THE FEE BASE, 22A: "gross_round_volume = sum of stake of every financially
 * activated entry", and "ENTRY_VOID and VOID entries are excluded".
 *
 * The same set `computePayoutTable` calls `activated`, and deliberately the
 * same predicate rather than a second one: a refunded entry is money that
 * never moved, and charging a fee on it would be charging for a round the
 * player was refunded out of.
 */
export function grossVolumeMsat(entries) {
  for (const e of entries)
    if (typeof e.stakeMsat !== 'bigint')
      throw new Error('stakes must be BigInt millisatoshi');
  return entries
    .filter((e) => !isRefund(e.outcome))
    .reduce((sum, e) => sum + e.stakeMsat, 0n);
}

/**
 * WHAT EVERY SIGNER NODE IS OWED, AND WHAT NOBODY IS.
 *
 * `pools` names the signer nodes of each pool - the committee, as selected - and
 * `eligible` is who among them qualified under 22A's availability rule, which
 * is 5A.3 row 6's question and is answered elsewhere.
 *
 * THE TWO POOLS SUM TO EXACTLY THE FEE. The second is the remainder of the
 * first rather than a second division, so a gross that does not divide by
 * 10000 cannot lose a millisatoshi between them.
 *
 * AN EMPTY POOL IS UNALLOCATED, NOT THE OPERATOR'S. 22A keeps the total at 2%
 * by redistributing inside a role pool, and with nobody eligible in one there
 * is no inside to redistribute to. The spec does not hand it anywhere, and the
 * one direction that cannot quietly become the operator's income is nowhere -
 * so it is returned named, and the caller may not mistake it for a share.
 *
 * `roundId` comes off the CONTRACT rather than being passed, so the order the
 * remainders go out in belongs to the round and not to whoever asks.
 */
// `feeBps`: the round's game's node fee (feeBpsOf - a market's own, 0.5 % by default), the rate every entry's fee
// was checked against at the door; the network's 5 % if none is named
// `weights`: { liquidity: Map(node hex -> sat) } - the providers' available balance from the federation's signed liquidity seating
// (2026.0.16, §23A.10); without it the liquidity pool is split evenly
export const LIQUIDITY_WEIGHT_STEP = 10000n;
export function nodeFeeTable({ contract, entries, pools, eligible, feeBps = NODE_FEE_BPS, weights = null }) {
  const gross = grossVolumeMsat(entries);
  const fee = (gross * BigInt(feeBps)) / 10000n;
  // THREE EQUAL THIRDS WHEN THE ROUND'S GUARDIANS ARE NAMED AND ONE IS ELIGIBLE: the first two floored, the guardian pool
  // what is left (two floors of the same ragged number can lose a millisatoshi between them). With no guardian named, the
  // two-pool table exactly as before - 1% and the rest.
  const guardians = ((pools && pools[GUARDIAN]) || []).filter((k) => eligible.has(hex(k)));
  let shareOf;
  const v = Number(contract && contract.protocolVersion);
  if (guardians.length && v >= LIQUIDITY_VERSION) {
    // FOUR QUARTERS (2026.0.16, §23A.10): game/verify, settlement, custody and liquidity; the custody quarter takes the floors' leftover.
    // With no eligible liquidity provider, its quarter is custody's (the guardians', then a third of it the gateway seats').
    const quarter = fee / 4n;
    const providers = ((pools && pools[LIQUIDITY]) || []).filter((k) => eligible.has(hex(k)));
    shareOf = providers.length ? { [GAME_VERIFY]: quarter, [SETTLEMENT]: quarter, [GUARDIAN]: fee - 3n * quarter, [LIQUIDITY]: quarter }
      : { [GAME_VERIFY]: quarter, [SETTLEMENT]: quarter, [GUARDIAN]: fee - 2n * quarter };
  } else if (guardians.length) {
    const third = fee / 3n;
    shareOf = { [GAME_VERIFY]: third, [SETTLEMENT]: third, [GUARDIAN]: fee - 2n * third };
  } else {
    // two halves of the fee (2.50% + 2.50% of the gross, the remainder msat to settlement), never a guardian third unspent
    const first = fee / 2n;
    shareOf = { [GAME_VERIFY]: first, [SETTLEMENT]: fee - first, [GUARDIAN]: 0n };
  }
  // A 2026.0.15 ROUND WITH A SEATED GATEWAY (§23A.9): one third of the guardian (custody) pool is the gateway seats', the guardians keep
  // the rest; with no eligible gateway the guardians keep it all, as before. On 2026.0.16 the custody pool is a quarter of the fee.
  const gateways = ((pools && pools[GATEWAY]) || []).filter((k) => eligible.has(hex(k)));
  if (guardians.length && v >= GATEWAY_SEAT_VERSION && gateways.length) {
    const gw = shareOf[GUARDIAN] / 3n;
    shareOf[GATEWAY] = gw; shareOf[GUARDIAN] -= gw;
  }

  const id = roundId(contract);
  const signerNodes = new Map();
  let unallocated = 0n;
  let cursor = 0;   // where the leftover order stopped (three pools)

  for (const pool of POOLS) {
    const amount = shareOf[pool];
    if (!amount) continue;   // the gateway pool is named only when a 2026.0.15 round pays it
    const inPool = (pools && pools[pool]) || [];
    const earning = inPool.filter((k) => eligible.has(hex(k)));

    if (!earning.length) { unallocated += amount; continue; }

    // Floor the base share, then hand the leftover out one millisatoshi at a
    // time in the round's own order - 22A's rule, and the one `payout.js`
    // already uses for the pool so there is one implementation of it.
    // THE LIQUIDITY POOL BY AVAILABLE BALANCE (2026.0.16, §23A.10; 2026-10-18: "Fee must be dependant on available balance too if
    // there is more than one"): each provider's weight floored to 10,000 sat, its share floored; with no weights (or all 0) evenly
    // THE GUARDIANS UNDER PRESSURE (2026.0.20, §23A.3a part 1): each by (min(bond, B*))^2 from `weights.guardian` (capacity.js
    // guardianWeights, read at the round's census height); none given (CALM, or an older version) - evenly
    const w = pool === LIQUIDITY && weights && weights[LIQUIDITY]
      ? earning.map((k) => { const x = BigInt(weights[LIQUIDITY].get(hex(k)) || 0n); return (x / LIQUIDITY_WEIGHT_STEP) * LIQUIDITY_WEIGHT_STEP; })
      : pool === GUARDIAN && v >= PRESSURE_WEIGHT_VERSION && weights && weights[GUARDIAN]
        ? earning.map((k) => BigInt(weights[GUARDIAN].get(hex(k)) || 0n)) : null;
    const total = w ? w.reduce((a, b) => a + b, 0n) : 0n;
    const shares = total > 0n ? w.map((x) => (amount * x) / total) : earning.map(() => amount / BigInt(earning.length));
    let left = amount - shares.reduce((a, b) => a + b, 0n);
    earning.forEach((k, i) => signerNodes.set(signerNodeKey(pool, k), (signerNodes.get(signerNodeKey(pool, k)) || 0n) + shares[i]));
    // WITH THREE POOLS THE LEFTOVER MSATS TAKE TURNS ACROSS THEM: the order goes on where the pool before stopped, so
    // a node does not take the extra millisatoshi of every third (measured: 4000 msat over two nodes, 2001 and 1999).
    // The two-pool table keeps its own order, exactly as before.
    const order = remainderOrder(id, earning.map((pubkey) => ({ pubkey })));
    const from = guardians.length ? cursor % order.length : 0;
    for (const e of [...order.slice(from), ...order.slice(0, from)]) {
      if (left <= 0n) break;
      signerNodes.set(signerNodeKey(pool, e.pubkey), signerNodes.get(signerNodeKey(pool, e.pubkey)) + 1n);
      left -= 1n;
      cursor++;
    }
  }

  const paid = [...signerNodes.values()].reduce((a, b) => a + b, 0n);
  if (paid + unallocated !== fee)
    throw new Error(`fee table broken: ${paid} paid and ${unallocated} unallocated of ${fee}`);

  return { gross, fee, pools: shareOf, signerNodes, unallocated };
}

/**
 * THE WEBSITE THAT BROUGHT AN ENTRY IS PAID 20% OF THE NODES' FEE ON IT (2026.0.9, roadmap item 7; RULED the owner
 * 2026-10-15, path (a): "Take it out of the nodes' 5% fee, 20% of that fee, so nodes earn less ... The player's stake is not increased
 * by this fee"). Per website payout key (hex, 33 bytes): `fee` x 20% x the stakes it brought / `gross` - the nodes' fee table's own
 * fee and gross - floored; the nodes share what is left of their fee. Refunded entries bring nothing. Answers
 * { shares: Map key -> msat (keys in ascending order), totalMsat }.
 */
export const FRONTEND_FEE_PERCENT = 20n;
export function frontendShares({ entries, fee, gross, pct = FRONTEND_FEE_PERCENT }) {
  const brought = new Map();
  for (const e of entries || []) {
    if (isRefund(e.outcome) || !(e.frontendPk instanceof Uint8Array)) continue;
    const k = hex(e.frontendPk);
    brought.set(k, (brought.get(k) || 0n) + e.stakeMsat);
  }
  const shares = new Map();
  let totalMsat = 0n;
  for (const k of [...brought.keys()].sort()) {
    const msat = gross > 0n ? (fee * pct * brought.get(k)) / (100n * gross) : 0n;
    shares.set(k, msat); totalMsat += msat;
  }
  if (totalMsat > (fee * pct) / 100n) throw new Error(`the websites' shares exceed ${pct}% of the nodes' fee`);
  return { shares, totalMsat };
}

/**
 * THE SAME 20% ON AN ORDER BOOK (comment 2295): a book's fees are what each claimed row paid (bookSettlement's
 * `buyFeeMsat + sellFeeMsat`), of which the nodes' part is `nodeBps / (nodeBps + donationBps)`. For each row whose entry names
 * a website (`entries`: entry id hex -> { frontendPk }), 20% of that row's nodes' part, floored, goes to the website; the msat a
 * floor leaves stays with the nodes. The donation's part is never touched. Answers { shares: Map key -> msat (ascending keys),
 * totalMsat }.
 */
export function frontendBookShares({ rows, entries, nodeBps, donationBps = 0, pct = FRONTEND_FEE_PERCENT }) {
  const total = BigInt(nodeBps) + BigInt(donationBps);
  const byKey = new Map();
  for (const r of rows || []) {
    const e = entries.get(r.entry);
    if (!e || !(e.frontendPk instanceof Uint8Array) || total === 0n) continue;
    const nodesPart = ((r.buyFeeMsat + r.sellFeeMsat) * BigInt(nodeBps)) / total;
    const k = hex(e.frontendPk);
    byKey.set(k, (byKey.get(k) || 0n) + (nodesPart * pct) / 100n);
  }
  const shares = new Map([...byKey.keys()].sort().map((k) => [k, byKey.get(k)]));
  return { shares, totalMsat: [...shares.values()].reduce((a, b) => a + b, 0n) };
}

/**
 * What one signer node is owed FOR ONE ROLE, or nothing at all.
 *
 * The role is required: 22A pays the two pools separately and a signer node held in
 * both earns both, so "what is this node owed" has no single answer.
 */
export const feeOwed = (table, nodePubkey, role) => {
  const pool = poolOfRole(role);
  return pool ? (table.signerNodes.get(signerNodeKey(pool, nodePubkey)) || 0n) : 0n;
};

const hex = (bytes) => {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
};

/**
 * THE TABLE AS ONE HASH, so a proof can be bound to it.
 *
 * 5A.3B step 4 rests on a stranger being able to re-derive a proof later and
 * check it. An over-claim is measured against a table, so the proof has to
 * name WHICH table - otherwise the accuser recomputes from an eligibility set
 * that suits them and every honest claim is an over-claim.
 *
 * The gross and the fee are in it as well as the rows: a table that agreed on
 * every signer node while disagreeing about what the round was worth would be a
 * different table with the same fingerprint.
 */
export function feeTableId(table) {
  const w = new Writer();
  w.u8(TYPE_FEE_CLAIM);
  w.u16(PROTOCOL_VERSION);
  w.u64(table.gross);
  w.u64(table.fee);
  w.u64(table.unallocated);
  const rows = [...table.signerNodes.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  w.vec(rows, (row, ww) => {
    // `pool:key`, so the same node's two shares are two rows and a table that
    // moved money between the pools is a different table.
    const [pool, key] = row[0].split(':');
    ww.u8(POOLS.indexOf(pool));
    ww.bytes32(fromHex(key));
    ww.u64(row[1]);
  });
  return taggedHash(TAG.feeTable, w.finish());
}

/**
 * WHAT ONE ENTRY OWES IN FEE: 2% OF THE WALLET COMMITMENT, TAKEN OUT OF IT.
 *
 * 22A, "Collection: inclusive in the stake (changed)": "'Play for 100' now
 * means 100 leaves the wallet, and the wallet dialog agrees with the button
 * that was pressed." `stakeMsat` is that commitment, the fee is 2% of it, and
 * `netStakeMsat` is what is left for the pool once the fee and the donation
 * have come out.
 *
 * RETRACTED (6e). This comment used to call Collection "the error" and charge
 * 18's older "on top of the stake", on the ground that the net reading turns
 * 22A's 61 x 100 example into 117.12 sat. It does not. 22A's fee base is
 * `gross_round_volume`, "(61 x 100, the wallet commitments)", so the fee is 2%
 * of 6,100 = 122 sat and it is the POOL that is net: 6,100 - 122 - 122 =
 * 5,856. 117.12 was 2% of the net stake, a base 22A never uses. Measured in
 * `inclusive.test.js`.
 *
 * THE RATE IS A CONSTANT AND NOT A CONTRACT FIELD. 22A calls it "2%,
 * identical for everyone", so one rate covers every entry of every round; a
 * field would let an operator price its own round's fee, which is the fault
 * contract fields exist to prevent rather than one to import.
 *
 * The same integer floor the table uses, so one rate is applied one way.
 */
// A MARKET'S OWN NODE FEE (2026-10-09: "per market in manifest"): `bps`, its manifest's
// marketTerms.nodeFeeBps (0 to NODE_FEE_BPS) - the rate is still never the operator's or the round's to choose, only the
// signed manifest's, within the network's. Without one, the network's.
// A MARKET'S ENTRY FEE CARRIES ITS DONATION TOO (entryFeeBpsOf), so the bound is the markets' 10 % together, not the
// network's 5 %; a game's rate is still the network's constant.
export const ENTRY_FEE_BPS_MAX = 1000;
export const entryFeeMsat = (stakeMsat, bps = NODE_FEE_BPS) => {
  if (typeof stakeMsat !== 'bigint') throw new Error('a stake is BigInt millisatoshi');
  if (stakeMsat < 0n) throw new Error('a stake cannot be negative');
  if (!Number.isInteger(bps) || bps < 0 || bps > ENTRY_FEE_BPS_MAX) throw new Error(`an entry fee is 0 to ${ENTRY_FEE_BPS_MAX} bps`);
  return (stakeMsat * BigInt(bps)) / 10000n;
};

/**
 * A MARKET'S DEFAULT FEE (2026-10-09: "market default fees are 1%, 0.5 + 0.5, per default"): an attested market that
 * names no fee of its own charges 0.5 % to the nodes and 0.5 % donation; a game, the network's 5 % (+ its donation choice).
 */
export const MARKET_DEFAULT_NODE_FEE_BPS = 50;
export const MARKET_DEFAULT_DONATION_BPS = 50;
const isMarket = (m) => !!m && m.resultType === 2;                       // RESULT_TYPE.ATTESTED (manifest.js)

/** The node fee a round's game charges: its market terms' rate, a market's default 0.5 %, or the network's. */
export const feeBpsOf = (manifest) => (manifest && manifest.marketTerms && Number.isInteger(manifest.marketTerms.nodeFeeBps)
  ? manifest.marketTerms.nodeFeeBps : isMarket(manifest) ? MARKET_DEFAULT_NODE_FEE_BPS : NODE_FEE_BPS);

/** A market's donation: its terms' rate, or the market default 0.5 %; null for a game (the player's donation choice). */
export const donationBpsOf = (manifest) => (manifest && manifest.marketTerms && Number.isInteger(manifest.marketTerms.donationBps)
  ? manifest.marketTerms.donationBps : isMarket(manifest) ? MARKET_DEFAULT_DONATION_BPS : null);

/**
 * A MARKET'S FEES ARE DUE AT RESOLUTION, ITS DONATION TOO (2026-10-09: "the fees are due at the
 * close, when you win or lose ... until then orders can be cancelled for free"): a market entry pays nothing at entry - its
 * fee lock holds the node fee AND the donation (1 % by default), claimed only when the market resolves, from winners and
 * losers alike, and returned whole on a cancel, a VOID or a market nobody picked right. So a market entry's `feeMsat` is
 * that whole rate of its stake and its `donationMsat` is 0 (no donation outputs beside the stake); the settlement splits
 * the claimed fee locks into the node table (feeBpsOf) and the donation set (the rest). A game: its node fee alone.
 */
/** A market's protocol reserve: the part of its donation rate its terms name for the reserves, else 0. */
export const reserveBpsOf = (manifest) => (manifest && manifest.marketTerms && Number.isInteger(manifest.marketTerms.reserveBps)
  ? manifest.marketTerms.reserveBps : 0);

export const entryFeeBpsOf = (manifest) => (isMarket(manifest) ? feeBpsOf(manifest) + donationBpsOf(manifest) : feeBpsOf(manifest));
export const donationInFee = (manifest) => isMarket(manifest);

/**
 * DOES THIS ENTRY'S FEE STAND?
 *
 * An entry whose `feeMsat` is not 2% of its own `stakeMsat` does not, and it
 * matters in both directions. Too little and the round collected less than the
 * table will owe its nodes. TOO MUCH AND THE EXCESS IS INCOME: the fee table
 * computes from the stakes, so a millisatoshi over is a millisatoshi the table
 * never allocates to anybody and that stays with whoever collected it.
 *
 * Answered rather than thrown for a malformed entry, like every other decision
 * in this package: a caller that asked whether an entry stands should be told,
 * not made to catch.
 */
// `donationInFee`: a market's entry (entryFeeBpsOf) - its donation rides in the fee lock, so its own donation field is 0
export function feeMatchesEntry(entry, { feeBps = NODE_FEE_BPS, donationInFee: inFee = false } = {}) {
  // STRICT, AND ON PURPOSE. Every entry the door judges is decoded from signed
  // bytes, so its amounts are BigInt - a free round is three zeros, not three
  // missing fields. Coercing a Number or a missing amount here would have
  // hidden the wiring fault that refused the Daily's free round at 11:15 (the
  // door not yet passing the donation) instead of naming it.
  if (!entry || typeof entry.stakeMsat !== 'bigint' || typeof entry.feeMsat !== 'bigint')
    return { ok: false, why: 'an entry carries a BigInt millisatoshi stake and fee' };
  if (entry.stakeMsat < 0n || entry.feeMsat < 0n)
    return { ok: false, why: 'a stake and a fee cannot be negative' };

  if (inFee && entry.donationMsat !== 0n)
    return { ok: false, why: `a market's donation is in its fee lock, due at resolution: that entry names a donation of ${entry.donationMsat} msat beside it` };
  const owed = entryFeeMsat(entry.stakeMsat, feeBps);
  const pct = `${feeBps / 100}%`;
  if (entry.feeMsat !== owed)
    return {
      ok: false,
      owed,
      why: entry.feeMsat > owed
        ? `that entry was charged ${entry.feeMsat} where ${pct} of ${entry.stakeMsat} is ${owed}: `
          + `the ${entry.feeMsat - owed} over is money no fee table allocates`
        : `that entry was charged ${entry.feeMsat} where ${pct} of ${entry.stakeMsat} is ${owed}`,
    };

  // AND THE DONATION COMES OUT OF THE SAME COMMITMENT, so together they cannot
  // come to more than it. Measured before 6e: a donation of 200000 msat on a
  // 100000 stake stood here, because nothing looked at the donation at all -
  // an entry promising the donation set twice what the player put up.
  let net;
  try { net = netStakeMsat(entry); }
  catch (e) { return { ok: false, owed, why: e.message }; }
  return { ok: true, owed, net, why: `${owed} is ${pct} of ${entry.stakeMsat}, and ${net} of it is staked` };
}
